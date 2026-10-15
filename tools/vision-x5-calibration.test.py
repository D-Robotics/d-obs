#!/usr/bin/env python3
"""Synthetic known-solution math fixtures; never real sensor calibration proof."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
MODULE = Path(__file__).with_name("vision-x5-calibration.py")
spec = importlib.util.spec_from_file_location("vision_x5_calibration", MODULE)
cal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cal)
np = cal.np
BLACK = {"R": 64, "Gr": 66, "Gb": 68, "B": 70}


def metadata(width=32, height=32, **changes):
    value = {"width": width, "height": height, "bitDepth": 12, "bayer": "RGGB", "packing": "unpacked16le",
             "stride": width * 2, "blackLevel": 0, "whiteLevel": 4095}
    value.update(changes)
    return value


def mosaic(channels, width=32, height=32):
    image = np.zeros((height, width), dtype=np.uint16)
    for name, (row, column) in zip(cal.CHANNELS, cal.LAYOUTS["RGGB"]):
        image[row::2, column::2] = channels[name]
    return image


def conditions(target, **changes):
    value = {"target": target, "source": "synthetic-fixture", "preprocessing": "sensor_raw_unprocessed",
             "sensorMode": "fixture-raw12", "exposureUs": 1000, "analogGain": 1}
    value.update(changes)
    return value


def task(operation, images, captures, options=None):
    artifacts = {}
    inputs = []
    for index, (image, capture) in enumerate(zip(images, captures)):
        artifact_id = "frame-" + str(index)
        data = image.astype("<u2").tobytes()
        artifacts[artifact_id] = data
        inputs.append({"artifactId": artifact_id, "sha256": cal.sha(data), "metadata": metadata(image.shape[1], image.shape[0]), "capture": capture})
    manifest = {"schema": cal.SCHEMA, "datasetId": "known-math-fixture", "operation": operation, "inputs": inputs, "options": options or {}}
    return manifest, artifacts


def measurement_task(dataset, options=None):
    data = cal.canonical(dataset)
    return {"schema": cal.SCHEMA, "datasetId": "known-ccm-fixture", "operation": "ccm",
            "inputs": [{"artifactId": "chart-measurements", "sha256": cal.sha(data)}], "options": options or {}}, {"chart-measurements": data}


@unittest.skipIf(np is None, "NumPy is required for numerical fixtures; dependency errors are tested separately")
class NumericalTests(unittest.TestCase):
    def evaluate(self, manifest, artifacts):
        result = cal.run_calibration(manifest, artifacts.__getitem__)
        self.assertEqual(result["hardwareVerification"], "unverified")
        self.assertEqual(result["qualityVerification"], "unverified")
        self.assertEqual(result["executor"], "cpu-offline-numpy")
        self.assertEqual(result["format"], "sdk-neutral-calibration-values-v1")
        digest = result.pop("outputSha256")
        self.assertEqual(digest, cal.sha(cal.canonical(result)))
        result["outputSha256"] = digest
        return result

    def dark_task(self):
        images = [mosaic({channel: value + jitter for channel, value in BLACK.items()}) for jitter in (-1, 0, 1)]
        images[1][0, 0] = 900  # Known hot-pixel outlier, not a change in true offset.
        return task("blc", images, [conditions("lens_covered_dark", lightBlocked=True) for _ in images])

    def flat_task(self):
        base = np.array([[300, 400], [400, 600]])
        signals = np.repeat(np.repeat(base, 8, axis=0), 8, axis=1)
        image = mosaic({channel: signals * factor + BLACK[channel] for channel, factor in zip(cal.CHANNELS, (1, 1.1, .9, 1.2))})
        cap = conditions("neutral_uniform_flat_field", illuminantId="fixture-flat-light",
                         illuminationUniformity={"method": "independent_meter_grid", "luxSamples": [100, 100.2, 99.8, 100.1, 99.9]})
        return task("lsc", [image.copy() for _ in range(3)], [copy.deepcopy(cap) for _ in range(3)], {"blackLevels": BLACK, "grid": {"rows": 2, "cols": 2}})

    def ccm_dataset(self, encoding="linear-srgb"):
        matrix = np.array([[1.05, -.03, .02], [.01, .97, .03], [-.02, .04, 1.01]])
        camera = np.random.default_rng(20261014).uniform(.1, .7, (12, 3))
        linear_reference = camera @ matrix.T
        reference = np.where(linear_reference <= .0031308, linear_reference * 12.92,
                             1.055 * linear_reference ** (1 / 2.4) - .055) if encoding == "srgb" else linear_reference
        patches = [{"patchId": "patch-" + str(index), "sourceArtifactId": "color-card-image",
                    "roi": {"x": index * 8, "y": 4, "width": 4, "height": 4}, "measuredLinearRgb": measured.tolist(),
                    "referenceRgb": target.tolist(), "split": "train" if index < 9 else "heldout"}
                   for index, (measured, target) in enumerate(zip(camera, reference))]
        return {"target": "recorded_color_chart", "measurementSpace": "camera-linear-rgb", "preprocessing": "fixture-known-linear-blc-lsc-fixed-wb",
                "referenceEncoding": encoding, "referenceWhitePoint": "D65", "referenceIlluminantId": "fixture-D65",
                "imageWidth": 128, "imageHeight": 32, "illuminant": {"id": "fixture-D65", "colorTemperatureK": 6500, "source": "synthetic-fixture"}, "patches": patches}, matrix

    def awb_task(self):
        images, captures = [], []
        for name, temperature, signal in (("warm-fixture", 2850, {"R": 500, "Gr": 400, "Gb": 400, "B": 200}),
                                          ("daylight-fixture", 6500, {"R": 200, "Gr": 400, "Gb": 400, "B": 500})):
            for _ in range(3):
                images.append(mosaic({channel: BLACK[channel] + value for channel, value in signal.items()}))
                captures.append(conditions("neutral_gray_card", illuminantId=name, colorTemperatureK=temperature,
                                           roi={"x": 4, "y": 4, "width": 16, "height": 16}))
        return task("awb", images, captures, {"blackLevels": BLACK})

    def test_raw10_raw12_and_padding_match_existing_platform_layout(self):
        raw10 = bytes([0, 0, 255, 128, 0x34, 0xaa, 0xaa, 64, 0, 0, 63, 0xf0, 0xaa, 0xaa])
        decoded = cal.decode_raw(raw10, metadata(4, 2, bitDepth=10, whiteLevel=1023, stride=7, packing="mipi-raw10"))
        np.testing.assert_array_equal(decoded, [[0, 1, 1023, 512], [256, 0, 3, 255]])
        raw12 = bytes([255, 1, 0x0f, 0xee, 128, 0, 0xf0, 0xee])
        np.testing.assert_array_equal(cal.decode_raw(raw12, metadata(2, 2, stride=4, packing="mipi-raw12")), [[4095, 16], [2048, 15]])
        with self.assertRaisesRegex(cal.CalibrationError, "pixel_exceeds"):
            cal.decode_raw(np.array([0, 1024, 0, 0], dtype="<u2").tobytes(), metadata(2, 2, bitDepth=10, whiteLevel=1023))
        with self.assertRaisesRegex(cal.CalibrationError, "exact_byte_count"):
            cal.decode_raw(b"\0" * 9, metadata(2, 2))

    def test_bayer_gr_and_gb_identity_is_not_merged(self):
        pixels = np.array([[1, 2], [3, 4]], dtype=np.uint16)
        for layout, expected in (("RGGB", [1, 2, 3, 4]), ("BGGR", [4, 3, 2, 1]), ("GRBG", [2, 1, 4, 3]), ("GBRG", [3, 4, 1, 2])):
            channels = cal.planes({"pixels": pixels, "metadata": {"bayer": layout}})
            self.assertEqual([int(channels[channel][0, 0]) for channel in cal.CHANNELS], expected)

    def test_blc_recovers_known_four_offsets_despite_hot_pixel_and_frame_noise(self):
        manifest, artifacts = self.dark_task()
        result = self.evaluate(manifest, artifacts)["parameters"]
        self.assertEqual(result["values"], BLACK)
        self.assertGreater(result["statistics"]["R"]["outlierRatio"], 0)
        self.assertEqual(result["statistics"]["Gr"]["frameMedianSpreadCodes"], 2)
        self.assertGreater(result["statistics"]["Gb"]["robustSigmaCodes"], 0)

    def test_blc_rejects_missing_cover_light_leak_and_mixed_exposure(self):
        for fault in ("cover", "leak", "exposure"):
            manifest, artifacts = self.dark_task()
            if fault == "cover":
                manifest["inputs"][0]["capture"]["lightBlocked"] = False
            elif fault == "exposure":
                manifest["inputs"][0]["capture"]["exposureUs"] = 2000
            else:
                for item in manifest["inputs"]:
                    data = np.full((32, 32), 900, dtype="<u2").tobytes()
                    artifacts[item["artifactId"]] = data; item["sha256"] = cal.sha(data)
            with self.assertRaises(cal.CalibrationError):
                cal.run_calibration(manifest, artifacts.__getitem__)

    def test_lsc_recovers_known_gain_mesh_and_all_four_channels(self):
        manifest, artifacts = self.flat_task()
        result = self.evaluate(manifest, artifacts)["parameters"]
        for channel in cal.CHANNELS:
            np.testing.assert_allclose(result["values"][channel], [[2, 1.5], [1.5, 1]], atol=.005)
        self.assertEqual(result["grid"]["xCentersNormalized"], [.25, .75])
        self.assertTrue(any("cannot distinguish" in value for value in result["constraints"]))

    def test_lsc_rejects_nonuniform_lighting_missing_black_and_saturated_samples(self):
        for fault in ("illumination", "black", "saturation", "scene"):
            manifest, artifacts = self.flat_task()
            if fault == "illumination":
                manifest["inputs"][0]["capture"]["illuminationUniformity"]["luxSamples"] = [50, 80, 100, 150, 200]
            elif fault == "black":
                manifest["options"].pop("blackLevels")
            elif fault == "scene":
                manifest["inputs"][0]["capture"]["target"] = "natural_scene"
            else:
                item = manifest["inputs"][0]; data = np.full((32, 32), 4095, dtype="<u2").tobytes()
                artifacts[item["artifactId"]] = data; item["sha256"] = cal.sha(data)
            with self.assertRaises(cal.CalibrationError):
                cal.run_calibration(manifest, artifacts.__getitem__)

    def test_lsc_rejects_texture_and_temporal_instability(self):
        for fault in ("texture", "unstable"):
            manifest, artifacts = self.flat_task()
            item = manifest["inputs"][0]
            image = cal.decode_raw(artifacts[item["artifactId"]], item["metadata"]).copy()
            if fault == "texture":
                image[0::4, :] += 200
            else:
                image += 100
            data = image.astype("<u2").tobytes(); artifacts[item["artifactId"]] = data; item["sha256"] = cal.sha(data)
            with self.assertRaises(cal.CalibrationError):
                cal.run_calibration(manifest, artifacts.__getitem__)

    def test_ccm_recovers_known_matrix_from_linear_and_explicit_srgb_references(self):
        for encoding in ("linear-srgb", "srgb"):
            dataset, expected = self.ccm_dataset(encoding)
            manifest, artifacts = measurement_task(dataset)
            result = self.evaluate(manifest, artifacts)["parameters"]
            np.testing.assert_allclose(result["values"], expected, atol=1e-12)
            self.assertEqual(result["statistics"]["rank"], 3)
            self.assertLess(result["statistics"]["heldoutRmseLinear"], 1e-12)
            self.assertEqual(result["statistics"]["heldoutCount"], 3)
        np.testing.assert_allclose(cal.srgb_to_linear([0, .04045, 1]), [0, .04045 / 12.92, 1])

    def test_ccm_rejects_rank_deficiency_heldout_error_and_reused_roi(self):
        for fault in ("rank", "heldout", "roi", "illumination", "split"):
            dataset, _expected = self.ccm_dataset()
            if fault == "rank":
                for patch in dataset["patches"]:
                    patch["measuredLinearRgb"] = [.2, .2, .2]
            elif fault == "heldout":
                dataset["patches"][-1]["referenceRgb"][0] += .3
            elif fault == "roi":
                dataset["patches"][-1]["roi"] = copy.deepcopy(dataset["patches"][0]["roi"])
            elif fault == "split":
                dataset["patches"][-1]["split"] = "train"
            else:
                dataset["referenceIlluminantId"] = "unknown"
            manifest, artifacts = measurement_task(dataset)
            with self.assertRaises(cal.CalibrationError):
                cal.run_calibration(manifest, artifacts.__getitem__)

    def test_awb_recovers_recorded_gray_card_gains_without_guessing_light(self):
        manifest, artifacts = self.awb_task()
        rows = self.evaluate(manifest, artifacts)["parameters"]["values"]
        self.assertEqual([row["colorTemperatureK"] for row in rows], [2850, 6500])
        np.testing.assert_allclose([[row["redGain"], row["greenGain"], row["blueGain"]] for row in rows], [[.8, 1, 2], [2, 1, .8]])
        self.assertEqual([row["frameCount"] for row in rows], [3, 3])

    def test_awb_rejects_gray_world_missing_roi_light_or_temperature_and_saturation(self):
        for fault in ("gray-world", "roi", "temperature", "one-light", "saturation"):
            manifest, artifacts = self.awb_task()
            capture = manifest["inputs"][0]["capture"]
            if fault == "gray-world":
                capture["target"] = "natural_scene_gray_world"
            elif fault == "roi":
                capture.pop("roi")
            elif fault == "temperature":
                capture.pop("colorTemperatureK")
            elif fault == "one-light":
                manifest["inputs"] = manifest["inputs"][:3]
            else:
                item = manifest["inputs"][0]; data = np.full((32, 32), 4095, dtype="<u2").tobytes()
                artifacts[item["artifactId"]] = data; item["sha256"] = cal.sha(data)
            with self.assertRaises(cal.CalibrationError):
                cal.run_calibration(manifest, artifacts.__getitem__)

    def test_hash_and_id_admission_prevents_client_path_resolution(self):
        manifest, artifacts = self.dark_task()
        manifest["inputs"][0]["artifactId"] = "../private-file"
        calls = []
        with self.assertRaises(cal.CalibrationError):
            cal.run_calibration(manifest, lambda artifact_id: calls.append(artifact_id))
        self.assertEqual(calls, [])
        manifest, artifacts = self.dark_task(); manifest["inputs"][0]["path"] = "/private/anything"
        with self.assertRaises(cal.CalibrationError):
            cal.run_calibration(manifest, artifacts.__getitem__)
        manifest, artifacts = self.dark_task(); manifest["inputs"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(cal.CalibrationError, "input_hash_mismatch"):
            cal.run_calibration(manifest, artifacts.__getitem__)

    def test_local_cli_writes_evidence_hashes_without_claiming_native_isp(self):
        manifest, artifacts = self.dark_task()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mapping = {}
            for artifact_id, data in artifacts.items():
                filename = root / (artifact_id + ".raw"); filename.write_bytes(data); mapping[artifact_id] = str(filename)
            (root / "task.json").write_text(json.dumps(manifest)); (root / "map.json").write_text(json.dumps(mapping))
            result = subprocess.run([sys.executable, str(MODULE), "--manifest", str(root / "task.json"), "--artifact-map", str(root / "map.json"), "--output", str(root / "result.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            receipt = json.loads(result.stdout); output = json.loads((root / "result.json").read_text())
            self.assertTrue(receipt["ok"]); self.assertEqual(receipt["outputSha256"], output["outputSha256"])
            self.assertEqual(output["parameters"]["values"], BLACK)
            self.assertNotIn(temporary, result.stdout); self.assertEqual(output["hardwareVerification"], "unverified")


class DependencyTests(unittest.TestCase):
    def test_missing_numpy_is_a_real_failure_before_any_artifact_read(self):
        with mock.patch.object(cal, "np", None):
            with self.assertRaisesRegex(cal.CalibrationError, "dependency_numpy_missing"):
                cal.run_calibration({}, lambda _artifact_id: self.fail("Must not read artifacts without dependency"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
