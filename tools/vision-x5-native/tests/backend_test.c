/* SPDX-License-Identifier: Apache-2.0
 * Isolated SDK-call replacements for CPU unit tests. This executable is not a
 * board adapter and is never used by the daemon or registered in the platform.
 * Compile against the real public SDK headers and reviewed VP config sources.
 */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "../x5_camera_backend.c"

static int frame_gets, frame_releases, invalidate_calls, cproc_sets;
static int flow_starts, flow_stops, flow_destroys, node_closes, camera_destroys;
static int memory_opens, memory_closes, binds, unbinds, attaches, detaches;
static const char *fail_name;
static int fail_code, fail_remaining;
static const char *second_fail_name;
static int second_fail_code, second_fail_remaining;
static int corrupt_readback;
static hbn_vnode_image_t sdk_frame;
static hbn_isp_cproc_attr_t sdk_cproc;
static const char *sdk_bayer = "GBRG";
static unsigned observed_phy, observed_vin_host;

static int maybe_fail(const char *name)
{
    if (fail_name && strcmp(name, fail_name) == 0 && fail_remaining > 0) {
        --fail_remaining;
        return fail_code;
    }
    if (second_fail_name && strcmp(name, second_fail_name) == 0 && second_fail_remaining > 0) {
        --second_fail_remaining;
        return second_fail_code;
    }
    return 0;
}

static void reset(void)
{
    assert(memory_users == 0);
    frame_gets = frame_releases = invalidate_calls = cproc_sets = 0;
    flow_starts = flow_stops = flow_destroys = node_closes = camera_destroys = 0;
    memory_opens = memory_closes = binds = unbinds = attaches = detaches = 0;
    fail_name = NULL;
    fail_code = fail_remaining = corrupt_readback = 0;
    second_fail_name = NULL;
    second_fail_code = second_fail_remaining = 0;
    sdk_bayer = "GBRG";
    observed_phy = observed_vin_host = UINT32_MAX;
    memset(&sdk_frame, 0, sizeof(sdk_frame));
    memset(&sdk_cproc, 0, sizeof(sdk_cproc));
    sdk_cproc.mode = HBN_ISP_MODE_MANUAL;
    sdk_cproc.manual_attr.contrast = 1.0f;
    sdk_cproc.manual_attr.saturation = 1.0f;
}

static void fail(const char *name, int code)
{
    fail_name = name;
    fail_code = code;
    fail_remaining = 1;
}

int32_t hb_mem_module_open(void) { ++memory_opens; return maybe_fail("memory_open"); }
int32_t hb_mem_module_close(void) { ++memory_closes; return maybe_fail("memory_close"); }
int32_t hb_mem_invalidate_buf_with_vaddr(uint64_t address, uint64_t size)
{
    assert(address && size);
    ++invalidate_calls;
    if (address == (uint64_t)(uintptr_t)sdk_frame.buffer.virt_addr[1]) {
        int ret = maybe_fail("invalidate_uv");
        if (ret) return ret;
    }
    return maybe_fail("invalidate");
}
int32_t hbn_camera_create(camera_config_t *cfg, camera_handle_t *out)
{
    assert(cfg->addr == 0x1a && cfg->width == 3840 && cfg->height == 2160);
    observed_phy = cfg->mipi_cfg->rx_attr.phy;
    assert(observed_phy <= 1); /* Protocol type, never CSI host 2. */
    int ret = maybe_fail("camera_create");
    if (!ret) *out = 201;
    return ret;
}
int32_t hbn_camera_destroy(camera_handle_t camera)
{
    assert(camera == 201); ++camera_destroys;
    return maybe_fail("camera_destroy");
}
int32_t hbn_camera_attach_to_vin(camera_handle_t camera, vpf_handle_t vin)
{
    assert(camera == 201 && vin == 101); ++attaches;
    return maybe_fail("attach");
}
int32_t hbn_camera_detach_from_vin(camera_handle_t camera)
{
    assert(camera == 201); ++detaches;
    return maybe_fail("detach");
}
int32_t hbn_camera_get_sns_info(camera_handle_t camera, camera_param_type_t type,
                               cam_parameter_t *out)
{
    assert(camera == 201 && type == CAMERA_SENSOR_PARAM);
    int ret = maybe_fail("bayer_get");
    if (!ret) snprintf(out->sns_param.bayer_pattern, LEN_PATTERN_STR, "%s", sdk_bayer);
    return ret;
}
hobot_status hbn_vnode_open(hb_vnode_type type, uint32_t hardware, int32_t id,
                           hbn_vnode_handle_t *out)
{
    assert(id == AUTO_ALLOC_ID);
    assert(type == HB_VIN || type == HB_ISP);
    if (type == HB_ISP) assert(hardware == 0);
    int ret = maybe_fail(type == HB_VIN ? "vin_open" : "isp_open");
    if (!ret) *out = type == HB_VIN ? 101 : 102;
    return ret;
}
void hbn_vnode_close(hbn_vnode_handle_t node)
{
    assert(node == 101 || node == 102); ++node_closes;
}
hobot_status hbn_vnode_set_attr(hbn_vnode_handle_t node, void *attr)
{
    if (node == 101) {
        observed_vin_host = ((vin_node_attr_t *)attr)->cim_attr.mipi_rx;
        assert(((vin_node_attr_t *)attr)->cim_attr.cim_isp_flyby == 0);
    }
    else assert(node == 102 && ((isp_attr_t *)attr)->input_mode == DDR_MODE);
    return maybe_fail(node == 101 ? "vin_attr" : "isp_attr");
}
hobot_status hbn_vnode_set_attr_ex(hbn_vnode_handle_t node, void *attr)
{
    assert(node == 101 && attr);
    return maybe_fail("extra_attr");
}
hobot_status hbn_vnode_set_ichn_attr(hbn_vnode_handle_t node, uint32_t channel, void *attr)
{
    assert((node == 101 || node == 102) && channel == 0 && attr);
    return maybe_fail("input_attr");
}
hobot_status hbn_vnode_set_ochn_attr(hbn_vnode_handle_t node, uint32_t channel, void *attr)
{
    assert((node == 101 || node == 102) && channel == 0 && attr);
    return maybe_fail("output_attr");
}
hobot_status hbn_vnode_set_ochn_buf_attr(hbn_vnode_handle_t node, uint32_t channel,
                                       hbn_buf_alloc_attr_t *attr)
{
    assert((node == 101 || node == 102) && channel == 0 && attr->buffers_num == 6);
    return maybe_fail("buffer_attr");
}
hobot_status hbn_vflow_create(hbn_vflow_handle_t *out)
{
    int ret = maybe_fail("flow_create");
    if (!ret) *out = 301;
    return ret;
}
void hbn_vflow_destroy(hbn_vflow_handle_t flow) { assert(flow == 301); ++flow_destroys; }
hobot_status hbn_vflow_add_vnode(hbn_vflow_handle_t flow, hbn_vnode_handle_t node)
{
    assert(flow == 301 && (node == 101 || node == 102));
    return maybe_fail(node == 101 ? "add_vin" : "add_isp");
}
hobot_status hbn_vflow_bind_vnode(hbn_vflow_handle_t flow, hbn_vnode_handle_t source,
                                 uint32_t output, hbn_vnode_handle_t destination, uint32_t input)
{
    assert(flow == 301 && source == 101 && destination == 102 && !output && !input);
    ++binds; return maybe_fail("bind");
}
hobot_status hbn_vflow_unbind_vnode(hbn_vflow_handle_t flow, hbn_vnode_handle_t source,
                                   uint32_t output, hbn_vnode_handle_t destination, uint32_t input)
{
    assert(flow == 301 && source == 101 && destination == 102 && !output && !input);
    ++unbinds; return maybe_fail("unbind");
}
hobot_status hbn_vflow_start(hbn_vflow_handle_t flow)
{
    assert(flow == 301); ++flow_starts; return maybe_fail("start");
}
hobot_status hbn_vflow_stop(hbn_vflow_handle_t flow)
{
    assert(flow == 301); ++flow_stops; return maybe_fail("stop");
}
hobot_status hbn_vnode_getframe(hbn_vnode_handle_t node, uint32_t channel,
                               uint32_t timeout, hbn_vnode_image_t *out)
{
    assert((node == 101 || node == 102) && !channel && timeout == 2000);
    ++frame_gets;
    int ret = maybe_fail("frame_get");
    if (!ret) *out = sdk_frame;
    return ret;
}
hobot_status hbn_vnode_getframe_cond(hbn_vnode_handle_t node, uint32_t channel,
                                    uint32_t timeout, int32_t condition, hbn_vnode_image_t *out)
{
    assert(node == 101 && condition == 0);
    return hbn_vnode_getframe(node, channel, timeout, out);
}
hobot_status hbn_vnode_releaseframe(hbn_vnode_handle_t node, uint32_t channel,
                                   hbn_vnode_image_t *frame)
{
    assert((node == 101 || node == 102) && !channel && frame);
    ++frame_releases; return maybe_fail("frame_release");
}
int32_t hbn_isp_get_cproc_attr(hbn_vnode_handle_t node, hbn_isp_cproc_attr_t *out)
{
    assert(node == 102);
    int ret = maybe_fail("cproc_get");
    if (!ret) {
        *out = sdk_cproc;
        if (corrupt_readback && cproc_sets) out->manual_attr.hue += 1;
    }
    return ret;
}
int32_t hbn_isp_set_cproc_attr(hbn_vnode_handle_t node, hbn_isp_cproc_attr_t *attr)
{
    assert(node == 102);
    ++cproc_sets;
    int ret = maybe_fail("cproc_set");
    if (!ret) sdk_cproc = *attr;
    return ret;
}

static void *opened(int port)
{
    void *ctx = NULL;
    assert(x5w_open("imx415-30fps-2lane", port, &ctx) == 0 && ctx);
    return ctx;
}

static void test_lifecycle(void)
{
    reset();
    assert(x5w_abi_version() == 2 && sizeof(x5w_frame_info) == 56);
    assert(x5w_config_supported("imx415-30fps-2lane", 0) == 0);
    assert(x5w_config_supported("imx415-30fps-4lane", 2) == 0);
    assert(x5w_config_supported("imx415-30fps-2lane", 1) == -95);
    assert(x5w_config_supported("unknown", 0) == -95 && memory_opens == 0);
    const vp_sensor_config_t *profile = selected_config("imx415-30fps-2lane");
    unsigned profile_phy = profile->camera_config->mipi_cfg->rx_attr.phy;
    unsigned profile_flyby = profile->vin_node_attr->cim_attr.cim_isp_flyby;
    void *ctx = opened(2);
    /* SDK profile defaults vary; the session must leave the actual shared
     * configuration unchanged while using its private offline-ISP copy. */
    assert(profile->camera_config->mipi_cfg->rx_attr.phy == profile_phy);
    assert(profile->vin_node_attr->cim_attr.cim_isp_flyby == profile_flyby);
    assert(x5w_start(ctx) == 0 && x5w_start(ctx) == 0 && flow_starts == 1);
    assert(x5w_stop(ctx) == 0 && x5w_stop(ctx) == 0 && flow_stops == 1);
    assert(unbinds == 1 && detaches == 1);
    assert(x5w_start(ctx) == 0 && flow_starts == 2);
    assert(x5w_close(ctx) == 0 && flow_stops == 2 && flow_destroys == 1);
    assert(camera_destroys == 1 && memory_closes == 1 && node_closes == 0);
    assert(profile->camera_config->mipi_cfg->rx_attr.phy == profile_phy);
    assert(profile->vin_node_attr->cim_attr.cim_isp_flyby == profile_flyby);
}

static void test_csi_host_preserves_phy(void)
{
    const char *profiles[] = {"imx415-30fps-2lane", "imx415-30fps-4lane"};
    const int ports[] = {0, 2};
    for (size_t p = 0; p < 2; ++p) {
        const vp_sensor_config_t *profile = selected_config(profiles[p]);
        unsigned profile_phy = profile->camera_config->mipi_cfg->rx_attr.phy;
        unsigned profile_host = profile->vin_node_attr->cim_attr.mipi_rx;
        for (size_t i = 0; i < 2; ++i) {
            reset();
            void *opaque = NULL;
            assert(x5w_open(profiles[p], ports[i], &opaque) == 0 && opaque);
            /* Verify arguments delivered to separate real SDK API boundaries,
             * not just the unchanged shared profile's source value. */
            assert(observed_phy == profile_phy);
            assert(observed_vin_host == (unsigned)ports[i]);
            assert(profile->camera_config->mipi_cfg->rx_attr.phy == profile_phy);
            assert(profile->vin_node_attr->cim_attr.mipi_rx == profile_host);
            assert(x5w_close(opaque) == 0);
        }
    }
}

static void test_cleanup_failures(void)
{
    reset();
    void *ctx = opened(0);
    fail("start", 401);
    assert(x5w_start(ctx) == 401);
    assert(x5w_start(ctx) == -EBUSY);
    assert(x5w_stop(ctx) == 0 && flow_stops == 1);
    assert(x5w_start(ctx) == 0);
    fail("stop", 402);
    assert(x5w_close(ctx) == 402 && flow_destroys == 0 && memory_closes == 0);
    assert(x5w_close(ctx) == 0 && flow_destroys == 1);

    reset();
    fail("isp_attr", 403);
    ctx = NULL;
    assert(x5w_open("imx415-30fps-2lane", 0, &ctx) == 403 && !ctx);
    assert(node_closes == 2 && camera_destroys == 1 && memory_closes == 1);

    reset();
    fail("add_isp", 404);
    assert(x5w_open("imx415-30fps-2lane", 0, &ctx) == 404 && !ctx);
    assert(flow_destroys == 1 && node_closes == 1); /* ISP was not added. */

    reset();
    ctx = opened(0);
    fail("camera_destroy", 405);
    assert(x5w_close(ctx) == 405 && flow_destroys == 1 && memory_closes == 0);
    assert(x5w_close(ctx) == 0 && flow_destroys == 1 && camera_destroys == 2);

    reset();
    ctx = opened(0);
    fail("memory_close", 406);
    assert(x5w_close(ctx) == 406 && memory_users == 1);
    assert(x5w_close(ctx) == 0 && memory_users == 0 && memory_closes == 2);

    reset();
    fail("isp_attr", 407);
    second_fail_name = "camera_destroy";
    second_fail_code = 408;
    second_fail_remaining = 1;
    ctx = NULL;
    assert(x5w_open("imx415-30fps-2lane", 0, &ctx) == 407 && ctx);
    assert(memory_users == 1 && node_closes == 2 && memory_closes == 0);
    assert(x5w_start(ctx) == -EBUSY); /* No false-ready partially destroyed flow. */
    assert(x5w_close(ctx) == 0 && camera_destroys == 2 && memory_users == 0);
}

static void test_start_stage_failures(void)
{
    reset();
    void *ctx = opened(2);
    fail("attach", -203);
    assert(x5w_start(ctx) == -203);
    assert(attaches == 1 && binds == 0 && flow_starts == 0);
    assert(x5w_close(ctx) == 0 && flow_stops == 0);

    reset();
    ctx = opened(2);
    fail("bind", -19);
    assert(x5w_start(ctx) == -19);
    assert(attaches == 1 && binds == 1 && flow_starts == 0);
    /* An attached camera still belongs to the failed-start context and must
     * be detached on close; an unstarted flow must not be reported running. */
    assert(x5w_close(ctx) == 0 && detaches == 1 && flow_stops == 0);
}

static void frame_fixture(x5w_context *ctx, int raw, unsigned char *y, unsigned char *uv)
{
    ctx->camera_cfg.width = 4;
    ctx->camera_cfg.height = 2;
    sdk_frame.buffer.width = 4;
    sdk_frame.buffer.height = 2;
    sdk_frame.buffer.stride = 8;
    sdk_frame.buffer.format = raw ? MEM_PIX_FMT_RAW10 : MEM_PIX_FMT_NV12;
    sdk_frame.buffer.plane_cnt = raw ? 1 : 2;
    sdk_frame.buffer.size[0] = 16;
    sdk_frame.buffer.size[1] = raw ? 0 : 8;
    sdk_frame.buffer.virt_addr[0] = y;
    sdk_frame.buffer.virt_addr[1] = uv;
    sdk_frame.info.frame_id = 17;
    sdk_frame.info.tv.tv_sec = 2;
    sdk_frame.info.tv.tv_usec = 3;
}

static void test_frames(void)
{
    reset();
    void *opaque = opened(0);
    assert(x5w_start(opaque) == 0);
    x5w_context *ctx = opaque;
    unsigned char y[16] = {1,0,255,3,0,0,0,0, 1,0,0,0,0,0,0,0};
    unsigned char uv[8] = {100,150,100,150,0,0,0,0};
    unsigned char dst[24] = {0};
    x5w_frame_info info;
    frame_fixture(ctx, 1, y, uv);
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == 0);
    assert(info.bayer == X5W_GBRG && info.alignment == X5W_RIGHT && info.packing == X5W_RAW16);
    assert(info.timestamp_ns == UINT64_C(2000003000) && info.frame_id == 17);
    assert(info.stride_y == 8 && info.size_y == 16 && !info.size_uv);
    assert(memcmp(dst, y, 16) == 0 && frame_releases == 1);

    assert(x5w_frame(opaque, 1, dst, 1, &info) == -ENOSPC && frame_releases == 2 && !info.width);
    memset(y, 0, sizeof(y));
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == -95 && frame_releases == 3);
    y[0] = 64; y[2] = 192; y[3] = 255;
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == 0 && info.alignment == X5W_LEFT);
    sdk_bayer = "unknown";
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == -95 && frame_releases == 5);
    sdk_bayer = "RGGB";
    fail("invalidate", 501);
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == 501 && frame_releases == 6);

    frame_fixture(ctx, 0, y, uv);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == 0);
    assert(info.packing == X5W_NV12 && info.size_y == 16 && info.size_uv == 8 && info.stride_uv == 8);
    assert(memcmp(dst + 16, uv, 8) == 0);
    sdk_frame.buffer.plane_cnt = 1;
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == -95 && frame_releases == 8);
    sdk_frame.buffer.plane_cnt = 2;
    fail("frame_release", 502);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == 502 && !info.width);
    fail("frame_get", 503);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == 503 && frame_releases == 9);
    frame_fixture(ctx, 1, y, uv);
    fail("bayer_get", 504);
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == -95 && frame_releases == 10);
    y[0] = 65; y[1] = 4; /* Neither valid RAW10 right nor left aligned. */
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == -EBADMSG && frame_releases == 11);
    sdk_frame.buffer.size[0] = 1;
    assert(x5w_frame(opaque, 1, dst, sizeof(dst), &info) == -EBADMSG && frame_releases == 12);
    assert(x5w_close(opaque) == 0);
}

static FILE *capture_stderr(int *saved_fd)
{
    assert(fflush(stderr) == 0);
    *saved_fd = dup(STDERR_FILENO);
    assert(*saved_fd >= 0);
    FILE *captured = tmpfile();
    assert(captured && dup2(fileno(captured), STDERR_FILENO) >= 0);
    return captured;
}

static void assert_stderr(FILE *captured, int saved_fd, const char *expected)
{
    char actual[512];
    assert(fflush(stderr) == 0);
    rewind(captured);
    size_t size = fread(actual, 1, sizeof(actual) - 1, captured);
    assert(!ferror(captured) && feof(captured));
    actual[size] = '\0';
    assert(dup2(saved_fd, STDERR_FILENO) >= 0);
    assert(close(saved_fd) == 0 && fclose(captured) == 0);
    assert(strcmp(actual, expected) == 0);
}

static void test_frame_failure_diagnostics(void)
{
    reset();
    void *opaque = opened(0);
    assert(x5w_start(opaque) == 0);
    unsigned char y[16] = {1}, uv[8] = {100}, dst[24];
    x5w_frame_info info;
    frame_fixture(opaque, 0, y, uv);
    int saved_fd;
    FILE *captured = capture_stderr(&saved_fd);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == 0);
    assert_stderr(captured, saved_fd, "");
    assert(frame_gets == 1 && frame_releases == 1);

    captured = capture_stderr(&saved_fd);
    fail("frame_get", -43);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == -43 && !info.width);
    assert_stderr(captured, saved_fd, "x5w_frame_failed stage=get code=-43 raw=0\n");
    assert(frame_gets == 2 && frame_releases == 1);

    captured = capture_stderr(&saved_fd);
    fail("invalidate", -43);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == -43 && !info.width);
    assert_stderr(captured, saved_fd, "x5w_frame_failed stage=cache_y code=-43 raw=0\n");
    assert(frame_releases == 2);

    captured = capture_stderr(&saved_fd);
    fail("invalidate_uv", -43);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == -43 && !info.width);
    assert_stderr(captured, saved_fd, "x5w_frame_failed stage=cache_uv code=-43 raw=0\n");
    assert(frame_releases == 3);

    captured = capture_stderr(&saved_fd);
    fail("frame_release", -43);
    assert(x5w_frame(opaque, 0, dst, sizeof(dst), &info) == -43 && !info.width);
    assert_stderr(captured, saved_fd, "x5w_frame_failed stage=release code=-43 raw=0\n");
    assert(frame_releases == 4);

    /* A copy error still releases its acquired frame. Preserve both failure
     * stages while retaining the existing release-error return precedence. */
    captured = capture_stderr(&saved_fd);
    fail("frame_release", -43);
    assert(x5w_frame(opaque, 1, dst, 1, &info) == -43 && !info.width);
    char expected[160];
    snprintf(expected, sizeof(expected),
        "x5w_frame_failed stage=copy code=%d raw=1\n"
        "x5w_frame_failed stage=release code=-43 raw=1\n", -ENOSPC);
    assert_stderr(captured, saved_fd, expected);
    assert(frame_releases == 5);
    assert(x5w_close(opaque) == 0);
}

static void test_controls(void)
{
    reset();
    void *ctx = opened(0);
    double value, low, high, step;
    int writable, active;
    assert(x5w_control_get(ctx, X5W_GAIN, &value, &low, &high, &step, &writable, &active) == -95);
    assert(x5w_control_set(ctx, X5W_AUTO_EXPOSURE, 0) == -95);
    assert(x5w_control_get(ctx, X5W_CONTRAST, &value, &low, &high, &step, &writable, &active) == 0);
    assert(value == 1 && low == 0 && high == (double)1.999f && step == 0 && writable && active);
    assert(x5w_control_set(ctx, X5W_CONTRAST, 1.1) == 0);
    assert(x5w_control_get(ctx, X5W_CONTRAST, &value, &low, &high, &step, &writable, &active) == 0);
    assert(value == (double)(float)1.1 && value != 1.1);
    assert(sdk_cproc.manual_attr.saturation == 1 && sdk_cproc.mode == HBN_ISP_MODE_MANUAL);
    assert(x5w_control_set(ctx, X5W_CONTRAST, (double)1.999f) == 0);
    assert(x5w_control_set(ctx, X5W_CONTRAST, 2) == -ERANGE);
    assert(x5w_control_set(ctx, X5W_HUE, NAN) == -ERANGE);
    sdk_cproc.mode = HBN_ISP_MODE_AUTO;
    assert(x5w_control_get(ctx, X5W_CONTRAST, &value, &low, &high, &step, &writable, &active) == 0);
    assert(!writable && !active);
    assert(x5w_control_set(ctx, X5W_CONTRAST, 1) == -95);
    sdk_cproc.mode = HBN_ISP_MODE_MANUAL;
    corrupt_readback = 1;
    assert(x5w_control_set(ctx, X5W_BRIGHTNESS, 1) == -EIO);
    assert(x5w_close(ctx) == 0);
}

int main(void)
{
    test_lifecycle();
    test_csi_host_preserves_phy();
    test_cleanup_failures();
    test_start_stage_failures();
    test_frames();
    test_frame_failure_diagnostics();
    test_controls();
    puts("X5 native isolated SDK tests passed: lifecycle, failure cleanup, frame release/layout, manual CPROC readback");
    return 0;
}

/* Core lifecycle/CPROC regression uses an SDK without optional modules.
 * The separate modules_test supplies complete typed getters and setters. */
int32_t hbn_isp_get_exposure_attr(hbn_vnode_handle_t node, hbn_isp_exposure_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_exposure_attr(hbn_vnode_handle_t node, hbn_isp_exposure_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_awb_attr(hbn_vnode_handle_t node, hbn_isp_awb_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_awb_attr(hbn_vnode_handle_t node, hbn_isp_awb_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_module_control(hbn_vnode_handle_t node, hbn_isp_module_ctrl_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_module_control(hbn_vnode_handle_t node, hbn_isp_module_ctrl_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_lsc_attr(hbn_vnode_handle_t node, hbn_isp_lsc_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_lsc_attr(hbn_vnode_handle_t node, hbn_isp_lsc_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_ccm_attr(hbn_vnode_handle_t node, hbn_isp_ccm_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_ccm_attr(hbn_vnode_handle_t node, hbn_isp_ccm_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_gc_attr(hbn_vnode_handle_t node, hbn_isp_gc_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_gc_attr(hbn_vnode_handle_t node, hbn_isp_gc_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_2dnr_attr(hbn_vnode_handle_t node, hbn_isp_2dnr_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_2dnr_attr(hbn_vnode_handle_t node, hbn_isp_2dnr_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_3dnr_attr(hbn_vnode_handle_t node, hbn_isp_3dnr_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_3dnr_attr(hbn_vnode_handle_t node, hbn_isp_3dnr_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_wdr_attr(hbn_vnode_handle_t node, hbn_isp_wdr_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_wdr_attr(hbn_vnode_handle_t node, hbn_isp_wdr_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_dmsc_attr(hbn_vnode_handle_t node, hbn_isp_dmsc_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_dmsc_attr(hbn_vnode_handle_t node, hbn_isp_dmsc_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_ee_attr(hbn_vnode_handle_t node, hbn_isp_ee_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_ee_attr(hbn_vnode_handle_t node, hbn_isp_ee_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_dpcc_attr(hbn_vnode_handle_t node, hbn_isp_dpcc_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_dpcc_attr(hbn_vnode_handle_t node, hbn_isp_dpcc_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_hdr_exposure_attr(hbn_vnode_handle_t node, hbn_isp_hdr_exposure_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_hdr_exposure_attr(hbn_vnode_handle_t node, hbn_isp_hdr_exposure_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_color_process_attr(hbn_vnode_handle_t node, hbn_isp_color_process_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_color_process_attr(hbn_vnode_handle_t node, hbn_isp_color_process_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_ae_zone_weight_attr(hbn_vnode_handle_t node, hbn_isp_ae_zone_weight_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_ae_zone_weight_attr(hbn_vnode_handle_t node, hbn_isp_ae_zone_weight_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_af_zone_weight_attr(hbn_vnode_handle_t node, hbn_isp_af_zone_weight_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_af_zone_weight_attr(hbn_vnode_handle_t node, hbn_isp_af_zone_weight_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_exposure_table(hbn_vnode_handle_t node, hbn_isp_exposure_table_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_exposure_table(hbn_vnode_handle_t node, hbn_isp_exposure_table_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_exposure_roi(hbn_vnode_handle_t node, hbn_isp_exposure_roi_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_exposure_roi(hbn_vnode_handle_t node, hbn_isp_exposure_roi_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_awb_preference_attr(hbn_vnode_handle_t node, hbn_isp_awb_preference_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_awb_preference_attr(hbn_vnode_handle_t node, hbn_isp_awb_preference_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_awb_calib_data(hbn_vnode_handle_t node, hbn_isp_awb_calib_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_awb_calib_data(hbn_vnode_handle_t node, hbn_isp_awb_calib_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_lsc_calib_data(hbn_vnode_handle_t node, hbn_isp_lsc_calib_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_lsc_calib_data(hbn_vnode_handle_t node, hbn_isp_lsc_calib_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_afm_attr(hbn_vnode_handle_t node, hbn_isp_afm_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_afm_attr(hbn_vnode_handle_t node, hbn_isp_afm_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_hist_attr(hbn_vnode_handle_t node, hbn_isp_hist_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_hist_attr(hbn_vnode_handle_t node, hbn_isp_hist_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_af_attr(hbn_vnode_handle_t node, hbn_isp_af_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_af_attr(hbn_vnode_handle_t node, hbn_isp_af_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_rgbir_attr(hbn_vnode_handle_t node, hbn_isp_rgbir_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_rgbir_attr(hbn_vnode_handle_t node, hbn_isp_rgbir_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_afmv1_attr(hbn_vnode_handle_t node, hbn_isp_afmv1_attr_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_set_afmv1_attr(hbn_vnode_handle_t node, hbn_isp_afmv1_attr_t *data)
{ (void)node; (void)data; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_sensor_attr(hbn_vnode_handle_t node, hbn_isp_sensor_param_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_ae_statistics(hbn_vnode_handle_t node, hbn_isp_ae_statistics_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_awb_statistics(hbn_vnode_handle_t node, hbn_isp_awb_statistics_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_af_statistics(hbn_vnode_handle_t node, hbn_isp_af_statistics_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_hist_sta(hbn_vnode_handle_t node, hbn_isp_hist_sta_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_afmv1_statistics(hbn_vnode_handle_t node, hbn_isp_afmv1_statistics_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_isp_get_lines_persecond(hbn_vnode_handle_t node, uint32_t *out)
{ (void)node; (void)out; return X5W_UNSUPPORTED; }
int32_t hbn_camera_switch_scence(int64_t flow, int64_t node, const char *path)
{ (void)flow; (void)node; (void)path; return X5W_UNSUPPORTED; }
hobot_status hbn_vnode_start(hbn_vnode_handle_t node)
{ (void)node; return X5W_UNSUPPORTED; }
hobot_status hbn_vnode_stop(hbn_vnode_handle_t node)
{ (void)node; return X5W_UNSUPPORTED; }
hobot_status hbn_vnode_sendframe(hbn_vnode_handle_t node, uint32_t channel, hbn_vnode_image_t *frame)
{ (void)node; (void)channel; (void)frame; return X5W_UNSUPPORTED; }
int32_t hb_mem_alloc_graph_buf(int32_t width, int32_t height, int32_t format, int64_t flags, int32_t stride, int32_t vstride, hb_mem_graphic_buf_t *buffer)
{ (void)width; (void)height; (void)format; (void)flags; (void)stride; (void)vstride; (void)buffer; return X5W_UNSUPPORTED; }
int32_t hb_mem_free_buf(int32_t fd)
{ (void)fd; return X5W_UNSUPPORTED; }
int32_t hb_mem_flush_buf_with_vaddr(uint64_t address, uint64_t size)
{ (void)address; (void)size; return X5W_UNSUPPORTED; }
