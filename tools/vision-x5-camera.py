#!/usr/bin/env python3
"""X5 HBN camera atomics. No shell commands, sensor scans or request paths.

The private loopback daemon loads the accompanying compiled SDK bridge. It
keeps a single pipeline, reads ISP state independently, and journals writes
before executing them. Hardware acceptance is never inferred from fixtures.
"""
import argparse
import base64
import ctypes
import hashlib
import hmac
import importlib.util
import json
import math
import os
import re
import signal
import stat
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONTRACT = "rdk.vision-device-runner.v1"
KIND = "x5-hbn-isp-controls-v1"
IDENTITY = ("board", "sensorModel", "sdkVersion", "sensorVendor", "cameraInterface", "cameraMode")
OPERATIONS = ("probe", "pipeline_validate", "bringup", "capture_raw", "preview_start", "preview_stop",
              "preview_frame", "capture_frame", "controls_get", "controls_set", "apply_tuning", "restore_tuning",
              "process_raw", "tuning_get", "tuning_load", "tuning_export", "calibration_apply")
CONTROL_NAMES = ("autoExposure", "exposureUs", "gain", "autoWhiteBalance", "redGain", "blueGain",
                 "brightness", "contrast", "saturation", "hue")
BOOL_CONTROLS = {"autoExposure", "autoWhiteBalance"}
MAX_FRAME_BYTES = 64 * 1024 * 1024


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stamp():
    return datetime.now(timezone.utc).isoformat()


def js_json(value):
    """JSON.stringify-compatible finite numbers; retain insertion order."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("nonfinite_json")
        if value == 0:
            return "0"
        if int(value) == value and abs(value) < 1e21:
            return str(int(value))
        text = repr(float(value)).lower()
        if "e" in text:
            from decimal import Decimal
            mantissa, exponent = text.split("e")
            exponent = int(exponent)
            if 1e-6 <= abs(value) < 1e21:
                return format(Decimal(text), "f")
            return mantissa.removesuffix(".0") + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
        return text
    if isinstance(value, list):
        return "[" + ",".join(js_json(item) for item in value) + "]"
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return "{" + ",".join(js_json(key) + ":" + js_json(item) for key, item in value.items()) + "}"
    raise ValueError("invalid_json")


def digest(value):
    return hashlib.sha256(js_json(value).encode()).hexdigest()


class NativeError(ValueError):
    def __init__(self, code, sdk_code=None):
        super().__init__(code)
        self.sdk_code = sdk_code


class FrameInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in
                ("width", "height", "stride_y", "stride_uv", "size_y", "size_uv", "bit_depth", "bayer", "packing", "alignment")]
    _fields_ += [("timestamp_ns", ctypes.c_uint64), ("frame_id", ctypes.c_uint64)]


class NativeBackend:
    """The C library includes the real SDK headers; ctypes never guesses them."""
    source = "x5-hbn-sdk"

    def __init__(self, config):
        self.config = config
        self.ctx = ctypes.c_void_p()
        self.open_failed = False
        self.isp = None
        try:
            self.lib = ctypes.CDLL(config["nativeLibrary"])
            self.lib.x5w_abi_version.restype = ctypes.c_uint32
            self.abi = self.lib.x5w_abi_version()
            if self.abi not in (1, 2):
                raise NativeError("native_abi_mismatch")
            self.lib.x5w_config_supported.argtypes = [ctypes.c_char_p, ctypes.c_int]
            self.lib.x5w_config_supported.restype = ctypes.c_int
            self.lib.x5w_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
            self.lib.x5w_open.restype = ctypes.c_int
            for name in ("start", "stop", "close"):
                method = getattr(self.lib, "x5w_" + name)
                method.argtypes = [ctypes.c_void_p]
                method.restype = ctypes.c_int
            self.lib.x5w_frame.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(FrameInfo)]
            self.lib.x5w_frame.restype = ctypes.c_int
            self.lib.x5w_control_get.argtypes = [ctypes.c_void_p, ctypes.c_int] + [ctypes.POINTER(ctypes.c_double)] * 4 + [ctypes.POINTER(ctypes.c_int)] * 2
            self.lib.x5w_control_get.restype = ctypes.c_int
            self.lib.x5w_control_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_double]
            self.lib.x5w_control_set.restype = ctypes.c_int
            if self.abi == 2:
                self.lib.x5w_awb_limits_set.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double]
                self.lib.x5w_awb_limits_set.restype = ctypes.c_int
                self.lib.x5w_control_quantize.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_double, ctypes.POINTER(ctypes.c_double)]
                self.lib.x5w_control_quantize.restype = ctypes.c_int
                self.lib.x5w_replay_cleanup.argtypes = [ctypes.c_void_p]
                self.lib.x5w_replay_cleanup.restype = ctypes.c_int
                self.lib.x5w_replay.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t] + [ctypes.c_int] * 5 + [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(FrameInfo)]
                self.lib.x5w_replay.restype = ctypes.c_int
        except (OSError, AttributeError) as exc:
            raise NativeError("native_sdk_unavailable") from exc
        self.check(self.lib.x5w_config_supported(config["sensorConfig"].encode(), config["csiPort"]), "native_config_unavailable")

    @staticmethod
    def check(code, error="native_sdk_call_failed"):
        if code != 0:
            raise NativeError(error, int(code))

    def open(self):
        if self.open_failed:
            raise NativeError("camera_pipeline_cleanup_required")
        if not self.ctx:
            code = self.lib.x5w_open(self.config["sensorConfig"].encode(), self.config["csiPort"], ctypes.byref(self.ctx))
            if code != 0:
                if self.ctx:
                    if self.lib.x5w_close(self.ctx) == 0:
                        self.ctx = ctypes.c_void_p()
                    else:
                        self.open_failed = True
                self.check(code, "camera_pipeline_open_failed")
            if not self.ctx:
                raise NativeError("camera_pipeline_open_failed")
            self.pipeline_session_id = uuid.uuid4().hex
            if self.abi == 2:
                if self.config.get('awbGainLimits'):
                    policy = self.config['awbGainLimits']
                    self.check(self.lib.x5w_awb_limits_set(self.ctx, policy['min'], policy['max']), 'isp_invalid_descriptor')
                self.isp = sibling('vision-x5-isp').Isp(self, self.config, NativeError, digest)

    def start(self):
        self.open()
        self.check(self.lib.x5w_start(self.ctx), "camera_stream_start_failed")

    def stop(self):
        if self.ctx:
            self.check(self.lib.x5w_stop(self.ctx), "camera_stream_stop_failed")
            if self.open_failed:
                self.close()

    def close(self):
        if self.ctx:
            self.check(self.lib.x5w_close(self.ctx), "camera_pipeline_close_failed")
            self.ctx = ctypes.c_void_p()
            self.open_failed = False
            self.pipeline_session_id = None
            self.isp = None

    def controls(self):
        if self.open_failed:
            raise NativeError("camera_pipeline_cleanup_required")
        if not self.ctx:
            raise NativeError("camera_bringup_required")
        result = {}
        for key, name in enumerate(CONTROL_NAMES):
            value, low, high, step = [ctypes.c_double() for _ in range(4)]
            writable, active = ctypes.c_int(), ctypes.c_int()
            code = self.lib.x5w_control_get(self.ctx, key, ctypes.byref(value), ctypes.byref(low), ctypes.byref(high), ctypes.byref(step), ctypes.byref(writable), ctypes.byref(active))
            if code == -95:  # EOPNOTSUPP; absence of safe readback/range is not invented.
                continue
            self.check(code, "isp_readback_failed")
            if not all(math.isfinite(number.value) for number in (value, low, high, step)) or writable.value not in (0, 1) or active.value not in (0, 1):
                raise NativeError("isp_invalid_descriptor")
            row = {"value": bool(value.value) if name in BOOL_CONTROLS else value.value,
                   "writable": bool(writable.value), "active": bool(active.value), "nativeName": name,
                   "unit": "boolean" if name in BOOL_CONTROLS else "us" if name == "exposureUs" else "SDK units"}
            if name in ("brightness", "contrast", "saturation", "hue"):
                row["nativeName"] = "hbn_isp_cproc_attr_t.manual_attr." + ("bright" if name == "brightness" else name)
            if name in BOOL_CONTROLS:
                if value.value not in (0, 1):
                    raise NativeError("isp_invalid_descriptor")
            else:
                if low.value > high.value or not low.value <= value.value <= high.value or step.value < 0:
                    raise NativeError("isp_invalid_descriptor")
                row.update(min=low.value, max=high.value)
                if self.abi == 2 and key in (1, 2, 4, 5):
                    row['nativePrecision'] = 'seconds-float32-us' if key == 1 else 'float32'
                    if key in (4, 5):
                        row.update(boundsSource='operator-policy', evidenceRef=self.config['awbGainLimits']['evidenceRef'])
                if step.value > 0:
                    row["step"] = step.value
            qualification='exposure' if name in ('autoExposure','exposureUs','gain') else 'awb' if name in ('autoWhiteBalance','redGain','blueGain') else None
            if self.abi == 2 and qualification and not self.config.get('modeReadbackEvidence',{}).get(qualification):
                row.update(writable=False, qualificationRequired=qualification+'_mode_readback_unavailable_in_public_sdk_docs')
            result[name] = row
        return result

    def set_control(self, name, value):
        self.check(self.lib.x5w_control_set(self.ctx, CONTROL_NAMES.index(name), float(value)), "isp_write_failed")

    def replay(self, raw, metadata):
        if self.abi != 2:
            raise NativeError('raw_replay_unavailable')
        source = ctypes.create_string_buffer(raw, len(raw))
        output = (ctypes.c_ubyte * MAX_FRAME_BYTES)()
        info = FrameInfo()
        self.check(self.lib.x5w_replay(self.ctx, source, len(raw), metadata['width'], metadata['height'], metadata['bitDepth'],
            ('RGGB','BGGR','GRBG','GBRG').index(metadata['bayer']), metadata['stride'], output, len(output), ctypes.byref(info)), 'raw_replay_failed')
        size = info.size_y + info.size_uv
        if not 0 < size <= MAX_FRAME_BYTES: raise NativeError('raw_replay_layout_invalid')
        return ctypes.string_at(output,size), {name:getattr(info,name) for name,_ctype in FrameInfo._fields_}

    def replay_cleanup(self):
        if self.abi == 2 and self.ctx:
            self.check(self.lib.x5w_replay_cleanup(self.ctx), 'raw_replay_cleanup_failed')

    def frame(self, raw=False):
        # The bridge copies planes and releases SDK buffers before returning.
        buffer = (ctypes.c_ubyte * MAX_FRAME_BYTES)()
        info = FrameInfo()
        self.check(self.lib.x5w_frame(self.ctx, int(raw), buffer, len(buffer), ctypes.byref(info)), "camera_frame_failed")
        size = info.size_y + info.size_uv
        if not 0 < size <= MAX_FRAME_BYTES:
            raise NativeError("camera_frame_layout_invalid")
        return ctypes.string_at(buffer, size), {name: getattr(info, name) for name, _ctype in FrameInfo._fields_}


def validate_config(config):
    allowed = {"token", *IDENTITY, "nativeLibrary", "sensorConfig", "csiPort", "port", "stateDir", "colorMatrix", "colorRange", "blackLevel", "whiteLevel", "discardFrames", "awbGainLimits", "ispFieldPolicies", "calibrationBindings", "effectLibrary", "modeReadbackEvidence", "disabledIspModules", "effectLibraryExportBinding"}
    if not isinstance(config, dict) or set(config) - allowed:
        raise ValueError("invalid_private_config")
    if config.get("board") != "RDK X5" or config.get("sensorModel") != "IMX415" or config.get("cameraInterface") != "MIPI CSI-2":
        raise ValueError("invalid_camera_identity")
    for key in IDENTITY:
        if key in config and (not isinstance(config[key], str) or not config[key].strip() or len(config[key]) > 120 or re.search(r"[\x00-\x1f\x7f]", config[key])):
            raise ValueError("invalid_camera_identity")
    if not config.get("sdkVersion") or not config.get("cameraMode"):
        raise ValueError("sdk_and_mode_required")
    if not isinstance(config.get("token"), str) or not re.fullmatch(r"[!-~]{24,4096}", config["token"]):
        raise ValueError("invalid_private_token")
    for field in ("nativeLibrary", "stateDir"):
        if not isinstance(config.get(field), str) or not Path(config[field]).is_absolute():
            raise ValueError("absolute_private_path_required")
    if config.get("sensorConfig") not in ("imx415-30fps-2lane", "imx415-30fps-4lane"):
        raise ValueError("invalid_sensor_config")
    for field, low, high in (("csiPort", 0, 3), ("port", 1024, 65535), ("discardFrames", 1, 30), ("blackLevel", 0, 65534), ("whiteLevel", 1, 65535)):
        if type(config.get(field)) is not int or not low <= config[field] <= high:
            raise ValueError("invalid_private_config")
    if config["blackLevel"] >= config["whiteLevel"] or config.get("colorMatrix") not in ("bt601", "bt709") or config.get("colorRange") not in ("limited", "full"):
        raise ValueError("explicit_frame_interpretation_required")
    if config["csiPort"] not in (0, 2):
        raise ValueError("invalid_rdk_x5_csi_port")
    if 'effectLibrary' in config and (not isinstance(config['effectLibrary'],str) or not Path(config['effectLibrary']).is_absolute()):
        raise ValueError('absolute_private_path_required')
    if 'awbGainLimits' in config:
        policy=config['awbGainLimits']
        if not isinstance(policy,dict) or set(policy)!={'min','max','evidenceRef'} or any(type(policy[k]) not in (int,float) or not math.isfinite(policy[k]) for k in ('min','max')) or not 0<policy['min']<policy['max'] or not isinstance(policy['evidenceRef'],str) or not policy['evidenceRef'].strip():
            raise ValueError('invalid_awb_operator_policy')
    policies=config.get('ispFieldPolicies',{})
    if not isinstance(policies,dict) or len(policies)>128: raise ValueError('invalid_isp_operator_policy')
    for key,policy in policies.items():
        if not isinstance(key,str) or not re.fullmatch(r'[a-zA-Z0-9_.]{1,160}',key) or not isinstance(policy,dict) or set(policy)!={'min','max','evidenceRef'} or any(type(policy[k]) not in (int,float) or not math.isfinite(policy[k]) for k in ('min','max')) or policy['min']>policy['max'] or not isinstance(policy['evidenceRef'],str) or not policy['evidenceRef'].strip():
            raise ValueError('invalid_isp_operator_policy')
    qualifications=config.get('modeReadbackEvidence',{})
    if not isinstance(qualifications,dict) or set(qualifications)-{'exposure','awb','hdr_exposure'} or any(not isinstance(value,str) or not value.strip() or len(value)>300 for value in qualifications.values()): raise ValueError('invalid_mode_readback_evidence')
    disabled=config.get('disabledIspModules',{})
    if not isinstance(disabled,dict) or len(disabled)>31: raise ValueError('invalid_disabled_isp_modules')
    for name,evidence in disabled.items():
        if (not isinstance(name,str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}',name)
            or name in ('exposure','awb','cproc') or not isinstance(evidence,dict)
            or set(evidence)!={'sdkVersion','cameraMode','sensorConfig','observedSdkCode','evidenceRef'}
            or any(evidence.get(key)!=config.get(key) for key in ('sdkVersion','cameraMode','sensorConfig'))
            or type(evidence.get('observedSdkCode')) is not int or not -2147483648<=evidence['observedSdkCode']<0
            or not isinstance(evidence.get('evidenceRef'),str) or not evidence['evidenceRef'].strip()
            or len(evidence['evidenceRef'])>300): raise ValueError('invalid_disabled_isp_modules')
    bindings=config.get('calibrationBindings',{})
    if not isinstance(bindings,dict) or set(bindings)-{'blc','lsc','ccm','awb'} or len(js_json(bindings))>32768:
        raise ValueError('invalid_calibration_bindings')
    for binding in bindings.values():
        if not isinstance(binding,dict) or not isinstance(binding.get('evidenceRef'),str) or not binding['evidenceRef'].strip(): raise ValueError('invalid_calibration_bindings')
    if 'effectLibraryExportBinding' in config:
        sibling('vision-x5-isp').validate_export_binding(config['effectLibraryExportBinding'], config)
    return dict(config)


class Camera:
    def __init__(self, config, backend=None, preflight=None):
        self.config = validate_config(config)
        self.preflight = preflight or sibling("vision-x5-preflight").collect_preflight
        self.frame_tools = sibling("vision-x5-frame")
        self.backend = backend
        self.backend_error = None
        if backend is None:
            try:
                self.backend = NativeBackend(self.config)
            except NativeError as exc:
                self.backend_error = str(exc)
        self.lock = threading.RLock()
        self.running = False
        self.cleanup_required = False
        self.closing = False
        self.original = None
        self.recovery_scope = None
        self.recovery_restarted = False
        self.changed = False
        self.last_frame = {}
        self.current_job = None
        self.last_write = None
        self.state_dir = Path(self.config["stateDir"])
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.state_dir.is_symlink() or self.state_dir.stat().st_mode & 0o077:
            raise ValueError("private_state_directory_required")
        self.journal_file = self.state_dir / "isp-write.json"
        self.unconfirmed = False
        if self.journal_file.exists():
            journal = read_private_json(self.journal_file)
            if journal.get("identity") != self.identity():
                raise ValueError("private_journal_identity_mismatch")
            self.unconfirmed = journal.get("outcome") in ("pending", "unconfirmed")
            # A crash after confirmed write still leaves an outstanding original.
            self.changed = journal.get("outcome") in ("pending", "unconfirmed", "confirmed")
            self.original = journal.get("original") if self.changed else None
            self.unconfirmed = self.changed
            self.recovery_restarted = self.changed
            if self.changed:
                scope = journal.get("recoveryScope")
                self.recovery_scope = scope if scope in ("modules", "library") else "library"
            self.cleanup_required = journal.get("cleanupRequired") is True
            self.last_write = {key: journal[key] for key in ("outcome", "updatedAt", "jobId", "experimentId", "operation", "code") if key in journal}

    def identity(self):
        return {key: self.config[key] for key in IDENTITY if key in self.config}

    def full_isp(self):
        return getattr(self.backend, 'isp', None)

    def capabilities(self):
        native_v2=self.backend is not None and getattr(self.backend,'abi',1)==2
        operations=list(OPERATIONS if native_v2 else OPERATIONS[:12] if self.backend else OPERATIONS[:2])
        qualifications=self.config.get('modeReadbackEvidence',{})
        replay=native_v2 and all(qualifications.get(key) for key in ('exposure','awb'))
        if not replay and 'process_raw' in operations: operations.remove('process_raw')
        if not self.config.get('calibrationBindings') and 'calibration_apply' in operations: operations.remove('calibration_apply')
        return {'contract':CONTRACT,**self.identity(),'operations':operations,
                'implementation':'x5-hbn-native-v2' if native_v2 else 'x5-hbn-native-v1','hardwareVerified':False,
                'sdkAvailable':self.backend is not None,'nativeIspFormat':'x5-hbn-isp-v2' if native_v2 else KIND,'rawReplay':replay,
                'modeQualifications':{key:'private_evidence_configured' if qualifications.get(key) else 'qualification_required' for key in ('exposure','awb','hdr_exposure')},
                'calibrationBindings':sorted(self.config.get('calibrationBindings',{})),
                **({'disabledIspModules':self.config['disabledIspModules']} if self.config.get('disabledIspModules') else {})}

    def require_sdk(self):
        if self.backend is None:
            raise NativeError(self.backend_error or "native_sdk_unavailable")

    def controls(self):
        self.require_sdk()
        controls = self.backend.controls()
        if not isinstance(controls, dict) or not controls:
            raise NativeError("isp_controls_unavailable")
        return controls

    def configuration(self, controls):
        if self.full_isp(): return self.full_isp().read()
        keys = [key for key in CONTROL_NAMES if key in controls and controls[key]["writable"] and controls[key].get("active", True)]
        return {"kind": KIND, "controls": {key: controls[key]["value"] for key in keys}}

    def baseline(self, controls):
        if self.full_isp(): return self.full_isp().baseline()
        config = self.configuration(controls)
        rules = [{"path": "/controls/" + key, "label": key, "min": row["min"], "max": row["max"],
                  **({"step": row["step"]} if "step" in row else {})}
                 for key, row in controls.items() if row["writable"] and row.get("active", True) and type(row["value"]) is not bool]
        return {"config": config, "rules": rules}

    def retain_recovery_scope(self, scope):
        if scope not in ("modules", "library"):
            raise ValueError("isp_invalid_write_intent")
        # Multiple writes share one original. Library intent can only be cleared
        # by a verified complete recovery, never by a later module/control write.
        if self.recovery_scope != "library":
            self.recovery_scope = scope

    def journal(self, outcome, requested=None, code=None):
        row = {"contract": "rdk.x5-isp-write.v1", "identity": self.identity(), "outcome": outcome,
               "original": self.original, "updatedAt": stamp(), "cleanupRequired": self.cleanup_required,
               "recoveryScope": None if outcome == "restored" else self.recovery_scope}
        if self.current_job:
            row.update(self.current_job)
        if requested is not None:
            row["requested"] = requested
        if code:
            row["code"] = code
        fd, name = tempfile.mkstemp(prefix="isp-write-", suffix=".tmp", dir=self.state_dir)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w") as output:
                output.write(js_json(row))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.journal_file)
            self.last_write = {key: row[key] for key in ("outcome", "updatedAt", "jobId", "experimentId", "operation", "code") if key in row}
            directory = os.open(self.state_dir, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            if outcome == "restored":
                self.recovery_scope = None
                self.recovery_restarted = False
        finally:
            temporary.unlink(missing_ok=True)

    def validate_values(self, values, controls, complete=False):
        if not isinstance(values, dict) or not values or set(values) - set(controls):
            raise ValueError("unsupported_isp_control")
        if complete:
            required = {key for key, row in controls.items() if row["writable"]}
            for switch, manual in (("autoExposure", ("exposureUs", "gain")), ("autoWhiteBalance", ("redGain", "blueGain"))):
                if values.get(switch) is True:
                    required -= set(manual)
            if set(values) != required:
                raise ValueError("complete_isp_snapshot_required")
        for key, value in values.items():
            row = controls[key]
            if not row["writable"] or type(value) is bool and type(row["value"]) is not bool or type(value) is not bool and (type(value) not in (int, float) or type(row["value"]) is bool or not math.isfinite(value)):
                raise ValueError("unsupported_isp_control")
            if type(value) is not bool:
                precision=row.get('nativePrecision')
                quantized=ctypes.c_float(value/1e6).value*1e6 if precision=='seconds-float32-us' else ctypes.c_float(value).value if precision=='float32' or row.get("nativeName", "").startswith("hbn_isp_cproc_attr_t.manual_attr.") else value
                if quantized != value:
                    raise ValueError("isp_control_float32_required")
                switch = "autoExposure" if key in ("exposureUs", "gain") else "autoWhiteBalance" if key in ("redGain", "blueGain") else None
                if not row.get("active", True) and not (switch and (values.get(switch) is False or complete and values.get(switch) is True)):
                    raise ValueError("manual_isp_control_inactive")
                if not row["min"] <= value <= row["max"] or row.get("step", 0) > 0 and abs((value - row["min"]) / row["step"] - round((value - row["min"]) / row["step"])) > 1e-5:
                    raise ValueError("isp_control_out_of_range")

    def set_values(self, values, complete=False, recovering=False):
        if self.cleanup_required:
            raise NativeError("camera_stream_cleanup_required")
        if self.unconfirmed and not recovering:
            raise ValueError("isp_write_unconfirmed_restore_required")
        if recovering and self.recovery_scope == "library":
            raise NativeError("isp_full_library_restore_required")
        if recovering and self.full_isp() and self.original:
            intent = self.full_isp().write_intent(self.original, True, self.recovery_scope, self.recovery_restarted)
            if intent == "library":
                raise NativeError("isp_full_library_restore_required")
        before = self.controls()
        self.validate_values(values, before, complete)
        if self.original is None:
            self.original = self.configuration(before)
        self.changed = True
        self.unconfirmed = True
        self.retain_recovery_scope("modules")
        requested = {"kind": KIND, "controls": values}
        self.journal("pending", requested)
        try:
            # Switching to manual and switching back to auto are separate SDK calls.
            for switch in ("autoExposure", "autoWhiteBalance"):
                manual_keys = ("exposureUs", "gain") if switch == "autoExposure" else ("redGain", "blueGain")
                if switch in values and (values[switch] is False or complete and any(key in values for key in manual_keys)):
                    self.backend.set_control(switch, False)
            for key in CONTROL_NAMES:
                if key in values and key not in BOOL_CONTROLS:
                    self.backend.set_control(key, values[key])
            for switch in ("autoExposure", "autoWhiteBalance"):
                if values.get(switch) is True:
                    self.backend.set_control(switch, True)
            actual = self.controls()
            for key, expected in values.items():
                row = actual[key]
                tolerance = max(1e-8, row.get("step", 0) / 2)
                # Dynamic outputs are not usable as a complete restorable snapshot.
                if type(expected) is bool and row["value"] is not expected or type(expected) is not bool and abs(row["value"] - expected) > tolerance:
                    raise NativeError("isp_readback_mismatch")
            actual_config = self.configuration(actual)
            self.verify_write_stream(actual_config, force=recovering)
            self.unconfirmed = False
            self.changed = actual_config != self.original
            self.journal("confirmed" if self.changed else "restored", actual_config)
            return actual
        except Exception as exc:
            self.unconfirmed = True
            self.journal("unconfirmed", requested, error_code(exc))
            raise

    def start(self):
        self.require_sdk()
        if self.cleanup_required:
            raise NativeError("camera_stream_cleanup_required")
        if not self.running:
            try:
                self.backend.start()
                self.running = True
                for _ in range(self.config["discardFrames"]):
                    self.take_frame(False)
                _data, info = self.take_frame(False)
            except Exception:
                self.cleanup_required = True
                try:
                    self.backend.stop()
                except Exception:
                    # A failed stop has no stopped receipt; explicit cleanup is
                    # required before this process will attempt another start.
                    raise
                else:
                    self.running = False
                    self.cleanup_required = False
                    self.last_frame.clear()
                raise
        else:
            _data, info = self.take_frame(False)
        return {"running": True, "width": info["width"], "height": info["height"],
                "evidence": self.frame_evidence(info)}

    def take_frame(self, raw):
        data, info = self.backend.frame(raw)
        width, height = info["width"], info["height"]
        if not all(type(value) is int and 2 <= value <= 8192 and value % 2 == 0 for value in (width, height)) or width * height > 32 * 1024 * 1024:
            raise NativeError("camera_frame_layout_invalid")
        if info["size_y"] + info["size_uv"] != len(data) or len(data) > MAX_FRAME_BYTES or not data:
            raise NativeError("camera_frame_layout_invalid")
        if not raw and (info["packing"] != 3 or info["stride_y"] < width or info["stride_uv"] < width
                        or info["size_y"] != info["stride_y"] * height or info["size_uv"] != info["stride_uv"] * height // 2):
            raise NativeError("camera_frame_layout_invalid")
        if info["frame_id"] < 0 or info["timestamp_ns"] <= 0:
            raise NativeError("camera_frame_identity_missing")
        last = self.last_frame.get(raw)
        if last and (info["frame_id"] <= last["frame_id"] or info["timestamp_ns"] <= last["timestamp_ns"]):
            raise NativeError("camera_frame_stale")
        self.last_frame[raw] = info
        return data, info

    def frame_evidence(self, info):
        return {"source": self.backend.source, "frameId": str(info["frame_id"]), "sdkTimestampNs": str(info["timestamp_ns"]),
                "timestampSource": "hbn_frame_info.tv_timeval",
                "hardwareAcceptance": "unverified", "sensorConfig": self.config["sensorConfig"]}

    def reset_frame_ids(self):
        # A restarted flow may reset its ID counter. Keep the timestamp floor
        # so an old queued frame cannot receive the new configuration hash.
        for info in self.last_frame.values():
            info["frame_id"] = -1

    def verify_write_stream(self, expected, force=False):
        """Confirm a new valid frame before committing a write/recovery receipt.

        A getter can succeed after scene switching has broken the live flow.
        Replay cleanup alone cannot prove that the camera stream is usable.
        """
        if not self.running and not force:
            return None
        try:
            if not self.running:
                evidence = self.start()["evidence"]
            else:
                for _ in range(self.config["discardFrames"]):
                    self.take_frame(False)
                _data, info = self.take_frame(False)
                evidence = self.frame_evidence(info)
            if self.configuration(self.controls()) != expected:
                raise NativeError("isp_controls_changed_during_capture")
            return {"status": "verified", **evidence}
        except Exception:
            self.cleanup_required = True
            raise

    def image(self, scene=None):
        self.start()
        before = self.controls()
        data, info = self.take_frame(False)
        received_at = stamp()
        after = self.controls()
        if self.configuration(before) != self.configuration(after):
            raise NativeError("isp_controls_changed_during_capture")
        if info["packing"] != 3:
            raise NativeError("isp_nv12_required")
        png = self.frame_tools.nv12_to_png(data[:info["size_y"]], data[info["size_y"]:], width=info["width"], height=info["height"],
            y_stride=info["stride_y"], uv_stride=info["stride_uv"], matrix=self.config["colorMatrix"], color_range=self.config["colorRange"])
        if len(png) > 16 * 1024 * 1024:
            raise NativeError("camera_image_output_limit")
        return {"filename": "x5-isp.png", "mimeType": "image/png", "contentBase64": base64.b64encode(png).decode(),
                "sha256": hashlib.sha256(png).hexdigest(), "width": info["width"], "height": info["height"], "capturedAt": received_at,
                "controls": after, "tuningHash": digest(self.configuration(after)), "scene": scene or "camera",
                "evidence": {**self.frame_evidence(info), "capturedAtSource": "host_receipt_after_sdk_getframe", "inputKind": "x5-isp-nv12", "colorMatrix": self.config["colorMatrix"], "colorRange": self.config["colorRange"]}}

    def apply_full(self, tuning, recovering=False):
        isp=self.full_isp()
        if not isp: raise NativeError('full_isp_unavailable')
        if self.cleanup_required: raise NativeError('camera_stream_cleanup_required')
        if self.unconfirmed and not recovering: raise ValueError('isp_write_unconfirmed_restore_required')
        isp.prepare(tuning)
        intent = isp.write_intent(tuning, recovering, self.recovery_scope, self.recovery_restarted)
        if recovering and hasattr(self.backend,'replay_cleanup'):
            self.backend.replay_cleanup()
        if self.original is None: self.original=isp.read()
        self.retain_recovery_scope(intent)
        self.changed=True; self.unconfirmed=True; self.journal('pending',tuning)
        generation=isp.scene_generation
        try:
            actual=isp.apply(tuning,intent=intent)
            if isp.scene_generation != generation: self.reset_frame_ids()
            actual_hash=digest(actual)
            if actual_hash!=digest(tuning): raise NativeError('isp_readback_mismatch')
            stream=self.verify_write_stream(actual,force=True)
            self.unconfirmed=False; self.changed=actual!=self.original
            self.journal('confirmed' if self.changed else 'restored',actual)
            return {'appliedHash':actual_hash,'readbackHash':actual_hash,'evidence':{'format':'x5-hbn-isp-v2','config':actual,
                'readback':'independent_hbn_isp_get_after_set','socIsp':True,'fullEffectLibrary':False,
                'streamVerification':stream,
                'readbackScope':isp.readback_scope(),'excludedModules':isp.disabled_modules,'writeIntent':intent,'modeReadbackQualification':{key:'private_evidence_configured' for key in self.config.get('modeReadbackEvidence',{})},'hardwareAcceptance':'unverified'}}
        except Exception as exc:
            if str(exc) == 'isp_effect_library_load_failed' or isp.scene_generation != generation:
                self.cleanup_required=True
            self.unconfirmed=True; self.journal('unconfirmed',tuning,error_code(exc)); raise

    def load_effect(self, inputs):
        isp=self.full_isp()
        if not isp: raise NativeError('full_isp_unavailable')
        if self.cleanup_required: raise NativeError('camera_stream_cleanup_required')
        if self.unconfirmed: raise ValueError('isp_write_unconfirmed_restore_required')
        text=inputs.get('contentBase64')
        if not isinstance(text,str) or len(text)>24*1024*1024: raise ValueError('isp_effect_library_size_invalid')
        try: blob=base64.b64decode(text,validate=True)
        except Exception: raise ValueError('isp_effect_library_encoding_invalid')
        if base64.b64encode(blob).decode()!=text or hashlib.sha256(blob).hexdigest()!=inputs.get('sha256'): raise ValueError('isp_effect_library_hash_mismatch')
        role=inputs.get('artifactRole')
        if role is not None and role!='vendor_effect_library_candidate': raise ValueError('isp_effect_library_role_invalid')
        isp.library_bytes(blob)
        if role: isp.validate_vendor_candidate(blob)
        before=isp.read()
        if 'library' not in isp.load_snapshot(before['snapshotId']): raise ValueError('isp_original_effect_library_unavailable')
        if self.original is None: self.original=before
        self.retain_recovery_scope('library')
        self.changed=True; self.unconfirmed=True; self.journal('pending',{'librarySha256':inputs['sha256']})
        try:
            vendor_receipt=isp.load_library(blob,require_candidate=bool(role))
            self.reset_frame_ids()
            actual,missing=isp.snapshot(blob)
            actual_hash=digest(actual)
            stream=self.verify_write_stream(actual,force=True)
            vendor_validation=isp.record_vendor_reload(blob,vendor_receipt,stream) if vendor_receipt else None
            self.unconfirmed=False; self.journal('confirmed',actual)
            return {**isp.export(),'appliedHash':actual_hash,'readbackHash':actual_hash,'baseline':isp.baseline(),
                'evidence':{'sdkCall':'hbn_camera_switch_scence','moduleReadback':'independent_hbn_isp_get',
                    'librarySha256':inputs['sha256'],'readbackScope':isp.readback_scope(),'excludedModules':isp.disabled_modules,'unavailableModules':missing,
                    'streamVerification':stream,
                    **({'vendorCandidateValidation':vendor_validation} if vendor_validation else {}),
                    'unexposedLibraryFieldsReadback':False,'hardwareAcceptance':'unverified'}}
        except Exception as exc:
            # Scene switching may have stopped or partially restarted the
            # flow before returning an SDK error. No automatic scene replay.
            self.cleanup_required=True
            self.unconfirmed=True; self.journal('unconfirmed',{'librarySha256':inputs['sha256']},error_code(exc)); raise

    def process_raw(self, inputs):
        self.require_sdk()
        if self.cleanup_required: raise NativeError('camera_stream_cleanup_required')
        if self.unconfirmed: raise ValueError('isp_write_unconfirmed_restore_required')
        if getattr(self.backend,'abi',1)==2 and not all(self.config.get('modeReadbackEvidence',{}).get(name) for name in ('exposure','awb')):
            raise ValueError('raw_replay_mode_qualification_required')
        raw=inputs.get('raw'); tuning=inputs.get('tuning')
        if not isinstance(raw,dict) or set(raw)!={'filename','metadata','sha256','contentBase64'} or not isinstance(tuning,dict) or digest(tuning)!=inputs.get('tuningHash'):
            raise ValueError('raw_replay_input_invalid')
        text=raw['contentBase64']
        if not isinstance(text,str) or len(text)>90*1024*1024: raise ValueError('raw_replay_input_limit')
        try: data=base64.b64decode(text,validate=True)
        except Exception: raise ValueError('raw_replay_input_encoding_invalid')
        if not 0<len(data)<=MAX_FRAME_BYTES or base64.b64encode(data).decode()!=text or hashlib.sha256(data).hexdigest()!=raw['sha256']:
            raise ValueError('raw_replay_input_hash_mismatch')
        metadata=raw['metadata']
        if not isinstance(metadata,dict) or metadata.get('packing')!='unpacked16le' or metadata.get('bitDepth')!=10 or metadata.get('bayer') not in ('RGGB','BGGR','GRBG','GBRG'):
            raise ValueError('raw_replay_layout_unsupported')
        if any(type(metadata.get(k)) is not int for k in ('width','height','stride')) or not 2<=metadata['width']<=8192 or not 2<=metadata['height']<=8192 or metadata['width']%2 or metadata['height']%2 or metadata['stride']<metadata['width']*2 or metadata['stride']%2 or len(data)!=metadata['stride']*metadata['height']:
            raise ValueError('raw_replay_layout_invalid')
        # Validate actual container words before changing tuning or the pipeline.
        # The native replay also checks them, but that happens after apply_full.
        self.frame_tools.raw16_container_to_unpacked16le(data,width=metadata['width'],height=metadata['height'],
            stride=metadata['stride'],bit_depth=10,alignment='right',byteorder='little')
        self.start()
        if self.configuration(self.controls())!=tuning:
            if tuning.get('kind')=='x5-hbn-isp-v2': self.apply_full(tuning)
            else: self.set_values(tuning.get('controls'),complete=True)
        before=self.configuration(self.controls())
        if digest(before)!=inputs['tuningHash']: raise NativeError('isp_readback_mismatch')
        try:
            output,info=self.backend.replay(data,metadata)
            self.reset_frame_ids() # native replay has restarted the prior live flow
            if self.configuration(self.controls())!=before: raise NativeError('isp_controls_changed_during_replay')
            if info['width']!=metadata['width'] or info['height']!=metadata['height'] or info['packing']!=3 or info['size_y']!=info['stride_y']*info['height'] or info['size_uv']!=info['stride_uv']*info['height']//2 or len(output)!=info['size_y']+info['size_uv'] or info['timestamp_ns']<=0 or info['frame_id']<=0:
                raise NativeError('raw_replay_layout_invalid')
            png=self.frame_tools.nv12_to_png(output[:info['size_y']],output[info['size_y']:],width=info['width'],height=info['height'],y_stride=info['stride_y'],uv_stride=info['stride_uv'],matrix=self.config['colorMatrix'],color_range=self.config['colorRange'])
            if len(png)>16*1024*1024: raise NativeError('camera_image_output_limit')
            return {'filename':'x5-raw-replay.png','mimeType':'image/png','contentBase64':base64.b64encode(png).decode(),
                'sha256':hashlib.sha256(png).hexdigest(),'rawHash':raw['sha256'],'tuningHash':digest(before),'readbackHash':digest(before),
                'width':info['width'],'height':info['height'],'evidence':{**self.frame_evidence(info),'timestampSource':'submitted_host_time_echoed_by_sdk',
                    'inputKind':'archived_bayer_raw10','rawHash':raw['sha256'],'tuningHash':digest(before),'readbackHash':digest(before),'sdkReplay':'hbn_vnode_sendframe_getframe_matching_id_and_timeval'}}
        except Exception as exc:
            self.cleanup_required=True
            try:
                self.backend.replay_cleanup(); self.reset_frame_ids(); self.cleanup_required=False
            except Exception: pass
            if self.cleanup_required:
                self.journal('unconfirmed' if self.unconfirmed else 'confirmed' if self.changed else 'cleanup_required', code=error_code(exc))
            raise exc

    def execute(self, operation, inputs):
        with self.lock:
            if self.closing:
                raise ValueError("camera_adapter_closing")
            if operation not in OPERATIONS or not isinstance(inputs, dict):
                raise ValueError("operation_unavailable")
            allowed = {"controls_set": {"values"}, "apply_tuning": {"tuning", "tuningHash"}, "restore_tuning": {"tuning", "tuningHash"},
                       "capture_raw": {"scene"}, "capture_frame": {"scene"},
                       "process_raw": {"raw", "tuning", "tuningHash"}, "tuning_load": {"contentBase64","sha256","artifactRole"},
                       "calibration_apply": {"result","options"}}.get(operation, set())
            if set(inputs) - allowed:
                raise ValueError("invalid_inputs")
            if operation == "probe":
                facts = {"environment": self.preflight(), "nativeSdkAvailable": self.backend is not None,
                         "streaming": None if self.cleanup_required else self.running, "cleanupRequired": self.cleanup_required,
                         "writeOutcome": "unconfirmed" if self.unconfirmed else "idle", "recoveryScope": self.recovery_scope,
                         "nativeIspFormat": "x5-hbn-isp-v2" if getattr(self.backend,"abi",1)==2 else KIND, "rawReplay": self.capabilities()["rawReplay"], "hardwareVerified": False}
                result = {"facts": facts}
                if self.unconfirmed and isinstance(self.original, dict):
                    # Bind explicit recovery to the durable original, without
                    # exporting private SDK snapshots or filesystem paths.
                    facts["recoveryOriginalHash"] = digest(self.original)
                if self.backend_error:
                    facts["nativeSdkReason"] = self.backend_error
                if self.last_write:
                    facts["lastWrite"] = dict(self.last_write)
                if self.running and not self.cleanup_required:
                    result["baseline"] = self.baseline(self.controls())
                return result
            if operation == "pipeline_validate":
                observed = False
                evidence = {"hardwareVerified": False, "reason": "actual_stream_required"}
                if self.cleanup_required:
                    evidence["reason"] = "camera_stream_cleanup_required"
                elif self.running:
                    try:
                        _data, info = self.take_frame(False)
                        observed = True
                        evidence.update(self.frame_evidence(info), reason="fresh_stream_observed")
                    except Exception as exc:
                        evidence.update(reason="actual_stream_failed", failureCode=error_code(exc))
                return {"passed": observed, "checks": [
                    {"name": "native-sdk-and-config", "passed": self.backend is not None},
                    {"name": "actual-current-stream-frame", "passed": observed}], "evidence": evidence}
            if operation in ("bringup", "preview_start"):
                status = self.start()
                return {"passed": True, "checks": [{"name": "actual-isp-frame", "passed": True}], "evidence": status,
                        "baseline": self.baseline(self.controls())} if operation == "bringup" else status
            if operation == "preview_stop":
                self.require_sdk()
                self.backend.stop()
                self.running = False
                self.cleanup_required = False
                self.last_frame.clear()
                if self.journal_file.exists():
                    previous = read_private_json(self.journal_file)
                    if previous.get("cleanupRequired"):
                        self.journal("unconfirmed" if self.unconfirmed else "idle" if previous["outcome"] == "cleanup_required" else previous["outcome"],
                                     previous.get("requested"), previous.get("code"))
                return {"running": False, "evidence": {"stop": "hbn_vflow_stop"}}
            if operation == "controls_get":
                return {"controls": self.controls(), "evidence": {"readback": "hbn_isp_get", "writeOutcome": "unconfirmed" if self.unconfirmed else "idle"}}
            if operation == "controls_set":
                return {"controls": self.set_values(inputs.get("values")), "evidence": {"readback": "hbn_isp_get_after_set", "socIsp": True}}
            if operation in ('tuning_get','tuning_export'):
                self.require_sdk()
                if not self.full_isp(): raise NativeError('full_isp_unavailable')
                return {**self.full_isp().export(), 'baseline': self.full_isp().baseline()}
            if operation == 'tuning_load':
                return self.load_effect(inputs)
            if operation == 'calibration_apply':
                if not self.full_isp(): raise NativeError('full_isp_unavailable')
                mapped=self.full_isp().map_calibration(inputs.get('result'),inputs.get('options',{}))
                if 'library' in mapped:
                    blob=mapped['library']
                    result=self.load_effect({'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()})
                else:
                    result=self.apply_full(mapped['tuning'])
                    result['baseline']=self.full_isp().baseline()
                result['calibrationEvidence']={**mapped['evidence'],'outputSha256':inputs['result']['outputSha256'],'hardwareVerification':'unverified','qualityVerification':'unverified'}
                return result
            if operation == 'process_raw':
                return self.process_raw(inputs)
            if operation in ("apply_tuning", "restore_tuning"):
                if inputs.get('tuning',{}).get('kind')=='x5-hbn-isp-v2':
                    if digest(inputs['tuning'])!=inputs.get('tuningHash'): raise ValueError('tuning_hash_mismatch')
                    return self.apply_full(inputs['tuning'],operation=='restore_tuning')
                tuning = inputs.get("tuning")
                if not isinstance(tuning, dict) or set(tuning) != {"kind", "controls"} or tuning.get("kind") != KIND:
                    raise ValueError("unsupported_isp_tuning_format")
                if digest(tuning) != inputs.get("tuningHash"):
                    raise ValueError("tuning_hash_mismatch")
                actual = self.set_values(tuning["controls"], complete=True, recovering=operation == "restore_tuning")
                readback = {"kind": KIND, "controls": {key: actual[key]["value"] for key in tuning["controls"]}}
                actual_hash = digest(readback)
                if actual_hash != inputs["tuningHash"]:
                    self.unconfirmed = True
                    self.journal("unconfirmed", tuning, "isp_readback_mismatch")
                    raise NativeError("isp_readback_mismatch")
                return {"appliedHash": actual_hash, "readbackHash": actual_hash,
                        "evidence": {"readback": "independent_hbn_isp_get_after_set", "config": readback, "controls": actual,
                                     "socIsp": True, "format": KIND, "fullEffectLibrary": False}}
            if operation in ("preview_frame", "capture_frame"):
                scene = inputs.get("scene")
                if scene is not None and (not isinstance(scene, str) or not scene.strip() or len(scene) > 120):
                    raise ValueError("invalid_scene")
                return self.image(scene)
            if operation == "capture_raw":
                scene = inputs.get("scene")
                if not isinstance(scene, str) or not scene.strip() or len(scene) > 120:
                    raise ValueError("invalid_scene")
                self.start()
                data, info = self.take_frame(True)
                if info["packing"] != 0 or info["bayer"] not in range(4) or info["alignment"] not in (0, 1) or info["size_uv"]:
                    raise NativeError("vin_raw_layout_unsupported")
                raw = self.frame_tools.raw16_container_to_unpacked16le(data, width=info["width"], height=info["height"],
                    stride=info["stride_y"], bit_depth=info["bit_depth"], alignment=("right", "left")[info["alignment"]], byteorder="little")
                if self.config["whiteLevel"] >= 2 ** info["bit_depth"]:
                    raise ValueError("raw_levels_mismatch")
                metadata = {"scene": scene, "width": info["width"], "height": info["height"], "bitDepth": info["bit_depth"],
                    "bayer": ("RGGB", "BGGR", "GRBG", "GBRG")[info["bayer"]], "packing": "unpacked16le", "stride": info["width"] * 2,
                    "blackLevel": self.config["blackLevel"], "whiteLevel": self.config["whiteLevel"]}
                return {"filename": "x5-vin.raw", "metadata": metadata, "contentBase64": base64.b64encode(raw).decode(),
                        "sha256": hashlib.sha256(raw).hexdigest(), "evidence": self.frame_evidence(info)}
            raise ValueError("operation_unavailable")

    def close(self):
        with self.lock:
            self.closing = True
            try:
                # A failed live flow must be explicitly cleaned up. Shutdown
                # must not replay another effect-library switch into that flow.
                if self.backend and self.changed and self.original and not self.cleanup_required:
                    self.backend.replay_cleanup() if hasattr(self.backend,'replay_cleanup') else None
                    if self.original.get('kind')=='x5-hbn-isp-v2': self.apply_full(self.original,recovering=True)
                    else: self.set_values(self.original["controls"], complete=True, recovering=True)
            finally:
                if self.backend:
                    try:
                        self.backend.stop()
                    finally:
                        self.running = False
                        self.backend.close()


def error_code(exc):
    return str(exc) if re.fullmatch(r"[a-z_]{1,100}", str(exc)) else "camera_operation_failed"


def read_private_json(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "r") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 32 * 1024 * 1024 or info.st_uid != os.geteuid():
            raise ValueError("private_regular_config_required")
        return json.loads(source.read())


def create_server(config, camera=None):
    camera = camera or Camera(config)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", "").encode("utf-8"), ("Bearer " + config["token"]).encode("ascii"))

        def do_GET(self):
            if not self.authorized():
                self.respond(401, {"ok": False, "error": "unauthorized"})
            elif self.path == "/capabilities":
                self.respond(200, {"ok": True, **camera.capabilities()})
            else:
                self.respond(404, {"ok": False, "error": "not_found"})

        def do_POST(self):
            if not self.authorized() or self.path != "/execute":
                self.respond(401 if not self.authorized() else 404, {"ok": False, "error": "unauthorized" if not self.authorized() else "not_found"})
                return
            try:
                if self.headers.get("Transfer-Encoding") or not self.headers.get("Content-Type", "").startswith("application/json"):
                    raise ValueError("invalid_request_encoding")
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= (96 * 1024 * 1024 if getattr(camera.backend,"abi",1)==2 else 65536):
                    raise ValueError("request_limit")
                self.connection.settimeout(10)
                body = self.rfile.read(size)
                if len(body) != size:
                    raise ValueError("incomplete_request")
                task = json.loads(body, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("nonfinite_json")))
                if not isinstance(task, dict) or set(task) != {"contract", "operation", "context", "inputs"} or task["contract"] != CONTRACT:
                    raise ValueError("invalid_contract")
                context = task["context"]
                if not isinstance(context, dict) or set(context) - {*IDENTITY, "jobId", "experimentId"} or any(context.get(key) != config.get(key) for key in IDENTITY):
                    raise ValueError("profile_mismatch")
                if any(not isinstance(context.get(key), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", context[key]) for key in ("jobId", "experimentId")):
                    raise ValueError("invalid_job_identity")
                if not camera.lock.acquire(blocking=False):
                    self.respond(429, {"ok": False, "error": "camera_busy"})
                    return
                try:
                    camera.current_job = {"jobId": context["jobId"], "experimentId": context["experimentId"], "operation": task["operation"]}
                    result = camera.execute(task["operation"], task["inputs"])
                finally:
                    camera.current_job = None
                    camera.lock.release()
                self.respond(200, {"ok": True, "contract": CONTRACT, "operation": task["operation"], "jobId": context["jobId"], "result": result})
            except Exception as exc:
                self.respond(422, {"ok": False, "error": error_code(exc),
                                   **({"sdkCode": exc.sdk_code} if isinstance(exc, NativeError) and exc.sdk_code is not None else {})})

        def respond(self, status, data):
            body = js_json(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # A disconnected write is queried, never retried by this daemon.

    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)
    server.daemon_threads = True
    server.camera = camera
    return server


def serve(config):
    server = create_server(config)
    camera = server.camera

    def stop(_signal, _frame):
        # Fence new requests before draining existing SDK work and restoration.
        camera.closing = True
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        try:
            camera.close()
        finally:
            server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        serve(validate_config(read_private_json(args.config)))
    except Exception as exc:
        print(error_code(exc), file=__import__("sys").stderr)
        raise SystemExit(1)
