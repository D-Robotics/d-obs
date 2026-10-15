/* SPDX-License-Identifier: Apache-2.0
 * Isolated replay SDK shim, compiled with the real public X5 SDK headers.
 * It exercises the include's state/ownership machine; the core copy_frame and
 * sensor helpers have separate backend tests. No board, ISP or adapter is used.
 */
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "hbn_api.h"
#include "hbn_isp_api.h"
#include "hb_camera_interface.h"
#include "isp_cfg.h"
#include "../x5_camera_backend.h"

#define X5W_UNSUPPORTED (-95)
typedef struct x5w_context {
    pthread_mutex_t lock;
    camera_config_t camera_cfg;
    isp_attr_t isp_attr;
    isp_ichn_attr_t isp_input;
    hbn_vnode_handle_t isp, vin;
    hbn_vflow_handle_t flow;
    int mem_open, isp_open, flow_open, running, stop_required, bound;
    void *replay_state;
} x5w_context;

static int sdk_live, sdk_isp_running, sdk_bound, owned_frames, old_frames;
static int allocs, frees, releases, sends, flushes, flow_starts, flow_stops;
static int node_starts, node_stops, bind_calls, unbind_calls;
static int auto_ae, auto_awb, corrupt_id, corrupt_time, malformed_alloc, corrupt_copy;
static int manual_change_after_send;
static int manual_change_after_start;
static int frame_bayer;
static const char *failure;
static int failures_left;
static hbn_vnode_image_t submitted;
static unsigned char *allocation;
static unsigned char y_plane[8], uv_plane[4];

static int fail(const char *name)
{
    if (failure && !strcmp(name, failure) && failures_left > 0) {
        --failures_left;
        return -777;
    }
    return 0;
}

static x5w_context *context(void *opaque) { return opaque; }
static int bayer_get(x5w_context *ctx, uint32_t *out)
{
    assert(ctx);
    *out = (uint32_t)frame_bayer;
    return fail("bayer");
}
static int copy_frame(x5w_context *ctx, int raw, const hbn_vnode_image_t *frame,
                      unsigned char *out, size_t cap, x5w_frame_info *info)
{
    assert(ctx && !raw && frame->buffer.format == MEM_PIX_FMT_NV12);
    if (corrupt_copy) return -EBADMSG;
    if (cap < 12) return -ENOSPC;
    memcpy(out, frame->buffer.virt_addr[0], 8);
    memcpy(out + 8, frame->buffer.virt_addr[1], 4);
    *info = (x5w_frame_info){ .width = 2, .height = 2, .stride_y = 4, .stride_uv = 4,
        .size_y = 8, .size_uv = 4, .bit_depth = 8, .packing = X5W_NV12,
        .frame_id = frame->info.frame_id,
        .timestamp_ns = (uint64_t)frame->info.tv.tv_sec * UINT64_C(1000000000) +
            (uint64_t)frame->info.tv.tv_usec * 1000 };
    return 0;
}

#include "../x5_isp_replay.inc.c"

int32_t hbn_isp_get_exposure_attr(hbn_vnode_handle_t node, hbn_isp_exposure_attr_t *out)
{
    assert(node == 102);
    int ret = fail("ae_get");
    if (!ret) out->mode = auto_ae ? HBN_ISP_MODE_AUTO : HBN_ISP_MODE_MANUAL;
    return ret;
}
int32_t hbn_isp_get_awb_attr(hbn_vnode_handle_t node, hbn_isp_awb_attr_t *out)
{
    assert(node == 102);
    int ret = fail("awb_get");
    if (!ret) out->mode = auto_awb ? HBN_ISP_MODE_AUTO : HBN_ISP_MODE_MANUAL;
    return ret;
}
hobot_status hbn_vflow_stop(hbn_vflow_handle_t flow)
{
    assert(flow == 103); ++flow_stops;
    int ret = fail("flow_stop");
    if (!ret) sdk_live = sdk_isp_running = 0;
    return ret;
}
hobot_status hbn_vflow_start(hbn_vflow_handle_t flow)
{
    assert(flow == 103 && sdk_bound && !allocation && !owned_frames);
    ++flow_starts;
    sdk_live = sdk_isp_running = 1; /* A failed start may have partial effects. */
    return fail("flow_start");
}
hobot_status hbn_vflow_bind_vnode(hbn_vflow_handle_t flow, hbn_vnode_handle_t vin,
                                 uint32_t output, hbn_vnode_handle_t isp, uint32_t input)
{
    assert(flow == 103 && vin == 101 && isp == 102 && output == 0 && input == 0);
    assert(!sdk_live && !allocation && !owned_frames); ++bind_calls;
    int ret = fail("bind");
    if (!ret) sdk_bound = 1;
    return ret;
}
hobot_status hbn_vflow_unbind_vnode(hbn_vflow_handle_t flow, hbn_vnode_handle_t vin,
                                   uint32_t output, hbn_vnode_handle_t isp, uint32_t input)
{
    assert(flow == 103 && vin == 101 && isp == 102 && output == 0 && input == 0);
    assert(!sdk_live); ++unbind_calls;
    int ret = fail("unbind");
    if (!ret) sdk_bound = 0;
    return ret;
}
hobot_status hbn_vnode_start(hbn_vnode_handle_t node)
{
    assert(node == 102 && !sdk_live && !sdk_bound); ++node_starts;
    sdk_isp_running = 1; /* Retain ownership even if this start returns failure. */
    if (manual_change_after_start) auto_ae = 1;
    return fail("node_start");
}
hobot_status hbn_vnode_stop(hbn_vnode_handle_t node)
{
    assert(node == 102 && !owned_frames); ++node_stops;
    int ret = fail("node_stop");
    if (!ret) sdk_isp_running = 0;
    return ret;
}
int32_t hb_mem_alloc_graph_buf(int32_t width, int32_t height, int32_t format,
                              int64_t flags, int32_t stride, int32_t vstride,
                              hb_mem_graphic_buf_t *out)
{
    assert(width == 2 && height == 2 && format == MEM_PIX_FMT_RAW10);
    assert(flags & HB_MEM_USAGE_HW_ISP);
    assert(flags & HB_MEM_USAGE_CACHED);
    assert(stride == 6 && vstride == 2 && !sdk_bound && !sdk_live && sdk_isp_running);
    ++allocs;
    int ret = fail("alloc");
    if (ret) return ret;
    allocation = malloc(16);
    assert(allocation);
    memset(allocation, 0xff, 16);
    *out = (hb_mem_graphic_buf_t){ .fd = {701, -1, -1}, .width = width, .height = height,
        .format = format, .plane_cnt = malformed_alloc ? 2 : 1, .stride = 8, .vstride = 2,
        .size = {16}, .virt_addr = {allocation} };
    return 0;
}
int32_t hb_mem_flush_buf_with_vaddr(uint64_t address, uint64_t size)
{
    assert(address == (uint64_t)(uintptr_t)allocation && size == 16); ++flushes;
    const unsigned char expected[] = {1, 0, 2, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 0, 0, 0};
    assert(!memcmp(allocation, expected, sizeof(expected)));
    return fail("flush");
}
int32_t hb_mem_free_buf(int32_t fd)
{
    assert(fd == 701 && allocation && !sdk_isp_running && !owned_frames); ++frees;
    int ret = fail("free");
    if (!ret) { free(allocation); allocation = NULL; }
    return ret;
}
hobot_status hbn_vnode_sendframe(hbn_vnode_handle_t node, uint32_t input,
                                hbn_vnode_image_t *frame)
{
    assert(node == 102 && input == 0 && sdk_isp_running && !sdk_live && !sdk_bound);
    assert(allocation && flushes && !owned_frames); ++sends;
    submitted = *frame;
    assert(submitted.info.frame_id >= UINT32_C(0x80000000));
    if (manual_change_after_send) auto_awb = 1;
    return fail("send");
}
hobot_status hbn_vnode_getframe(hbn_vnode_handle_t node, uint32_t output,
                               uint32_t timeout, hbn_vnode_image_t *frame)
{
    assert(node == 102 && output == 0 && sdk_isp_running && !sdk_live && !sdk_bound);
    int ret = fail(timeout ? "get" : "drain");
    if (ret) return ret;
    if (!timeout && old_frames == 0) return -ETIMEDOUT;
    if (!timeout) --old_frames;
    else assert(timeout == 2000 && sends && allocation);
    assert(!owned_frames);
    ++owned_frames;
    *frame = (hbn_vnode_image_t){ .buffer = { .width = 2, .height = 2, .stride = 4,
        .format = MEM_PIX_FMT_NV12, .plane_cnt = 2, .size = {8, 4}, .virt_addr = {y_plane, uv_plane} } };
    frame->info = timeout ? submitted.info : (hbn_frame_info_t){ .frame_id = 7 };
    if (timeout && corrupt_id) --frame->info.frame_id;
    if (timeout && corrupt_time) ++frame->info.tv.tv_usec;
    return 0;
}
hobot_status hbn_vnode_releaseframe(hbn_vnode_handle_t node, uint32_t output,
                                   hbn_vnode_image_t *frame)
{
    assert(node == 102 && output == 0 && frame && owned_frames); ++releases;
    int ret = fail("release");
    if (!ret) --owned_frames;
    return ret;
}

static const unsigned char raw[] = {1, 0, 2, 0, 0xaa, 0xbb, 3, 0, 4, 0, 0xcc, 0xdd};
static x5w_context fixture(int live)
{
    assert(!allocation && !owned_frames);
    sdk_live = sdk_isp_running = sdk_bound = live;
    old_frames = 2;
    allocs = frees = releases = sends = flushes = flow_starts = flow_stops = 0;
    node_starts = node_stops = bind_calls = unbind_calls = 0;
    auto_ae = auto_awb = corrupt_id = corrupt_time = malformed_alloc = corrupt_copy = 0;
    manual_change_after_send = manual_change_after_start = frame_bayer = 0;
    failure = NULL; failures_left = 0;
    memset(&submitted, 0, sizeof(submitted));
    x5w_context ctx = { .lock = PTHREAD_MUTEX_INITIALIZER, .isp = 102, .vin = 101,
        .flow = 103, .mem_open = 1, .isp_open = 1, .flow_open = 1,
        .running = live, .stop_required = live, .bound = live,
        .camera_cfg = {.width = 2, .height = 2},
        .isp_attr = {.input_mode = DDR_MODE},
        .isp_input = {.width = 2, .height = 2, .fmt = FRM_FMT_RAW, .bit_width = 10} };
    return ctx;
}
static int replay(x5w_context *ctx, x5w_frame_info *info)
{
    unsigned char out[12];
    return x5w_replay(ctx, raw, sizeof(raw), 2, 2, 10, 0, 6, out, sizeof(out), info);
}
static void completed(x5w_context *ctx, int live)
{
    assert(!ctx->replay_state && !allocation && !owned_frames);
    assert(ctx->running == live && sdk_live == live && ctx->bound == live && sdk_bound == live);
    pthread_mutex_destroy(&ctx->lock);
}

static void success_cases(void)
{
    for (int live = 0; live <= 1; ++live) {
        x5w_context ctx = fixture(live);
        x5w_frame_info info;
        assert(replay(&ctx, &info) == 0);
        assert(info.frame_id == submitted.info.frame_id && info.timestamp_ns > 0);
        assert(info.packing == X5W_NV12 && info.size_y == 8 && info.size_uv == 4);
        assert(allocs == 1 && frees == 1 && sends == 1 && releases == 3);
        assert(flow_stops == live && flow_starts == live);
        uint64_t first = info.frame_id;
        assert(replay(&ctx, &info) == 0 && info.frame_id > first);
        completed(&ctx, live);
    }
}
static void input_guards(void)
{
    x5w_context ctx = fixture(1);
    unsigned char out[12]; x5w_frame_info info;
    assert(x5w_replay(&ctx, raw, sizeof(raw) - 1, 2, 2, 10, 0, 6, out, 12, &info) == -EINVAL);
    assert(x5w_replay(&ctx, raw, sizeof(raw), 2, 2, 12, 0, 6, out, 12, &info) == -EINVAL);
    assert(x5w_replay(&ctx, raw, sizeof(raw), 2, 2, 10, 1, 6, out, 12, &info) == -EINVAL);
    unsigned char invalid[12]; memcpy(invalid, raw, 12); invalid[1] = 4;
    assert(x5w_replay(&ctx, invalid, 12, 2, 2, 10, 0, 6, out, 12, &info) == -EBADMSG);
    assert(x5w_replay(&ctx, raw, 12, 8192, 8192, 10, 0, 16384, out, 12, &info) == -EINVAL);
    ctx.isp_attr.input_mode = MCM_MODE;
    assert(replay(&ctx, &info) == X5W_UNSUPPORTED);
    ctx.isp_attr.input_mode = DDR_MODE;
    auto_ae = 1; assert(replay(&ctx, &info) == -EPERM); auto_ae = 0;
    auto_awb = 1; assert(replay(&ctx, &info) == -EPERM); auto_awb = 0;
    assert(!flow_stops && !node_starts && !allocs);
    completed(&ctx, 1);
    ctx = fixture(1); manual_change_after_start = 1;
    assert(replay(&ctx, &info) == -EPERM);
    assert(!allocs && !sends);
    completed(&ctx, 1);
}
static void operation_failures(void)
{
    const char *operations[] = {"bayer", "ae_get", "awb_get", "flow_stop", "unbind",
        "node_start", "drain", "alloc", "flush", "send", "get"};
    for (unsigned i = 0; i < sizeof(operations) / sizeof(operations[0]); ++i) {
        x5w_context ctx = fixture(1); x5w_frame_info info;
        failure = operations[i]; failures_left = 1;
        assert(replay(&ctx, &info) == -777);
        assert(info.frame_id == 0 && info.timestamp_ns == 0);
        assert(frees <= allocs);
        completed(&ctx, 1);
    }
    for (int mode = 0; mode < 5; ++mode) {
        x5w_context ctx = fixture(1); x5w_frame_info info;
        if (mode == 0) corrupt_id = 1;
        if (mode == 1) corrupt_time = 1;
        if (mode == 2) malformed_alloc = 1;
        if (mode == 3) corrupt_copy = 1;
        if (mode == 4) manual_change_after_send = 1;
        assert(replay(&ctx, &info) < 0);
        assert(info.frame_id == 0 && info.timestamp_ns == 0);
        assert(allocs == 1 && frees == 1);
        completed(&ctx, 1);
    }
}
static void cleanup_failures(void)
{
    const char *operations[] = {"release", "node_stop", "free", "bind", "flow_start"};
    for (unsigned i = 0; i < sizeof(operations) / sizeof(operations[0]); ++i) {
        x5w_context ctx = fixture(1); x5w_frame_info info;
        old_frames = 0;
        failure = operations[i]; failures_left = 1;
        assert(replay(&ctx, &info) == -777);
        assert(ctx.replay_state && info.frame_id == 0 && info.timestamp_ns == 0);
        int sent = sends;
        assert(replay(&ctx, &info) == -EBUSY && sends == sent);
        if (i < 3) assert(allocation);
        assert(x5w_replay_cleanup(&ctx) == 0);
        completed(&ctx, 1);
    }
    x5w_context ctx = fixture(1); x5w_frame_info info;
    failure = "node_stop"; failures_left = 1;
    assert(replay(&ctx, &info) == -777 && allocation);
    assert(x5w_replay_cleanup_locked(&ctx, 0) == 0);
    assert(flow_starts == 0);
    completed(&ctx, 0);
}
static void stale_queue_and_capacity(void)
{
    x5w_context ctx = fixture(1); x5w_frame_info info; unsigned char out[1];
    assert(x5w_replay(&ctx, raw, sizeof(raw), 2, 2, 10, 0, 6, out, 1, &info) == -ENOSPC);
    assert(frees == 1 && releases == 3 && !info.frame_id);
    completed(&ctx, 1);
    ctx = fixture(1); old_frames = 100;
    assert(replay(&ctx, &info) == -EBUSY);
    assert(releases == 64 && allocs == 0 && sends == 0);
    completed(&ctx, 1);
    ctx = fixture(1);
    uint32_t sequence = atomic_load(&x5w_replay_sequence);
    atomic_store(&x5w_replay_sequence, UINT32_MAX);
    assert(replay(&ctx, &info) == -EOVERFLOW);
    assert(replay(&ctx, &info) == -EOVERFLOW && sends == 0);
    assert(atomic_load(&x5w_replay_sequence) == UINT32_MAX);
    atomic_store(&x5w_replay_sequence, sequence);
    completed(&ctx, 1);
}
int main(void)
{
    success_cases(); input_guards(); operation_failures(); cleanup_failures();
    stale_queue_and_capacity();
    puts("X5 replay SDK shim: ownership, input/output identity and live restoration PASS (no hardware)");
    return 0;
}
