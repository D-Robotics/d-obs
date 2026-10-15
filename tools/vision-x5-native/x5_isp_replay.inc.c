/* SPDX-License-Identifier: Apache-2.0
 * Included after x5_camera_backend.c's live lifecycle/frame helpers.
 * HBN DDR sendframe is synchronous; output must echo the submitted identity.
 * https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/1-HBN_API_zh_CN.html
 * https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/samples/sample_isp.html
 *
 * Reuse the initialized, calibrated ISP while the complete live flow is stopped
 * and its VIN input is unbound. No replacement sensor, guessed calibration or
 * stale live image is used. The caller binds the exact tuning/readback to the
 * RAW hash; this function never changes tuning or automatic modes.
 */
#include <stdatomic.h>

#define X5W_REPLAY_MAX_BYTES (UINT64_C(64) * 1024 * 1024)
#define X5W_REPLAY_MAX_PIXELS (UINT64_C(32) * 1024 * 1024)

typedef struct x5w_replay_state {
    hbn_vnode_image_t input, output;
    int input_owned, output_owned, isp_stop_required;
    int flow_stop_required, unbind_required;
    int resume_running, resume_bound;
} x5w_replay_state;

static _Atomic uint32_t x5w_replay_sequence = UINT32_C(0x80000000);

static int x5w_replay_id(uint32_t *out)
{
    uint32_t previous = atomic_load_explicit(&x5w_replay_sequence, memory_order_relaxed);
    for (;;) {
        if (previous == UINT32_MAX) return -EOVERFLOW;
        uint32_t next = previous + 1;
        if (atomic_compare_exchange_weak_explicit(&x5w_replay_sequence, &previous, next,
                memory_order_relaxed, memory_order_relaxed)) {
            *out = next;
            return 0;
        }
    }
}

/* A failed SDK release/stop/free keeps ownership in the parent context. Never
 * free an input that an uncertain ISP operation might still access. The normal
 * stop/close path calls this with restore_live=0 before destroying any node. */
static int x5w_replay_cleanup_locked(x5w_context *ctx, int restore_live)
{
    x5w_replay_state *state = ctx->replay_state;
    if (!state) return 0;
    int ret;
    if (state->output_owned) {
        ret = hbn_vnode_releaseframe(ctx->isp, 0, &state->output);
        if (ret != 0) return ret;
        state->output_owned = 0;
    }
    if (state->isp_stop_required) {
        ret = hbn_vnode_stop(ctx->isp);
        if (ret != 0) return ret;
        state->isp_stop_required = 0;
    }
    if (state->input_owned) {
        ret = hb_mem_free_buf(state->input.buffer.fd[0]);
        if (ret != 0) return ret;
        state->input_owned = 0;
    }
    if (state->flow_stop_required) {
        ret = hbn_vflow_stop(ctx->flow);
        if (ret != 0) return ret;
        state->flow_stop_required = 0;
        ctx->stop_required = ctx->running = 0;
    }
    if (state->unbind_required) {
        ret = hbn_vflow_unbind_vnode(ctx->flow, ctx->vin, 0, ctx->isp, 0);
        if (ret != 0) return ret;
        state->unbind_required = 0;
        ctx->bound = 0;
    }
    if (restore_live) {
        if (state->resume_bound && !ctx->bound) {
            ret = hbn_vflow_bind_vnode(ctx->flow, ctx->vin, 0, ctx->isp, 0);
            if (ret != 0) return ret;
            ctx->bound = 1;
        }
        if (state->resume_running) {
            ctx->stop_required = 1;
            /* Retain a partial failed restart for a stop-before-retry. */
            state->flow_stop_required = 1;
            ret = hbn_vflow_start(ctx->flow);
            if (ret != 0) return ret;
            state->flow_stop_required = 0;
            ctx->running = 1;
        }
    }
    free(state);
    ctx->replay_state = NULL;
    return 0;
}

int x5w_replay_cleanup(void *opaque)
{
    x5w_context *ctx = context(opaque);
    if (!ctx) return -EINVAL;
    pthread_mutex_lock(&ctx->lock);
    int ret = x5w_replay_cleanup_locked(ctx, 1);
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

static int x5w_replay_manual(hbn_vnode_handle_t isp)
{
    hbn_isp_exposure_attr_t ae = {0};
    hbn_isp_awb_attr_t awb = {0};
    int ret = hbn_isp_get_exposure_attr(isp, &ae);
    if (ret != 0) return ret;
    ret = hbn_isp_get_awb_attr(isp, &awb);
    if (ret != 0) return ret;
    return ae.mode == HBN_ISP_MODE_MANUAL && awb.mode == HBN_ISP_MODE_MANUAL ? 0 : -EPERM;
}

static int x5w_replay_queue_empty(int ret)
{
    /* Public HBN error codes combine the module and status in the low 16 bits.
     * Accept only a documented empty wait, never an arbitrary driver failure. */
    if (ret == -EAGAIN || ret == -ETIMEDOUT) return 1;
    uint32_t magnitude = ret < 0 ? (uint32_t)(-(int64_t)ret) : (uint32_t)ret;
    uint32_t status = magnitude & UINT32_C(0xffff);
    return status == HBN_STATUS_TIMEOUT || status == HBN_STATUS_NODE_POLL_TIMEOUT;
}

static int x5w_replay_drain(x5w_context *ctx, x5w_replay_state *state)
{
    for (unsigned i = 0; i < 64; ++i) {
        memset(&state->output, 0, sizeof(state->output));
        int ret = hbn_vnode_getframe(ctx->isp, 0, 0, &state->output);
        if (ret != 0) return x5w_replay_queue_empty(ret) ? 0 : ret;
        state->output_owned = 1;
        ret = hbn_vnode_releaseframe(ctx->isp, 0, &state->output);
        if (ret != 0) return ret;
        state->output_owned = 0;
    }
    return -EBUSY; /* An unbounded source is not an isolated replay pipeline. */
}

int x5w_replay(void *opaque, const unsigned char *raw, size_t n,
               int width, int height, int bitdepth, int bayer, int stride,
               unsigned char *out, size_t cap, x5w_frame_info *info)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !raw || !out || !info) return -EINVAL;
    memset(info, 0, sizeof(*info));
    if (width < 2 || height < 2 || width > 8192 || height > 8192 ||
        (width & 1) || (height & 1) || bitdepth != 10 || bayer < 0 || bayer > 3 ||
        stride < width * 2 || (uint64_t)width * height > X5W_REPLAY_MAX_PIXELS ||
        (uint64_t)stride * height > X5W_REPLAY_MAX_BYTES ||
        n != (size_t)stride * (size_t)height) return -EINVAL;
    /* Canonical unpacked little-endian right-aligned RAW10, never MIPI packing.
     * Padding is excluded from sample validation and copied as initialized zero. */
    for (int y = 0; y < height; ++y) {
        const unsigned char *row = raw + (size_t)y * stride;
        for (int x = 0; x < width; ++x)
            if ((unsigned)row[2 * x] + ((unsigned)row[2 * x + 1] << 8) > 1023)
                return -EBADMSG;
    }
    pthread_mutex_lock(&ctx->lock);
    int ret = 0;
    if (ctx->replay_state || (!ctx->running && ctx->stop_required)) { ret = -EBUSY; goto done; }
    if (!ctx->mem_open || !ctx->isp_open || !ctx->flow_open ||
        ctx->isp_attr.input_mode != DDR_MODE || ctx->isp_input.fmt != FRM_FMT_RAW ||
        ctx->isp_input.bit_width != 10 || ctx->isp_input.width != (uint32_t)width ||
        ctx->isp_input.height != (uint32_t)height ||
        ctx->camera_cfg.width != (uint32_t)width || ctx->camera_cfg.height != (uint32_t)height) {
        ret = X5W_UNSUPPORTED; goto done;
    }
    uint32_t actual_bayer;
    ret = bayer_get(ctx, &actual_bayer);
    if (ret != 0) goto done;
    if (actual_bayer != (uint32_t)bayer) { ret = -EINVAL; goto done; }
    ret = x5w_replay_manual(ctx->isp);
    if (ret != 0) goto done;
    x5w_replay_state *state = calloc(1, sizeof(*state));
    if (!state) { ret = -ENOMEM; goto done; }
    ctx->replay_state = state;
    state->resume_running = ctx->running;
    state->resume_bound = ctx->bound;
    if (ctx->running) {
        state->flow_stop_required = 1;
        ret = hbn_vflow_stop(ctx->flow);
        if (ret != 0) goto cleanup;
        state->flow_stop_required = 0;
        ctx->stop_required = ctx->running = 0;
    }
    if (ctx->bound) {
        state->unbind_required = 1;
        ret = hbn_vflow_unbind_vnode(ctx->flow, ctx->vin, 0, ctx->isp, 0);
        if (ret != 0) goto cleanup;
        state->unbind_required = 0;
        ctx->bound = 0;
    }
    state->isp_stop_required = 1; /* A failed start can still affect hardware. */
    ret = hbn_vnode_start(ctx->isp);
    if (ret != 0) goto cleanup;
    /* Some SDK revisions initialize algorithm modes at start. Refuse an auto
     * algorithm before submitting RAW, even if the pre-stop getter was manual. */
    ret = x5w_replay_manual(ctx->isp);
    if (ret != 0) goto cleanup;
    ret = x5w_replay_drain(ctx, state);
    if (ret != 0) goto cleanup;
    for (unsigned i = 0; i < MAX_GRAPHIC_BUF_COMP; ++i) state->input.buffer.fd[i] = -1;
    ret = hb_mem_alloc_graph_buf(width, height, MEM_PIX_FMT_RAW10,
        HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
        HB_MEM_USAGE_HW_ISP | HB_MEM_USAGE_CACHED | HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF,
        stride, height, &state->input.buffer);
    if (ret != 0) {
        if (state->input.buffer.fd[0] >= 0) state->input_owned = 1;
        goto cleanup;
    }
    state->input_owned = 1;
    hb_mem_graphic_buf_t *buffer = &state->input.buffer;
    uint64_t bytes = buffer->stride > 0 ? (uint64_t)buffer->stride * height : 0;
    if (buffer->plane_cnt != 1 || buffer->format != MEM_PIX_FMT_RAW10 ||
        buffer->width != width || buffer->height != height || buffer->vstride < height ||
        buffer->stride < width * 2 ||
        buffer->fd[0] < 0 || !buffer->virt_addr[0] || bytes > X5W_REPLAY_MAX_BYTES ||
        buffer->size[0] < bytes) { ret = -EBADMSG; goto cleanup; }
    memset(buffer->virt_addr[0], 0, (size_t)bytes);
    for (int y = 0; y < height; ++y)
        memcpy(buffer->virt_addr[0] + (size_t)y * buffer->stride,
               raw + (size_t)y * stride, (size_t)width * 2);
    ret = hb_mem_flush_buf_with_vaddr((uint64_t)(uintptr_t)buffer->virt_addr[0], bytes);
    if (ret != 0) goto cleanup;
    uint32_t submitted_id;
    ret = x5w_replay_id(&submitted_id);
    if (ret != 0) goto cleanup;
    state->input.info.frame_id = submitted_id;
    if (gettimeofday(&state->input.info.tv, NULL) != 0) { ret = -errno; goto cleanup; }
    ret = hbn_vnode_sendframe(ctx->isp, 0, &state->input);
    if (ret != 0) goto cleanup;
    ret = hbn_vnode_getframe(ctx->isp, 0, 2000, &state->output);
    if (ret != 0) goto cleanup;
    state->output_owned = 1;
    if (state->output.info.frame_id != submitted_id ||
        state->output.info.tv.tv_sec != state->input.info.tv.tv_sec ||
        state->output.info.tv.tv_usec != state->input.info.tv.tv_usec) {
        ret = -ESTALE; goto cleanup;
    }
    ret = copy_frame(ctx, 0, &state->output, out, cap, info);
    if (ret == 0) ret = x5w_replay_manual(ctx->isp);
cleanup: {
        int cleanup_ret = x5w_replay_cleanup_locked(ctx, 1);
        if (cleanup_ret != 0) ret = cleanup_ret;
        if (ret != 0) memset(info, 0, sizeof(*info));
    }
done:
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}
