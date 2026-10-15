#!/usr/bin/env python3
"""Explicit local protocol fixtures only; no camera, V4L2 or ISP hardware claims."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("vision_uvc_camera", Path(__file__).with_name("vision-uvc-camera.py"))
camera_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera_module)

CONTROL_TEXT = """
                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0
                          gamma 0x00980910 (int)    : min=72 max=500 step=1 default=100 value=100
                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value={mode}
                                1: Manual Mode
                                3: Aperture Priority Mode
         exposure_time_absolute 0x009a0902 (int)    : min=1 max=5000 step=1 default=156 value=156 flags=inactive
"""


class FakeThread:
    def is_alive(self):
        return True


class FixtureCamera(camera_module.Camera):
    def __init__(self):
        super().__init__({"device": "/dev/video1", "width": 640, "height": 480, "fps": 30})
        self.state = {
            "exposureUs": {"value": 1000, "min": 100, "max": 5000, "step": 100, "writable": True, "active": True, "unit": "µs"},
            "brightness": {"value": 20, "min": -64, "max": 64, "step": 1, "writable": True, "active": True, "unit": "device units"},
            "gamma": {"value": 100, "min": 72, "max": 500, "step": 1, "writable": True, "active": True, "unit": "device units"},
            "autoExposure": {"value": False, "writable": True, "unit": "boolean"},
        }
        self.events = []
        self.fail_once = None
        self.ignore_restore = False

    def controls(self):
        return copy.deepcopy(self.state)

    def _write(self, key, value):
        self.events.append(("write", key, value))
        if self.fail_once == key:
            self.fail_once = None
            raise ValueError("fixture_write_failed")
        if self.ignore_restore and key == "brightness" and value == 20:
            return
        self.state[key]["value"] = value
        if key == "autoExposure":
            self.state["exposureUs"]["active"] = not value

    def start(self):
        self.events.append(("start",))
        if self.original is None:
            self.original = {key: row["value"] for key, row in self.state.items() if row["writable"]}
        self.thread = FakeThread()
        return {"running": True, "width": 640, "height": 480, "fps": 30}

    def stop_preview(self):
        self.events.append(("stop",))
        self.thread = None
        return {"running": False}

    def image(self, png=False):
        self.events.append(("frame",))
        return {"filename": "explicit-fixture.png", "mimeType": "image/png"}


class CameraContractTests(unittest.TestCase):
    def test_parser_native_exposure_units_and_inactive_flag(self):
        controls = camera_module.parse_controls(CONTROL_TEXT.format(mode=3))
        self.assertEqual(controls["exposureUs"]["value"], 15600)
        self.assertEqual(controls["exposureUs"]["step"], 100)
        self.assertFalse(controls["exposureUs"]["active"])
        self.assertTrue(controls["autoExposure"]["value"])
        self.assertTrue(controls["exposureUs"]["writable"])

    def test_parser_does_not_collapse_unknown_automatic_modes(self):
        for mode in [0, 2]:
            with self.subTest(mode=mode):
                self.assertNotIn("autoExposure", camera_module.parse_controls(CONTROL_TEXT.format(mode=mode)))
        self.assertFalse(camera_module.parse_controls(CONTROL_TEXT.format(mode=1))["autoExposure"]["value"])

    def test_inactive_manual_edit_requires_explicit_auto_disable(self):
        camera = FixtureCamera()
        camera.state["autoExposure"]["value"] = True
        camera.state["exposureUs"]["active"] = False
        with self.assertRaisesRegex(ValueError, "inactive"):
            camera.execute("controls_set", {"values": {"exposureUs": 1200}})
        self.assertEqual(camera.events, [])
        actual = camera.execute("controls_set", {"values": {"exposureUs": 1200, "autoExposure": False}})
        self.assertEqual(actual["controls"]["exposureUs"]["value"], 1200)
        self.assertTrue(actual["controls"]["exposureUs"]["active"])

    def test_partial_write_restores_previous_values_before_restarting_stream(self):
        camera = FixtureCamera()
        before = camera.controls()
        camera.thread = FakeThread()
        camera.fail_once = "gamma"
        with self.assertRaisesRegex(ValueError, "fixture_write_failed"):
            camera.set_values({"brightness": 30, "gamma": 84})
        self.assertEqual(camera.controls(), before)
        self.assertEqual(camera.events[0], ("stop",))
        self.assertEqual(camera.events[-1], ("start",))
        self.assertIn(("write", "brightness", 20), camera.events)

    def test_partial_write_cannot_report_rollback_when_readback_disagrees(self):
        camera = FixtureCamera()
        camera.fail_once = "gamma"
        camera.ignore_restore = True
        with self.assertRaisesRegex(ValueError, "rollback"):
            camera.set_values({"brightness": 30, "gamma": 84})
        self.assertEqual(camera.controls()["brightness"]["value"], 30)

    def test_full_imported_key_order_survives_apply_and_frame_hash(self):
        camera = FixtureCamera()
        tuning = camera.baseline()["config"]
        tuning["controls"] = {key: tuning["controls"][key] for key in reversed(tuning["controls"])}
        tuning["controls"]["gamma"] = 84
        expected_hash = camera_module.digest(tuning)
        applied = camera.execute("apply_tuning", {"tuning": tuning, "tuningHash": expected_hash})
        self.assertEqual(applied["readbackHash"], expected_hash)
        self.assertEqual(camera.execute("capture_frame", {})["tuningHash"], expected_hash)
        subset = {"kind": "uvc-controls-v1", "controls": {"gamma": 85}}
        with self.assertRaisesRegex(ValueError, "complete_control_snapshot"):
            camera.execute("apply_tuning", {"tuning": subset, "tuningHash": camera_module.digest(subset)})
        self.assertEqual(camera.state["gamma"]["value"], 84)

    def test_shutdown_restores_original_state_and_rejects_queued_actions(self):
        camera = FixtureCamera()
        original = camera.controls()
        camera.set_values({"gamma": 84})
        camera.start()
        camera.close()
        self.assertEqual(camera.controls(), original)
        self.assertIsNone(camera.thread)
        with self.assertRaisesRegex(ValueError, "clos|shut"):
            camera.execute("controls_set", {"values": {"gamma": 85}})
        with self.assertRaisesRegex(ValueError, "clos|shut"):
            camera.execute("preview_start", {})
        self.assertEqual(camera.controls(), original)

    def test_inactive_controls_are_not_numeric_ai_rules(self):
        camera = FixtureCamera()
        camera.state["autoExposure"]["value"] = True
        camera.state["exposureUs"]["active"] = False
        paths = {rule["path"] for rule in camera.baseline()["rules"]}
        self.assertNotIn("/controls/exposureUs", paths)
        self.assertIn("/controls/gamma", paths)


if __name__ == "__main__":
    unittest.main()
