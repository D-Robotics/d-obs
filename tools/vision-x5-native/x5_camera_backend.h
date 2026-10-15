/* SPDX-License-Identifier: Apache-2.0 */
#ifndef VISION_X5_CAMERA_BACKEND_H
#define VISION_X5_CAMERA_BACKEND_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ABI 1/2: these fixed-width fields are also consumed by Python ctypes. */
typedef struct x5w_frame_info {
    uint32_t width, height, stride_y, stride_uv, size_y, size_uv;
    uint32_t bit_depth, bayer, packing, alignment;
    uint64_t timestamp_ns, frame_id;
} x5w_frame_info;

enum x5w_bayer { X5W_RGGB, X5W_BGGR, X5W_GRBG, X5W_GBRG };
enum x5w_packing { X5W_RAW16, X5W_MIPI_RAW10, X5W_MIPI_RAW12, X5W_NV12 };
enum x5w_alignment { X5W_RIGHT, X5W_LEFT };
enum x5w_control {
    X5W_AUTO_EXPOSURE, X5W_EXPOSURE_US, X5W_GAIN, X5W_AUTO_WHITE_BALANCE,
    X5W_RED_GAIN, X5W_BLUE_GAIN, X5W_BRIGHTNESS, X5W_CONTRAST,
    X5W_SATURATION, X5W_HUE
};

/* 0 succeeds; -95 is an unsupported capability. Other errors retain the SDK
 * return code or use negative errno. No return value implies hardware readiness.
 * A non-NULL context returned on a failed open still needs x5w_close: teardown
 * may itself have failed and must remain retryable. Callers serialize ownership
 * and must not reuse a context after a successful close. */
uint32_t x5w_abi_version(void);
int x5w_config_supported(const char *sensor_config_name, int csi_port);
int x5w_open(const char *sensor_config_name, int csi_port, void **ctx);
int x5w_start(void *ctx);
int x5w_stop(void *ctx);
int x5w_close(void *ctx);
int x5w_frame(void *ctx, int raw, unsigned char *buffer, size_t cap,
              x5w_frame_info *info);
int x5w_control_get(void *ctx, int key, double *value, double *min, double *max,
                    double *step, int *writable, int *active);
int x5w_control_set(void *ctx, int key, double value);

/* ABI 2 adds compiler-described ISP modules and true SDK RAW replay. */
size_t x5w_module_size(int module);
const char *x5w_module_name(int module);
int x5w_module_writable(int module);
int x5w_module_get(void *ctx, int module, void *out, size_t cap);
int x5w_module_set(void *ctx, int module, const void *data, size_t n);
int x5w_module_normalize(int module, void *data, size_t n);
int x5w_module_field_count(int module);
int x5w_module_field_info(int module, int index, char *name, size_t namecap,
    size_t *offset, int *type, size_t *count, double *min, double *max, int *editable);
int x5w_awb_limits_set(void *ctx, double min, double max);
int x5w_control_quantize(void *ctx, int key, double input, double *out);
int x5w_tuning_load(void *ctx, const char *absolute_private_json);
int x5w_replay(void *ctx, const unsigned char *raw, size_t n,
    int width, int height, int bit_depth, int bayer, int stride,
    unsigned char *out, size_t cap, x5w_frame_info *info);
int x5w_replay_cleanup(void *ctx);

#ifdef __cplusplus
}
#endif
#endif
