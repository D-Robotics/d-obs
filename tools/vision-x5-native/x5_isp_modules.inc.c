/* SPDX-License-Identifier: Apache-2.0
 * Included by x5_camera_backend.c after its context and ownership helpers.
 * All layouts come from the installed HBN SDK. Opaque inputs must originate
 * from a real SDK getter / protected private snapshot, never client bytes.
 */
#ifndef X5W_ISP_MODULES_INCLUDED
#define X5W_ISP_MODULES_INCLUDED

#include <float.h>
#include <sys/stat.h>

/* Stable ABI IDs. A compiled API is not proof that a particular SDK instance
 * or sensor supports it; each getter's actual return code remains authoritative. */
#define X5W_MODULE_LIST(X) \
 X(0, exposure, hbn_isp_exposure_attr_t, hbn_isp_get_exposure_attr, hbn_isp_set_exposure_attr) \
 X(1, awb, hbn_isp_awb_attr_t, hbn_isp_get_awb_attr, hbn_isp_set_awb_attr) \
 X(2, module_control, hbn_isp_module_ctrl_t, hbn_isp_get_module_control, hbn_isp_set_module_control) \
 X(3, cproc, hbn_isp_cproc_attr_t, hbn_isp_get_cproc_attr, hbn_isp_set_cproc_attr) \
 X(4, lsc, hbn_isp_lsc_attr_t, hbn_isp_get_lsc_attr, hbn_isp_set_lsc_attr) \
 X(5, ccm, hbn_isp_ccm_attr_t, hbn_isp_get_ccm_attr, hbn_isp_set_ccm_attr) \
 X(6, gamma, hbn_isp_gc_attr_t, hbn_isp_get_gc_attr, hbn_isp_set_gc_attr) \
 X(7, nr2d, hbn_isp_2dnr_attr_t, hbn_isp_get_2dnr_attr, hbn_isp_set_2dnr_attr) \
 X(8, nr3d, hbn_isp_3dnr_attr_t, hbn_isp_get_3dnr_attr, hbn_isp_set_3dnr_attr) \
 X(9, wdr, hbn_isp_wdr_attr_t, hbn_isp_get_wdr_attr, hbn_isp_set_wdr_attr) \
 X(10, demosaic, hbn_isp_dmsc_attr_t, hbn_isp_get_dmsc_attr, hbn_isp_set_dmsc_attr) \
 X(11, edge_enhancement, hbn_isp_ee_attr_t, hbn_isp_get_ee_attr, hbn_isp_set_ee_attr) \
 X(12, dpcc, hbn_isp_dpcc_attr_t, hbn_isp_get_dpcc_attr, hbn_isp_set_dpcc_attr) \
 X(13, hdr_exposure, hbn_isp_hdr_exposure_attr_t, hbn_isp_get_hdr_exposure_attr, hbn_isp_set_hdr_exposure_attr) \
 X(14, color_process, hbn_isp_color_process_attr_t, hbn_isp_get_color_process_attr, hbn_isp_set_color_process_attr) \
 X(15, ae_zone_weight, hbn_isp_ae_zone_weight_attr_t, hbn_isp_get_ae_zone_weight_attr, hbn_isp_set_ae_zone_weight_attr) \
 X(16, af_zone_weight, hbn_isp_af_zone_weight_attr_t, hbn_isp_get_af_zone_weight_attr, hbn_isp_set_af_zone_weight_attr) \
 X(17, exposure_table, hbn_isp_exposure_table_t, hbn_isp_get_exposure_table, hbn_isp_set_exposure_table) \
 X(18, exposure_roi, hbn_isp_exposure_roi_t, hbn_isp_get_exposure_roi, hbn_isp_set_exposure_roi) \
 X(19, awb_preference, hbn_isp_awb_preference_attr_t, hbn_isp_get_awb_preference_attr, hbn_isp_set_awb_preference_attr) \
 X(20, awb_calibration, hbn_isp_awb_calib_t, hbn_isp_get_awb_calib_data, hbn_isp_set_awb_calib_data) \
 X(21, lsc_calibration, hbn_isp_lsc_calib_t, hbn_isp_get_lsc_calib_data, hbn_isp_set_lsc_calib_data) \
 X(22, afm, hbn_isp_afm_attr_t, hbn_isp_get_afm_attr, hbn_isp_set_afm_attr) \
 X(23, histogram, hbn_isp_hist_t, hbn_isp_get_hist_attr, hbn_isp_set_hist_attr) \
 X(24, autofocus, hbn_isp_af_attr_t, hbn_isp_get_af_attr, hbn_isp_set_af_attr) \
 X(25, rgbir, hbn_isp_rgbir_attr_t, hbn_isp_get_rgbir_attr, hbn_isp_set_rgbir_attr) \
 X(26, afmv1, hbn_isp_afmv1_attr_t, hbn_isp_get_afmv1_attr, hbn_isp_set_afmv1_attr)

#define X5W_READONLY_MODULE_LIST(X) \
 X(27, sensor, hbn_isp_sensor_param_t, hbn_isp_get_sensor_attr) \
 X(28, ae_statistics, hbn_isp_ae_statistics_t, hbn_isp_get_ae_statistics) \
 X(29, awb_statistics, hbn_isp_awb_statistics_t, hbn_isp_get_awb_statistics) \
 X(30, af_statistics, hbn_isp_af_statistics_t, hbn_isp_get_af_statistics) \
 X(31, histogram_statistics, hbn_isp_hist_sta_t, hbn_isp_get_hist_sta) \
 X(32, afmv1_statistics, hbn_isp_afmv1_statistics_t, hbn_isp_get_afmv1_statistics) \
 X(33, lines_per_second, uint32_t, hbn_isp_get_lines_persecond)

#define X5W_MODULE_COUNT 34

size_t x5w_module_size(int module)
{
    switch (module) {
#define X5W_SIZE(id, name, type, get, ...) case id: return sizeof(type);
    X5W_MODULE_LIST(X5W_SIZE)
    X5W_READONLY_MODULE_LIST(X5W_SIZE)
#undef X5W_SIZE
    default: return 0;
    }
}

const char *x5w_module_name(int module)
{
    switch (module) {
#define X5W_NAME(id, name, ...) case id: return #name;
    X5W_MODULE_LIST(X5W_NAME)
    X5W_READONLY_MODULE_LIST(X5W_NAME)
#undef X5W_NAME
    default: return NULL;
    }
}

int x5w_module_writable(int module) { return module >= 0 && module <= 26; }

static int x5w_module_sdk_get(hbn_vnode_handle_t node, int module, void *out)
{
    switch (module) {
#define X5W_GET(id, name, type, get, ...) \
    case id: { type attr = {0}; int ret = get(node, &attr); \
        if (ret == 0) { \
            memcpy(out, &attr, sizeof(attr)); \
        } \
        return ret; }
    X5W_MODULE_LIST(X5W_GET)
    X5W_READONLY_MODULE_LIST(X5W_GET)
#undef X5W_GET
    default: return X5W_UNSUPPORTED;
    }
}

static int x5w_module_sdk_set(hbn_vnode_handle_t node, int module, const void *data)
{
    switch (module) {
#define X5W_SET(id, name, type, get, set) \
    case id: { type attr = {0}; memcpy(&attr, data, sizeof(attr)); return set(node, &attr); }
    X5W_MODULE_LIST(X5W_SET)
#undef X5W_SET
    default: return X5W_UNSUPPORTED;
    }
}

static int x5w_module_padding_clear(int module, void *data, size_t n);

/* Preserve a raw snapshot separately. This canonical comparison scope removes
 * getter-only metadata and the current, changing output of AUTO algorithms.
 * Inactive-mode attributes are not a promise of restoration: SDK setters accept
 * the selected mode's attributes. Mode itself is always compared strictly. */
int x5w_module_normalize(int module, void *data, size_t n)
{
    if (!data || !x5w_module_size(module) || n != x5w_module_size(module)) return -EINVAL;
    int padding_ret = x5w_module_padding_clear(module, data, n);
    if (padding_ret != 0) return padding_ret;
    switch (module) {
    case 0: {
        hbn_isp_exposure_attr_t attr; memcpy(&attr, data, sizeof(attr));
        attr.lock_state = 0;
        attr.manual_attr.ae_exp = 0; attr.manual_attr.cur_lux = 0;
        attr.manual_attr.frame_id = 0; attr.manual_attr.timestamps = 0;
        if (attr.mode == HBN_ISP_MODE_AUTO) {
            memset(&attr.manual_attr, 0, sizeof(attr.manual_attr));
            memset(&attr.auto_attr.exp_time_range, 0, sizeof(attr.auto_attr.exp_time_range));
            memset(&attr.auto_attr.again_range, 0, sizeof(attr.auto_attr.again_range));
            memset(&attr.auto_attr.dgain_range, 0, sizeof(attr.auto_attr.dgain_range));
            memset(&attr.auto_attr.isp_dgain_range, 0, sizeof(attr.auto_attr.isp_dgain_range));
        } else if (attr.mode == HBN_ISP_MODE_MANUAL) memset(&attr.auto_attr, 0, sizeof(attr.auto_attr));
        else return X5W_UNSUPPORTED;
        memcpy(data, &attr, sizeof(attr)); return 0;
    }
    case 1: {
        hbn_isp_awb_attr_t attr; memcpy(&attr, data, sizeof(attr));
        attr.lock_state = 0;
        attr.manual_attr.temper = 0; /* SDK reserved. */
        /* Official API describes these as unsupported or getter-only. */
        attr.auto_attr.rg_strength = attr.auto_attr.bg_strength = 0;
        memset(&attr.auto_attr.gain, 0, sizeof(attr.auto_attr.gain));
        attr.auto_attr.temper = 0;
        if (!attr.auto_attr.use_manual_damp_coff) attr.auto_attr.manual_damp_coff = 0;
        if (attr.mode == HBN_ISP_MODE_AUTO) memset(&attr.manual_attr, 0, sizeof(attr.manual_attr));
        else if (attr.mode == HBN_ISP_MODE_MANUAL) memset(&attr.auto_attr, 0, sizeof(attr.auto_attr));
        else return X5W_UNSUPPORTED;
        memcpy(data, &attr, sizeof(attr)); return 0;
    }
    case 6: {
        hbn_isp_gc_attr_t attr; memcpy(&attr, data, sizeof(attr));
        if (attr.mode == HBN_ISP_MODE_AUTO) memset(&attr.manual_attr, 0, sizeof(attr.manual_attr));
        else if (attr.mode == HBN_ISP_MODE_MANUAL) {
            memset(&attr.auto_attr, 0, sizeof(attr.auto_attr));
            if (attr.manual_attr.standard) memset(attr.manual_attr.curve, 0, sizeof(attr.manual_attr.curve));
            else attr.manual_attr.standard_val = 0;
            if (!attr.manual_attr.user_curve_x) memset(attr.manual_attr.curve_px, 0, sizeof(attr.manual_attr.curve_px));
        } else return X5W_UNSUPPORTED;
        memcpy(data, &attr, sizeof(attr)); return 0;
    }
    case 13: {
        hbn_isp_hdr_exposure_attr_t attr; memcpy(&attr, data, sizeof(attr));
        attr.manual_attr.ae_exp = 0;
        if (attr.mode == HBN_ISP_MODE_AUTO) {
            memset(&attr.manual_attr, 0, sizeof(attr.manual_attr));
            memset(&attr.auto_attr.exp_ratio_range, 0, sizeof(attr.auto_attr.exp_ratio_range));
        } else if (attr.mode == HBN_ISP_MODE_MANUAL) memset(&attr.auto_attr, 0, sizeof(attr.auto_attr));
        else return X5W_UNSUPPORTED;
        memcpy(data, &attr, sizeof(attr)); return 0;
    }
#define X5W_NORMALIZE_MODE(id, type) case id: { \
        type attr; memcpy(&attr, data, sizeof(attr)); \
        if (attr.mode == HBN_ISP_MODE_AUTO) { \
            memset(&attr.manual_attr, 0, sizeof(attr.manual_attr)); \
        } else if (attr.mode == HBN_ISP_MODE_MANUAL) { \
            memset(&attr.auto_attr, 0, sizeof(attr.auto_attr)); \
        } else { \
            return X5W_UNSUPPORTED; \
        } \
        memcpy(data, &attr, sizeof(attr)); \
        return 0; }
    X5W_NORMALIZE_MODE(3, hbn_isp_cproc_attr_t)
    X5W_NORMALIZE_MODE(4, hbn_isp_lsc_attr_t)
    X5W_NORMALIZE_MODE(7, hbn_isp_2dnr_attr_t)
    X5W_NORMALIZE_MODE(8, hbn_isp_3dnr_attr_t)
    X5W_NORMALIZE_MODE(9, hbn_isp_wdr_attr_t)
    X5W_NORMALIZE_MODE(10, hbn_isp_dmsc_attr_t)
    X5W_NORMALIZE_MODE(11, hbn_isp_ee_attr_t)
    X5W_NORMALIZE_MODE(12, hbn_isp_dpcc_attr_t)
    X5W_NORMALIZE_MODE(14, hbn_isp_color_process_attr_t)
#undef X5W_NORMALIZE_MODE
    case 21: {
        hbn_isp_lsc_calib_t attr; memcpy(&attr, data, sizeof(attr));
        attr.valid_num = 0; memcpy(data, &attr, sizeof(attr)); return 0;
    }
    case 20: {
        hbn_isp_awb_calib_t attr; memcpy(&attr, data, sizeof(attr));
        memset(&attr.ctcurve, 0, sizeof(attr.ctcurve));
        attr.fade1.fade_point = attr.fade2.fade_point = 0;
        for (size_t i = 0; i < HBN_ISP_AWB_ILLUPROFILE_NUM; ++i) {
            attr.illu_profiles[i].id = 0;
            attr.illu_profiles[i].door_type = attr.illu_profiles[i].awb_type = 0;
            memset(attr.illu_profiles[i].ccm_coeff, 0, sizeof(attr.illu_profiles[i].ccm_coeff));
            memset(attr.illu_profiles[i].ccm_offset, 0, sizeof(attr.illu_profiles[i].ccm_offset));
        }
        memcpy(data, &attr, sizeof(attr)); return 0;
    }
    default:
        if (!x5w_module_writable(module)) memset(data, 0, n); /* Statistics are not tuning. */
        return 0;
    }
}

static int x5w_module_equal(int module, const void *wanted, const void *actual)
{
    size_t n = x5w_module_size(module);
    if (!n || !wanted || !actual) return -EINVAL;
    void *a = malloc(n), *b = malloc(n);
    if (!a || !b) { free(a); free(b); return -ENOMEM; }
    memcpy(a, wanted, n); memcpy(b, actual, n);
    int ret = x5w_module_normalize(module, a, n);
    if (ret == 0) ret = x5w_module_normalize(module, b, n);
    if (ret == 0) ret = memcmp(a, b, n) == 0 ? 1 : 0;
    free(a); free(b); return ret;
}

int x5w_module_get(void *opaque, int module, void *out, size_t cap)
{
    x5w_context *ctx = context(opaque);
    size_t n = x5w_module_size(module);
    if (!ctx || !out) return -EINVAL;
    if (!n) return X5W_UNSUPPORTED;
    if (cap < n) return -ENOSPC;
    memset(out, 0, n);
    pthread_mutex_lock(&ctx->lock);
    int ret = ctx->isp_open ? x5w_module_sdk_get(ctx->isp, module, out) : -ENODEV;
    pthread_mutex_unlock(&ctx->lock);
    return ret;
}

static int x5w_module_set_locked(x5w_context *ctx, int module, const void *data)
{
    size_t n = x5w_module_size(module);
    if (!ctx->isp_open) return -ENODEV;
    if (ctx->replay_state) return -EBUSY;
    void *actual = calloc(1, n), *probe = malloc(n);
    if (!actual || !probe) { free(actual); free(probe); return -ENOMEM; }
    memcpy(probe, data, n);
    const char *failed_stage = "validate";
    int actual_valid = 0;
    int ret = x5w_module_normalize(module, probe, n); /* Validate known mode. */
    if (ret == 0) { failed_stage = "sdk_set"; ret = x5w_module_sdk_set(ctx->isp, module, data); }
    if (ret == 0) { failed_stage = "sdk_get"; ret = x5w_module_sdk_get(ctx->isp, module, actual); actual_valid = ret == 0; }
    if (ret == 0) {
        failed_stage = "normalized_readback_compare";
        int equal = x5w_module_equal(module, data, actual);
        ret = equal == 1 ? 0 : equal < 0 ? equal : -EIO;
    }
    if (ret != 0) {
        fprintf(stderr, "x5w_isp_write_failed module=%s stage=%s code=%d\n", x5w_module_name(module), failed_stage, ret);
        if (module == 3 && actual_valid) {
            const hbn_isp_cproc_attr_t *wanted = data, *got = actual;
            fprintf(stderr, "x5w_cproc_readback wanted_mode=%d actual_mode=%d wanted_manual=%g,%g,%g,%g actual_manual=%g,%g,%g,%g\n",
                (int)wanted->mode, (int)got->mode,
                (double)wanted->manual_attr.bright, (double)wanted->manual_attr.contrast, (double)wanted->manual_attr.saturation, (double)wanted->manual_attr.hue,
                (double)got->manual_attr.bright, (double)got->manual_attr.contrast, (double)got->manual_attr.saturation, (double)got->manual_attr.hue);
        }
    }
    free(actual); free(probe); return ret;
}

int x5w_module_set(void *opaque, int module, const void *data, size_t n)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !data) return -EINVAL;
    if (!x5w_module_writable(module)) return X5W_UNSUPPORTED;
    if (n != x5w_module_size(module)) return -EINVAL;
    pthread_mutex_lock(&ctx->lock);
    int ret = x5w_module_set_locked(ctx, module, data);
    pthread_mutex_unlock(&ctx->lock); return ret;
}

/* Descriptor types describe storage width, not invented physical limits. */
enum x5w_field_type { X5W_I32, X5W_U32, X5W_F32, X5W_U16, X5W_I16, X5W_U8, X5W_I8, X5W_F64 };
typedef struct x5w_field_desc {
    int module; const char *name; size_t offset; int type; size_t count;
    double low, high; int editable;
} x5w_field_desc;
#define X5W_FIELD(id, struct_type, field, storage, count, low, high, edit) \
 {id, #field, offsetof(struct_type, field), storage, count, low, high, edit}
#define X5W_MODE(id, struct_type) X5W_FIELD(id, struct_type, mode, X5W_I32, 1, 0, 1, 1)
static const x5w_field_desc x5w_fields[] = {
 X5W_MODE(0, hbn_isp_exposure_attr_t),
 X5W_FIELD(0, hbn_isp_exposure_attr_t, manual_attr.exp_time, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(0, hbn_isp_exposure_attr_t, manual_attr.again, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(0, hbn_isp_exposure_attr_t, manual_attr.dgain, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(0, hbn_isp_exposure_attr_t, manual_attr.ispgain, X5W_F32, 1, NAN, NAN, 0),
 X5W_MODE(1, hbn_isp_awb_attr_t),
 X5W_FIELD(1, hbn_isp_awb_attr_t, manual_attr.gain.rgain, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(1, hbn_isp_awb_attr_t, manual_attr.gain.grgain, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(1, hbn_isp_awb_attr_t, manual_attr.gain.gbgain, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(1, hbn_isp_awb_attr_t, manual_attr.gain.bgain, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(1, hbn_isp_awb_attr_t, auto_attr.use_damping, X5W_U32, 1, 0, 1, 1),
 X5W_FIELD(1, hbn_isp_awb_attr_t, auto_attr.use_manual_damp_coff, X5W_U32, 1, 0, 1, 1),
 X5W_FIELD(1, hbn_isp_awb_attr_t, auto_attr.manual_damp_coff, X5W_F32, 1, (double)0.1f, (double)0.999f, 1),
 X5W_FIELD(1, hbn_isp_awb_attr_t, auto_attr.lock_tolerance, X5W_F32, 1, 0, (double)0.2f, 1),
 X5W_FIELD(1, hbn_isp_awb_attr_t, auto_attr.unlock_tolerance, X5W_F32, 1, 0, (double)0.2f, 1),
 X5W_FIELD(2, hbn_isp_module_ctrl_t, version, X5W_I32, 1, 0, 1, 0),
 X5W_FIELD(2, hbn_isp_module_ctrl_t, module.u32Key, X5W_U32, 1, 0, 16383, 1),
 X5W_MODE(3, hbn_isp_cproc_attr_t),
 X5W_FIELD(3, hbn_isp_cproc_attr_t, manual_attr.bright, X5W_F32, 1, -127, 127, 1),
 X5W_FIELD(3, hbn_isp_cproc_attr_t, manual_attr.contrast, X5W_F32, 1, 0, (double)1.999f, 1),
 X5W_FIELD(3, hbn_isp_cproc_attr_t, manual_attr.saturation, X5W_F32, 1, 0, (double)1.999f, 1),
 X5W_FIELD(3, hbn_isp_cproc_attr_t, manual_attr.hue, X5W_F32, 1, -90, 90, 1),
 X5W_MODE(4, hbn_isp_lsc_attr_t),
 X5W_FIELD(4, hbn_isp_lsc_attr_t, manual_attr.matrix, X5W_U16,
   HBN_RAW_CHANNEL_NUM * HBN_LSC_V_POINT_NUM * HBN_LSC_H_POINT_NUM, HBN_ISP_LSC_M_MIN, HBN_ISP_LSC_M_MAX, 1),
 X5W_FIELD(4, hbn_isp_lsc_attr_t, manual_attr.x_size, X5W_U16, HBN_LSC_H_BLOCK_NUM, NAN, NAN, 0),
 X5W_FIELD(4, hbn_isp_lsc_attr_t, manual_attr.y_size, X5W_U16, HBN_LSC_V_BLOCK_NUM / 2, NAN, NAN, 0),
 X5W_FIELD(5, hbn_isp_ccm_attr_t, manual_attr.cc_matrix, X5W_F32, HBN_CC_MATRIX_SIZE, NAN, NAN, 0),
 X5W_FIELD(5, hbn_isp_ccm_attr_t, manual_attr.cc_offset, X5W_F32, HBN_CC_COLOR_CHANNEL_NUM, NAN, NAN, 0),
 X5W_FIELD(5, hbn_isp_ccm_attr_t, configMode, X5W_U32, 1, NAN, NAN, 0),
 X5W_MODE(6, hbn_isp_gc_attr_t),
 X5W_FIELD(6, hbn_isp_gc_attr_t, manual_attr.standard, X5W_I32, 1, 0, 1, 1),
 X5W_FIELD(6, hbn_isp_gc_attr_t, manual_attr.standard_val, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(6, hbn_isp_gc_attr_t, manual_attr.curve, X5W_U16, HBN_GC_CURVE_SIZE, NAN, NAN, 0),
 X5W_FIELD(6, hbn_isp_gc_attr_t, manual_attr.user_curve_x, X5W_I32, 1, 0, 1, 1),
 X5W_FIELD(6, hbn_isp_gc_attr_t, manual_attr.curve_px, X5W_U32, HBN_GC_CURVE_SIZE, NAN, NAN, 0),
 X5W_MODE(7, hbn_isp_2dnr_attr_t), X5W_MODE(8, hbn_isp_3dnr_attr_t),
 X5W_MODE(9, hbn_isp_wdr_attr_t), X5W_MODE(10, hbn_isp_dmsc_attr_t),
 X5W_MODE(11, hbn_isp_ee_attr_t), X5W_MODE(12, hbn_isp_dpcc_attr_t),
 X5W_MODE(13, hbn_isp_hdr_exposure_attr_t), X5W_MODE(14, hbn_isp_color_process_attr_t),
 X5W_FIELD(1, hbn_isp_awb_attr_t, manual_attr.temper, X5W_U32, 1, NAN, NAN, 0),
 /* SDK 2.0.0 ISP API §5.7.5.31: every AUTO sigma_scale element is
  * [0.001, 100]. Expose one typed slot; do not expand the entire table.
  * https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/5-ISP_Tune_API_zh_CN.html#hbn-isp-2dnr-auto-attr-t
  * Installed header: uint8_t auto_level; float gain[]; float sigma_scale[][3].
  * Slot 0 is not claimed to be the current interpolated gain/ISO. */
 {7, "auto_attr.sigma_scale_0_0", offsetof(hbn_isp_2dnr_attr_t, auto_attr.sigma_scale[0][0]),
   X5W_F32, 1, (double)0.001f, 100, 1},
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, auto_attr.auto_level, X5W_U8, 1, NAN, NAN, 0),
 {7, "auto_attr.gain_0", offsetof(hbn_isp_2dnr_attr_t, auto_attr.gain[0]), X5W_F32, 1, NAN, NAN, 0},
 {7, "auto_attr.gain_1", offsetof(hbn_isp_2dnr_attr_t, auto_attr.gain[1]), X5W_F32, 1, NAN, NAN, 0},
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.blend_static, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.blend_motion, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.blend_slope, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.vst_factor, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.sigma_scale, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.sigma_factor_mul, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.sigma_factor_motion_max, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.sigma_factor_motion_min, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.sigma_offset, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.static_detail_thresh, X5W_U16, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.static_detail_boost_thresh, X5W_U16, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.static_detail_boost, X5W_F32, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.static_detail_clip_thresh, X5W_U16, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.moving_detail_thresh, X5W_U16, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.moving_detail_boost_thresh, X5W_U16, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.moving_detail_boost, X5W_F32, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.moving_detail_clip_thresh, X5W_U16, 6, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.static_factor, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.ary_x, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.ary_y, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.ary_px, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.interp_mode, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.ary_x, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.ary_y, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.ary_px, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.interp_mode, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.motion_anchor_x, X5W_U16, 2, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.ary_x, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.ary_y, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.ary_px, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(7, hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.interp_mode, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.vst_factor, X5W_F64, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.tnr_strength, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.tnr_strength2, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.filter_len, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.filter_len2, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.motion_smooth_factor, X5W_F64, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.range_h, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.sad_weight, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.diff_type, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.sqr_diff_factor, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.motion_smooth_lvl, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.dilate_h, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.noise_level, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.thr_motion_slope, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.tnr_luma_curve_x, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.tnr_luma_curve_y, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.tnr_motion_slop_y, X5W_U16, 12, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.input_bits, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.fix_curve_start, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.noisemodel_a, X5W_F64, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.noisemodel_b, X5W_F64, 1, NAN, NAN, 0),
 X5W_FIELD(8, hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.bls_exp, X5W_U32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.strength_attr.strength, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.strength_attr.high_strength, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.strength_attr.low_strength, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.contrast, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.entropy_enable, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.entropy_base, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.entropy_slope, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.wdr_luma_thr, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_attr.flat_mode, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_attr.flat_evel, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_attr.flat_level_inc, X5W_U8, 68, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.ltm_attr.dark_attention_level, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_weight_attr.fixed_weight, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.wdr_curve_select, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.log_weight, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.log_anchor_xlog, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.log_anchor_slope, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.ratio_actual, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_thr, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_losat, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_lofactor, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_hifactor, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gtm_attr.flat_level_global, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.degamma_attr.degamma, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gain_limitation_attr.max_gain, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.gain_limitation_attr.min_gain, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.defringe_attr.diff_high, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.defringe_attr.diff_low, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.sat_adjust_attr.sat_range, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.sat_adjust_attr.sat_thr_gain_down, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.sat_adjust_attr.sat_thr_gain_up, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_sat_lothr, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_sat_hithr, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_red_thr_log, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_green_thr_log, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_blue_thr_log, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_yellow_thr_log, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_cyan_thr_log, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_magenta_thr_log, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.high_light_attr.hlc_base_log, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.high_light_attr.hlc_slope, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.light_en, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_mode, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_curve_coef, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_curve_max, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_curve_min, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_avg_coef, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_avg_max, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_avg_min, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_coef_dec_limit, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_coef_inc_limit, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_filter_size, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_hithr_log, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_lothr_log, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.color_weight_attr.wdr_rgb_coef, X5W_U8, 3, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.color_weight_attr.wdr_lightness_weight, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(9, hbn_isp_wdr_attr_t, manual_attr.color_weight_attr.wdr_color_weight, X5W_U8, 3, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.grad_th_min, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.grad_th_max, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.diff_color_coef, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_mode, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_th_low, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_th_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_min, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_max, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.highlight_control_th, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.highlight_control_str, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.deburst_mode, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.pure_g_weight, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.pure_rb_weight, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.pure_g_weight_iso, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.pure_rb_weight_iso, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.a_blue, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.a_red, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.b_blue, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.b_red, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.c_blue, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.c_red, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.center_h_offs, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.cac_attr.center_v_offs, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.demoire_attr.refine_g_th, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.strength, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.t1, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.shift1, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.r1, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.r2, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.denoise_strength, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.defalse_attr.color_str, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.defalse_attr.cbcr_class_th, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.defalse_attr.gray_protect_str, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.grad_control, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.protect_th_low, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.protect_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.thr, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cbcr_mode, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.sat_shrink, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.color_range_mode, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cb_lowth, X5W_U8, 2, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cb_highth, X5W_U8, 2, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cr_lowth, X5W_U8, 2, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cr_highth, X5W_U8, 2, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.interp_corner_attr.inter_dir_strength, X5W_U8, 4, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.interp_corner_attr.interp_large_str, X5W_U8, 2, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.interp_corner_attr.dir0_interp_type, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.decline_attr.corner_low_th, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(10, hbn_isp_dmsc_attr_t, manual_attr.decline_attr.corner_shift, X5W_U8, 1, NAN, NAN, 0),
 /* Installed SDK storage is uint16_t sharp_gain[20][2]. No official
  * field range is established, so expose this single AUTO slot read-only. */
 {11, "auto_attr.sharp_gain_0_0", offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_gain[0][0]),
   X5W_U16, 1, NAN, NAN, 0},
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.src_strength, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.src_strength_skin, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.edge_nr_lvl, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.edge_scale, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.edge_use_auxi_dir, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.detail_lvl, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.detail_scaler, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.detail_pre_enhance_str, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.detect_str, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_y_min, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_y_max, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cr_min, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cr_max, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cb_min, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cb_max, X5W_I16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t0, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t1_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t2, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t3_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t0, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t1_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t2, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t3_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_edge, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_detail, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_edge_skin, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_detail_skin, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.strength, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_curve_lvl, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_skin_curve_lvl, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain.up, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain.down, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain_skin.up, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain_skin.down, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain_uv, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit_type, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit.up, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit.down, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit_skin.up, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit_skin.down, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_detect_range, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_u_up_limit, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_u_down_limit, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_v_up_limit, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_v_down_limit, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_detect_luma_th, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_detect_luma_diff, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_comp_luma_diff, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_sat_str, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_fix_str, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.ca_attr.lut_chroma_tbl, X5W_U16, 65, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.ca_attr.ca_mode, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.dci_attr.degamma, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(11, hbn_isp_ee_attr_t, manual_attr.dci_attr.lut_luma_tbl, X5W_U16, 65, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.bpt_enable, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.bpt_num, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.bpt_out_mode, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.bpt_pos_x, X5W_U16, 2048, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.bpt_pos_y, X5W_U16, 2048, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.line_mad_fac, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.line_thresh, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.methods_set, X5W_U16, 3, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.out_mode, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.pg_fac, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.rg_fac, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.rnd_offs, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.rnd_thresh, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.ro_limits, X5W_U8, 6, NAN, NAN, 0),
 X5W_FIELD(12, hbn_isp_dpcc_attr_t, manual_attr.set_use, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, rg_proj_indoor_min, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, rg_proj_max, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, k_factor, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, center_line.rg, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, center_line.bg, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, center_line.d, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, fade1.fade, X5W_F32, 16, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, fade1.gain_dist, X5W_F32, 16, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, fade2.fade, X5W_F32, 16, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, fade2.gain_dist, X5W_F32, 16, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[0].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[1].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[2].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[3].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[4].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[5].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[6].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[7].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[8].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profiles[9].manual_wb, X5W_F32, 4, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.iir_add, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.iir_sub, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.iir_threshold, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.iir_min, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.iir_max, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.iir_coef_init, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, iir.filter_item_number, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(20, hbn_isp_awb_calib_t, illu_profile_number, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[0].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[0].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[0].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[0].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[1].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[1].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[1].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[1].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[2].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[2].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[2].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[2].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[3].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[3].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[3].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[3].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[4].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[4].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[4].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[4].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[5].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[5].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[5].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[5].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[6].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[6].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[6].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[6].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[7].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[7].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[7].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[7].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[8].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[8].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[8].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[8].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[9].matrixs[0].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[9].matrixs[1].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[9].matrixs[2].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, calib_profiles[9].matrixs[3].coeff, X5W_U16, 1089, NAN, NAN, 0),
 X5W_FIELD(21, hbn_isp_lsc_calib_t, valid_num, X5W_I32, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, bls, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, hist_threshold, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, gamma, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, hw_roi, X5W_U16, 4, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.iir_highpass_y, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.iir_highpass_x, X5W_U8, 4, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.iir_lowpass_y, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.iir_lowpass_x, X5W_U8, 4, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.fir_highpass_y, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.fir_highpass_x, X5W_U8, 4, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.fir_lowpass_y, X5W_F32, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, ldg.fir_lowpass_x, X5W_U8, 4, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, coring.iir_highpass, X5W_U8, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, coring.iir_lowpass, X5W_U8, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, coring.fir_highpass, X5W_U8, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, coring.fir_lowpass, X5W_U8, 3, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, iir.data_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, iir.data_shift_v, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, iir.highpass_weight, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, iir.lowpass_weight, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, iir.highpass_coeff, X5W_F32, 12, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, iir.lowpass_coeff, X5W_F32, 12, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.data_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.data_shift_v, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.highpass_weight, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.lowpass_weight, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.highdata_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.highdata_shift_v, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.lowdata_shift, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.lowdata_shift_v, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.highpass_coeff, X5W_U8, 2, NAN, NAN, 0),
 X5W_FIELD(22, hbn_isp_afm_attr_t, fir.lowpass_coeff, X5W_U8, 4, NAN, NAN, 0),
 X5W_FIELD(23, hbn_isp_hist_t, window.h_offset, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(23, hbn_isp_hist_t, window.v_offset, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(23, hbn_isp_hist_t, window.width, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(23, hbn_isp_hist_t, window.height, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, position, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.af_mode, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.stable_tolerance, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.points_of_curve, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.min_focal, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.max_focal, X5W_U16, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.motion_threshold, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.uphill_allowance, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.downhill_allowance, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.pdconf_threshold, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.pdshift_threshold, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.pdstable_count_max, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.pdaf_unlock_threshold, X5W_F32, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.defocus_framenum, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.lossconfidence_framenum, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.accurate_focus_step, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(24, hbn_isp_af_attr_t, auto_attr.accurate_focus_enable, X5W_U8, 1, NAN, NAN, 0),
 X5W_FIELD(25, hbn_isp_rgbir_attr_t, cc_matrix, X5W_F32, 12, NAN, NAN, 0),
 X5W_FIELD(25, hbn_isp_rgbir_attr_t, dpcc_mid_th, X5W_U16, 4, NAN, NAN, 0),
 X5W_FIELD(25, hbn_isp_rgbir_attr_t, dpcc_th, X5W_U16, 4, NAN, NAN, 0),
 X5W_FIELD(25, hbn_isp_rgbir_attr_t, ir_threshold, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(25, hbn_isp_rgbir_attr_t, l_threshold, X5W_U32, 1, NAN, NAN, 0),
 X5W_FIELD(26, hbn_isp_afmv1_attr_t, threshold, X5W_U32, 1, NAN, NAN, 0)
};
#undef X5W_FIELD
#undef X5W_MODE

static const x5w_field_desc *x5w_field(int module, int index)
{
    if (index < 0) return NULL;
    for (size_t i = 0; i < sizeof(x5w_fields) / sizeof(x5w_fields[0]); ++i)
        if (x5w_fields[i].module == module && index-- == 0) return &x5w_fields[i];
    return NULL;
}

int x5w_module_field_count(int module)
{
    if (!x5w_module_size(module)) return X5W_UNSUPPORTED;
    int count = 0;
    for (size_t i = 0; i < sizeof(x5w_fields) / sizeof(x5w_fields[0]); ++i)
        if (x5w_fields[i].module == module) ++count;
    return count;
}

int x5w_module_field_info(int module, int index, char *name, size_t namecap,
                          size_t *offset, int *type, size_t *count,
                          double *low, double *high, int *editable)
{
    const x5w_field_desc *field = x5w_field(module, index);
    if (!field) return X5W_UNSUPPORTED;
    if (!name || !offset || !type || !count || !low || !high || !editable) return -EINVAL;
    if (strlen(field->name) + 1 > namecap) return -ENOSPC;
    memcpy(name, field->name, strlen(field->name) + 1);
    *offset = field->offset; *type = field->type; *count = field->count;
    *low = field->low; *high = field->high; *editable = field->editable;
    return 0;
}

static int x5w_mode_valid(hbn_isp_mode_e mode)
{
    return mode == HBN_ISP_MODE_AUTO || mode == HBN_ISP_MODE_MANUAL;
}

static void x5w_ae_limits_update(x5w_context *ctx, const hbn_isp_exposure_attr_t *attr)
{
    const hbn_isp_param_range_t *exposure = &attr->auto_attr.exp_time_range;
    const hbn_isp_param_range_t *gain = &attr->auto_attr.again_range;
    if (isfinite(exposure->min) && isfinite(exposure->max) && exposure->min > 0 &&
        exposure->max >= exposure->min && isfinite(gain->min) && isfinite(gain->max) &&
        gain->min > 0 && gain->max >= gain->min) {
        ctx->ae_exposure_limits = *exposure;
        ctx->ae_gain_limits = *gain;
        ctx->ae_limits_valid = 1;
    }
}

/* This configures a host-side operator policy, not ISP or sensor capabilities.
 * Ceil/floor to representable f32 values never expands the supplied interval. */
int x5w_awb_limits_set(void *opaque, double low, double high)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !isfinite(low) || !isfinite(high) || low <= 0 || high < low || high > FLT_MAX)
        return -EINVAL;
    float lo = (float)low, hi = (float)high;
    if ((double)lo < low) lo = nextafterf(lo, INFINITY);
    if ((double)hi > high) hi = nextafterf(hi, -INFINITY);
    if (lo > hi || lo <= 0) return -ERANGE;
    pthread_mutex_lock(&ctx->lock);
    ctx->awb_min = lo; ctx->awb_max = hi; ctx->awb_limits_set = 1;
    pthread_mutex_unlock(&ctx->lock); return 0;
}

/* SDK exposure uses float seconds; microsecond representation is a double
 * conversion of that float. It cannot be rounded as a float microsecond value.
 * No artificial line-period step is attached to an off-grid SDK getter value. */
int x5w_control_quantize(void *opaque, int key, double input, double *out)
{
    if (!context(opaque) || !out || !isfinite(input)) return -EINVAL;
    if (key == X5W_AUTO_EXPOSURE || key == X5W_AUTO_WHITE_BALANCE) {
        if (input != 0 && input != 1) return -ERANGE;
        *out = input; return 0;
    }
    if (key < X5W_EXPOSURE_US || key > X5W_HUE) return X5W_UNSUPPORTED;
    double value = key == X5W_EXPOSURE_US ? (double)(float)(input / 1000000.0) * 1000000.0 :
                   (double)(float)input;
    if (!isfinite(value)) return -ERANGE;
    *out = value; return 0;
}

int x5w_extended_control_get(void *opaque, int key, double *value, double *low, double *high,
                            double *step, int *writable, int *active)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !value || !low || !high || !step || !writable || !active) return -EINVAL;
    if (key < X5W_AUTO_EXPOSURE || key > X5W_BLUE_GAIN) return X5W_UNSUPPORTED;
    pthread_mutex_lock(&ctx->lock);
    int ret = -ENODEV;
    if (!ctx->isp_open) goto done;
    *step = 0;
    if (key <= X5W_GAIN) {
        hbn_isp_exposure_attr_t attr = {0};
        ret = hbn_isp_get_exposure_attr(ctx->isp, &attr);
        if (ret != 0) goto done;
        if (!x5w_mode_valid(attr.mode) || attr.version > HBN_ISP_EXP_V2) { ret = X5W_UNSUPPORTED; goto done; }
        x5w_ae_limits_update(ctx, &attr);
        if (key == X5W_AUTO_EXPOSURE) {
            *value = attr.mode == HBN_ISP_MODE_AUTO; *low = 0; *high = 1; *step = 1;
            *active = *writable = 1;
        } else {
            if (!ctx->ae_limits_valid) { ret = X5W_UNSUPPORTED; goto done; }
            const hbn_isp_param_range_t *range = key == X5W_EXPOSURE_US ?
                &ctx->ae_exposure_limits : &ctx->ae_gain_limits;
            double scale = key == X5W_EXPOSURE_US ? 1000000.0 : 1.0;
            *value = (key == X5W_EXPOSURE_US ? (double)attr.manual_attr.exp_time :
                     (double)attr.manual_attr.again) * scale;
            *low = (double)range->min * scale; *high = (double)range->max * scale;
            if (!isfinite(*value) || *value < *low || *value > *high) {
                ret = attr.mode == HBN_ISP_MODE_AUTO ? X5W_UNSUPPORTED : -ERANGE; goto done;
            }
            *active = *writable = attr.mode == HBN_ISP_MODE_MANUAL;
        }
    } else {
        hbn_isp_awb_attr_t attr = {0};
        ret = hbn_isp_get_awb_attr(ctx->isp, &attr);
        if (ret != 0) goto done;
        if (!x5w_mode_valid(attr.mode) || attr.version > HBN_ISP_WB_V1) { ret = X5W_UNSUPPORTED; goto done; }
        if (key == X5W_AUTO_WHITE_BALANCE) {
            *value = attr.mode == HBN_ISP_MODE_AUTO; *low = 0; *high = 1; *step = 1;
            *active = *writable = 1;
        } else {
            if (!ctx->awb_limits_set) { ret = X5W_UNSUPPORTED; goto done; }
            *value = key == X5W_RED_GAIN ? attr.manual_attr.gain.rgain : attr.manual_attr.gain.bgain;
            *low = ctx->awb_min; *high = ctx->awb_max;
            if (!isfinite(*value) || *value < *low || *value > *high) {
                ret = attr.mode == HBN_ISP_MODE_AUTO ? X5W_UNSUPPORTED : -ERANGE; goto done;
            }
            *active = *writable = attr.mode == HBN_ISP_MODE_MANUAL;
        }
    }
done:
    pthread_mutex_unlock(&ctx->lock); return ret;
}

int x5w_extended_control_set(void *opaque, int key, double value)
{
    x5w_context *ctx = context(opaque);
    if (!ctx) return -EINVAL;
    if (key < X5W_AUTO_EXPOSURE || key > X5W_BLUE_GAIN) return X5W_UNSUPPORTED;
    double quantized;
    int ret = x5w_control_quantize(opaque, key, value, &quantized);
    if (ret != 0) return ret;
    if (quantized != value) return -ERANGE; /* Canonicalize before candidate hashing. */
    pthread_mutex_lock(&ctx->lock);
    ret = -ENODEV;
    if (!ctx->isp_open) goto done;
    if (key <= X5W_GAIN) {
        hbn_isp_exposure_attr_t attr = {0};
        ret = hbn_isp_get_exposure_attr(ctx->isp, &attr);
        if (ret != 0) goto done;
        if (!x5w_mode_valid(attr.mode) || attr.version > HBN_ISP_EXP_V2) { ret = X5W_UNSUPPORTED; goto done; }
        x5w_ae_limits_update(ctx, &attr);
        if (key == X5W_AUTO_EXPOSURE) {
            if (value == 0 && (!isfinite(attr.manual_attr.exp_time) || attr.manual_attr.exp_time <= 0 ||
                !isfinite(attr.manual_attr.again) || attr.manual_attr.again <= 0 ||
                !isfinite(attr.manual_attr.dgain) || attr.manual_attr.dgain <= 0 ||
                !isfinite(attr.manual_attr.ispgain) || attr.manual_attr.ispgain <= 0)) { ret = -ERANGE; goto done; }
            attr.mode = value ? HBN_ISP_MODE_AUTO : HBN_ISP_MODE_MANUAL;
        } else {
            if (attr.mode != HBN_ISP_MODE_MANUAL) { ret = -EACCES; goto done; }
            if (!ctx->ae_limits_valid) { ret = X5W_UNSUPPORTED; goto done; }
            hbn_isp_param_range_t range = key == X5W_EXPOSURE_US ? ctx->ae_exposure_limits : ctx->ae_gain_limits;
            float requested = key == X5W_EXPOSURE_US ? (float)(value / 1000000.0) : (float)value;
            if (requested < range.min || requested > range.max) { ret = -ERANGE; goto done; }
            if (key == X5W_EXPOSURE_US) attr.manual_attr.exp_time = requested;
            else attr.manual_attr.again = requested;
        }
        ret = x5w_module_set_locked(ctx, 0, &attr);
    } else {
        hbn_isp_awb_attr_t attr = {0};
        ret = hbn_isp_get_awb_attr(ctx->isp, &attr);
        if (ret != 0) goto done;
        if (!x5w_mode_valid(attr.mode) || attr.version > HBN_ISP_WB_V1) { ret = X5W_UNSUPPORTED; goto done; }
        if (key == X5W_AUTO_WHITE_BALANCE) {
            if (value == 0 && (!isfinite(attr.manual_attr.gain.rgain) || attr.manual_attr.gain.rgain <= 0 ||
                !isfinite(attr.manual_attr.gain.grgain) || attr.manual_attr.gain.grgain <= 0 ||
                !isfinite(attr.manual_attr.gain.gbgain) || attr.manual_attr.gain.gbgain <= 0 ||
                !isfinite(attr.manual_attr.gain.bgain) || attr.manual_attr.gain.bgain <= 0)) { ret = -ERANGE; goto done; }
            attr.mode = value ? HBN_ISP_MODE_AUTO : HBN_ISP_MODE_MANUAL;
        } else {
            if (attr.mode != HBN_ISP_MODE_MANUAL) { ret = -EACCES; goto done; }
            if (!ctx->awb_limits_set) { ret = X5W_UNSUPPORTED; goto done; }
            if (value < ctx->awb_min || value > ctx->awb_max) { ret = -ERANGE; goto done; }
            if (key == X5W_RED_GAIN) attr.manual_attr.gain.rgain = (float)value;
            else attr.manual_attr.gain.bgain = (float)value;
        }
        ret = x5w_module_set_locked(ctx, 1, &attr);
    }
done:
    pthread_mutex_unlock(&ctx->lock); return ret;
}

/* A successful call means the real SDK scene API accepted the private filename
 * and mandatory module getters subsequently succeeded. The Python owner must
 * obtain/store those actual snapshots and validate requested semantic fields;
 * a filename or its SHA is never used as a fabricated module readback hash. */
int x5w_tuning_load(void *opaque, const char *private_path)
{
    x5w_context *ctx = context(opaque);
    if (!ctx || !private_path || private_path[0] != '/') return -EINVAL;
    size_t n = strlen(private_path);
    if (n < 6 || n > 100 || strcmp(private_path + n - 5, ".json") != 0) return -EINVAL;
    struct stat st;
    if (stat(private_path, &st) != 0) return -errno;
    if (!S_ISREG(st.st_mode) || st.st_size <= 0) return -EINVAL;
    pthread_mutex_lock(&ctx->lock);
    int ret = -ENODEV;
    if (!ctx->flow_open || !ctx->isp_open) goto done;
    if (ctx->replay_state) { ret = -EBUSY; goto done; }
    ctx->ae_limits_valid = 0; /* A different tuning can change the reported limits. */
    ret = hbn_camera_switch_scence(ctx->flow, ctx->isp, private_path);
    if (ret != 0) goto done;
    unsigned mandatory = 0;
    int first_error = 0;
    for (int module = 0; module <= 26; ++module) {
        size_t bytes = x5w_module_size(module);
        void *actual = calloc(1, bytes);
        if (!actual) { ret = -ENOMEM; goto done; }
        int get_ret = x5w_module_sdk_get(ctx->isp, module, actual);
        if (module <= 3) {
            if (get_ret == 0) mandatory |= 1u << module;
            else if (!first_error) first_error = get_ret;
        }
        free(actual);
    }
    ret = mandatory == 15 ? 0 : first_error ? first_error : -EIO;
done:
    pthread_mutex_unlock(&ctx->lock); return ret;
}

/* Semantic field coverage derived from reviewed official SDK headers. */
static int x5w_module_padding_clear(int module, void *data, size_t n)
{
    unsigned char *mask = calloc(1, n);
    if (!mask) return -ENOMEM;
    switch (module) {
    case 0:
        memset(mask + offsetof(hbn_isp_exposure_attr_t, version), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->version));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, lock_state), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->lock_state));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, mode), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.exp_time_range.min), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.exp_time_range.min));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.exp_time_range.max), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.exp_time_range.max));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.again_range.min), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.again_range.min));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.again_range.max), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.again_range.max));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.dgain_range.min), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.dgain_range.min));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.dgain_range.max), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.dgain_range.max));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.isp_dgain_range.min), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.isp_dgain_range.min));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.isp_dgain_range.max), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.isp_dgain_range.max));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.speed_over), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.speed_over));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.speed_under), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.speed_under));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.dampover_gain), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.dampover_gain));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.dampover_ratio), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.dampover_ratio));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.dampunder_gain), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.dampunder_gain));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.dampunder_ratio), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.dampunder_ratio));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.tolerance), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.tolerance));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.target), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.target));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.anti_flicker_status), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.anti_flicker_status));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.flicker_freq), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.flicker_freq));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, auto_attr.mode), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->auto_attr.mode));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.exp_time), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.exp_time));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.again), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.again));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.dgain), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.dgain));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.ispgain), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.ispgain));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.ae_exp), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.ae_exp));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.cur_lux), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.cur_lux));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.frame_id), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.frame_id));
        memset(mask + offsetof(hbn_isp_exposure_attr_t, manual_attr.timestamps), 1, sizeof(((hbn_isp_exposure_attr_t *)0)->manual_attr.timestamps));
        break;
    case 1:
        memset(mask + offsetof(hbn_isp_awb_attr_t, version), 1, sizeof(((hbn_isp_awb_attr_t *)0)->version));
        memset(mask + offsetof(hbn_isp_awb_attr_t, lock_state), 1, sizeof(((hbn_isp_awb_attr_t *)0)->lock_state));
        memset(mask + offsetof(hbn_isp_awb_attr_t, mode), 1, sizeof(((hbn_isp_awb_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.use_damping), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.use_damping));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.use_manual_damp_coff), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.use_manual_damp_coff));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.manual_damp_coff), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.manual_damp_coff));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.lock_tolerance), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.lock_tolerance));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.unlock_tolerance), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.unlock_tolerance));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.rg_strength), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.rg_strength));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.bg_strength), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.bg_strength));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.gain.rgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.gain.rgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.gain.grgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.gain.grgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.gain.gbgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.gain.gbgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.gain.bgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.gain.bgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, auto_attr.temper), 1, sizeof(((hbn_isp_awb_attr_t *)0)->auto_attr.temper));
        memset(mask + offsetof(hbn_isp_awb_attr_t, manual_attr.gain.rgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->manual_attr.gain.rgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, manual_attr.gain.grgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->manual_attr.gain.grgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, manual_attr.gain.gbgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->manual_attr.gain.gbgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, manual_attr.gain.bgain), 1, sizeof(((hbn_isp_awb_attr_t *)0)->manual_attr.gain.bgain));
        memset(mask + offsetof(hbn_isp_awb_attr_t, manual_attr.temper), 1, sizeof(((hbn_isp_awb_attr_t *)0)->manual_attr.temper));
        break;
    case 2:
        memset(mask + offsetof(hbn_isp_module_ctrl_t, version), 1, sizeof(((hbn_isp_module_ctrl_t *)0)->version));
        memset(mask + offsetof(hbn_isp_module_ctrl_t, module.u32Key), 1, sizeof(((hbn_isp_module_ctrl_t *)0)->module.u32Key));
        break;
    case 3:
        memset(mask + offsetof(hbn_isp_cproc_attr_t, mode), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, auto_attr.gains), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->auto_attr.gains));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, auto_attr.contrast), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->auto_attr.contrast));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, auto_attr.bright), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->auto_attr.bright));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, auto_attr.saturation), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->auto_attr.saturation));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, auto_attr.hue), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->auto_attr.hue));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, manual_attr.contrast), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->manual_attr.contrast));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, manual_attr.bright), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->manual_attr.bright));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, manual_attr.saturation), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->manual_attr.saturation));
        memset(mask + offsetof(hbn_isp_cproc_attr_t, manual_attr.hue), 1, sizeof(((hbn_isp_cproc_attr_t *)0)->manual_attr.hue));
        break;
    case 4:
        memset(mask + offsetof(hbn_isp_lsc_attr_t, mode), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, manual_attr.matrix), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->manual_attr.matrix));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, manual_attr.x_size), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->manual_attr.x_size));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, manual_attr.y_size), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->manual_attr.y_size));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, auto_attr.gains), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->auto_attr.gains));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, auto_attr.damping), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->auto_attr.damping));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, auto_attr.strength), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->auto_attr.strength));
        memset(mask + offsetof(hbn_isp_lsc_attr_t, auto_attr.inter_mode), 1, sizeof(((hbn_isp_lsc_attr_t *)0)->auto_attr.inter_mode));
        break;
    case 5:
        memset(mask + offsetof(hbn_isp_ccm_attr_t, manual_attr.cc_matrix), 1, sizeof(((hbn_isp_ccm_attr_t *)0)->manual_attr.cc_matrix));
        memset(mask + offsetof(hbn_isp_ccm_attr_t, manual_attr.cc_offset), 1, sizeof(((hbn_isp_ccm_attr_t *)0)->manual_attr.cc_offset));
        memset(mask + offsetof(hbn_isp_ccm_attr_t, configMode), 1, sizeof(((hbn_isp_ccm_attr_t *)0)->configMode));
        break;
    case 6:
        memset(mask + offsetof(hbn_isp_gc_attr_t, mode), 1, sizeof(((hbn_isp_gc_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_gc_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_gc_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_gc_attr_t, auto_attr.gain), 1, sizeof(((hbn_isp_gc_attr_t *)0)->auto_attr.gain));
        memset(mask + offsetof(hbn_isp_gc_attr_t, auto_attr.curve), 1, sizeof(((hbn_isp_gc_attr_t *)0)->auto_attr.curve));
        memset(mask + offsetof(hbn_isp_gc_attr_t, manual_attr.standard), 1, sizeof(((hbn_isp_gc_attr_t *)0)->manual_attr.standard));
        memset(mask + offsetof(hbn_isp_gc_attr_t, manual_attr.standard_val), 1, sizeof(((hbn_isp_gc_attr_t *)0)->manual_attr.standard_val));
        memset(mask + offsetof(hbn_isp_gc_attr_t, manual_attr.curve), 1, sizeof(((hbn_isp_gc_attr_t *)0)->manual_attr.curve));
        memset(mask + offsetof(hbn_isp_gc_attr_t, manual_attr.user_curve_x), 1, sizeof(((hbn_isp_gc_attr_t *)0)->manual_attr.user_curve_x));
        memset(mask + offsetof(hbn_isp_gc_attr_t, manual_attr.curve_px), 1, sizeof(((hbn_isp_gc_attr_t *)0)->manual_attr.curve_px));
        break;
    case 7:
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, mode), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.blend_static), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.blend_static));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.blend_motion), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.blend_motion));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.blend_slope), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.blend_slope));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.vst_factor), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.vst_factor));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.sigma_scale), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.sigma_scale));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.sigma_factor_mul), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.sigma_factor_mul));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.sigma_factor_motion_max), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.sigma_factor_motion_max));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.sigma_factor_motion_min), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.sigma_factor_motion_min));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.sigma_offset), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.sigma_offset));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.static_detail_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.static_detail_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.static_detail_boost_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.static_detail_boost_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.static_detail_boost), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.static_detail_boost));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.static_detail_clip_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.static_detail_clip_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.moving_detail_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.moving_detail_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.moving_detail_boost_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.moving_detail_boost_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.moving_detail_boost), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.moving_detail_boost));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.moving_detail_clip_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.moving_detail_clip_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.static_factor), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.static_factor));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.ary_x), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.luma_curve_cfg.ary_x));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.ary_y), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.luma_curve_cfg.ary_y));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.ary_px), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.luma_curve_cfg.ary_px));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.luma_curve_cfg.interp_mode), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.luma_curve_cfg.interp_mode));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.ary_x), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.lsc_comp_curve_cfg.ary_x));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.ary_y), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.lsc_comp_curve_cfg.ary_y));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.ary_px), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.lsc_comp_curve_cfg.ary_px));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.lsc_comp_curve_cfg.interp_mode), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.lsc_comp_curve_cfg.interp_mode));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.motion_anchor_x), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.motion_cfg.motion_anchor_x));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.ary_x), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.motion_cfg.curve_cfg.ary_x));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.ary_y), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.motion_cfg.curve_cfg.ary_y));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.ary_px), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.motion_cfg.curve_cfg.ary_px));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, manual_attr.motion_cfg.curve_cfg.interp_mode), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->manual_attr.motion_cfg.curve_cfg.interp_mode));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.gain), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.gain));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.vst_factor), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.vst_factor));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.blend_static), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.blend_static));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.blend_motion), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.blend_motion));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.blend_slope), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.blend_slope));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.sigma_offset), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.sigma_offset));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.luma_curve_y), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.luma_curve_y));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.lsc_comp_curve_y), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.lsc_comp_curve_y));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.motion_fac_curve_y), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.motion_fac_curve_y));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.motion_anchor_x), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.motion_anchor_x));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.static_detail_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.static_detail_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.static_detail_boost_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.static_detail_boost_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.static_detail_boost), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.static_detail_boost));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.static_detail_clip_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.static_detail_clip_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.moving_detail_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.moving_detail_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.moving_detail_boost_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.moving_detail_boost_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.moving_detail_boost), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.moving_detail_boost));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.moving_detail_clip_thresh), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.moving_detail_clip_thresh));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.sigma_scale), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.sigma_scale));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.static_factor), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.static_factor));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.sigma_factor_mul), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.sigma_factor_mul));
        memset(mask + offsetof(hbn_isp_2dnr_attr_t, auto_attr.sigma_factor_motion_max), 1, sizeof(((hbn_isp_2dnr_attr_t *)0)->auto_attr.sigma_factor_motion_max));
        break;
    case 8:
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, mode), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.vst_factor), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.vst_factor));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.tnr_strength), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.tnr_strength));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.tnr_strength2), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.tnr_strength2));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.filter_len), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.filter_len));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.filter_len2), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.filter_len2));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.motion_smooth_factor), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.motion_smooth_factor));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.range_h), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.range_h));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.sad_weight), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.sad_weight));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.diff_type), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.diff_type));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.sqr_diff_factor), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.sqr_diff_factor));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.motion_smooth_lvl), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.motion_smooth_lvl));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.dilate_h), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.dilate_h));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.noise_level), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.noise_level));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.thr_motion_slope), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.thr_motion_slope));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.tnr_luma_curve_x), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.tnr_luma_curve_x));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.tnr_luma_curve_y), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.tnr_luma_curve_y));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.tnr_motion_slop_y), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.tnr_motion_slop_y));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.input_bits), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.noise_cfg.input_bits));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.fix_curve_start), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.noise_cfg.fix_curve_start));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.noisemodel_a), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.noise_cfg.noisemodel_a));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.noisemodel_b), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.noise_cfg.noisemodel_b));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, manual_attr.noise_cfg.bls_exp), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->manual_attr.noise_cfg.bls_exp));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.nm_k), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.nm_k));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.nm_p), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.nm_p));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.gains), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.gains));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.fix_curve_start), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.fix_curve_start));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.noisemodel_a), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.noisemodel_a));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.noisemodel_b), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.noisemodel_b));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.bls_exp), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.bls_exp));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.tnr_strength), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.tnr_strength));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.tnr_strength2), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.tnr_strength2));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.filter_len), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.filter_len));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.filter_len2), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.filter_len2));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.motion_smooth_factor), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.motion_smooth_factor));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.range_h), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.range_h));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.sad_weight), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.sad_weight));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.sqr_diff_factor), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.sqr_diff_factor));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.motion_smooth_lvl), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.motion_smooth_lvl));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.motion_dilate_en), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.motion_dilate_en));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.dilate_h), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.dilate_h));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.tnr_luma_curve_y), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.tnr_luma_curve_y));
        memset(mask + offsetof(hbn_isp_3dnr_attr_t, auto_attr.tnr_motion_slop_y), 1, sizeof(((hbn_isp_3dnr_attr_t *)0)->auto_attr.tnr_motion_slop_y));
        break;
    case 9:
        memset(mask + offsetof(hbn_isp_wdr_attr_t, mode), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.gain), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.gain));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.high_strength), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.high_strength));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.low_strength), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.low_strength));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.entropy_base), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.entropy_base));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.wdr_luma_thr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.wdr_luma_thr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.entropy_slope), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.entropy_slope));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.flat_level), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.flat_level));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.flat_level_global), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.flat_level_global));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.sat_range), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.sat_range));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.sat_thr_gaindown), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.sat_thr_gaindown));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.sat_thr_gainup), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.sat_thr_gainup));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.degamma), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.degamma));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.hlc_base_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.hlc_base_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_sat_lothr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_sat_lothr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_sat_hithr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_sat_hithr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_red_thrlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_red_thrlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_green_thrlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_green_thrlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_blue_thrlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_blue_thrlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_yellow_thrlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_yellow_thrlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_cyan_thrlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_cyan_thrlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_magenta_thrlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_magenta_thrlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.contrast), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.contrast));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.fixed_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.fixed_weight));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.log_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.log_weight));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.log_anchor_xlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.log_anchor_xlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.log_anchor_slope), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.log_anchor_slope));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.max_gain), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.max_gain));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.hlc_slope), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.hlc_slope));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.light_en), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.light_en));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, auto_attr.wdr_color_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->auto_attr.wdr_color_weight));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.strength_attr.strength), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.strength_attr.strength));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.strength_attr.high_strength), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.strength_attr.high_strength));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.strength_attr.low_strength), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.strength_attr.low_strength));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.contrast), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_weight_attr.contrast));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.entropy_enable), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_weight_attr.entropy_enable));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.entropy_base), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_weight_attr.entropy_base));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.entropy_slope), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_weight_attr.entropy_slope));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_weight_attr.wdr_luma_thr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_weight_attr.wdr_luma_thr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_attr.flat_mode), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_attr.flat_mode));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_attr.flat_evel), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_attr.flat_evel));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_attr.flat_level_inc), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_attr.flat_level_inc));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.ltm_attr.dark_attention_level), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.ltm_attr.dark_attention_level));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_weight_attr.fixed_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_weight_attr.fixed_weight));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.wdr_curve_select), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.wdr_curve_select));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.log_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.log_weight));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.log_anchor_xlog), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.log_anchor_xlog));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.log_anchor_slope), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.log_anchor_slope));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.ratio_actual), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.ratio_actual));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_thr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.curve2_thr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_losat), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.curve2_losat));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_lofactor), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.curve2_lofactor));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.curve2_hifactor), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.curve2_hifactor));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gtm_attr.flat_level_global), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gtm_attr.flat_level_global));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.degamma_attr.degamma), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.degamma_attr.degamma));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gain_limitation_attr.max_gain), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gain_limitation_attr.max_gain));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.gain_limitation_attr.min_gain), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.gain_limitation_attr.min_gain));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.defringe_attr.diff_high), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.defringe_attr.diff_high));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.defringe_attr.diff_low), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.defringe_attr.diff_low));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.sat_adjust_attr.sat_range), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.sat_adjust_attr.sat_range));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.sat_adjust_attr.sat_thr_gain_down), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.sat_adjust_attr.sat_thr_gain_down));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.sat_adjust_attr.sat_thr_gain_up), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.sat_adjust_attr.sat_thr_gain_up));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_sat_lothr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_sat_lothr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_sat_hithr), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_sat_hithr));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_red_thr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_red_thr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_green_thr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_green_thr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_blue_thr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_blue_thr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_yellow_thr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_yellow_thr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_cyan_thr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_cyan_thr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.halo_color_fading_attr.light_magenta_thr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.halo_color_fading_attr.light_magenta_thr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.high_light_attr.hlc_base_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.high_light_attr.hlc_base_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.high_light_attr.hlc_slope), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.high_light_attr.hlc_slope));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.light_en), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.light_en));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_mode), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_mode));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_curve_coef), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_curve_coef));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_curve_max), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_curve_max));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_curve_min), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_curve_min));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_avg_coef), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_avg_coef));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_avg_max), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_avg_max));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_avg_min), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_avg_min));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_coef_dec_limit), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_coef_dec_limit));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_coef_inc_limit), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_coef_inc_limit));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_filter_size), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_filter_size));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_hithr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_hithr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.damp_attr.damp_lothr_log), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.damp_attr.damp_lothr_log));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.color_weight_attr.wdr_rgb_coef), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.color_weight_attr.wdr_rgb_coef));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.color_weight_attr.wdr_lightness_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.color_weight_attr.wdr_lightness_weight));
        memset(mask + offsetof(hbn_isp_wdr_attr_t, manual_attr.color_weight_attr.wdr_color_weight), 1, sizeof(((hbn_isp_wdr_attr_t *)0)->manual_attr.color_weight_attr.wdr_color_weight));
        break;
    case 10:
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, mode), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.grad_th_min), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.grad_th_min));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.grad_th_max), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.grad_th_max));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.diff_color_coef), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.diff_color_coef));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_mode), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.adpt_coef_mode));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_th_low), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.adpt_coef_th_low));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_th_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.adpt_coef_th_shift));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_min), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.adpt_coef_min));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.adpt_coef_max), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.adpt_coef_max));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.highlight_control_th), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.highlight_control_th));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.highlight_control_str), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.highlight_control_str));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.deburst_mode), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.deburst_mode));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.pure_g_weight), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.pure_g_weight));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.pure_rb_weight), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.pure_rb_weight));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.pure_g_weight_iso), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.pure_g_weight_iso));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.pure_rb_weight_iso), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.pure_rb_weight_iso));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.a_blue), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.a_blue));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.a_red), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.a_red));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.b_blue), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.b_blue));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.b_red), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.b_red));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.c_blue), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.c_blue));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.c_red), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.c_red));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.center_h_offs), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.center_h_offs));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.cac_attr.center_v_offs), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.cac_attr.center_v_offs));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.demoire_attr.refine_g_th), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.demoire_attr.refine_g_th));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.strength), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_line_attr.strength));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.t1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_line_attr.t1));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.shift1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_line_attr.shift1));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.r1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_line_attr.r1));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_line_attr.r2), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_line_attr.r2));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.denoise_strength), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.denoise_strength));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.factor) / sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.factor[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.factor[i0].white), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.factor[i0].white));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.factor[i0].black), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.factor[i0].black));
        }
        for (size_t i1 = 0; i1 < sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.clip) / sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.clip[0]); ++i1) {
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.clip[i1].white), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.clip[i1].white));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.clip[i1].black), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.clip[i1].black));
        }
        for (size_t i2 = 0; i2 < sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve) / sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[0]); ++i2) {
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_t1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_t1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_t2_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_t2_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_t3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_t3));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_t4_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_t4_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_r1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_r1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_r2), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_r2));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.sharpen_attr.curve[i2].layer_r3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.sharpen_attr.curve[i2].layer_r3));
        }
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.defalse_attr.color_str), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.defalse_attr.color_str));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.defalse_attr.cbcr_class_th), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.defalse_attr.cbcr_class_th));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.defalse_attr.gray_protect_str), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.defalse_attr.gray_protect_str));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.grad_control), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.grad_control));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.protect_th_low), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.protect_th_low));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.protect_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.protect_shift));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.thr), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.thr));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cbcr_mode), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.cbcr_mode));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.sat_shrink), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.sat_shrink));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.color_range_mode), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.color_range_mode));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cb_lowth), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.cb_lowth));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cb_highth), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.cb_highth));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cr_lowth), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.cr_lowth));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.depurple_attr.cr_highth), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.depurple_attr.cr_highth));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.interp_corner_attr.inter_dir_strength), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.interp_corner_attr.inter_dir_strength));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.interp_corner_attr.interp_large_str), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.interp_corner_attr.interp_large_str));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.interp_corner_attr.dir0_interp_type), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.interp_corner_attr.dir0_interp_type));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.decline_attr.corner_low_th), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.decline_attr.corner_low_th));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, manual_attr.decline_attr.corner_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->manual_attr.decline_attr.corner_shift));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.gains), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.gains));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.interp_dir_strength), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.interp_dir_strength));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.interp_large_str), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.interp_large_str));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.decline_en), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.decline_en));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.highlight_th), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.highlight_th));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_depurple_enable), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_depurple_enable));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_depurple_thr), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_depurple_thr));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_depurple_sat_shrink), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_depurple_sat_shrink));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_depurple_cbcr_range), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_depurple_cbcr_range));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.denoise_strength), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.denoise_strength));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_enable), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_enable));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_factor), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_factor));
        memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_clip), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_clip));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0) / sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_t1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_t1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_t2_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_t2_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_t3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_t3));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_t4_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_t4_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_r1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_r1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_r2), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_r2));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve0[i0].layer_r3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve0[i0].layer_r3));
        }
        for (size_t i1 = 0; i1 < sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1) / sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[0]); ++i1) {
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_t1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_t1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_t2_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_t2_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_t3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_t3));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_t4_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_t4_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_r1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_r1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_r2), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_r2));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve1[i1].layer_r3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve1[i1].layer_r3));
        }
        for (size_t i2 = 0; i2 < sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2) / sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[0]); ++i2) {
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_t1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_t1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_t2_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_t2_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_t3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_t3));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_t4_shift), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_t4_shift));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_r1), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_r1));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_r2), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_r2));
            memset(mask + offsetof(hbn_isp_dmsc_attr_t, auto_attr.dmsc_sharpen_curve2[i2].layer_r3), 1, sizeof(((hbn_isp_dmsc_attr_t *)0)->auto_attr.dmsc_sharpen_curve2[i2].layer_r3));
        }
        break;
    case 11:
        memset(mask + offsetof(hbn_isp_ee_attr_t, mode), 1, sizeof(((hbn_isp_ee_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.src_strength), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.src_strength));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.src_strength_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.src_strength_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.edge_nr_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.edge_detail_attr.edge_nr_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.edge_scale), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.edge_detail_attr.edge_scale));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.edge_use_auxi_dir), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.edge_detail_attr.edge_use_auxi_dir));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.detail_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.edge_detail_attr.detail_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.detail_scaler), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.edge_detail_attr.detail_scaler));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.edge_detail_attr.detail_pre_enhance_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.edge_detail_attr.detail_pre_enhance_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.detect_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.detect_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_y_min), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.hth_y_min));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_y_max), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.hth_y_max));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cr_min), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.hth_cr_min));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cr_max), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.hth_cr_max));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cb_min), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.hth_cb_min));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.skin_attr.hth_cb_max), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.skin_attr.hth_cb_max));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t0), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve.t0));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t1_shift), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve.t1_shift));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t2), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve.t2));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve.t3_shift), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve.t3_shift));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t0), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve_skin.t0));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t1_shift), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve_skin.t1_shift));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t2), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve_skin.t2));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.merge_curve_attr.hf_merge_curve_skin.t3_shift), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.merge_curve_attr.hf_merge_curve_skin.t3_shift));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_edge), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.noise_cut_off_attr.grad_th_edge));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_detail), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.noise_cut_off_attr.grad_th_detail));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_edge_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.noise_cut_off_attr.grad_th_edge_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.noise_cut_off_attr.grad_th_detail_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.noise_cut_off_attr.grad_th_detail_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.strength), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.strength));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_curve_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_curve_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_skin_curve_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_skin_curve_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain.up), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_gain.up));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain.down), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_gain.down));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain_skin.up), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_gain_skin.up));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain_skin.down), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_gain_skin.down));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_gain_uv), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_gain_uv));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit_type), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_limit_type));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit.up), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_limit.up));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit.down), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_limit.down));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit_skin.up), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_limit_skin.up));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.enhancement_attr.sharp_limit_skin.down), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.enhancement_attr.sharp_limit_skin.down));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_detect_range), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_detect_range));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_u_up_limit), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_u_up_limit));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_u_down_limit), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_u_down_limit));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_v_up_limit), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_v_up_limit));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_v_down_limit), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_v_down_limit));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_detect_luma_th), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_detect_luma_th));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_detect_luma_diff), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_detect_luma_diff));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_comp_luma_diff), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_comp_luma_diff));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_sat_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_sat_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.depurple_attr.depf_fix_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.depurple_attr.depf_fix_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.ca_attr.lut_chroma_tbl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.ca_attr.lut_chroma_tbl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.ca_attr.ca_mode), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.ca_attr.ca_mode));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.dci_attr.degamma), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.dci_attr.degamma));
        memset(mask + offsetof(hbn_isp_ee_attr_t, manual_attr.dci_attr.lut_luma_tbl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->manual_attr.dci_attr.lut_luma_tbl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.gains), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.gains));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.ee_strength), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.ee_strength));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.ee_src_strength), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.ee_src_strength));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.ee_src_strength_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.ee_src_strength_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.edge_nr_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.edge_nr_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.detail_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.detail_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.detail_pre_enhance_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.detail_pre_enhance_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.skin_proc_en), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.skin_proc_en));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.skin_detect_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.skin_detect_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.skin_threshold), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.skin_threshold));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.hf_merge_curve), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.hf_merge_curve));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.hf_merge_curve_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.hf_merge_curve_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.grad_th), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.grad_th));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.grad_th_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.grad_th_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_curve_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_curve_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_skin_curve_lvl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_skin_curve_lvl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_gain), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_gain));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_gain_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_gain_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_gain_uv), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_gain_uv));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_limit), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_limit));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.sharp_limit_skin), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.sharp_limit_skin));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depurple_en), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depurple_en));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depf_limit), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depf_limit));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depf_detect_luma_th), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depf_detect_luma_th));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depf_detect_luma_diff), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depf_detect_luma_diff));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depf_comp_luma_diff), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depf_comp_luma_diff));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depf_sat_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depf_sat_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.depf_fix_str), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.depf_fix_str));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.ca_enable), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.ca_enable));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.lut_chroma_tbl), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.lut_chroma_tbl));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.dci_enable), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.dci_enable));
        memset(mask + offsetof(hbn_isp_ee_attr_t, auto_attr.dci_curve), 1, sizeof(((hbn_isp_ee_attr_t *)0)->auto_attr.dci_curve));
        break;
    case 12:
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, mode), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.bpt_enable), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.bpt_enable));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.bpt_num), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.bpt_num));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.bpt_out_mode), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.bpt_out_mode));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.bpt_pos_x), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.bpt_pos_x));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.bpt_pos_y), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.bpt_pos_y));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.line_mad_fac), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.line_mad_fac));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.line_thresh), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.line_thresh));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.methods_set), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.methods_set));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.out_mode), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.out_mode));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.pg_fac), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.pg_fac));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.rg_fac), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.rg_fac));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.rnd_offs), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.rnd_offs));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.rnd_thresh), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.rnd_thresh));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.ro_limits), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.ro_limits));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, manual_attr.set_use), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->manual_attr.set_use));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.auto_level), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.auto_level));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.gains), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.gains));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.line_mad_fac), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.line_mad_fac));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.line_thresh), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.line_thresh));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.methods_set), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.methods_set));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.out_mode), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.out_mode));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.pg_fac), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.pg_fac));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.rg_fac), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.rg_fac));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.rnd_offs), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.rnd_offs));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.rnd_thresh), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.rnd_thresh));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.ro_limits), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.ro_limits));
        memset(mask + offsetof(hbn_isp_dpcc_attr_t, auto_attr.set_use), 1, sizeof(((hbn_isp_dpcc_attr_t *)0)->auto_attr.set_use));
        break;
    case 13:
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, version), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->version));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, mode), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, auto_attr.exp_ratio), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->auto_attr.exp_ratio));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, auto_attr.exp_ratio_range.min), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->auto_attr.exp_ratio_range.min));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, auto_attr.exp_ratio_range.max), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->auto_attr.exp_ratio_range.max));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, manual_attr.exp_time), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->manual_attr.exp_time));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, manual_attr.again), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->manual_attr.again));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, manual_attr.dgain), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->manual_attr.dgain));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, manual_attr.ispgain), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->manual_attr.ispgain));
        memset(mask + offsetof(hbn_isp_hdr_exposure_attr_t, manual_attr.ae_exp), 1, sizeof(((hbn_isp_hdr_exposure_attr_t *)0)->manual_attr.ae_exp));
        break;
    case 14:
        memset(mask + offsetof(hbn_isp_color_process_attr_t, version), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->version));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, mode), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, auto_attr.total_size), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->auto_attr.total_size));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, auto_attr.gain), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->auto_attr.gain));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, auto_attr.bright), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->auto_attr.bright));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, auto_attr.contrast), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->auto_attr.contrast));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, auto_attr.saturation), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->auto_attr.saturation));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, auto_attr.hue), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->auto_attr.hue));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, manual_attr.total_size), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->manual_attr.total_size));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, manual_attr.bright), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->manual_attr.bright));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, manual_attr.contrast), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->manual_attr.contrast));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, manual_attr.saturation), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->manual_attr.saturation));
        memset(mask + offsetof(hbn_isp_color_process_attr_t, manual_attr.hue), 1, sizeof(((hbn_isp_color_process_attr_t *)0)->manual_attr.hue));
        break;
    case 15:
        memset(mask + offsetof(hbn_isp_ae_zone_weight_attr_t, version), 1, sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->version));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight) / sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_ae_zone_weight_attr_t, weight[i0].x), 1, sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight[i0].x));
            memset(mask + offsetof(hbn_isp_ae_zone_weight_attr_t, weight[i0].y), 1, sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight[i0].y));
            memset(mask + offsetof(hbn_isp_ae_zone_weight_attr_t, weight[i0].h), 1, sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight[i0].h));
            memset(mask + offsetof(hbn_isp_ae_zone_weight_attr_t, weight[i0].w), 1, sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight[i0].w));
            memset(mask + offsetof(hbn_isp_ae_zone_weight_attr_t, weight[i0].weight), 1, sizeof(((hbn_isp_ae_zone_weight_attr_t *)0)->weight[i0].weight));
        }
        break;
    case 16:
        memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, version), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->version));
        memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, attr.func_a_attr.total_size), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.total_size));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight) / sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, attr.func_a_attr.weight[i0].x), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight[i0].x));
            memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, attr.func_a_attr.weight[i0].y), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight[i0].y));
            memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, attr.func_a_attr.weight[i0].h), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight[i0].h));
            memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, attr.func_a_attr.weight[i0].w), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight[i0].w));
            memset(mask + offsetof(hbn_isp_af_zone_weight_attr_t, attr.func_a_attr.weight[i0].weight), 1, sizeof(((hbn_isp_af_zone_weight_attr_t *)0)->attr.func_a_attr.weight[i0].weight));
        }
        break;
    case 17:
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_exposure_table_t *)0)->exp_table) / sizeof(((hbn_isp_exposure_table_t *)0)->exp_table[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_exposure_table_t, exp_table[i0].exposure_time), 1, sizeof(((hbn_isp_exposure_table_t *)0)->exp_table[i0].exposure_time));
            memset(mask + offsetof(hbn_isp_exposure_table_t, exp_table[i0].again), 1, sizeof(((hbn_isp_exposure_table_t *)0)->exp_table[i0].again));
            memset(mask + offsetof(hbn_isp_exposure_table_t, exp_table[i0].dgain), 1, sizeof(((hbn_isp_exposure_table_t *)0)->exp_table[i0].dgain));
            memset(mask + offsetof(hbn_isp_exposure_table_t, exp_table[i0].isp_gain), 1, sizeof(((hbn_isp_exposure_table_t *)0)->exp_table[i0].isp_gain));
        }
        memset(mask + offsetof(hbn_isp_exposure_table_t, valid_num), 1, sizeof(((hbn_isp_exposure_table_t *)0)->valid_num));
        break;
    case 18:
        memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_num), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_num));
        memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_weight), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_weight));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window) / sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_window[i0].window.h_offset), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window[i0].window.h_offset));
            memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_window[i0].window.v_offset), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window[i0].window.v_offset));
            memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_window[i0].window.width), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window[i0].window.width));
            memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_window[i0].window.height), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window[i0].window.height));
            memset(mask + offsetof(hbn_isp_exposure_roi_t, roi_window[i0].weight), 1, sizeof(((hbn_isp_exposure_roi_t *)0)->roi_window[i0].weight));
        }
        break;
    case 19:
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_awb_preference_attr_t *)0)->gray_preference) / sizeof(((hbn_isp_awb_preference_attr_t *)0)->gray_preference[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_awb_preference_attr_t, gray_preference[i0].enable), 1, sizeof(((hbn_isp_awb_preference_attr_t *)0)->gray_preference[i0].enable));
            memset(mask + offsetof(hbn_isp_awb_preference_attr_t, gray_preference[i0].brightness_level), 1, sizeof(((hbn_isp_awb_preference_attr_t *)0)->gray_preference[i0].brightness_level));
            memset(mask + offsetof(hbn_isp_awb_preference_attr_t, gray_preference[i0].gray_rgain), 1, sizeof(((hbn_isp_awb_preference_attr_t *)0)->gray_preference[i0].gray_rgain));
            memset(mask + offsetof(hbn_isp_awb_preference_attr_t, gray_preference[i0].gray_bgain), 1, sizeof(((hbn_isp_awb_preference_attr_t *)0)->gray_preference[i0].gray_bgain));
        }
        break;
    case 20:
        memset(mask + offsetof(hbn_isp_awb_calib_t, rg_proj_indoor_min), 1, sizeof(((hbn_isp_awb_calib_t *)0)->rg_proj_indoor_min));
        memset(mask + offsetof(hbn_isp_awb_calib_t, rg_proj_max), 1, sizeof(((hbn_isp_awb_calib_t *)0)->rg_proj_max));
        memset(mask + offsetof(hbn_isp_awb_calib_t, k_factor), 1, sizeof(((hbn_isp_awb_calib_t *)0)->k_factor));
        memset(mask + offsetof(hbn_isp_awb_calib_t, center_line.rg), 1, sizeof(((hbn_isp_awb_calib_t *)0)->center_line.rg));
        memset(mask + offsetof(hbn_isp_awb_calib_t, center_line.bg), 1, sizeof(((hbn_isp_awb_calib_t *)0)->center_line.bg));
        memset(mask + offsetof(hbn_isp_awb_calib_t, center_line.d), 1, sizeof(((hbn_isp_awb_calib_t *)0)->center_line.d));
        memset(mask + offsetof(hbn_isp_awb_calib_t, ctcurve.ct_a), 1, sizeof(((hbn_isp_awb_calib_t *)0)->ctcurve.ct_a));
        memset(mask + offsetof(hbn_isp_awb_calib_t, ctcurve.ct_b), 1, sizeof(((hbn_isp_awb_calib_t *)0)->ctcurve.ct_b));
        memset(mask + offsetof(hbn_isp_awb_calib_t, ctcurve.ct_c), 1, sizeof(((hbn_isp_awb_calib_t *)0)->ctcurve.ct_c));
        memset(mask + offsetof(hbn_isp_awb_calib_t, fade1.fade), 1, sizeof(((hbn_isp_awb_calib_t *)0)->fade1.fade));
        memset(mask + offsetof(hbn_isp_awb_calib_t, fade1.gain_dist), 1, sizeof(((hbn_isp_awb_calib_t *)0)->fade1.gain_dist));
        memset(mask + offsetof(hbn_isp_awb_calib_t, fade1.fade_point), 1, sizeof(((hbn_isp_awb_calib_t *)0)->fade1.fade_point));
        memset(mask + offsetof(hbn_isp_awb_calib_t, fade2.fade), 1, sizeof(((hbn_isp_awb_calib_t *)0)->fade2.fade));
        memset(mask + offsetof(hbn_isp_awb_calib_t, fade2.gain_dist), 1, sizeof(((hbn_isp_awb_calib_t *)0)->fade2.gain_dist));
        memset(mask + offsetof(hbn_isp_awb_calib_t, fade2.fade_point), 1, sizeof(((hbn_isp_awb_calib_t *)0)->fade2.fade_point));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles) / sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].name), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].name));
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].id), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].id));
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].door_type), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].door_type));
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].awb_type), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].awb_type));
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].ccm_coeff), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].ccm_coeff));
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].ccm_offset), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].ccm_offset));
            memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profiles[i0].manual_wb), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profiles[i0].manual_wb));
        }
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.iir_add), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.iir_add));
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.iir_sub), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.iir_sub));
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.iir_threshold), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.iir_threshold));
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.iir_min), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.iir_min));
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.iir_max), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.iir_max));
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.iir_coef_init), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.iir_coef_init));
        memset(mask + offsetof(hbn_isp_awb_calib_t, iir.filter_item_number), 1, sizeof(((hbn_isp_awb_calib_t *)0)->iir.filter_item_number));
        memset(mask + offsetof(hbn_isp_awb_calib_t, illu_profile_number), 1, sizeof(((hbn_isp_awb_calib_t *)0)->illu_profile_number));
        break;
    case 21:
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles) / sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_lsc_calib_t, calib_profiles[i0].name), 1, sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[i0].name));
            memset(mask + offsetof(hbn_isp_lsc_calib_t, calib_profiles[i0].resolution), 1, sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[i0].resolution));
            memset(mask + offsetof(hbn_isp_lsc_calib_t, calib_profiles[i0].illumination), 1, sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[i0].illumination));
            for (size_t i1 = 0; i1 < sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[i0].matrixs) / sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[i0].matrixs[0]); ++i1) {
                memset(mask + offsetof(hbn_isp_lsc_calib_t, calib_profiles[i0].matrixs[i1].coeff), 1, sizeof(((hbn_isp_lsc_calib_t *)0)->calib_profiles[i0].matrixs[i1].coeff));
            }
        }
        memset(mask + offsetof(hbn_isp_lsc_calib_t, valid_num), 1, sizeof(((hbn_isp_lsc_calib_t *)0)->valid_num));
        break;
    case 22:
        memset(mask + offsetof(hbn_isp_afm_attr_t, bls), 1, sizeof(((hbn_isp_afm_attr_t *)0)->bls));
        memset(mask + offsetof(hbn_isp_afm_attr_t, hist_threshold), 1, sizeof(((hbn_isp_afm_attr_t *)0)->hist_threshold));
        memset(mask + offsetof(hbn_isp_afm_attr_t, gamma), 1, sizeof(((hbn_isp_afm_attr_t *)0)->gamma));
        memset(mask + offsetof(hbn_isp_afm_attr_t, hw_roi), 1, sizeof(((hbn_isp_afm_attr_t *)0)->hw_roi));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.iir_highpass_y), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.iir_highpass_y));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.iir_highpass_x), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.iir_highpass_x));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.iir_lowpass_y), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.iir_lowpass_y));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.iir_lowpass_x), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.iir_lowpass_x));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.fir_highpass_y), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.fir_highpass_y));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.fir_highpass_x), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.fir_highpass_x));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.fir_lowpass_y), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.fir_lowpass_y));
        memset(mask + offsetof(hbn_isp_afm_attr_t, ldg.fir_lowpass_x), 1, sizeof(((hbn_isp_afm_attr_t *)0)->ldg.fir_lowpass_x));
        memset(mask + offsetof(hbn_isp_afm_attr_t, coring.iir_highpass), 1, sizeof(((hbn_isp_afm_attr_t *)0)->coring.iir_highpass));
        memset(mask + offsetof(hbn_isp_afm_attr_t, coring.iir_lowpass), 1, sizeof(((hbn_isp_afm_attr_t *)0)->coring.iir_lowpass));
        memset(mask + offsetof(hbn_isp_afm_attr_t, coring.fir_highpass), 1, sizeof(((hbn_isp_afm_attr_t *)0)->coring.fir_highpass));
        memset(mask + offsetof(hbn_isp_afm_attr_t, coring.fir_lowpass), 1, sizeof(((hbn_isp_afm_attr_t *)0)->coring.fir_lowpass));
        memset(mask + offsetof(hbn_isp_afm_attr_t, iir.data_shift), 1, sizeof(((hbn_isp_afm_attr_t *)0)->iir.data_shift));
        memset(mask + offsetof(hbn_isp_afm_attr_t, iir.data_shift_v), 1, sizeof(((hbn_isp_afm_attr_t *)0)->iir.data_shift_v));
        memset(mask + offsetof(hbn_isp_afm_attr_t, iir.highpass_weight), 1, sizeof(((hbn_isp_afm_attr_t *)0)->iir.highpass_weight));
        memset(mask + offsetof(hbn_isp_afm_attr_t, iir.lowpass_weight), 1, sizeof(((hbn_isp_afm_attr_t *)0)->iir.lowpass_weight));
        memset(mask + offsetof(hbn_isp_afm_attr_t, iir.highpass_coeff), 1, sizeof(((hbn_isp_afm_attr_t *)0)->iir.highpass_coeff));
        memset(mask + offsetof(hbn_isp_afm_attr_t, iir.lowpass_coeff), 1, sizeof(((hbn_isp_afm_attr_t *)0)->iir.lowpass_coeff));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.data_shift), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.data_shift));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.data_shift_v), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.data_shift_v));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.highpass_weight), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.highpass_weight));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.lowpass_weight), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.lowpass_weight));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.highdata_shift), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.highdata_shift));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.highdata_shift_v), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.highdata_shift_v));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.lowdata_shift), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.lowdata_shift));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.lowdata_shift_v), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.lowdata_shift_v));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.highpass_coeff), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.highpass_coeff));
        memset(mask + offsetof(hbn_isp_afm_attr_t, fir.lowpass_coeff), 1, sizeof(((hbn_isp_afm_attr_t *)0)->fir.lowpass_coeff));
        break;
    case 23:
        memset(mask + offsetof(hbn_isp_hist_t, mode), 1, sizeof(((hbn_isp_hist_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_hist_t, window.h_offset), 1, sizeof(((hbn_isp_hist_t *)0)->window.h_offset));
        memset(mask + offsetof(hbn_isp_hist_t, window.v_offset), 1, sizeof(((hbn_isp_hist_t *)0)->window.v_offset));
        memset(mask + offsetof(hbn_isp_hist_t, window.width), 1, sizeof(((hbn_isp_hist_t *)0)->window.width));
        memset(mask + offsetof(hbn_isp_hist_t, window.height), 1, sizeof(((hbn_isp_hist_t *)0)->window.height));
        break;
    case 24:
        memset(mask + offsetof(hbn_isp_af_attr_t, mode), 1, sizeof(((hbn_isp_af_attr_t *)0)->mode));
        memset(mask + offsetof(hbn_isp_af_attr_t, position), 1, sizeof(((hbn_isp_af_attr_t *)0)->position));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.af_mode), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.af_mode));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.stable_tolerance), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.stable_tolerance));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.points_of_curve), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.points_of_curve));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.min_focal), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.min_focal));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.max_focal), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.max_focal));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.motion_threshold), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.motion_threshold));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.uphill_allowance), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.uphill_allowance));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.downhill_allowance), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.downhill_allowance));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.pdconf_threshold), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.pdconf_threshold));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.pdshift_threshold), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.pdshift_threshold));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.pdstable_count_max), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.pdstable_count_max));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.pdaf_unlock_threshold), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.pdaf_unlock_threshold));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.defocus_framenum), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.defocus_framenum));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.lossconfidence_framenum), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.lossconfidence_framenum));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.accurate_focus_step), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.accurate_focus_step));
        memset(mask + offsetof(hbn_isp_af_attr_t, auto_attr.accurate_focus_enable), 1, sizeof(((hbn_isp_af_attr_t *)0)->auto_attr.accurate_focus_enable));
        break;
    case 25:
        memset(mask + offsetof(hbn_isp_rgbir_attr_t, cc_matrix), 1, sizeof(((hbn_isp_rgbir_attr_t *)0)->cc_matrix));
        memset(mask + offsetof(hbn_isp_rgbir_attr_t, dpcc_mid_th), 1, sizeof(((hbn_isp_rgbir_attr_t *)0)->dpcc_mid_th));
        memset(mask + offsetof(hbn_isp_rgbir_attr_t, dpcc_th), 1, sizeof(((hbn_isp_rgbir_attr_t *)0)->dpcc_th));
        memset(mask + offsetof(hbn_isp_rgbir_attr_t, ir_threshold), 1, sizeof(((hbn_isp_rgbir_attr_t *)0)->ir_threshold));
        memset(mask + offsetof(hbn_isp_rgbir_attr_t, l_threshold), 1, sizeof(((hbn_isp_rgbir_attr_t *)0)->l_threshold));
        break;
    case 26:
        memset(mask + offsetof(hbn_isp_afmv1_attr_t, threshold), 1, sizeof(((hbn_isp_afmv1_attr_t *)0)->threshold));
        for (size_t i0 = 0; i0 < sizeof(((hbn_isp_afmv1_attr_t *)0)->afm_windows) / sizeof(((hbn_isp_afmv1_attr_t *)0)->afm_windows[0]); ++i0) {
            memset(mask + offsetof(hbn_isp_afmv1_attr_t, afm_windows[i0].h_offset), 1, sizeof(((hbn_isp_afmv1_attr_t *)0)->afm_windows[i0].h_offset));
            memset(mask + offsetof(hbn_isp_afmv1_attr_t, afm_windows[i0].v_offset), 1, sizeof(((hbn_isp_afmv1_attr_t *)0)->afm_windows[i0].v_offset));
            memset(mask + offsetof(hbn_isp_afmv1_attr_t, afm_windows[i0].width), 1, sizeof(((hbn_isp_afmv1_attr_t *)0)->afm_windows[i0].width));
            memset(mask + offsetof(hbn_isp_afmv1_attr_t, afm_windows[i0].height), 1, sizeof(((hbn_isp_afmv1_attr_t *)0)->afm_windows[i0].height));
        }
        break;
    case 27:
        memset(mask + offsetof(hbn_isp_sensor_param_t, lines_per_second), 1, sizeof(((hbn_isp_sensor_param_t *)0)->lines_per_second));
        memset(mask + offsetof(hbn_isp_sensor_param_t, again_max), 1, sizeof(((hbn_isp_sensor_param_t *)0)->again_max));
        memset(mask + offsetof(hbn_isp_sensor_param_t, dgain_max), 1, sizeof(((hbn_isp_sensor_param_t *)0)->dgain_max));
        memset(mask + offsetof(hbn_isp_sensor_param_t, exp_time_max), 1, sizeof(((hbn_isp_sensor_param_t *)0)->exp_time_max));
        memset(mask + offsetof(hbn_isp_sensor_param_t, exp_time_min), 1, sizeof(((hbn_isp_sensor_param_t *)0)->exp_time_min));
        break;
    case 28:
        memset(mask + offsetof(hbn_isp_ae_statistics_t, expStat), 1, sizeof(((hbn_isp_ae_statistics_t *)0)->expStat));
        memset(mask + offsetof(hbn_isp_ae_statistics_t, datatype), 1, sizeof(((hbn_isp_ae_statistics_t *)0)->datatype));
        memset(mask + offsetof(hbn_isp_ae_statistics_t, frame_id), 1, sizeof(((hbn_isp_ae_statistics_t *)0)->frame_id));
        memset(mask + offsetof(hbn_isp_ae_statistics_t, timestamps), 1, sizeof(((hbn_isp_ae_statistics_t *)0)->timestamps));
        break;
    case 29:
        memset(mask + offsetof(hbn_isp_awb_statistics_t, awbStat), 1, sizeof(((hbn_isp_awb_statistics_t *)0)->awbStat));
        memset(mask + offsetof(hbn_isp_awb_statistics_t, datatype), 1, sizeof(((hbn_isp_awb_statistics_t *)0)->datatype));
        memset(mask + offsetof(hbn_isp_awb_statistics_t, frame_id), 1, sizeof(((hbn_isp_awb_statistics_t *)0)->frame_id));
        memset(mask + offsetof(hbn_isp_awb_statistics_t, timestamps), 1, sizeof(((hbn_isp_awb_statistics_t *)0)->timestamps));
        break;
    case 30:
        memset(mask + offsetof(hbn_isp_af_statistics_t, sharpnessLowPass), 1, sizeof(((hbn_isp_af_statistics_t *)0)->sharpnessLowPass));
        memset(mask + offsetof(hbn_isp_af_statistics_t, sharpnessHighPass), 1, sizeof(((hbn_isp_af_statistics_t *)0)->sharpnessHighPass));
        memset(mask + offsetof(hbn_isp_af_statistics_t, histLowData), 1, sizeof(((hbn_isp_af_statistics_t *)0)->histLowData));
        memset(mask + offsetof(hbn_isp_af_statistics_t, histHighData), 1, sizeof(((hbn_isp_af_statistics_t *)0)->histHighData));
        memset(mask + offsetof(hbn_isp_af_statistics_t, frame_id), 1, sizeof(((hbn_isp_af_statistics_t *)0)->frame_id));
        break;
    case 31:
        memset(mask + offsetof(hbn_isp_hist_sta_t, bins), 1, sizeof(((hbn_isp_hist_sta_t *)0)->bins));
        break;
    case 32:
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, sharpness_a), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->sharpness_a));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, sharpness_b), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->sharpness_b));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, sharpness_c), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->sharpness_c));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, luminance_a), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->luminance_a));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, luminance_b), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->luminance_b));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, luminance_c), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->luminance_c));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, pixelcnt_a), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->pixelcnt_a));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, pixelcnt_b), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->pixelcnt_b));
        memset(mask + offsetof(hbn_isp_afmv1_statistics_t, pixelcnt_c), 1, sizeof(((hbn_isp_afmv1_statistics_t *)0)->pixelcnt_c));
        break;
    case 33:
        memset(mask, 1, n);
        break;
    default: free(mask); return X5W_UNSUPPORTED;
    }
    for (size_t i = 0; i < n; ++i) if (!mask[i]) ((unsigned char *)data)[i] = 0;
    free(mask); return 0;
}

#endif
