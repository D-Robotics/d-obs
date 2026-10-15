/* SPDX-License-Identifier: Apache-2.0
 * CPU-only SDK module contract tests. No adapter or hardware fixture is exposed
 * to the platform. All ISP structures/prototypes come from real SDK headers.
 */
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "hbn_api.h"
#include "hbn_isp_api.h"
#include "hb_camera_interface.h"
#include "../x5_camera_backend.h"
#define X5W_UNSUPPORTED (-95)

/* Internal context ownership is separate from SDK structures. */
typedef struct x5w_context {
    pthread_mutex_t lock;
    hbn_vnode_handle_t isp;
    hbn_vflow_handle_t flow;
    int isp_open, flow_open;
    double awb_min, awb_max;
    int awb_limits_set;
    hbn_isp_param_range_t ae_exposure_limits, ae_gain_limits;
    int ae_limits_valid;
    void *replay_state;
} x5w_context;
static x5w_context fixture;
static x5w_context *context(void *opaque) { return opaque == &fixture ? &fixture : NULL; }

#include "../x5_isp_modules.inc.c"

static unsigned char *sdk_module[X5W_MODULE_COUNT];
static int sdk_get_count[X5W_MODULE_COUNT], sdk_set_count[X5W_MODULE_COUNT];
static int ignore_module = -1, get_error_module = -1, set_error_module = -1;
static int unavailable_mode, scene_calls, scene_error;

static void post_get(int module, void *out)
{
    if (module == 0) {
        hbn_isp_exposure_attr_t *attr = out;
        attr->lock_state = sdk_get_count[module] % 2;
        attr->manual_attr.frame_id = sdk_get_count[module];
        attr->manual_attr.timestamps = (uint64_t)sdk_get_count[module] * 1000;
        if (unavailable_mode) attr->mode = HBN_ISP_MODE_AUTO;
    }
    if (module == 1) {
        hbn_isp_awb_attr_t *attr = out;
        attr->lock_state = sdk_get_count[module] % 2;
        if (unavailable_mode) attr->mode = HBN_ISP_MODE_AUTO;
    }
}

#define X5W_STUB(id, name, type, get, set) \
int32_t get(hbn_vnode_handle_t node, type *out) \
{ \
    assert(node == 102); ++sdk_get_count[id]; \
    if (get_error_module == id) return 501; \
    memcpy(out, sdk_module[id], sizeof(*out)); post_get(id, out); return 0; \
} \
int32_t set(hbn_vnode_handle_t node, type *data) \
{ \
    assert(node == 102); ++sdk_set_count[id]; \
    if (set_error_module == id) return 502; \
    if (ignore_module != id) { \
        memcpy(sdk_module[id], data, sizeof(*data)); \
    } \
    return 0; \
}
X5W_MODULE_LIST(X5W_STUB)
#undef X5W_STUB

#define X5W_RO_STUB(id, name, type, get) \
int32_t get(hbn_vnode_handle_t node, type *out) \
{ \
    assert(node == 102); ++sdk_get_count[id]; \
    if (get_error_module == id) return 501; \
    memcpy(out, sdk_module[id], sizeof(*out)); return 0; \
}
X5W_READONLY_MODULE_LIST(X5W_RO_STUB)
#undef X5W_RO_STUB

int32_t hbn_camera_switch_scence(int64_t flow, int64_t node, const char *path)
{
    assert(flow == 301 && node == 102 && path && path[0] == '/');
    ++scene_calls;
    if (scene_error) return scene_error;
    ((hbn_isp_cproc_attr_t *)sdk_module[3])->manual_attr.bright = 7;
    return 0;
}

static void init(void)
{
    memset(&fixture, 0, sizeof(fixture));
    assert(pthread_mutex_init(&fixture.lock, NULL) == 0);
    fixture.isp = 102; fixture.flow = 301;
    fixture.isp_open = fixture.flow_open = 1;
    for (int id = 0; id < X5W_MODULE_COUNT; ++id) {
        assert(x5w_module_size(id) > 0 && x5w_module_name(id));
        sdk_module[id] = calloc(1, x5w_module_size(id));
        assert(sdk_module[id]);
    }
    hbn_isp_exposure_attr_t *ae = (void *)sdk_module[0];
    ae->version = HBN_ISP_EXP_V2;
    ae->mode = HBN_ISP_MODE_AUTO;
    ae->auto_attr.exp_time_range.min = 0.0001f;
    ae->auto_attr.exp_time_range.max = 0.03f;
    ae->auto_attr.again_range.min = 1; ae->auto_attr.again_range.max = 16;
    ae->manual_attr.exp_time = 0.01f;
    ae->manual_attr.again = 2; ae->manual_attr.dgain = ae->manual_attr.ispgain = 1;
    hbn_isp_awb_attr_t *awb = (void *)sdk_module[1];
    awb->version = HBN_ISP_WB_V1;
    awb->mode = HBN_ISP_MODE_AUTO;
    awb->manual_attr.gain = (hbn_isp_awb_gain_t){2, 1, 1, 2.5f};
    hbn_isp_cproc_attr_t *cproc = (void *)sdk_module[3];
    cproc->mode = HBN_ISP_MODE_MANUAL;
    cproc->manual_attr.contrast = cproc->manual_attr.saturation = 1;
    *(uint32_t *)sdk_module[33] = 67500;
}

static void test_catalog(void)
{
    assert(x5w_module_size(-1) == 0 && !x5w_module_name(34));
    for (int id = 0; id < X5W_MODULE_COUNT; ++id) {
        size_t n = x5w_module_size(id);
        void *bytes = calloc(1, n);
        assert(bytes && x5w_module_get(&fixture, id, bytes, n) == 0);
        if (x5w_module_writable(id)) assert(x5w_module_set(&fixture, id, bytes, n) == 0);
        else assert(x5w_module_set(&fixture, id, bytes, n) == -95);
        assert(x5w_module_get(&fixture, id, bytes, n - 1) == -ENOSPC);
        free(bytes);
    }
}

static void test_persistent_scope(void)
{
    hbn_isp_exposure_attr_t a = {0}, b = {0};
    a.mode = b.mode = HBN_ISP_MODE_AUTO;
    a.manual_attr.exp_time = 0.01f; b.manual_attr.exp_time = 0.02f;
    a.manual_attr.frame_id = 1; b.manual_attr.frame_id = 200;
    a.lock_state = 0; b.lock_state = 1;
    a.auto_attr.exp_time_range.max = 0.1f; b.auto_attr.exp_time_range.max = 0.2f;
    assert(x5w_module_equal(0, &a, &b) == 1);
    b.auto_attr.target = 1;
    assert(x5w_module_equal(0, &a, &b) == 0);
    b.auto_attr.target = 0; b.mode = HBN_ISP_MODE_MANUAL;
    assert(x5w_module_equal(0, &a, &b) == 0); /* Mode is never ignored. */

    hbn_isp_2dnr_attr_t nr_a = {0}, nr_b = {0};
    size_t padding = offsetof(hbn_isp_2dnr_attr_t, auto_attr.auto_level) + 1;
    assert(padding < offsetof(hbn_isp_2dnr_attr_t, auto_attr.gain));
    ((unsigned char *)&nr_b)[padding] = 123;
    assert(x5w_module_equal(7, &nr_a, &nr_b) == 1);

    hbn_isp_gc_attr_t gc_a = {0}, gc_b = {0};
    gc_a.mode = gc_b.mode = HBN_ISP_MODE_MANUAL;
    gc_a.manual_attr.standard = gc_b.manual_attr.standard = BOOL_TRUE;
    gc_a.manual_attr.standard_val = gc_b.manual_attr.standard_val = 2;
    gc_b.manual_attr.curve[0] = 100; /* Generated curve, not user input. */
    assert(x5w_module_equal(6, &gc_a, &gc_b) == 1);
    gc_b.manual_attr.standard_val = 3;
    assert(x5w_module_equal(6, &gc_a, &gc_b) == 0);
}

static void test_independent_readback(void)
{
    hbn_isp_cproc_attr_t wanted = {0};
    assert(x5w_module_get(&fixture, 3, &wanted, sizeof(wanted)) == 0);
    wanted.manual_attr.bright = 2;
    ignore_module = 3;
    assert(x5w_module_set(&fixture, 3, &wanted, sizeof(wanted)) == -EIO);
    ignore_module = -1; get_error_module = 3;
    assert(x5w_module_set(&fixture, 3, &wanted, sizeof(wanted)) == 501);
    get_error_module = -1;
    assert(x5w_module_set(&fixture, 3, &wanted, sizeof(wanted)) == 0);
    set_error_module = 3;
    assert(x5w_module_set(&fixture, 3, &wanted, sizeof(wanted)) == 502);
    set_error_module = -1;
    int before = sdk_set_count[3];
    fixture.replay_state = &fixture;
    assert(x5w_module_set(&fixture, 3, &wanted, sizeof(wanted)) == -EBUSY);
    assert(sdk_set_count[3] == before);
    fixture.replay_state = NULL;
}

static void descriptor(int key, double *value, double *low, double *high, int *active)
{
    double step; int writable;
    assert(x5w_extended_control_get(&fixture, key, value, low, high, &step, &writable, active) == 0);
    if (key == X5W_AUTO_EXPOSURE || key == X5W_AUTO_WHITE_BALANCE) assert(step == 1);
    else assert(step == 0);
}

static void test_extended_controls(void)
{
    double value, low, high, quantized; int active;
    descriptor(X5W_AUTO_EXPOSURE, &value, &low, &high, &active);
    assert(value == 1 && active);
    descriptor(X5W_EXPOSURE_US, &value, &low, &high, &active);
    assert(value == (double)0.01f * 1000000 && !active && low == (double)0.0001f * 1000000);
    assert(x5w_extended_control_set(&fixture, X5W_EXPOSURE_US, value) == -EACCES);
    hbn_isp_exposure_attr_t *ae = (void *)sdk_module[0];
    float original_exp = ae->manual_attr.exp_time;
    ae->manual_attr.exp_time = 0;
    double missing_step; int missing_write;
    assert(x5w_extended_control_get(&fixture, X5W_EXPOSURE_US, &value, &low, &high,
        &missing_step, &missing_write, &active) == -95);
    descriptor(X5W_AUTO_EXPOSURE, &value, &low, &high, &active);
    assert(value == 1); /* Uninitialized AUTO numeric output does not hide the mode. */
    ae->manual_attr.exp_time = original_exp;
    assert(x5w_extended_control_set(&fixture, X5W_AUTO_EXPOSURE, 0) == 0);
    assert(x5w_control_quantize(&fixture, X5W_EXPOSURE_US, 12000, &quantized) == 0);
    assert(quantized == (double)0.012f * 1000000);
    assert(x5w_extended_control_set(&fixture, X5W_EXPOSURE_US, 12000) == -ERANGE);
    assert(x5w_extended_control_set(&fixture, X5W_EXPOSURE_US, quantized) == 0);
    descriptor(X5W_EXPOSURE_US, &value, &low, &high, &active);
    assert(value == quantized && active);
    assert(x5w_extended_control_set(&fixture, X5W_GAIN, 2.2) == -ERANGE);
    assert(x5w_extended_control_set(&fixture, X5W_GAIN, (double)2.2f) == 0);
    unavailable_mode = 1;
    assert(x5w_extended_control_set(&fixture, X5W_AUTO_EXPOSURE, 0) == -EIO);
    unavailable_mode = 0;

    double step; int writable;
    assert(x5w_extended_control_get(&fixture, X5W_RED_GAIN, &value, &low, &high, &step, &writable, &active) == -95);
    int before = sdk_set_count[1];
    assert(x5w_awb_limits_set(&fixture, 1, 4) == 0 && sdk_set_count[1] == before);
    assert(x5w_awb_limits_set(&fixture, 0, 4) == -EINVAL);
    hbn_isp_awb_attr_t *awb = (void *)sdk_module[1];
    float original_red = awb->manual_attr.gain.rgain;
    awb->manual_attr.gain.rgain = 0;
    assert(x5w_extended_control_get(&fixture, X5W_RED_GAIN, &value, &low, &high,
        &missing_step, &missing_write, &active) == -95);
    awb->manual_attr.gain.rgain = original_red;
    assert(x5w_extended_control_set(&fixture, X5W_RED_GAIN, 2) == -EACCES);
    assert(x5w_extended_control_set(&fixture, X5W_AUTO_WHITE_BALANCE, 0) == 0);
    assert(x5w_extended_control_set(&fixture, X5W_RED_GAIN, (double)2.1f) == 0);
    descriptor(X5W_RED_GAIN, &value, &low, &high, &active);
    assert(value == (double)2.1f && low == 1 && high == 4 && active);
    assert(awb->manual_attr.gain.grgain == 1 && awb->manual_attr.gain.gbgain == 1 && awb->manual_attr.gain.bgain == 2.5f);
    assert(x5w_extended_control_set(&fixture, X5W_BLUE_GAIN, 5) == -ERANGE);
}

static void test_schema(void)
{
    for (int id = 0; id < X5W_MODULE_COUNT; ++id) {
        int count = x5w_module_field_count(id);
        for (int field = 0; field < count; ++field) {
            char name[128]; size_t offset, items; int type, editable; double low, high;
            assert(x5w_module_field_info(id, field, name, sizeof(name), &offset, &type, &items, &low, &high, &editable) == 0);
            size_t bytes = type == X5W_U16 || type == X5W_I16 ? 2 : type == X5W_U8 || type == X5W_I8 ? 1 : type == X5W_F64 ? 8 : 4;
            assert(offset + items * bytes <= x5w_module_size(id));
            if (editable) assert(isfinite(low) && isfinite(high) && low <= high);
        }
    }
    assert(x5w_module_field_count(4) >= 4 && x5w_module_field_count(5) >= 3);
}

static void test_nr2d_auto_leaf(void)
{
    size_t leaf_offset = 0;
    double leaf_low = NAN, leaf_high = NAN;
    int found_leaf = 0, found_level = 0, found_gain0 = 0, found_gain1 = 0;
    for (int field = 0; field < x5w_module_field_count(7); ++field) {
        char name[128]; size_t offset, items; int type, editable; double low, high;
        assert(x5w_module_field_info(7, field, name, sizeof(name), &offset, &type, &items,
                                    &low, &high, &editable) == 0);
        if (strcmp(name, "auto_attr.sigma_scale_0_0") == 0) {
            ++found_leaf; leaf_offset = offset; leaf_low = low; leaf_high = high;
            assert(offset == offsetof(hbn_isp_2dnr_attr_t, auto_attr.sigma_scale[0][0]));
            assert(items == 1 && type == X5W_F32 && editable == 1);
            assert(low == (double)0.001f && high == 100);
        } else if (strcmp(name, "auto_attr.auto_level") == 0) {
            ++found_level;
            assert(offset == offsetof(hbn_isp_2dnr_attr_t, auto_attr.auto_level));
            assert(items == 1 && type == X5W_U8 && editable == 0);
        } else if (strcmp(name, "auto_attr.gain_0") == 0 || strcmp(name, "auto_attr.gain_1") == 0) {
            int slot = strcmp(name, "auto_attr.gain_0") == 0 ? 0 : 1;
            if (slot == 0) ++found_gain0; else ++found_gain1;
            assert(offset == offsetof(hbn_isp_2dnr_attr_t, auto_attr.gain) + (size_t)slot * sizeof(float));
            assert(items == 1 && type == X5W_F32 && editable == 0);
        }
    }
    assert(found_leaf == 1 && found_level == 1 && found_gain0 == 1 && found_gain1 == 1);
    assert(sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.auto_level) == sizeof(uint8_t));
    assert(sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.gain[0]) == sizeof(float));
    assert(sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.sigma_scale[0][0]) == sizeof(float));
    assert((double)nextafterf(0.001f, -INFINITY) < leaf_low);
    assert((double)nextafterf(100.0f, INFINITY) > leaf_high);

    hbn_isp_2dnr_attr_t original = {0}, candidate, observed;
    original.mode = HBN_ISP_MODE_AUTO;
    original.auto_attr.auto_level = 2;
    original.auto_attr.gain[0] = 1; original.auto_attr.gain[1] = 2;
    original.auto_attr.sigma_scale[0][0] = 2;
    original.auto_attr.sigma_scale[0][1] = 2;
    original.auto_attr.sigma_scale[0][2] = 4;
    original.auto_attr.sigma_scale[1][0] = 3;
    memcpy(&candidate, &original, sizeof(candidate));
    float value = 2.1f;
    assert((double)value >= leaf_low && (double)value <= leaf_high);
    memcpy((unsigned char *)&candidate + leaf_offset, &value, sizeof(value));
    assert(memcmp(&candidate, &original, leaf_offset) == 0);
    assert(memcmp((unsigned char *)&candidate + leaf_offset + sizeof(value),
                  (unsigned char *)&original + leaf_offset + sizeof(value),
                  sizeof(candidate) - leaf_offset - sizeof(value)) == 0);
    assert(candidate.mode == HBN_ISP_MODE_AUTO);
    assert(candidate.auto_attr.sigma_scale[0][1] == 2 && candidate.auto_attr.sigma_scale[0][2] == 4);
    assert(candidate.auto_attr.sigma_scale[1][0] == 3);
    assert(x5w_module_equal(7, &original, &candidate) == 0); /* AUTO slot stays in readback. */
    int scenes_before = scene_calls;
    assert(x5w_module_set(&fixture, 7, &candidate, sizeof(candidate)) == 0);
    assert(x5w_module_get(&fixture, 7, &observed, sizeof(observed)) == 0);
    assert(memcmp(&observed, &candidate, sizeof(observed)) == 0 && scene_calls == scenes_before);
    assert(x5w_module_set(&fixture, 7, &original, sizeof(original)) == 0);
}

static void test_ee_auto_leaf(void)
{
    size_t leaf_offset = 0;
    int found_leaf = 0;
    for (int field = 0; field < x5w_module_field_count(11); ++field) {
        char name[128]; size_t offset, items; int type, editable; double low, high;
        assert(x5w_module_field_info(11, field, name, sizeof(name), &offset, &type, &items,
                                    &low, &high, &editable) == 0);
        if (strcmp(name, "auto_attr.sharp_gain_0_0") != 0) continue;
        ++found_leaf; leaf_offset = offset;
        assert(offset == offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_gain[0][0]));
        assert(items == 1 && type == X5W_U16 && editable == 0);
        assert(isnan(low) && isnan(high));
    }
    assert(found_leaf == 1);
    assert(sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_gain[0][0]) == sizeof(uint16_t));

    hbn_isp_ee_attr_t original = {0}, candidate;
    original.mode = HBN_ISP_MODE_AUTO;
    original.auto_attr.sharp_gain[0][1] = 2;
    original.auto_attr.sharp_gain[1][0] = 3;
    memcpy(&candidate, &original, sizeof(candidate));
    uint16_t value = 1;
    memcpy((unsigned char *)&candidate + leaf_offset, &value, sizeof(value));
    assert(candidate.auto_attr.sharp_gain[0][0] == value);
    assert(memcmp(&candidate, &original, leaf_offset) == 0);
    assert(memcmp((unsigned char *)&candidate + leaf_offset + sizeof(value),
                  (unsigned char *)&original + leaf_offset + sizeof(value),
                  sizeof(candidate) - leaf_offset - sizeof(value)) == 0);
    assert(candidate.mode == HBN_ISP_MODE_AUTO);
    assert(candidate.auto_attr.sharp_gain[0][1] == 2 && candidate.auto_attr.sharp_gain[1][0] == 3);
    assert(x5w_module_equal(11, &original, &candidate) == 0);
}

static void test_scene_load(void)
{
    char temporary[] = "/tmp/x5w-tuning-test-XXXXXX";
    int fd = mkstemp(temporary);
    assert(fd >= 0 && write(fd, "{}", 2) == 2);
    close(fd);
    char json_path[100];
    assert(snprintf(json_path, sizeof(json_path), "%s.json", temporary) > 0);
    assert(rename(temporary, json_path) == 0);
    fixture.replay_state = &fixture;
    assert(x5w_tuning_load(&fixture, json_path) == -EBUSY && scene_calls == 0);
    fixture.replay_state = NULL;
    int before = sdk_get_count[3];
    assert(x5w_tuning_load(&fixture, json_path) == 0 && scene_calls == 1 && sdk_get_count[3] > before);
    assert(((hbn_isp_cproc_attr_t *)sdk_module[3])->manual_attr.bright == 7);
    assert(!fixture.ae_limits_valid);
    get_error_module = 1;
    assert(x5w_tuning_load(&fixture, json_path) == 501 && scene_calls == 2);
    get_error_module = -1;
    scene_error = 503;
    assert(x5w_tuning_load(&fixture, json_path) == 503);
    assert(x5w_tuning_load(&fixture, "relative.json") == -EINVAL);
    assert(unlink(json_path) == 0);
}

int main(void)
{
    init();
    test_catalog(); test_persistent_scope(); test_independent_readback();
    test_extended_controls(); test_schema(); test_nr2d_auto_leaf(); test_ee_auto_leaf(); test_scene_load();
    for (int id = 0; id < X5W_MODULE_COUNT; ++id) free(sdk_module[id]);
    pthread_mutex_destroy(&fixture.lock);
    puts("X5 ISP isolated module tests passed: 34 typed APIs, persistent scope/padding, AE/AWB, policy/schema, SDK scene/readback");
    return 0;
}
