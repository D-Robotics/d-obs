# Build on an RDK X5 with its installed matching SDK, or with its exact sysroot.
# No download, installation, sensor probing or board execution is performed here.
CC ?= cc
SDK_INCLUDE ?= /usr/include
SDK_LIBDIR ?= /usr/hobot/lib
VP_ROOT ?= /app/platform_samples
VP_SENSOR_DIR ?= $(VP_ROOT)/vp_sensors
SDK_LIBS ?= -lvpf -lcam -lhbmem
OUT_DIR ?= build
CPPFLAGS += -I$(SDK_INCLUDE) -I$(VP_SENSOR_DIR)
CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -fPIC -Wall -Wextra -Werror
LDFLAGS += -L$(SDK_LIBDIR)
SENSOR_SOURCES = $(VP_SENSOR_DIR)/imx415/linear_3840x2160_raw10_30fps_2lane.c \
                 $(VP_SENSOR_DIR)/imx415/linear_3840x2160_raw10_30fps_4lane.c
# Newer official profiles reference this sensor-specific chip-ID callback.
# Do not pull in the generic vp_sensors.c discovery/GPIO implementation.
IMX415_COMMON_SOURCE = $(wildcard $(VP_SENSOR_DIR)/imx415/imx415_common.c)
IMX415_COMMON_HEADER = $(VP_SENSOR_DIR)/imx415/imx415_common.h
IMX415_COMMON_OBJECT = $(if $(IMX415_COMMON_SOURCE),$(OUT_DIR)/imx415_common.o)
# The installed callback uses POSIX close/usleep without including unistd.h.
# Scope its feature declaration and forced include to this external TU only.
IMX415_COMMON_CPPFLAGS = -D_DEFAULT_SOURCE -include unistd.h

.PHONY: all check-inputs check-sdk syntax-check test clean
all: $(OUT_DIR)/libvision_x5_native.so

check-inputs:
	@test -f "$(SDK_INCLUDE)/hbn_isp_api.h" || { echo "Matching X5 HBN SDK headers required" >&2; exit 1; }
	@test -f "$(VP_SENSOR_DIR)/vp_sensors.h" || { echo "Set VP_SENSOR_DIR to the reviewed VP sensors directory" >&2; exit 1; }
	@test -f "$(VP_SENSOR_DIR)/imx415/linear_3840x2160_raw10_30fps_2lane.c"
	@test -f "$(VP_SENSOR_DIR)/imx415/linear_3840x2160_raw10_30fps_4lane.c"
	@test -z "$(IMX415_COMMON_SOURCE)" || test -f "$(IMX415_COMMON_HEADER)" || { echo "Matching IMX415 common callback header required" >&2; exit 1; }

check-sdk: check-inputs
	@$(CC) $(CPPFLAGS) $(CFLAGS) -fsyntax-only x5_camera_backend.c $(SENSOR_SOURCES) || { \
		echo "unsupported_sdk: X5 native ABI 2 requires matching VP layouts and the full typed ISP SDK (CPROC, EE, 2DNR, 3DNR and other bound modules). Existing camera capture support does not establish compatibility." >&2; exit 1; }
	@if test -n "$(IMX415_COMMON_SOURCE)"; then \
		$(CC) $(CPPFLAGS) $(IMX415_COMMON_CPPFLAGS) $(CFLAGS) -fsyntax-only "$(IMX415_COMMON_SOURCE)"; \
	fi

ifneq ($(IMX415_COMMON_SOURCE),)
$(IMX415_COMMON_OBJECT): $(IMX415_COMMON_SOURCE) $(IMX415_COMMON_HEADER) | check-inputs
	@mkdir -p "$(OUT_DIR)"
	$(CC) $(CPPFLAGS) $(IMX415_COMMON_CPPFLAGS) $(CFLAGS) -c "$(IMX415_COMMON_SOURCE)" -o "$@"
endif

$(OUT_DIR)/libvision_x5_native.so: x5_camera_backend.c x5_camera_backend.h x5_isp_modules.inc.c x5_isp_replay.inc.c $(SENSOR_SOURCES) $(IMX415_COMMON_OBJECT) | check-sdk
	@mkdir -p "$(OUT_DIR)"
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -shared -Wl,--no-undefined \
		x5_camera_backend.c $(SENSOR_SOURCES) $(IMX415_COMMON_OBJECT) $(SDK_LIBS) -lm -pthread -o "$@"

syntax-check: check-sdk

# SDK calls are replaced by an isolated test shim, never a platform adapter.
test: check-sdk $(IMX415_COMMON_OBJECT)
	@mkdir -p "$(OUT_DIR)"
	$(CC) $(CPPFLAGS) $(CFLAGS) tests/backend_test.c $(SENSOR_SOURCES) $(IMX415_COMMON_OBJECT) -lm -pthread -o "$(OUT_DIR)/backend_test"
	"$(OUT_DIR)/backend_test"

	$(CC) $(CPPFLAGS) $(CFLAGS) tests/modules_test.c -lm -pthread -o "$(OUT_DIR)/modules_test"
	"$(OUT_DIR)/modules_test"
	$(CC) $(CPPFLAGS) $(CFLAGS) tests/replay_test.c -lm -pthread -o "$(OUT_DIR)/replay_test"
	"$(OUT_DIR)/replay_test"

clean:
	rm -rf "$(OUT_DIR)"
