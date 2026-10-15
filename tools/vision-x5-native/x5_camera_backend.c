/* SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2024, D-Robotics. (VP lifecycle portions.)
 * The lifecycle follows D-Robotics x5-hobot-spdev's Apache-2.0 VP wrappers.
 * SDK types and sensor configs are included/linked from the operator's SDK,
 * never reproduced as guessed ctypes layouts or sensor register sequences.
 */
#include "x5_camera_backend.h"

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hbn_api.h"
#include "hbn_isp_api.h"
#include "hb_camera_interface.h"
#include "hb_mem_mgr.h"
#include "vp_sensors.h"

#define X5W_UNSUPPORTED (-95)
#define X5W_MAGIC UINT32_C(0x58355731)

/* Upstream exported symbols contain "3480"; their actual width is 3840. */
extern vp_sensor_config_t imx415_linear_3480x2160_raw10_30fps_2lane;
extern vp_sensor_config_t imx415_linear_3480x2160_raw10_30fps_4lane;

typedef struct x5w_context {
    uint32_t magic;
    pthread_mutex_t lock;
    camera_config_t camera_cfg;
    mipi_config_t mipi_cfg;
    vin_node_attr_t vin_attr;
    vin_ichn_attr_t vin_input;
    vin_ochn_attr_t vin_output;
    vin_attr_ex_t vin_extra;
    isp_attr_t isp_attr;
    isp_ichn_attr_t isp_input;
    isp_ochn_attr_t isp_output;
    camera_handle_t camera;
    hbn_vnode_handle_t vin, isp;
    hbn_vflow_handle_t flow;
    int mem_open, camera_open, vin_open, isp_open, flow_open;
    int vin_added, isp_added, attached, bound, running, stop_required;
    double awb_min, awb_max;
    int awb_limits_set;
    hbn_isp_param_range_t ae_exposure_limits, ae_gain_limits;
    int ae_limits_valid;
    void *replay_state;
} x5w_context;

static int x5w_replay_cleanup_locked(x5w_context *ctx, int restore_live);
int x5w_extended_control_get(void *ctx, int key, double *value, double *low, double *high, double *step, int *writable, int *active);
int x5w_extended_control_set(void *ctx, int key, double value);

static pthread_mutex_t memory_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned memory_users;

_Static_assert(sizeof(x5w_frame_info) == 56, "ctypes ABI frame size");
_Static_assert(offsetof(x5w_frame_info, timestamp_ns) == 40, "ctypes ABI timestamp");

static x5w_context *context(void *opaque)
{
    x5w_context *ctx = opaque;
    return ctx && ctx->magic == X5W_MAGIC ? ctx : NULL;
}

static const vp_sensor_config_t *selected_config(const char *name)
{
    if (!name) return NULL;
    if (strcmp(name, "imx415-30fps-2lane") == 0)
        return &imx415_linear_3480x2160_raw10_30fps_2lane;
    if (strcmp(name, "imx415-30fps-4lane") == 0)
        return &imx415_linear_3480x2160_raw10_30fps_4lane;
    return NULL;
}

uint32_t x5w_abi_version(void) { return 2; }

int x5w_config_supported(const char *name, int port)
{
    return selected_config(name) && (port == 0 || port == 2) ? 0 : X5W_UNSUPPORTED;
}

static int memory_open(x5w_context *ctx)
{
    int ret = 0;
    pthread_mutex_lock(&memory_lock);
    if (memory_users == 0) ret = hb_mem_module_open();
    if (ret == 0) { ++memory_users; ctx->mem_open = 1; }
    pthread_mutex_unlock(&memory_lock);
    return ret;
}

static int memory_close(x5w_context *ctx)
{
    int ret = 0;
    if (!ctx->mem_open) return 0;
    pthread_mutex_lock(&memory_lock);
    if (memory_users == 1) ret = hb_mem_module_close();
    if (ret == 0) { --memory_users; ctx->mem_open = 0; }
    pthread_mutex_unlock(&memory_lock);
    return ret;
}

/* The official VP wrapper omits MCLK attributes for an external oscillator.
 * Read just the chosen host's device-tree property; no GPIO/I2C/clock scanning. */
static int host_has_mclk(int port)
{
    const char *suffix = port == 0 ? "3d060000" : "3d080000";
    char path[160];
    unsigned char phandle[4];
    snprintf(path, sizeof(path), "/proc/device-tree/soc/cam/mipi_host@%s/pinctrl-0", suffix);
    FILE *file = fopen(path, "rb");
    if (!file) return 0;
    size_t count = fread(phandle, 1, sizeof(phandle), file);
    fclose(file);
    return count == sizeof(phandle) &&
        (phandle[0] || phandle[1] || phandle[2] || phandle[3]);
}

static int sdk_stage_result(const char *stage, int ret)
{
    if (ret != 0) fprintf(stderr, "vision-x5-native: %s failed: %d\n", stage, ret);
    return ret;
}

static int stop_locked(x5w_context *ctx)
{
    int ret;
    if (ctx->replay_state) {
        ret = x5w_replay_cleanup_locked(ctx, 0);
        if (ret != 0) return ret;
    }
    if (ctx->stop_required) {
        ret = sdk_stage_result("hbn_vflow_stop", hbn_vflow_stop(ctx->flow));
        if (ret != 0) return ret;
        ctx->stop_required = 0;
        ctx->running = 0;
    }
    if (ctx->bound) {
        ret = sdk_stage_result("hbn_vflow_unbind_vnode",
            hbn_vflow_unbind_vnode(ctx->flow, ctx->vin, 0, ctx->isp, 0));
        if (ret != 0) return ret;
        ctx->bound = 0;
    }
    if (ctx->attached) {
        ret = sdk_stage_result("hbn_camera_detach_from_vin",
            hbn_camera_detach_from_vin(ctx->camera));
        if (ret != 0) return ret;
        ctx->attached = 0;
    }
    return 0;
}

static int destroy_locked(x5w_context *ctx)
{
    int ret = stop_locked(ctx);
    if (ret != 0) return ret;
    /* SDK destroy/close return void. Flow destroy closes its added vnodes. */
    if (ctx->flow_open) {
        hbn_vflow_destroy(ctx->flow);
        ctx->flow_open = 0;
        if (ctx->vin_added) ctx->vin_open = 0;
        if (ctx->isp_added) ctx->isp_open = 0;
        ctx->vin_added = ctx->isp_added = 0;
    }
    if (ctx->isp_open) { hbn_vnode_close(ctx->isp); ctx->isp_open = 0; }
    if (ctx->vin_open) { hbn_vnode_close(ctx->vin); ctx->vin_open = 0; }
    if (ctx->camera_open) {
        ret = hbn_camera_destroy(ctx->camera);
        if (ret != 0) return ret;
        ctx->camera_open = 0;
    }
    return memory_close(ctx);
}

static int clone_config(x5w_context *ctx, const vp_sensor_config_t *cfg, int port)
{
    if (!cfg->camera_config || !cfg->camera_config->mipi_cfg ||
        !cfg->vin_node_attr || !cfg->vin_ichn_attr || !cfg->vin_ochn_attr ||
        !cfg->isp_attr || !cfg->isp_ichn_attr || !cfg->isp_ochn_attr)
        return X5W_UNSUPPORTED;
    ctx->camera_cfg = *cfg->camera_config;
    ctx->mipi_cfg = *cfg->camera_config->mipi_cfg;
    ctx->camera_cfg.mipi_cfg = &ctx->mipi_cfg;
    ctx->vin_attr = *cfg->vin_node_attr;
    ctx->vin_input = *cfg->vin_ichn_attr;
    ctx->vin_output = *cfg->vin_ochn_attr;
    if (cfg->vin_attr_ex) ctx->vin_extra = *cfg->vin_attr_ex;
    ctx->isp_attr = *cfg->isp_attr;
    ctx->isp_input = *cfg->isp_ichn_attr;
    ctx->isp_output = *cfg->isp_ochn_attr;
    /* Limit the ABI to the two reviewed linear RAW10 configurations. */
    if (ctx->camera_cfg.addr != 0x1a || ctx->camera_cfg.width != 3840 ||
        ctx->camera_cfg.height != 2160 || ctx->camera_cfg.fps != 30 ||
        ctx->camera_cfg.format != 0x2b || ctx->isp_input.bit_width != 10 ||
        ctx->isp_input.fmt != FRM_FMT_RAW || ctx->isp_output.fmt != FRM_FMT_NV12 ||
        ctx->isp_output.bit_width != 8 || ctx->vin_output.vin_basic_attr.pack_mode != 0)
        return X5W_UNSUPPORTED;
    /* phy is the DPHY/CPHY protocol type (0/1), not a CSI host index.
     * Preserve the reviewed profile; only VIN selects host 0 or 2. */
    ctx->vin_attr.cim_attr.mipi_rx = port;
    ctx->vin_attr.cim_attr.cim_isp_flyby = 0;
    ctx->vin_attr.cim_attr.func.enable_frame_id = 1;
    ctx->vin_attr.cim_attr.func.time_stamp_en = 1;
    ctx->vin_attr.cim_attr.func.time_stamp_mode = TS_IPI_VSYNC;
    ctx->vin_attr.cim_attr.func.ts_src = 1;
    ctx->vin_output.ddr_en = 1;
    ctx->isp_attr.input_mode = DDR_MODE;
    ctx->isp_output.ddr_en = 1;
    if (!host_has_mclk(port)) ctx->vin_extra.vin_attr_ex_mask = 0;
    return 0;
}

int x5w_open(const char *name, int port, void **out)
{
    if (!out) return -EINVAL;
    *out = NULL;
    int ret = x5w_config_supported(name, port);
    if (ret != 0) return ret;
    x5w_context *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) return -ENOMEM;
    ctx->magic = X5W_MAGIC;
    ret = pthread_mutex_init(&ctx->lock, NULL);
    if (ret != 0) { free(ctx); return -ret; }
    ret = clone_config(ctx, selected_config(name), port);
    if (ret != 0) goto failure;
    ret = memory_open(ctx);
    if (ret != 0) goto failure;
    ret = hbn_camera_create(&ctx->camera_cfg, &ctx->camera);
    if (ret != 0) goto failure;
    ctx->camera_open = 1;
    ret = hbn_vnode_open(HB_VIN, port, AUTO_ALLOC_ID, &ctx->vin);
    if (ret != 0) goto failure;
    ctx->vin_open = 1;
    ret = hbn_vnode_set_attr(ctx->vin, &ctx->vin_attr);
    if (ret != 0) goto failure;
    ret = hbn_vnode_set_ichn_attr(ctx->vin, 0, &ctx->vin_input);
    if (ret != 0) goto failure;
    ret = hbn_vnode_set_ochn_attr(ctx->vin, 0, &ctx->vin_output);
    if (ret != 0) goto failure;
    for (unsigned i = 0; i < VIN_ATTR_EX_INVALID; ++i) {
        if (!(ctx->vin_extra.vin_attr_ex_mask & (UINT64_C(1) << i))) continue;
        ctx->vin_extra.ex_attr_type = i;
        ret = hbn_vnode_set_attr_ex(ctx->vin, &ctx->vin_extra);
        if (ret != 0) goto failure;
    }
    hbn_buf_alloc_attr_t alloc = {0};
    alloc.buffers_num = 6;
    alloc.is_contig = 1;
    alloc.flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
        HB_MEM_USAGE_CACHED | HB_MEM_USAGE_HW_CIM | HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF;
    ret = hbn_vnode_set_ochn_buf_attr(ctx->vin, 0, &alloc);
    if (ret != 0) goto failure;
    ret = hbn_vnode_open(HB_ISP, 0, AUTO_ALLOC_ID, &ctx->isp);
    if (ret != 0) goto failure;
    ctx->isp_open = 1;
    ret = hbn_vnode_set_attr(ctx->isp, &ctx->isp_attr);
    if (ret != 0) goto failure;
    ret = hbn_vnode_set_ichn_attr(ctx->isp, 0, &ctx->isp_input);
    if (ret != 0) goto failure;
    ret = hbn_vnode_set_ochn_attr(ctx->isp, 0, &ctx->isp_output);
    if (ret != 0) goto failure;
    alloc.flags = HB_MEM_USAGE_CPU_READ_OFTEN | HB_MEM_USAGE_CPU_WRITE_OFTEN |
        HB_MEM_USAGE_CACHED | HB_MEM_USAGE_HW_ISP | HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF;
    ret = hbn_vnode_set_ochn_buf_attr(ctx->isp, 0, &alloc);
    if (ret != 0) goto failure;
    ret = hbn_vflow_create(&ctx->flow);
    if (ret != 0) goto failure;
    ctx->flow_open = 1;
    ret = hbn_vflow_add_vnode(ctx->flow, ctx->vin);
    if (ret != 0) goto failure;
    ctx->vin_added = 1;
    ret = hbn_vflow_add_vnode(ctx->flow, ctx->isp);
    if (ret != 0) goto failure;
    ctx->isp_added = 1;
    *out = ctx;
    return 0;
failure:
    if (destroy_locked(ctx) != 0) { *out = ctx; return ret; }
    pthread_mutex_destroy(&ctx->lock);
    free(ctx);
    return ret;
}

int x5w_start(void *opaque)
{
    x5w_context *ctx = context(opaque);
    if (!ctx) return -EINVAL;
    pthread_mutex_lock(&ctx->lock);
    int ret = 0;
    if (ctx->replay_state) { ret = -EBUSY; goto done; }
    if (ctx->running) goto done;
    if (!ctx->flow_open || ctx->stop_required) { ret = -EBUSY; goto done; }
    if (!ctx->attached) {
        ret = sdk_stage_result("hbn_camera_attach_to_vin",
            hbn_camera_attach_to_vin(ctx->camera, ctx->vin));
        if (ret != 0) goto done;
        ctx->attached = 1;
    }
    if (!ctx->bound) {
        ret = sdk_stage_result("hbn_vflow_bind_vnode",
            hbn_vflow_bind_vnode(ctx->flow, ctx->vin, 0, ctx->isp, 0));
        if (ret != 0) goto done;
        ctx->bound = 1;
    }
    /* A failed start can have partial hardware effects: require stop before retry. */
    ctx->stop_required = 1;
    ret = sdk_stage_result("hbn_vflow_start", hbn_vflow_start(ctx->flow));
    if (ret == 0) ctx->running = 1;
done:
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

int x5w_stop(void *opaque)
{
    x5w_context *ctx = context(opaque);
    if (!ctx) return -EINVAL;
    pthread_mutex_lock(&ctx->lock);
    int ret = stop_locked(ctx);
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

int x5w_close(void *opaque)
{
    x5w_context *ctx = context(opaque);
    if (!ctx) return -EINVAL;
    pthread_mutex_lock(&ctx->lock);
    int ret = destroy_locked(ctx);
    if (ret == 0) ctx->magic = 0;
    pthread_mutex_unlock(&ctx->lock);
    if (ret == 0) { pthread_mutex_destroy(&ctx->lock); free(ctx); }
    return ret;
}

static int bayer_get(x5w_context *ctx, uint32_t *out)
{
    cam_parameter_t parameter = {0};
    int ret = hbn_camera_get_sns_info(ctx->camera, CAMERA_SENSOR_PARAM, &parameter);
    if (ret != 0) return X5W_UNSUPPORTED;
    const char *pattern = parameter.sns_param.bayer_pattern;
    const char *known[] = {"RGGB", "BGGR", "GRBG", "GBRG"};
    for (uint32_t i = 0; i < 4; ++i)
        if (memcmp(pattern, known[i], 4) == 0 && pattern[4] == '\0') {
            *out = i;
            return 0;
        }
    return X5W_UNSUPPORTED;
}

static int raw_alignment(const hb_mem_graphic_buf_t *buf, uint32_t *out)
{
    int right = 1, left = 1;
    for (int y = 0; y < buf->height; ++y) {
        const unsigned char *row = buf->virt_addr[0] + (size_t)y * buf->stride;
        for (int x = 0; x < buf->width; ++x) {
            /* Reviewed configs write unpacked RAW10 to 16-bit LE DDR samples. */
            unsigned sample = row[2 * x] | ((unsigned)row[2 * x + 1] << 8);
            if (sample > 1023) right = 0;
            if (sample & 63) left = 0;
            if (!right && !left) return -EBADMSG;
        }
    }
    if (right == left) return X5W_UNSUPPORTED; /* All-black/ambiguous: no guess. */
    *out = right ? X5W_RIGHT : X5W_LEFT;
    return 0;
}

static int copy_frame_stage(x5w_context *ctx, int raw, const hbn_vnode_image_t *frame,
                       unsigned char *dst, size_t cap, x5w_frame_info *info,
                       const char **failed_stage)
{
    *failed_stage = "copy";
    const hb_mem_graphic_buf_t *buf = &frame->buffer;
    if (buf->width <= 0 || buf->height <= 0 || buf->stride <= 0 ||
        buf->width != (int)ctx->camera_cfg.width || buf->height != (int)ctx->camera_cfg.height)
        return -EBADMSG;
    size_t sy = (size_t)buf->stride * buf->height;
    size_t suv = raw ? 0 : sy / 2;
    if (sy > UINT32_MAX || suv > UINT32_MAX || sy > cap || suv > cap - sy)
        return -ENOSPC;
    if (!buf->virt_addr[0] || buf->size[0] < sy) return -EBADMSG;
    if (raw) {
        if (buf->format != MEM_PIX_FMT_RAW10 || buf->plane_cnt != 1 ||
            buf->stride < buf->width * 2) return X5W_UNSUPPORTED;
    } else {
        /* Require explicit SDK Y/UV planes. Do not infer a hidden UV address. */
        if (buf->format != MEM_PIX_FMT_NV12 || buf->plane_cnt != 2 ||
            (buf->width & 1) || (buf->height & 1) || buf->stride < buf->width ||
            !buf->virt_addr[1] || buf->size[1] < suv) return X5W_UNSUPPORTED;
    }
    *failed_stage = "cache_y";
    int ret = hb_mem_invalidate_buf_with_vaddr((uint64_t)(uintptr_t)buf->virt_addr[0], sy);
    if (ret != 0) return ret;
    if (raw) {
        *failed_stage = "bayer";
        ret = bayer_get(ctx, &info->bayer);
        if (ret != 0) return ret;
        *failed_stage = "raw_alignment";
        ret = raw_alignment(buf, &info->alignment);
        if (ret != 0) return ret;
    } else {
        *failed_stage = "cache_uv";
        ret = hb_mem_invalidate_buf_with_vaddr((uint64_t)(uintptr_t)buf->virt_addr[1], suv);
        if (ret != 0) return ret;
    }
    memcpy(dst, buf->virt_addr[0], sy);
    if (suv) memcpy(dst + sy, buf->virt_addr[1], suv);
    info->width = buf->width;
    info->height = buf->height;
    info->stride_y = buf->stride;
    info->stride_uv = raw ? 0 : buf->stride;
    info->size_y = (uint32_t)sy;
    info->size_uv = (uint32_t)suv;
    info->bit_depth = raw ? 10 : 8;
    info->packing = raw ? X5W_RAW16 : X5W_NV12;
    info->frame_id = frame->info.frame_id;
    /* timeval units are specified by the SDK type. Zero means unavailable;
     * never substitute host receipt time for a sensor/hardware timestamp. */
    if (frame->info.tv.tv_sec >= 0 && frame->info.tv.tv_usec >= 0 &&
        frame->info.tv.tv_usec < 1000000 &&
        (uint64_t)frame->info.tv.tv_sec <= (UINT64_MAX - UINT64_C(999999000)) / UINT64_C(1000000000))
        info->timestamp_ns = (uint64_t)frame->info.tv.tv_sec * UINT64_C(1000000000) +
            (uint64_t)frame->info.tv.tv_usec * UINT64_C(1000);
    return 0;
}

static int copy_frame(x5w_context *ctx, int raw, const hbn_vnode_image_t *frame,
                       unsigned char *dst, size_t cap, x5w_frame_info *info)
{
    const char *failed_stage = "copy";
    return copy_frame_stage(ctx, raw, frame, dst, cap, info, &failed_stage);
}

static void frame_failure(const char *stage, int code, int raw)
{
    /* Diagnostic metadata only; never log frame bytes, addresses or handles. */
    int saved_errno = errno;
    fprintf(stderr, "x5w_frame_failed stage=%s code=%d raw=%d\n", stage, code, raw);
    errno = saved_errno;
}

int x5w_frame(void *opaque, int raw, unsigned char *buffer, size_t cap, x5w_frame_info *info)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !buffer || !info || (raw != 0 && raw != 1)) return -EINVAL;
    memset(info, 0, sizeof(*info));
    pthread_mutex_lock(&ctx->lock);
    int ret = -EPIPE;
    if (!ctx->running) goto done;
    hbn_vnode_handle_t node = raw ? ctx->vin : ctx->isp;
    hbn_vnode_image_t frame = {0};
    ret = raw ? hbn_vnode_getframe_cond(node, 0, 2000, 0, &frame) :
                hbn_vnode_getframe(node, 0, 2000, &frame);
    if (ret != 0) {
        frame_failure("get", ret, raw);
        goto done;
    }
    const char *failed_stage = "copy";
    ret = copy_frame_stage(ctx, raw, &frame, buffer, cap, info, &failed_stage);
    if (ret != 0) frame_failure(failed_stage, ret, raw);
    /* Release every successful SDK acquisition, including invalid layouts,
     * short output buffers, cache failures and unsupported metadata. */
    int release_ret = hbn_vnode_releaseframe(node, 0, &frame);
    if (release_ret != 0) {
        frame_failure("release", release_ret, raw);
        ret = release_ret;
    }
    if (ret != 0) memset(info, 0, sizeof(*info));
done:
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

static float *cproc_field(hbn_isp_cproc_attr_t *attr, int key)
{
    switch (key) {
    case X5W_BRIGHTNESS: return &attr->manual_attr.bright;
    case X5W_CONTRAST: return &attr->manual_attr.contrast;
    case X5W_SATURATION: return &attr->manual_attr.saturation;
    case X5W_HUE: return &attr->manual_attr.hue;
    default: return NULL;
    }
}

static void cproc_limits(int key, double *low, double *high)
{
    if (key == X5W_BRIGHTNESS) { *low = -127; *high = 127; }
    else if (key == X5W_HUE) { *low = -90; *high = 90; }
    else { *low = 0; *high = (double)1.999f; }
}

int x5w_control_get(void *opaque, int key, double *value, double *low, double *high,
                     double *step, int *writable, int *active)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !value || !low || !high || !step || !writable || !active) return -EINVAL;
    if (key >= X5W_AUTO_EXPOSURE && key < X5W_BRIGHTNESS) return x5w_extended_control_get(ctx, key, value, low, high, step, writable, active);
    if (key < X5W_BRIGHTNESS || key > X5W_HUE) return X5W_UNSUPPORTED;
    pthread_mutex_lock(&ctx->lock);
    hbn_isp_cproc_attr_t attr = {0};
    int ret = ctx->isp_open ? hbn_isp_get_cproc_attr(ctx->isp, &attr) : -ENODEV;
    if (ret == 0) {
        float current = *cproc_field(&attr, key);
        cproc_limits(key, low, high);
        if (!isfinite(current) || current < *low || current > *high ||
            (attr.mode != HBN_ISP_MODE_AUTO && attr.mode != HBN_ISP_MODE_MANUAL))
            ret = X5W_UNSUPPORTED;
        else {
            *value = (double)current; /* Actual f32 getter; never round/echo inputs. */
            *step = 0; /* Continuous SDK float, no invented quantization step. */
            *active = attr.mode == HBN_ISP_MODE_MANUAL;
            *writable = *active;
        }
    }
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

int x5w_control_set(void *opaque, int key, double value)
{
    x5w_context *ctx = context(opaque);
    if (!ctx) return -EINVAL;
    if (key >= X5W_AUTO_EXPOSURE && key < X5W_BRIGHTNESS) return x5w_extended_control_set(ctx, key, value);
    if (key < X5W_BRIGHTNESS || key > X5W_HUE) return X5W_UNSUPPORTED;
    double low, high;
    cproc_limits(key, &low, &high);
    if (!isfinite(value) || value < low || value > high) return -ERANGE;
    pthread_mutex_lock(&ctx->lock);
    hbn_isp_cproc_attr_t attr = {0};
    int ret = ctx->replay_state ? -EBUSY : ctx->isp_open ? hbn_isp_get_cproc_attr(ctx->isp, &attr) : -ENODEV;
    if (ret != 0) goto done;
    if (attr.mode != HBN_ISP_MODE_MANUAL) { ret = X5W_UNSUPPORTED; goto done; }
    /* Getter-modify-set retains the module mode and every unselected field. */
    *cproc_field(&attr, key) = (float)value;
    ret = hbn_isp_set_cproc_attr(ctx->isp, &attr);
    if (ret != 0) goto done;
    hbn_isp_cproc_attr_t actual = {0};
    ret = hbn_isp_get_cproc_attr(ctx->isp, &actual);
    if (ret == 0 && (actual.mode != attr.mode ||
        actual.manual_attr.bright != attr.manual_attr.bright ||
        actual.manual_attr.contrast != attr.manual_attr.contrast ||
        actual.manual_attr.saturation != attr.manual_attr.saturation ||
        actual.manual_attr.hue != attr.manual_attr.hue)) ret = -EIO;
done:
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

#include "x5_isp_modules.inc.c"
#include "x5_isp_replay.inc.c"
