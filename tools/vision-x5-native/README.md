# X5 native Camera / VIN / ISP backend

This library implements ABI 2 (with the ABI 1 frame layout) consumed by `tools/vision-x5-camera.py` using real
X5 HBN SDK calls. On 2026-10-15 it compiled and linked on an RDKOS 3.5.0 X5 with
multimedia 3.0.5 / multimedia-dev 3.0.4 and loaded the installed HBN libraries.
The first upgraded-image attempt had no I²C response and attachment returned
`-207` (`HB_CAM_I2C_WRITE_FAIL` in its installed header). A later retry on the
same day recovered sensor response and captured real 3840 × 2160 NV12 frames,
including 95 successive successful acquisitions with increasing SDK identities.
A temporary preview subsequently completed 505 images, but another run failed
with SDK `-43`; sustained operation remains unqualified. No ISP setters ran in
these retries. Compile/link, captures and isolated SDK tests do not establish
image quality, ISP calibration, control restoration or adapter readiness.

The only accepted profiles are `imx415-30fps-2lane` and `imx415-30fps-4lane`,
3840 × 2160, linear RAW10 at 30 fps, I²C address `0x1a`, CSI receiver 0 or 2.
Matching a name/port checks the library's reviewed configuration whitelist; it
does not detect a module or establish which lane configuration a vendor module
needs. The operator must confirm the physical port, cable and selected mode.

## Build prerequisites

Use the board's matching X5 headers and shared libraries. System image version
3.5 and SDK documentation version 2.0.0 are different version identifiers; no
compatibility is inferred between them. Record the system packages, HBN/libcam
versions, sensor driver and tuning revision before qualifying a build.

The inspected RDKOS 3.1.1 board has multimedia/dev packages
`3.0.2-20250110154647`. Its older `hbn_isp_api.h` lacks the typed CPROC, EE,
2DNR/3DNR APIs and its VP layout lacks `vin_attr_ex`; this ABI 2 backend cannot
compile against those headers. Successful capture through that board's official
`libsrcampy` does not qualify this backend. `check-sdk` compiles the complete
binding before a build or isolated test and reports `unsupported_sdk` for an
incompatible SDK; there are no fabricated types, fallback setters or automatic
system upgrades. A temporary diagnostic/preload bridge is not a platform adapter.

The library links the two reviewed VP sensor configuration translation
units and includes `vp_sensors.h`. When the installed profiles provide
`imx415/imx415_common.c` and its matching header, the build also checks and links
that exact sensor-specific chip-ID callback. Its POSIX declarations are enabled
only for that external translation unit; `-Werror` remains enabled. Legacy
profiles without this optional file keep the two-source build. It does not compile `vp_sensors.c`, which has
generic detection, GPIO and clock operations. No initialization register table,
vendor driver, firmware or tuning JSON is vendored here. Use matching files from
your installed platform samples or the reviewed official `x5-hobot-spdev` tree.
Actual sample-directory locations vary; pass `VP_SENSOR_DIR` explicitly if the
default does not contain the files.

The reviewed VP configs use `calib_lname="disable"`. In the cited **SDK 2.0.0**
Camera API and ISP sample this string selects the default
`<sensor_name>_tuning.json`; it is not documented there as disabling the ISP.
For name `imx415` the documented default directory/file is
`/usr/hobot/lib/sensor/imx415_tuning.json`. Check its actual presence/hash,
matching SDK schema and independent module mode/getters on the board. This
version-specific convention is not a compatibility claim for RDKOS 3.5.

```sh
make VP_SENSOR_DIR=/path/to/official/vp_sensors \
  SDK_INCLUDE=/usr/include SDK_LIBDIR=/usr/hobot/lib
```

`SDK_LIBS=-lvpf -lcam -lhbmem` follows the SDK libraries used by official VP
samples. `SDK_LIBDIR` defaults to `/usr/hobot/lib`, where the inspected board's
HBN `libvpf.so.1` and `libcam.so.1` reside; `/usr/lib/libvpf.so` on that board is
a different library. Override `SDK_LIBDIR` for a matching sysroot or installation.
Linking uses `--no-undefined`, so missing or incompatible symbols fail
the build. For a cross build, provide the matching ARM64 compiler/sysroot in
`CC`, `CPPFLAGS`, and `LDFLAGS`; do not link macOS libraries into a board artifact.
The result is `build/libvision_x5_native.so`. The Makefile does not deploy it,
install dependencies, probe devices or execute the pipeline.

```sh
make syntax-check VP_SENSOR_DIR=/path/to/official/vp_sensors \
  SDK_INCLUDE=/path/to/matching/sdk/include
make test VP_SENSOR_DIR=/path/to/official/vp_sensors \
  SDK_INCLUDE=/path/to/matching/sdk/include
```

The three backend/modules/replay tests use actual SDK headers and sensor configurations with isolated
function replacements. It verifies ownership/error handling and control/frame/replay and independent module snapshot
semantics without opening a board or registering a fake adapter.

## Implemented scope and runtime evidence

- `x5w_open` clones the official configuration per session, creates Camera, VIN
  and ISP, sets buffer attributes, and adds both nodes to an HBN flow. VIN DDR
  channel 0 binds to offline ISP input 0. No shared static config is mutated.
  MCLK enablement follows a read of the selected host's device-tree pinctrl;
  absence retains the official external-oscillator behavior.
- CSI host selection changes `vin_attr.cim_attr.mipi_rx` only. The profile's
  `mipi_cfg.rx_attr.phy` is the DPHY/CPHY protocol type (0/1), so host 2 must not
  be written there. The isolated regression checks the actual arguments passed
  to Camera and VIN separately for both profiles and hosts 0/2.
- `x5w_start` attaches the camera, binds the actual VIN/ISP nodes, then starts
  the flow. `stop` unbinds those same nodes and detaches the camera. A failed
  start requires stop before a retry. Close stops first and destroys the actual
  resources; a teardown failure retains the context for retry. SDK node close
  and flow destroy return `void`, so the API cannot verify their own return code.
  Attach, bind, start, stop, unbind and detach failures report the SDK stage and
  original return code on stderr. A stop/close failure retains context ownership;
  the caller must inspect the failure and recover before retrying. It is not a
  successful release, a service restart or permission to reload a scene blindly.
- Frame acquisition uses `hbn_vnode_getframe_cond` on VIN for RAW and
  `hbn_vnode_getframe` on ISP for NV12. Cache invalidation precedes copying.
  Every acquired SDK frame is released even when layout validation or copying
  fails. A release error fails the capture and clears the output metadata.
- RAW is unpacked 10-bit data in 16-bit little-endian samples, preserving the
  real SDK stride. Bayer must be returned by the running camera's
  `hbn_camera_get_sns_info(CAMERA_SENSOR_PARAM)` as one of four known patterns.
  No Bayer pattern is inferred from a product name. Alignment must be uniquely
  consistent with the actual sample bits. Ambiguous black/low-information data,
  missing Bayer metadata or unrecognized layouts return unsupported. This is
  a constrained RAW layout check, not optical Bayer calibration.
- NV12 requires actual SDK Y and UV planes and copies their real row stride
  without padding guesses. ABI metadata includes sensor frame ID and the SDK
  `timeval` converted to nanoseconds. A zero timestamp means unavailable; no
  host timestamp is substituted. Raw `timestamps` units are not guessed.
- Controls 6–9 use `hbn_isp_get_cproc_attr` / `hbn_isp_set_cproc_attr` for
  brightness, contrast, saturation and hue. SDK MANUAL mode is required for
  direct numeric control writing. AUTO numeric values remain inactive. The
  separate v2 typed module API supports explicit mode/config edits and restoration
  from a genuine SDK snapshot; it never infers an arbitrary SDK JSON schema.
- Bounds follow the public CPROC header: brightness `[-127,127]`, hue
  `[-90,90]`, contrast/saturation `[0,(double)1.999f]`. Float getters are promoted
  to double exactly; setters quantize once to the SDK float and read back all
  four manual fields plus mode. `step=0` denotes a continuous float control.
  Restoration uses the same setters with a saved actual getter baseline.
- Controls 0–5 bind real AE/AWB getters and setters. AE time and analog gain
  limits are observed SDK getter ranges; missing ranges keep numeric controls
  unavailable. Exposure is encoded as f32 seconds and exposed in microseconds,
  with `x5w_control_quantize` preserving the actual SDK representation. No line
  step is invented when a returned value is off that grid. AWB red/blue gains
  need an explicit positive finite private operator interval set with
  `x5w_awb_limits_set`; that interval is host policy, not a claimed sensor limit.
- `x5_isp_modules.inc.c` binds 34 real typed API families: 27 getter/setter
  attribute modules and 7 read-only sensor/statistics observations. Snapshots
  include AE/AWB, CPROC, module control, LSC/CCM/GC, NR/WDR/demosaic/EE/DPCC,
  exposure tables/ROI, public calibration data and additional AF/histogram/RGBIR
  attributes. Actual getter failures remain failures or unavailable modules.
- `x5w_module_field_info` gives compiler `offsetof`, storage type and array count.
  Known SDK bounds are explicit; unknown bounds are NaN/read-only. A separate
  private operator policy may qualify an otherwise unbounded numeric field.
  All writable structures were inspected and contain inline values/arrays only,
  with no pointer or callback fields. Opaque native data must come from real SDK
  getters/protected private snapshots, never unsigned client bytes. The public
  client uses only a server-generated opaque 128bit snapshot ID; the Python owner
  validates file owner/mode/no-symlink and compiled layout/profile identity.
- Normalization clears compiler padding via semantic member coverage, documented
  getter-only/reserved data and AUTO current output. Mode remains strictly
  compared. The verified scope is the SDK-readable selected-mode configuration;
  inactive attributes, AUTO statistics and unexposed effect JSON parameters are
  not promoted to complete parameter readback. A setter is followed by a new
  independent getter; ignored writes, getter errors and mode mismatch fail.
- SDK 2.0.0 documentation says AE/HDR/AWB getter mode is temporarily unavailable.
  The daemon requires explicit `modeReadbackEvidence` qualifications for
  `exposure`, `awb` and `hdr_exposure` before exposing their mode writes;
  AE/WB numeric controls remain read-only without the corresponding evidence.
  A private bounds policy cannot bypass mode qualification.
  The C binding rejects a mismatching mode. Merely compiling an enum field or a
  matching fixture does not establish trustworthy mode readback on the board.
- `x5w_tuning_load` binds the real `hbn_camera_switch_scence` API to a private
  absolute JSON filename, then calls the public module getters (AE/AWB/control/
  CPROC are required). Python archives the actual snapshots separately. An
  archived filename/SHA describes the declared input, not proof of each JSON
  field's effective value. Original effect-library template restoration and
  public module readback are separate evidence; BLC and other unexposed fields
  have no invented getter. Their full readback remains unverified.
- CPU BLC/LSC/CCM/AWB task outputs are SDK-neutral computations. Private SDK
  bindings provide the exact field order, units/encoding, geometry and limits
  before a setter or library load is attempted. A missing binding fails closed.
  Recorded input conditions and successful calculations do not prove physically
  acquired calibration data or optical quality.
- `x5_isp_replay.inc.c` implements true RAW DDR submission to the actual ISP node:
  stop/unbind live VIN, drain output, allocate and flush a real input, sendframe,
  verify submitted frame ID/time, acquire/copy/release output and restore live
  flow. AE/AWB must be manual. Submission timestamps come from the host and are
  not sensor exposure timestamps. Failed cleanup retains ownership and blocks
  new module/control/library writes; old/live frames cannot stand in for replay.

`x5_camera_backend.h` is the canonical ABI layout. Return 0 means that the
specific SDK operation succeeded. `-95` means unsupported. Other SDK return
codes are preserved; local validation uses negative errno. If a failed open
returns a non-NULL context because cleanup failed, the caller must retain it
and retry close. A successful close invalidates the pointer. The caller must
serialize context ownership and prevent concurrent close/use.

## Reviewed public sources

- [X5 HBN API](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/1-HBN_API_zh_CN.html),
  [Camera API](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/4-Camera_API_zh_CN.html),
  [VIN API](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/4-VIN_API_zh_CN.html),
  [ISP tuning API](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/5-ISP_Tune_API_zh_CN.html).
- [Actual X5 SDK headers](https://github.com/D-Robotics/x5-hobot-multimedia-dev/tree/f625c7fd28a3553f57524c2bc3721a42078af2b7/usr/include),
  revision `f625c7fd28a3553f57524c2bc3721a42078af2b7`.
- [VP sensor configurations](https://github.com/D-Robotics/x5-hobot-spdev/tree/506ec790a80c01ebe552929e6efb572d562b3b14/src/vp_sensors/imx415),
  [VIN/ISP/flow wrappers](https://github.com/D-Robotics/x5-hobot-spdev/tree/506ec790a80c01ebe552929e6efb572d562b3b14/src/vp_wrap/src),
  revision `506ec790a80c01ebe552929e6efb572d562b3b14`.
  Upstream configuration symbols retain their `3480` spelling although the
  configuration width is 3840.
- [IMX415 sensor driver](https://github.com/D-Robotics/x5-libcam-sensor/tree/8c4159238e5a0db768d273853e4dce0039522cba/imx415),
  revision `8c4159238e5a0db768d273853e4dce0039522cba`, reviewed as evidence only.
  It does not establish the version present on an unconnected board.

New source is Apache-2.0; the official VP wrappers/configurations are covered by
the upstream [Apache-2.0 license](https://github.com/D-Robotics/x5-hobot-spdev/blob/506ec790a80c01ebe552929e6efb572d562b3b14/LICENSE).
Installations must preserve their upstream notices. SDK headers/libraries and
sensor initialization tables are not redistributed by this backend.

The remaining qualification is compatibility on other SDK builds, private
JSON binding semantics and the actual camera/RAW/ISP/calibration/restore/quality
measurements. This source neither deploys the service nor marks a hardware
adapter ready.
