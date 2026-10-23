"""End-to-end orchestration test for the classroom WB drill against a fixture board daemon.

Runs both phases (A: qualify+bringup+baseline, B: adjust+restore+summary) of vision-x5-wb-drill.py
against a stub daemon that implements the camera contract with gain-dependent frames, then asserts
the ratio table, drift direction and restore confirmation. No hardware involved.
Run: python3 vision-x5-wb-drill.e2e.test.py
"""
import base64
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

REPO = Path(__file__).parent
DRILL = REPO / "vision-x5-wb-drill.py"
BOOT_ID = "fixture-boot-id"

STUB_DAEMON = '''
import base64, hashlib, io, json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
from PIL import Image
cfg = json.load(open(sys.argv[sys.argv.index("--config") + 1]))
CONTRACT = "fixture-camera-contract-v1"
IDENTITY = ("board", "sensorModel", "sdkVersion", "sensorVendor", "cameraInterface", "cameraMode")
def validate_config(config):
    return config
state = {"gain": 2.6}
def frame_png():
    blue = int(min(255, max(0, 200 + (state["gain"] - 2.6) * 50)))
    array = np.zeros((240, 320, 3), dtype="uint8")
    array[:] = (200, 200, blue)
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="PNG")
    return buffer.getvalue()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        task = json.loads(self.rfile.read(length))
        operation = task["operation"]
        inputs = task.get("inputs") or {}
        if operation == "probe":
            body = {"ok": True, "result": {"status": "ok"}}
        elif operation == "preview_start":
            body = {"ok": True, "result": {}}
        elif operation == "preview_frame":
            data = frame_png()
            body = {"ok": True, "result": {"contentBase64": base64.b64encode(data).decode(),
                                           "sha256": hashlib.sha256(data).hexdigest()}}
        elif operation == "controls_get":
            body = {"ok": True, "result": {"values": {"wb_bgain": {"value": state["gain"], "range": {"min": 1.0, "max": 4.0}}}}}
        elif operation == "controls_set":
            value = inputs["values"]["wb_bgain"]
            if not 1.0 <= value <= 4.0:
                body = {"ok": False, "error": "out_of_range"}
            else:
                state["gain"] = value
                body = {"ok": True, "result": {}}
        elif operation == "preview_stop":
            body = {"ok": True, "result": {}}
        else:
            body = {"ok": False, "error": "unknown_operation"}
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(cfg["port"])), Handler).serve_forever()
'''


def free_port():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()
    return port


class DrillEndToEndTests(unittest.TestCase):
    def test_both_phases_produce_ratio_table_with_restore_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "vision-x5-camera.py").write_text(STUB_DAEMON)
            library = root / "native.so"
            library.write_bytes(b"fixture-native-library-bytes")
            binding = {
                "bootId": BOOT_ID,
                "nativeLibrarySha256": hashlib.sha256(library.read_bytes()).hexdigest(),
                "sdkVersion": "fixture-sdk", "cameraMode": "fixture-mode",
                "sensorConfig": "fixture-sensor", "csiPort": 2,
            }
            (root / "formal-qualified-config-patch-binding.json").write_text(json.dumps(binding))
            (root / "formal-qualified-config-patch.json").write_text("{}")
            config = {
                "port": free_port(), "token": "fixture-token", "nativeLibrary": str(library),
                "board": "RDK X5", "sensorModel": "IMX415", "sdkVersion": "fixture-sdk",
                "sensorVendor": "Sony", "cameraInterface": "MIPI CSI-2", "cameraMode": "fixture-mode",
                "sensorConfig": "fixture-sensor", "csiPort": 2,
            }
            config_path = root / "camera.json"
            config_path.write_text(json.dumps(config))
            config_path.chmod(0o600)
            environment = {**os.environ, "WB_DRILL_TEST_BOOT_ID": BOOT_ID}

            phase_a = subprocess.run([sys.executable, str(DRILL), "--config", str(config_path), "--phase", "A"],
                                     capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(phase_a.returncode, 0, phase_a.stderr)
            output_a = json.loads(phase_a.stdout)
            self.assertTrue(output_a["A1"]["usable"])
            self.assertEqual(output_a["A1"]["BoverGMedian"], 1.0)

            phase_b = subprocess.run([sys.executable, str(DRILL), "--config", str(config_path), "--phase", "B",
                                      "--step", "-0.25"],
                                     capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(phase_b.returncode, 0, phase_b.stderr)
            output_b = json.loads(phase_b.stdout)
            summary = output_b["summary"]
            table = summary["table"]
            self.assertLess(table["B"]["driftFromA1"]["BoverG"], 0, "candidate must read bluer than baseline")
            self.assertAlmostEqual(table["A2"]["driftFromA1"]["BoverG"], 0.0, places=2)
            self.assertTrue(summary["restoredWithinDrift"])

            receipt_b = json.loads((Path(output_b["out"]) / "receipt.json").read_text())
            self.assertTrue(receipt_b["restoredConfirmed"])
            self.assertTrue(receipt_b["calls"][-1]["operation"] != "preview_stop" or receipt_b["calls"][-1]["ok"])
            hashes = {frame["sha256"] for frame in receipt_b["frames"].values()}
            self.assertEqual(len(hashes), 2, "B and A2 frames must be distinct captures")


if __name__ == "__main__":
    unittest.main()
