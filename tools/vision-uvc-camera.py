#!/usr/bin/env python3
"""Real V4L2/UVC camera adapter. USB images are processed frames, never Bayer RAW.

Runs on the board, bound to loopback with a private bearer token. It owns only
the configured capture device, preserves its controls, and releases it on stop.
No commands, paths, URLs or arbitrary V4L2 IDs are accepted from API requests.
"""
import argparse
import base64
import copy
import hashlib
import hmac
import json
import math
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONTROLS = {
    "exposureUs": ("exposure_time_absolute", 100, "µs"),
    "gain": ("gain", 1, "device units"),
    "brightness": ("brightness", 1, "device units"),
    "contrast": ("contrast", 1, "device units"),
    "saturation": ("saturation", 1, "device units"),
    "hue": ("hue", 1, "device units"),
    "gamma": ("gamma", 1, "device units"),
    "sharpness": ("sharpness", 1, "device units"),
    "whiteBalanceTemperature": ("white_balance_temperature", 1, "K"),
    "autoExposure": ("auto_exposure", 1, "boolean"),
    "autoWhiteBalance": ("white_balance_automatic", 1, "boolean"),
}
OPERATIONS = {"probe", "pipeline_validate", "bringup", "preview_start",
              "preview_stop", "preview_frame", "capture_frame", "controls_get",
              "controls_set", "apply_tuning", "restore_tuning"}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def parse_controls(text):
    """Parse actual driver ranges, current values and supported exposure menu."""
    native = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\w+)\s+0x[0-9a-f]+\s+\((\w+)\)\s*:\s*(.*)", line)
        if not m:
            continue
        attrs = {key: int(value) for key, value in re.findall(r"(min|max|step|default|value)=(-?\d+)", m[3])}
        attrs.update(type=m[2], flags=m[3].split("flags=", 1)[1] if "flags=" in m[3] else "")
        native[m[1]] = attrs
    result = {}
    for key, (name, scale, unit) in CONTROLS.items():
        row = native.get(name)
        if not row or "value" not in row:
            continue
        writable = "read-only" not in row["flags"] and "disabled" not in row["flags"]
        if key == "autoExposure":
            # UVC manual=1, aperture-priority=3. Other modes are not guessed.
            menu = text.split(name, 1)[1].split("\n\n", 1)[0]
            if row["value"] not in {1, 3} or not re.search(r"\b1:\s*Manual", menu) or not re.search(r"\b3:\s*Aperture", menu):
                continue
            result[key] = {"value": row["value"] != 1, "writable": writable, "nativeName": name, "unit": unit}
        elif key == "autoWhiteBalance":
            result[key] = {"value": bool(row["value"]), "writable": writable, "nativeName": name, "unit": unit}
        elif all(part in row for part in ["min", "max", "step"]):
            result[key] = {"value": row["value"] * scale, "min": row["min"] * scale,
                           "max": row["max"] * scale, "step": max(1, row["step"]) * scale,
                           "writable": writable, "nativeName": name, "unit": unit,
                           "active": "inactive" not in row["flags"]}
    return result


class Camera:
    def __init__(self, config):
        self.config = config
        self.device = config["device"]
        if not re.fullmatch(r"/dev/video\d+", self.device):
            raise ValueError("invalid_capture_device")
        self.lock = threading.RLock()
        self.condition = threading.Condition()
        self.stop = threading.Event()
        self.thread = None
        self.frame = None
        self.captured_at = None
        self.capture_error = None
        self.original = None
        self.tuning_keys = None
        self.negotiated_fps = None
        self.closing = False

    def v4l2(self, *args):
        result = subprocess.run(["v4l2-ctl", "-d", self.device, *args],
                                capture_output=True, text=True, timeout=8, check=True)
        return result.stdout

    def controls(self):
        return parse_controls(self.v4l2("--list-ctrls-menus"))

    def configuration(self, controls):
        keys = self.tuning_keys or [key for key, row in controls.items() if row["writable"]]
        if set(keys) != {key for key, row in controls.items() if row["writable"]}:
            raise ValueError("camera_controls_changed")
        return {"kind": "uvc-controls-v1", "controls": {key: controls[key]["value"] for key in keys}}

    def baseline(self, controls=None):
        controls = self.controls() if controls is None else controls
        rules = [{"path": "/controls/" + key, "label": key + " (" + row["unit"] + ")",
                  "min": row["min"], "max": row["max"], "step": row["step"]}
                 for key, row in controls.items() if row["writable"] and row.get("active", True) and "min" in row]
        return {"config": self.configuration(controls), "rules": rules}

    def set_values(self, values):
        if not isinstance(values, dict) or not values or len(values) > len(CONTROLS):
            raise ValueError("invalid_controls")
        current = self.controls()
        for key, value in values.items():
            row = current.get(key)
            if not row or not row["writable"]:
                raise ValueError("unsupported_control")
            if isinstance(row["value"], bool):
                if not isinstance(value, bool):
                    raise ValueError("invalid_control_type")
            elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
                    or value < row["min"] or value > row["max"] \
                    or abs((value - row["min"]) / row["step"] - round((value - row["min"]) / row["step"])) > 1e-8:
                raise ValueError("control_out_of_range")
        # Snapshot before the first write. Used for explicit restore and shutdown.
        if self.original is None:
            self.original = {key: row["value"] for key, row in current.items() if row["writable"]}
        previous = {key: row["value"] for key, row in current.items() if row["writable"]}
        was_running = bool(self.thread and self.thread.is_alive())
        if was_running:
            self.stop_preview()
        try:
            self._write_values(values, current)
            actual = self.controls()
            if any(actual.get(key, {}).get("value") != value for key, value in values.items()):
                raise ValueError("control_readback_mismatch")
            return actual
        except Exception:
            # A multi-control write may partially succeed; roll back our own write.
            self._write_values(previous, self.controls())
            rolled_back = self.controls()
            if any(rolled_back.get(key, {}).get("value") != value for key, value in previous.items()):
                raise ValueError("control_rollback_unconfirmed")
            raise
        finally:
            # Restarting creates a fresh streaming queue after the write, so
            # archived candidate frames cannot be pre-write buffered images.
            if was_running:
                self.start()

    def _write_values(self, values, current):
        auto = {"autoExposure": "exposureUs", "autoWhiteBalance": "whiteBalanceTemperature"}
        final_auto = {}
        for switch, manual in auto.items():
            if manual in values and switch in current:
                final_auto[switch] = values.get(switch, current[switch]["value"])
                self._write(switch, False)
        for key, value in values.items():
            if key not in auto:
                self._write(key, value)
        for key in auto:
            if key in values or key in final_auto:
                self._write(key, values.get(key, final_auto.get(key)))

    def _write(self, key, value):
        name, scale, _unit = CONTROLS[key]
        native = (3 if value else 1) if key == "autoExposure" else int(value / scale) if not isinstance(value, bool) else int(value)
        self.v4l2("--set-ctrl", name + "=" + str(native))

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return self.status()
            # Preserve controls even if the user only starts preview.
            if self.original is None:
                self.original = {key: row["value"] for key, row in self.controls().items() if row["writable"]}
            self.stop.clear()
            self.frame = None
            self.capture_error = None
            self.thread = threading.Thread(target=self.capture, daemon=True)
            self.thread.start()
            self.wait_frame(8)
            return self.status()

    def capture(self):
        import cv2
        cap = cv2.VideoCapture(self.device, cv2.CAP_V4L2)
        try:
            if not cap.isOpened():
                raise ValueError("camera_open_failed")
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.config["width"])
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config["height"])
            cap.set(cv2.CAP_PROP_FPS, self.config["fps"])
            negotiated_fps = cap.get(cv2.CAP_PROP_FPS)
            self.negotiated_fps = negotiated_fps if negotiated_fps > 0 else None
            discard = 5
            while not self.stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    raise ValueError("camera_read_failed")
                if frame.shape[1] != self.config["width"] or frame.shape[0] != self.config["height"]:
                    raise ValueError("camera_mode_mismatch")
                if discard:
                    discard -= 1
                    continue
                with self.condition:
                    self.frame = frame
                    self.captured_at = stamp()
                    self.condition.notify_all()
        except Exception as exc:
            self.capture_error = str(exc)
            with self.condition:
                self.condition.notify_all()
        finally:
            cap.release()

    def wait_frame(self, timeout=4, newer_than=None):
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.frame is None or (newer_than and self.captured_at <= newer_than):
                if self.capture_error:
                    raise ValueError(self.capture_error)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("camera_frame_timeout")
                self.condition.wait(remaining)
            return self.frame.copy(), self.captured_at

    def status(self):
        if self.frame is None:
            return {"running": False}
        return {"running": bool(self.thread and self.thread.is_alive()),
                "width": int(self.frame.shape[1]), "height": int(self.frame.shape[0]),
                **({"fps": self.negotiated_fps} if self.negotiated_fps else {})}

    def stop_preview(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=5)
            if self.thread.is_alive():
                raise ValueError("camera_stop_unconfirmed")
        self.thread = None
        return {"running": False}

    def image(self, png=False):
        import cv2
        self.start()
        frame, captured_at = self.wait_frame(newer_than=self.captured_at)
        extension = ".png" if png else ".jpg"
        ok, encoded = cv2.imencode(extension, frame, [] if png else [cv2.IMWRITE_JPEG_QUALITY, 82])
        if not ok:
            raise ValueError("camera_encode_failed")
        data = encoded.tobytes()
        return {"filename": "camera" + extension, "mimeType": "image/png" if png else "image/jpeg",
                "contentBase64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest(),
                "width": int(frame.shape[1]), "height": int(frame.shape[0]), "capturedAt": captured_at,
                "source": "camera", "inputKind": "uvc-processed-frame"}

    def execute(self, operation, inputs):
        if operation not in OPERATIONS or not isinstance(inputs, dict):
            raise ValueError("operation_unavailable")
        with self.lock:
            if self.closing:
                raise ValueError("camera_adapter_closing")
            if operation == "probe":
                info = self.v4l2("--all")
                formats = self.v4l2("--list-formats-ext")
                return {"facts": {"board": self.config["board"], "camera": self.config["sensorModel"],
                        "interface": "USB UVC", "driver": "uvcvideo", "formats": formats,
                        "bayerRaw": False, "socIsp": False, "driverInfo": info}, "baseline": self.baseline()}
            if operation == "pipeline_validate":
                formats = self.v4l2("--list-formats-ext")
                checks = [{"name": "capture-device", "passed": Path(self.device).exists()},
                          {"name": "mjpeg-output", "passed": "MJPG" in formats},
                          {"name": "camera-controls", "passed": bool(self.controls())}]
                return {"passed": all(row["passed"] for row in checks), "checks": checks,
                        "evidence": {"rawAvailable": False, "socIspAvailable": False}}
            if operation in {"bringup", "preview_start"}:
                status = self.start()
                return {"passed": status["running"], "checks": [{"name": "actual-frame", "passed": status["running"]}], "evidence": status} if operation == "bringup" else status
            if operation == "preview_stop":
                return self.stop_preview()
            if operation in {"preview_frame", "capture_frame"}:
                controls = self.controls() if operation == "capture_frame" else None
                result = self.image(png=operation == "capture_frame")
                if operation == "capture_frame":
                    after = self.controls()
                    if self.configuration(controls) != self.configuration(after):
                        raise ValueError("camera_controls_changed_during_capture")
                    result["controls"] = controls
                    result["scene"] = inputs.get("scene", "camera")
                    result["tuningHash"] = digest(self.configuration(controls))
                return result
            if operation == "controls_get":
                return {"controls": self.controls()}
            if operation == "controls_set":
                if set(inputs) != {"values"}:
                    raise ValueError("invalid_controls")
                before = self.controls()
                for manual, switch in {"exposureUs": "autoExposure", "whiteBalanceTemperature": "autoWhiteBalance"}.items():
                    if manual in inputs["values"] and not before.get(manual, {}).get("active", True) and inputs["values"].get(switch) is not False:
                        raise ValueError("manual_control_inactive")
                return {"controls": self.set_values(inputs["values"]), "evidence": {"readback": "actual-v4l2-get"}}
            if operation in {"apply_tuning", "restore_tuning"}:
                tuning = inputs.get("tuning")
                if not isinstance(tuning, dict) or set(tuning) != {"kind", "controls"} or tuning["kind"] != "uvc-controls-v1":
                    raise ValueError("unsupported_tuning_format")
                if digest(tuning) != inputs.get("tuningHash"):
                    raise ValueError("tuning_hash_mismatch")
                before = self.controls()
                if set(tuning["controls"]) != {key for key, row in before.items() if row["writable"]}:
                    raise ValueError("complete_control_snapshot_required")
                actual = self.set_values(tuning["controls"])
                self.tuning_keys = list(tuning["controls"])
                readback = copy.deepcopy(tuning)
                for key in readback["controls"]:
                    readback["controls"][key] = actual[key]["value"]
                actual_hash = digest(readback)
                return {"appliedHash": actual_hash, "readbackHash": actual_hash,
                        "evidence": {"readback": "actual-v4l2-get", "controls": actual,
                        "processing": "camera-internal-uvc-controls", "socIsp": False}}
            raise ValueError("operation_unavailable")

    def close(self):
        with self.lock:
            self.closing = True
            self.stop_preview()
            if self.original:
                self.set_values(self.original)


def serve(config):
    token = config["token"]
    if not isinstance(token, str) or len(token) < 24:
        raise ValueError("invalid_private_token")
    camera = Camera(config)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_POST(self):
            if self.path != "/execute" or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.respond(403, {"error": "unauthorized"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 1 or size > 1024 * 1024:
                    raise ValueError("request_limit")
                value = json.loads(self.rfile.read(size))
                if not isinstance(value, dict) or set(value) != {"operation", "inputs"}:
                    raise ValueError("invalid_request")
                result = camera.execute(value["operation"], value["inputs"])
                self.respond(200, result)
            except Exception as exc:
                # No command output, filesystem paths or tokens in public errors.
                code = str(exc) if re.fullmatch(r"[a-z_]{1,80}", str(exc)) else "camera_operation_failed"
                self.respond(422, {"error": code})

        def respond(self, status, data):
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)
    def stop(_signal, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        camera.close()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    configuration = json.loads(Path(args.config).read_text())
    serve(configuration)
