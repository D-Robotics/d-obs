#!/usr/bin/env python3
"""Stateful SDK protocol fixtures. No X5 camera/hardware acceptance is claimed."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
MODULE = Path(__file__).with_name("vision-x5-camera.py")
spec = importlib.util.spec_from_file_location("vision_x5_camera", MODULE)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class StatefulSdkFixture:
    source = "sdk-protocol-fixture"

    def __init__(self):
        self.values = {"autoExposure": False, "exposureUs": 1000, "gain": 2,
                       "autoWhiteBalance": False, "redGain": 1.2, "blueGain": 1.4,
                       "brightness": 64, "contrast": 64, "saturation": 64, "hue": 0}
        self.initial = copy.deepcopy(self.values)
        self.events = []
        self.running = False
        self.frame_number = 0
        self.frame_calls = 0
        self.last_timestamp = 0
        self.stale = None
        self.ignore_writes = False
        self.fail_write_after_change = False
        self.fail_read_after_write = False
        self.fail_discard_after_write = False
        self.raw_alignment = 0
        self.raw_values = [0, 100, 500, 1023]
        self.mutate_on_frame = None

    def controls(self):
        self.events.append(("get",))
        if self.fail_read_after_write and any(event[0] == "set" for event in self.events):
            raise native.NativeError("fixture_read_failed", -5)
        output = {}
        for key, value in self.values.items():
            row = {"value": value, "writable": True, "active": True, "nativeName": key}
            if type(value) is not bool:
                low, high, step = (100, 20_000, 100) if key == "exposureUs" else (1, 8, .25) if key == "gain" else (.5, 4, .1) if key in ("redGain", "blueGain") else (-180, 180, 1) if key == "hue" else (0, 255, 1)
                row.update(min=low, max=high, step=step)
                if key in ("exposureUs", "gain"):
                    row["active"] = not self.values["autoExposure"]
                if key in ("redGain", "blueGain"):
                    row["active"] = not self.values["autoWhiteBalance"]
            output[key] = row
        return copy.deepcopy(output)

    def set_control(self, name, value):
        self.events.append(("set", name, value))
        if not self.ignore_writes:
            self.values[name] = value
        if self.fail_write_after_change:
            raise native.NativeError("fixture_write_failed", -5)

    def start(self):
        self.events.append(("start",))
        self.running = True

    def stop(self):
        self.events.append(("stop",))
        self.running = False

    def close(self):
        self.events.append(("close",))

    def frame(self, raw=False):
        self.events.append(("frame", raw))
        self.frame_calls += 1
        if self.fail_discard_after_write and any(event[0] == "set" for event in self.events):
            raise native.NativeError("fixture_frame_failed", -5)
        if self.mutate_on_frame == self.frame_calls:
            self.values["brightness"] += 1
        if self.stale != "frame_id":
            self.frame_number += 1
        if self.stale != "timestamp":
            self.last_timestamp += 1_000_000
        info = dict(width=2, height=2, frame_id=self.frame_number, timestamp_ns=self.last_timestamp,
                    stride_y=4, stride_uv=4, size_y=8, size_uv=4, bit_depth=8, bayer=0, packing=3, alignment=0)
        if raw:
            info.update(stride_y=6, stride_uv=0, size_y=12, size_uv=0, bit_depth=10, packing=0, alignment=self.raw_alignment)
            words = [value << 6 if self.raw_alignment else value for value in self.raw_values]
            data = struct.pack("<2H", *words[:2]) + b"xx" + struct.pack("<2H", *words[2:]) + b"zz"
        else:
            luminance = 16 + self.frame_number % 200
            data = bytes([luminance, luminance, 247, 249] * 2) + bytes([128, 128, 251, 253])
        return data, info


class CameraTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="x5-sdk-protocol-fixture-")
        self.root = Path(self.temporary.name)
        self.backend = StatefulSdkFixture()
        self.preflight_calls = []
        self.config = {"token": "sdk-protocol-fixture-private-token-0123456789", "board": "RDK X5", "sensorModel": "IMX415",
                       "sensorVendor": "Sony", "sdkVersion": "fixture-sdk-not-hardware", "cameraInterface": "MIPI CSI-2",
                       "cameraMode": "fixture-2x2-not-hardware", "nativeLibrary": str(self.root / "fixture-never-loaded.so"),
                       "sensorConfig": "imx415-30fps-2lane", "csiPort": 0, "port": 3217, "stateDir": str(self.root / "state"),
                       "colorMatrix": "bt601", "colorRange": "limited", "blackLevel": 0, "whiteLevel": 1023, "discardFrames": 1}
        self.camera = native.Camera(self.config, backend=self.backend, preflight=self.preflight)

    def tearDown(self):
        self.temporary.cleanup()

    def preflight(self):
        self.preflight_calls.append("fixture")
        return {"source": "sdk-protocol-fixture", "ready": False, "hardwareVerified": False}

    def tuning(self, **changes):
        values = copy.deepcopy(self.backend.values)
        values.update(changes)
        return {"kind": native.KIND, "controls": values}

    def apply(self, tuning, operation="apply_tuning"):
        return self.camera.execute(operation, {"tuning": tuning, "tuningHash": native.digest(tuning)})

    def journal(self):
        return json.loads(self.camera.journal_file.read_text())

    def test_missing_sdk_probe_and_pipeline_report_actual_not_ready(self):
        config = {**self.config, "stateDir": str(self.root / "missing-sdk-state")}
        with mock.patch.object(native, "NativeBackend", side_effect=native.NativeError("native_sdk_unavailable")) as load:
            camera = native.Camera(config, preflight=self.preflight)
        self.assertEqual(load.call_count, 1)
        result = camera.execute("probe", {})
        self.assertFalse(result["facts"]["nativeSdkAvailable"])
        self.assertFalse(result["facts"]["hardwareVerified"])
        self.assertEqual(result["facts"]["nativeSdkReason"], "native_sdk_unavailable")
        self.assertFalse(camera.execute("pipeline_validate", {})["passed"])
        self.assertEqual(camera.capabilities()["operations"], ["probe", "pipeline_validate"])
        with self.assertRaisesRegex(native.NativeError, "native_sdk_unavailable"):
            camera.execute("bringup", {})

    def test_fixture_capabilities_never_promote_protocol_success_to_hardware_verified(self):
        capabilities = self.camera.capabilities()
        self.assertFalse(capabilities["hardwareVerified"])
        self.assertFalse(capabilities["rawReplay"])
        self.assertNotIn("process_raw", capabilities["operations"])
        self.camera.execute("bringup", {})
        self.assertFalse(self.camera.execute("probe", {})["facts"]["hardwareVerified"])
        self.assertEqual(self.preflight_calls, ["fixture"])

    def test_bringup_observes_new_monotonic_frames_and_preserves_fixture_source(self):
        first = self.camera.execute("bringup", {})
        second = self.camera.execute("bringup", {})
        self.assertTrue(first["passed"])
        first_evidence = first["evidence"]["evidence"]
        second_evidence = second["evidence"]["evidence"]
        self.assertGreater(int(second_evidence["frameId"]), int(first_evidence["frameId"]))
        self.assertGreater(int(second_evidence["sdkTimestampNs"]), int(first_evidence["sdkTimestampNs"]))
        self.assertEqual(second_evidence["timestampSource"], "hbn_frame_info.tv_timeval")
        self.assertEqual(second_evidence["source"], "sdk-protocol-fixture")
        self.assertEqual(second_evidence["hardwareAcceptance"], "unverified")
        self.assertTrue(self.camera.execute("pipeline_validate", {})["passed"])

    def test_repeated_frame_id_or_sensor_timestamp_is_rejected(self):
        self.camera.execute("bringup", {})
        for stale in ("frame_id", "timestamp"):
            self.backend.stale = stale
            with self.assertRaisesRegex(native.NativeError, "camera_frame_stale"):
                self.camera.execute("capture_frame", {})
            self.backend.stale = None

    def test_nv12_capture_returns_real_png_hash_and_control_snapshot(self):
        result = self.camera.execute("capture_frame", {"scene": "fixture scene"})
        png = base64.b64decode(result["contentBase64"], validate=True)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", png[16:24]), (2, 2))
        self.assertEqual(hashlib.sha256(png).hexdigest(), result["sha256"])
        self.assertEqual(result["tuningHash"], native.digest(self.camera.configuration(self.backend.controls())))
        self.assertEqual(result["evidence"]["inputKind"], "x5-isp-nv12")
        self.assertEqual(result["evidence"]["source"], "sdk-protocol-fixture")

    def test_raw_capture_preserves_samples_hash_and_declared_layout(self):
        for alignment in (0, 1):
            self.backend.raw_alignment = alignment
            result = self.camera.execute("capture_raw", {"scene": "fixture raw"})
            data = base64.b64decode(result["contentBase64"], validate=True)
            self.assertEqual(data, struct.pack("<4H", *self.backend.raw_values))
            self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(result["metadata"]["packing"], "unpacked16le")
            self.assertEqual(result["metadata"]["stride"], 4)
            self.assertEqual(result["metadata"]["bitDepth"], 10)
            self.assertEqual(result["evidence"]["hardwareAcceptance"], "unverified")

    def test_control_set_uses_independent_get_after_real_state_change(self):
        result = self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.assertEqual(self.backend.values["brightness"], 80)
        self.assertEqual(result["controls"]["brightness"]["value"], 80)
        self.assertEqual([event[0] for event in self.backend.events], ["get", "set", "get"])
        self.assertEqual(self.journal()["outcome"], "confirmed")
        self.assertEqual(self.journal()["original"]["controls"], self.backend.initial)

    def test_ignored_write_cannot_claim_independent_readback_hash(self):
        self.backend.ignore_writes = True
        with self.assertRaisesRegex(native.NativeError, "isp_readback_mismatch"):
            self.apply(self.tuning(brightness=80))
        self.assertEqual(self.backend.values, self.backend.initial)
        self.assertTrue(self.camera.unconfirmed)
        self.assertEqual(self.journal()["outcome"], "unconfirmed")

    def test_partial_write_failure_stays_unconfirmed_and_cannot_replay(self):
        self.backend.fail_write_after_change = True
        with self.assertRaisesRegex(native.NativeError, "fixture_write_failed"):
            self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.assertEqual(self.backend.values["brightness"], 80)
        self.assertTrue(self.camera.unconfirmed)
        self.assertEqual(self.journal()["outcome"], "unconfirmed")
        calls = copy.deepcopy(self.backend.events)
        self.backend.fail_write_after_change = False
        with self.assertRaisesRegex(ValueError, "isp_write_unconfirmed_restore_required"):
            self.camera.execute("controls_set", {"values": {"brightness": 90}})
        self.assertEqual(self.backend.events, calls)
        facts = self.camera.execute("probe", {})["facts"]
        self.assertEqual(facts["writeOutcome"], "unconfirmed")
        self.assertEqual(facts["recoveryOriginalHash"], native.digest(self.camera.original))
        self.assertNotIn("original", facts)
        self.assertNotIn("stateDir", facts)

    def test_failed_independent_read_after_set_blocks_further_writes(self):
        self.backend.fail_read_after_write = True
        with self.assertRaisesRegex(native.NativeError, "fixture_read_failed"):
            self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.assertTrue(self.camera.unconfirmed)
        with self.assertRaisesRegex(ValueError, "isp_write_unconfirmed_restore_required"):
            self.camera.execute("controls_set", {"values": {"brightness": 90}})

    def test_failed_discard_after_write_keeps_memory_and_journal_unconfirmed(self):
        self.camera.execute("bringup", {})
        self.backend.fail_discard_after_write = True
        with self.assertRaisesRegex(native.NativeError, "fixture_frame_failed"):
            self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.assertEqual(self.journal()["outcome"], "unconfirmed")
        self.assertTrue(self.camera.unconfirmed)
        self.backend.fail_discard_after_write = False
        self.assertTrue(self.camera.cleanup_required)
        self.assertTrue(self.journal()["cleanupRequired"])
        with self.assertRaisesRegex(ValueError, "camera_stream_cleanup_required"):
            self.camera.execute("controls_set", {"values": {"brightness": 90}})

    def test_restore_from_stopped_stream_requires_a_fresh_valid_frame(self):
        original = self.tuning()
        self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.assertFalse(self.camera.running)
        before = self.backend.frame_calls
        self.apply(original, "restore_tuning")
        self.assertGreater(self.backend.frame_calls, before)
        self.assertEqual(self.journal()["outcome"], "restored")

    def test_failed_recovery_frame_keeps_write_and_cleanup_fence_across_restart(self):
        original = self.tuning()
        self.camera.execute("controls_set", {"values": {"brightness": 80}})
        frame = self.backend.frame
        self.backend.frame = mock.Mock(side_effect=native.NativeError("fixture_frame_failed", -36))
        with self.assertRaisesRegex(native.NativeError, "fixture_frame_failed"):
            self.apply(original, "restore_tuning")
        self.assertEqual(self.backend.values, self.backend.initial)
        self.assertEqual(self.journal()["outcome"], "unconfirmed")
        restarted = native.Camera(self.config, backend=self.backend, preflight=self.preflight)
        self.assertTrue(restarted.cleanup_required)
        writes = sum(event[0] == "set" for event in self.backend.events)
        with self.assertRaisesRegex(native.NativeError, "camera_stream_cleanup_required"):
            restarted.execute("restore_tuning", {"tuning": original, "tuningHash": native.digest(original)})
        self.assertEqual(sum(event[0] == "set" for event in self.backend.events), writes)
        self.backend.frame = frame
        restarted.execute("preview_stop", {})
        self.assertFalse(self.journal()["cleanupRequired"])
        restarted.execute("restore_tuning", {"tuning": original, "tuningHash": native.digest(original)})
        self.assertEqual(self.journal()["outcome"], "restored")

    def test_restore_requires_complete_snapshot_and_hashes_actual_readback(self):
        original = self.tuning()
        self.apply(self.tuning(brightness=80, contrast=90))
        incomplete = {"kind": native.KIND, "controls": {"brightness": 64}}
        calls = len(self.backend.events)
        with self.assertRaisesRegex(ValueError, "complete_isp_snapshot_required"):
            self.apply(incomplete, "restore_tuning")
        self.assertEqual(len([event for event in self.backend.events[calls:] if event[0] == "set"]), 0)
        result = self.apply(original, "restore_tuning")
        self.assertEqual(self.backend.values, self.backend.initial)
        self.assertEqual(result["appliedHash"], native.digest(original))
        self.assertEqual(result["readbackHash"], native.digest(original))
        self.assertEqual(result["evidence"]["config"], original)
        self.assertFalse(result["evidence"]["fullEffectLibrary"])
        self.assertEqual(self.journal()["outcome"], "restored")

    def test_close_restores_actual_original_then_stops_and_fences_new_requests(self):
        self.camera.execute("bringup", {})
        self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.camera.close()
        self.assertEqual(self.backend.values, self.backend.initial)
        self.assertEqual(self.backend.events[-2:], [("stop",), ("close",)])
        self.assertFalse(self.camera.running)
        self.assertEqual(self.journal()["outcome"], "restored")
        calls = len(self.backend.events)
        with self.assertRaisesRegex(ValueError, "camera_adapter_closing"):
            self.camera.execute("preview_start", {})
        self.assertEqual(len(self.backend.events), calls)

    def test_close_failed_restore_still_stops_and_does_not_claim_recovery(self):
        self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.backend.ignore_writes = True
        with self.assertRaisesRegex(native.NativeError, "isp_readback_mismatch"):
            self.camera.close()
        self.assertEqual(self.backend.values["brightness"], 80)
        self.assertEqual(self.backend.events[-2:], [("stop",), ("close",)])
        self.assertTrue(self.camera.unconfirmed)
        self.assertEqual(self.journal()["outcome"], "unconfirmed")

    def test_restart_pending_journal_blocks_writes_until_complete_recovery(self):
        original = self.tuning()
        self.camera.original = original
        self.camera.retain_recovery_scope("modules")
        self.camera.journal("pending", self.tuning(brightness=80))
        self.backend.values["brightness"] = 80
        restarted = native.Camera(self.config, backend=self.backend, preflight=self.preflight)
        self.assertTrue(restarted.unconfirmed)
        self.assertEqual(restarted.original, original)
        calls = len(self.backend.events)
        with self.assertRaisesRegex(ValueError, "isp_write_unconfirmed_restore_required"):
            restarted.execute("controls_set", {"values": {"brightness": 90}})
        self.assertEqual(len(self.backend.events), calls)
        result = restarted.execute("restore_tuning", {"tuning": original, "tuningHash": native.digest(original)})
        self.assertEqual(result["readbackHash"], native.digest(original))
        self.assertFalse(restarted.unconfirmed)
        self.assertEqual(self.backend.values, self.backend.initial)

    def test_legacy_journal_without_intent_cannot_be_cleared_by_controls_only(self):
        self.apply(self.tuning(brightness=80))
        row=self.journal();row.pop("recoveryScope")
        self.camera.journal_file.write_text(json.dumps(row))
        restarted=native.Camera(self.config,backend=self.backend,preflight=self.preflight)
        self.assertEqual(restarted.recovery_scope,"library")
        calls=len(self.backend.events)
        with self.assertRaisesRegex(native.NativeError,"isp_full_library_restore_required"):
            restarted.execute("restore_tuning",{"tuning":self.tuning(),"tuningHash":native.digest(self.tuning())})
        self.assertEqual(len(self.backend.events),calls)
        self.assertTrue(restarted.unconfirmed)

    def test_invalid_identity_paths_and_request_keys_do_not_execute_sdk(self):
        for changes in ({"board": "RDK S100"}, {"sensorModel": "IMX999"}, {"cameraInterface": "USB UVC"},
                        {"sdkVersion": ""}, {"cameraMode": ""}, {"nativeLibrary": "relative.so"},
                        {"stateDir": "relative-state"}, {"sensorConfig": "imx415_mode;unsafe"}, {"csiPort": True}):
            with self.assertRaises(ValueError):
                native.Camera({**self.config, **changes}, backend=self.backend, preflight=self.preflight)
        for operation, inputs in (("probe", {"command": "unsafe"}), ("bringup", {"path": "/private/anywhere"}),
                                  ("controls_set", {"values": {"brightness": 80}, "url": "https://external.invalid"}),
                                  ("process_raw", {}), ("capture_raw", {"scene": ""})):
            with self.assertRaises(ValueError):
                self.camera.execute(operation, inputs)
        self.assertEqual(self.backend.events, [])

    def test_invalid_tuning_hash_out_of_range_and_inactive_control_never_write(self):
        with self.assertRaisesRegex(ValueError, "tuning_hash_mismatch"):
            self.camera.execute("apply_tuning", {"tuning": self.tuning(brightness=80), "tuningHash": "0" * 64})
        for values in ({"brightness": 256}, {"brightness": float("nan")}, {"invented": 1}, {"brightness": "80"}):
            with self.assertRaises(ValueError):
                self.camera.execute("controls_set", {"values": values})
        self.backend.values["autoExposure"] = True
        with self.assertRaisesRegex(ValueError, "manual_isp_control_inactive"):
            self.camera.execute("controls_set", {"values": {"exposureUs": 1200}})
        self.assertFalse(any(event[0] == "set" for event in self.backend.events))
        result = self.camera.execute("controls_set", {"values": {"autoExposure": False, "exposureUs": 1200}})
        self.assertFalse(result["controls"]["autoExposure"]["value"])
        self.assertEqual(result["controls"]["exposureUs"]["value"], 1200)

    def test_controls_change_during_frame_capture_rejects_configuration_label(self):
        self.camera.execute("bringup", {})
        self.backend.mutate_on_frame = self.backend.frame_calls + 2
        with self.assertRaisesRegex(native.NativeError, "isp_controls_changed_during_capture"):
            self.camera.execute("capture_frame", {})

    def test_pipeline_validation_requires_another_fresh_sdk_frame(self):
        self.camera.execute("bringup", {})
        calls = self.backend.frame_calls
        self.assertTrue(self.camera.execute("pipeline_validate", {})["passed"])
        self.assertGreater(self.backend.frame_calls, calls)
        self.backend.stale = "frame_id"
        result = self.camera.execute("pipeline_validate", {})
        self.assertFalse(result["passed"])
        self.assertEqual(result["evidence"]["failureCode"], "camera_frame_stale")

    def test_successful_failed_start_cleanup_allows_a_new_frame_epoch(self):
        self.camera.execute("bringup", {})
        self.camera.execute("preview_stop", {})
        self.backend.stale = "frame_id"
        with self.assertRaisesRegex(native.NativeError, "camera_frame_stale"):
            self.camera.execute("preview_start", {})
        self.assertFalse(self.camera.running)
        self.assertFalse(self.camera.cleanup_required)
        self.assertEqual(self.camera.last_frame, {})
        self.backend.stale = None
        self.backend.frame_number = 0
        self.backend.last_timestamp = 0
        self.assertTrue(self.camera.execute("preview_start", {})["running"])

    def test_cproc_non_float32_tuning_rejects_before_sdk_write(self):
        original = self.backend.controls
        def controls():
            result = original()
            result["contrast"].update(value=1.0, min=0, max=1.9991, nativeName="hbn_isp_cproc_attr_t.manual_attr.contrast")
            result["contrast"].pop("step")
            return result
        self.backend.controls = controls
        with self.assertRaisesRegex(ValueError, "isp_control_float32_required"):
            self.camera.execute("controls_set", {"values": {"contrast": 1.1}})
        self.assertFalse(any(event[0] == "set" for event in self.backend.events))
        self.assertFalse(self.camera.journal_file.exists())

    def test_crash_after_confirmed_write_preserves_original_for_recovery(self):
        self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.assertEqual(self.journal()["outcome"], "confirmed")
        restarted = native.Camera(self.config, backend=self.backend, preflight=self.preflight)
        self.assertTrue(restarted.unconfirmed)
        self.assertEqual(restarted.original["controls"]["brightness"], 64)
        with self.assertRaisesRegex(ValueError, "isp_write_unconfirmed_restore_required"):
            restarted.execute("controls_set", {"values": {"brightness": 82}})
        restarted.close()
        self.assertEqual(self.backend.values["brightness"], 64)

    def test_restore_to_another_saved_version_keeps_original_outstanding_after_restart(self):
        self.camera.execute("controls_set", {"values": {"brightness": 80}})
        self.apply(self.tuning(brightness=76), "restore_tuning")
        self.assertEqual(self.journal()["outcome"], "confirmed")
        restarted = native.Camera(self.config, backend=self.backend, preflight=self.preflight)
        self.assertEqual(restarted.original["controls"]["brightness"], 64)
        restarted.close()
        self.assertEqual(self.backend.values["brightness"], 64)
        self.assertEqual(self.journal()["outcome"], "restored")

    def test_failed_stop_after_stream_fault_requires_cleanup_before_new_start_or_write(self):
        stop = self.backend.stop
        self.backend.frame = mock.Mock(side_effect=native.NativeError("fixture_frame_failed", -5))
        self.backend.stop = mock.Mock(side_effect=native.NativeError("fixture_stop_failed", -5))
        with self.assertRaisesRegex(native.NativeError, "fixture_stop_failed"):
            self.camera.execute("bringup", {})
        self.assertTrue(self.camera.cleanup_required)
        self.assertIsNone(self.camera.execute("probe", {})["facts"]["streaming"])
        self.assertFalse(self.camera.execute("pipeline_validate", {})["passed"])
        for operation, inputs in (("preview_start", {}), ("controls_set", {"values": {"brightness": 80}})):
            with self.assertRaisesRegex(native.NativeError, "camera_stream_cleanup_required"):
                self.camera.execute(operation, inputs)
        self.assertFalse(any(event[0] == "set" for event in self.backend.events))
        self.backend.stop = stop
        self.assertFalse(self.camera.execute("preview_stop", {})["running"])
        self.assertFalse(self.camera.cleanup_required)


if __name__ == "__main__":
    unittest.main(verbosity=2)
