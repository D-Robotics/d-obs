#!/usr/bin/env python3
"""CPU offline Bayer/colour calibration; outputs are SDK-neutral, not ISP writes.

The platform entrypoint accepts artifact IDs and an authorized byte resolver.
Only the local CLI uses a separate ID-to-file map. A source label and plausible
statistics do not prove camera provenance, lighting quality or hardware success.
sRGB decoding: https://www.w3.org/TR/css-color-4/#color-conversion-code
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re

try:
    import numpy as np
except ImportError:
    np = None

SCHEMA = "rdk.x5-calibration-task.v1"
RESULT_SCHEMA = "rdk.x5-calibration-result.v1"
CHANNELS = ("R", "Gr", "Gb", "B")
LAYOUTS = {"RGGB": ((0, 0), (0, 1), (1, 0), (1, 1)),
           "BGGR": ((1, 1), (1, 0), (0, 1), (0, 0)),
           "GRBG": ((0, 1), (0, 0), (1, 1), (1, 0)),
           "GBRG": ((1, 0), (1, 1), (0, 0), (0, 1))}
MAX_FRAME_BYTES = 64 * 1024 * 1024
MAX_DATASET_BYTES = 256 * 1024 * 1024


class CalibrationError(ValueError):
    pass


def fail(code):
    raise CalibrationError("calibration_" + code)


def require_numpy():
    if np is None:
        fail("dependency_numpy_missing")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        fail("invalid_integer")
    return value


def number(value, low, high):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        fail("invalid_number")
    return float(value)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        fail("artifact_or_dataset_id_invalid")
    return value


def decode_raw(data, metadata):
    """Exact single-frame RAW16 or CSI-2 packed RAW10/12, with row padding."""
    require_numpy()
    if not isinstance(metadata, dict):
        fail("raw_metadata_invalid")
    width = integer(metadata.get("width"), 2, 8192)
    height = integer(metadata.get("height"), 2, 8192)
    depth = metadata.get("bitDepth")
    packing = metadata.get("packing")
    if width % 2 or height % 2 or width * height > 32 * 1024 * 1024 or depth not in (8, 10, 12, 14, 16) or type(depth) is not int or metadata.get("bayer") not in LAYOUTS:
        fail("raw_layout_invalid")
    if packing == "unpacked16le":
        row_bytes = width * 2
    elif packing == "mipi-raw10" and depth == 10 and width % 4 == 0:
        row_bytes = width // 4 * 5
    elif packing == "mipi-raw12" and depth == 12:
        row_bytes = width // 2 * 3
    else:
        fail("raw_packing_invalid")
    stride = integer(metadata.get("stride"), row_bytes, row_bytes + 4096)
    if not isinstance(data, bytes) or len(data) != stride * height or len(data) > MAX_FRAME_BYTES:
        fail("raw_exact_byte_count_required")
    white = integer(metadata.get("whiteLevel"), 1, (1 << depth) - 1)
    black = integer(metadata.get("blackLevel"), 0, white - 1)
    rows = np.frombuffer(data, dtype=np.uint8).reshape(height, stride)[:, :row_bytes].copy()
    if packing == "unpacked16le":
        pixels = rows.reshape(height, width, 2).astype(np.uint16)
        output = pixels[:, :, 0] | (pixels[:, :, 1] << 8)
    else:
        count, size, shift = (4, 5, 2) if packing == "mipi-raw10" else (2, 3, 4)
        groups = rows.reshape(height, width // count, size).astype(np.uint16)
        output = np.empty((height, width), dtype=np.uint16)
        for offset in range(count):
            output[:, offset::count] = (groups[:, :, offset] << shift) | ((groups[:, :, count] >> (offset * shift)) & ((1 << shift) - 1))
    if np.any(output > (1 << depth) - 1):
        fail("raw_pixel_exceeds_bit_depth")
    return output


def planes(record, roi=None):
    image = record["pixels"]
    if roi is not None:
        if not isinstance(roi, dict) or set(roi) != {"x", "y", "width", "height"}:
            fail("recorded_roi_required")
        x, y = integer(roi["x"], 0, image.shape[1] - 2), integer(roi["y"], 0, image.shape[0] - 2)
        w, h = integer(roi["width"], 4, image.shape[1]), integer(roi["height"], 4, image.shape[0])
        if any(value % 2 for value in (x, y, w, h)) or x + w > image.shape[1] or y + h > image.shape[0]:
            fail("roi_bounds_or_bayer_alignment_invalid")
        image = image[y:y+h, x:x+w]
    return {channel: image[row::2, column::2].astype(np.float64) for channel, (row, column) in zip(CHANNELS, LAYOUTS[record["metadata"]["bayer"]])}


def capture(record, target):
    row = record.get("capture")
    if not isinstance(row, dict) or row.get("target") != target or row.get("preprocessing") != "sensor_raw_unprocessed" or row.get("source") not in ("recorded-camera-artifact", "synthetic-fixture"):
        fail("recorded_capture_conditions_required")
    identifier(row.get("sensorMode"))
    number(row.get("exposureUs"), 1, 60_000_000)
    number(row.get("analogGain"), .0001, 65_536)
    return row


def consistent(records):
    if not 3 <= len(records) <= 32:
        fail("at_least_three_frames_required")
    signatures = {(row["metadata"]["width"], row["metadata"]["height"], row["metadata"]["bitDepth"], row["metadata"]["bayer"], row["metadata"]["whiteLevel"], row["capture"]["sensorMode"], row["capture"]["exposureUs"], row["capture"]["analogGain"]) for row in records}
    if len(signatures) != 1:
        fail("mixed_capture_modes_or_exposure")


def robust(values):
    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    return median, mad


def black_levels(values, white):
    if not isinstance(values, dict) or set(values) != set(CHANNELS):
        fail("four_channel_black_levels_required")
    return {key: number(value, 0, white - 1) for key, value in values.items()}


def calibrate_blc(records, options=None):
    require_numpy()
    options = options or {}
    for record in records:
        if capture(record, "lens_covered_dark").get("lightBlocked") is not True:
            fail("blocked_light_dark_capture_required")
    consistent(records)
    white = records[0]["metadata"]["whiteLevel"]
    max_dark = number(options.get("maxDarkFraction", .15), .001, .5) * white
    max_drift = number(options.get("maxFrameDriftCodes", 8), 0, white)
    result = {}
    for channel in CHANNELS:
        arrays = [planes(record)[channel].ravel() for record in records]
        values = np.concatenate(arrays)
        median, mad = robust(values)
        frame_medians = [float(np.median(array)) for array in arrays]
        saturated = float(np.mean(values >= white))
        spread = max(frame_medians) - min(frame_medians)
        if median > max_dark or saturated > .001 or spread > max_drift:
            fail("dark_sample_light_leak_saturation_or_drift")
        result[channel] = {"blackLevelCodes": median, "madCodes": mad, "robustSigmaCodes": 1.4826 * mad,
                           "pixelCount": int(values.size), "frameMedians": frame_medians, "frameMedianSpreadCodes": spread,
                           "outlierRatio": float(np.mean(np.abs(values - median) > max(2, 8 * mad)))}
    return {"method": "multi_dark_frame_per_bayer_channel_median_mad", "values": {key: row["blackLevelCodes"] for key, row in result.items()},
            "statistics": result, "constraints": ["Offsets are sensor code values before BLC; match gain/exposure/temperature and SDK channel order.", "Do not subtract an already applied BLC twice."]}


def calibrate_lsc(records, black, grid, options=None):
    require_numpy()
    options = options or {}
    rows, cols = integer(grid.get("rows"), 2, 33), integer(grid.get("cols"), 2, 33)
    max_lux_spread = number(options.get("maxIlluminationRelativeSpread", .10), .001, .5)
    for record in records:
        cap = capture(record, "neutral_uniform_flat_field")
        illumination = cap.get("illuminationUniformity")
        if not isinstance(illumination, dict) or illumination.get("method") != "independent_meter_grid":
            fail("independent_uniform_illumination_evidence_required")
        lux = np.asarray(illumination.get("luxSamples"), dtype=float)
        if lux.ndim != 1 or not 5 <= lux.size <= 256 or not np.all(np.isfinite(lux)) or np.any(lux <= 0):
            fail("illumination_measurements_invalid")
        if float((lux.max() - lux.min()) / np.median(lux)) > max_lux_spread:
            fail("illumination_nonuniform")
        identifier(cap.get("illuminantId"))
    consistent(records)
    if len({record["capture"]["illuminantId"] for record in records}) != 1:
        fail("mixed_flat_field_illuminants")
    white = records[0]["metadata"]["whiteLevel"]
    black = black_levels(black, white)
    max_gain = number(options.get("maxGain", 8), 1, 32)
    max_texture = number(options.get("maxCellRelativeMad", .08), .001, .5)
    max_instability = number(options.get("maxFrameRelativeSpread", .08), .001, .5)
    means, gains = {}, {}
    for channel in CHANNELS:
        samples = [planes(record)[channel] for record in records]
        h, w = samples[0].shape
        if h // rows < 4 or w // cols < 4:
            fail("flat_field_grid_under_sampled")
        per_frame = []
        for samples_frame in samples:
            if float(np.mean(samples_frame >= white)) > .001:
                fail("flat_field_saturated")
            corrected = samples_frame - black[channel]
            cells = np.empty((rows, cols))
            for y in range(rows):
                for x in range(cols):
                    cell = corrected[y*h//rows:(y+1)*h//rows, x*w//cols:(x+1)*w//cols]
                    median, mad = robust(cell)
                    if median < .03 * (white - black[channel]) or mad / median > max_texture:
                        fail("flat_field_low_signal_or_texture")
                    cells[y, x] = median
            per_frame.append(cells)
        stack = np.stack(per_frame)
        mesh = np.median(stack, axis=0)
        if np.any((np.max(stack, axis=0) - np.min(stack, axis=0)) / mesh > max_instability):
            fail("flat_field_temporally_unstable")
        gain = float(mesh.max()) / mesh
        if np.any(gain > max_gain):
            fail("flat_field_gain_limit")
        means[channel], gains[channel] = mesh.tolist(), gain.tolist()
    return {"method": "black_subtracted_flat_field_cell_medians", "values": gains, "cellSignalCodes": means,
            "grid": {"rows": rows, "cols": cols, "xCentersNormalized": [float((x + .5) / cols) for x in range(cols)], "yCentersNormalized": [float((y + .5) / rows) for y in range(rows)]},
            "blackLevels": black, "constraints": ["This is a cell-center relative gain mesh, not any vendor LSC binary; resample and quantize using the matched SDK schema.", "Reference gain is the brightest cell per channel; it does not correct inter-channel white balance.", "A single flat-field image cannot distinguish lens shading from illumination gradients; independent meter evidence remains a physical precondition, not software-verified provenance."]}


def srgb_to_linear(values):
    require_numpy()
    values = np.asarray(values, dtype=float)
    if not np.all(np.isfinite(values)) or np.any(values < 0) or np.any(values > 1):
        fail("reference_rgb_invalid")
    return np.where(values <= .04045, values / 12.92, ((values + .055) / 1.055) ** 2.4)


def calibrate_ccm(dataset, options=None):
    require_numpy()
    options = options or {}
    if dataset.get("target") != "recorded_color_chart" or dataset.get("measurementSpace") != "camera-linear-rgb" or not isinstance(dataset.get("preprocessing"), str) or not dataset["preprocessing"]:
        fail("ccm_recorded_linear_chart_required")
    illuminant = dataset.get("illuminant", {})
    identifier(illuminant.get("id")); number(illuminant.get("colorTemperatureK"), 1000, 25000)
    if dataset.get("referenceIlluminantId") != illuminant["id"] or dataset.get("referenceWhitePoint") != "D65":
        fail("ccm_explicit_reference_illumination_required")
    if dataset.get("referenceEncoding") not in ("srgb", "linear-srgb"):
        fail("ccm_reference_encoding_required")
    width, height = integer(dataset.get("imageWidth"), 4, 8192), integer(dataset.get("imageHeight"), 4, 8192)
    patches = dataset.get("patches")
    if not isinstance(patches, list) or not 9 <= len(patches) <= 256:
        fail("ccm_training_and_heldout_required")
    measured, reference, train, heldout, seen, regions = [], [], [], [], set(), []
    for index, patch in enumerate(patches):
        patch_id = identifier(patch.get("patchId"))
        if patch_id in seen:
            fail("ccm_duplicate_patch")
        seen.add(patch_id); identifier(patch.get("sourceArtifactId"))
        roi = patch.get("roi", {})
        x, y = integer(roi.get("x"), 0, width - 1), integer(roi.get("y"), 0, height - 1)
        w, h = integer(roi.get("width"), 1, width), integer(roi.get("height"), 1, height)
        if x + w > width or y + h > height:
            fail("ccm_roi_outside_image")
        source_id = patch["sourceArtifactId"]
        if any(source_id == previous[0] and x < previous[1] + previous[3] and previous[1] < x + w and y < previous[2] + previous[4] and previous[2] < y + h for previous in regions):
            fail("ccm_overlapping_patch_rois")
        regions.append((source_id, x, y, w, h))
        a, b = np.asarray(patch.get("measuredLinearRgb"), dtype=float), np.asarray(patch.get("referenceRgb"), dtype=float)
        if a.shape != (3,) or b.shape != (3,) or not np.all(np.isfinite(a)) or not np.all(np.isfinite(b)) or np.any(a < 0) or np.any(a >= .995) or np.any(b < 0) or np.any(b > 1):
            fail("ccm_invalid_or_saturated_rgb")
        measured.append(a); reference.append(b)
        if patch.get("split") == "train":
            train.append(index)
        elif patch.get("split") == "heldout":
            heldout.append(index)
        else:
            fail("ccm_explicit_split_required")
    if len(train) < 6 or len(heldout) < 3:
        fail("ccm_training_and_heldout_required")
    a, b = np.stack(measured), np.stack(reference)
    if dataset["referenceEncoding"] == "srgb":
        b = srgb_to_linear(b)
    condition = float(np.linalg.cond(a[train]))
    if np.linalg.matrix_rank(a[train]) != 3 or not math.isfinite(condition) or condition > number(options.get("maxCondition", 100), 1, 10000):
        fail("ccm_rank_or_condition_invalid")
    coefficients, _residual, rank, _singular = np.linalg.lstsq(a[train], b[train], rcond=None)
    predicted = a @ coefficients
    train_rmse = float(np.sqrt(np.mean((predicted[train] - b[train]) ** 2)))
    heldout_rmse = float(np.sqrt(np.mean((predicted[heldout] - b[heldout]) ** 2)))
    limit = number(options.get("maxRmse", .05), .000001, .5)
    if train_rmse > limit or heldout_rmse > limit:
        fail("ccm_training_or_heldout_residual_exceeded")
    return {"method": "linear_rgb_3x3_least_squares_no_intercept", "values": coefficients.T.tolist(),
            "statistics": {"rank": int(rank), "conditionNumber": condition, "trainRmseLinear": train_rmse, "heldoutRmseLinear": heldout_rmse, "trainCount": len(train), "heldoutCount": len(heldout)},
            "referenceEncoding": dataset["referenceEncoding"], "referenceWhitePoint": "D65", "illuminant": illuminant,
            "constraints": ["reference_column_rgb = matrix3x3 @ camera_column_rgb; no intercept, gamma or tone curve is fitted.", "Apply at the recorded linear measurement stage, with matching BLC/LSC/fixed WB, illuminant and explicit reference colour space.", "Use SDK-specific channel/matrix order, coefficient range, quantization and gamut validation; this is not a vendor tuning binary or a Delta-E/colour-quality certification."]}


def calibrate_awb(records, black, options=None):
    require_numpy()
    options = options or {}
    groups = {}
    for record in records:
        cap = capture(record, "neutral_gray_card")
        light = identifier(cap.get("illuminantId"))
        temperature = number(cap.get("colorTemperatureK"), 1000, 25000)
        if not isinstance(cap.get("roi"), dict):
            fail("awb_explicit_gray_card_roi_required")
        groups.setdefault(light, []).append(record)
    if len(groups) < 2:
        fail("awb_multiple_recorded_illuminants_required")
    samples = []
    for light, frames in groups.items():
        consistent(frames)
        temperatures = {row["capture"]["colorTemperatureK"] for row in frames}
        if len(temperatures) != 1:
            fail("awb_conflicting_temperature_labels")
        white = frames[0]["metadata"]["whiteLevel"]
        offsets = black_levels(black, white)
        rows = []
        for record in frames:
            channel_planes = planes(record, record["capture"]["roi"])
            medians = {}
            for channel, pixels in channel_planes.items():
                if float(np.mean(pixels >= white)) > .001:
                    fail("awb_gray_card_saturated")
                median, mad = robust(pixels - offsets[channel])
                if median <= .03 * (white - offsets[channel]) or mad / median > .08:
                    fail("awb_gray_card_low_signal_or_texture")
                medians[channel] = median
            green = (medians["Gr"] + medians["Gb"]) / 2
            if abs(medians["Gr"] - medians["Gb"]) / green > .15:
                fail("awb_green_channels_inconsistent")
            rows.append([green / medians["R"], 1, green / medians["B"]])
        gains = np.median(np.asarray(rows), axis=0)
        if np.any(gains < .125) or np.any(gains > number(options.get("maxGain", 8), 1, 32)) or np.any(np.ptp(np.asarray(rows), axis=0) > .08 * gains):
            fail("awb_gains_invalid_or_unstable")
        samples.append({"illuminantId": light, "colorTemperatureK": float(next(iter(temperatures))), "redGain": float(gains[0]), "greenGain": 1.0, "blueGain": float(gains[2]), "frameCount": len(frames), "gainMad": np.median(np.abs(np.asarray(rows) - gains), axis=0).tolist()})
    samples.sort(key=lambda row: (row["colorTemperatureK"], row["illuminantId"]))
    return {"method": "black_subtracted_recorded_gray_card_roi_channel_ratios", "values": samples, "blackLevels": black,
            "constraints": ["CCT and light identity are recorded inputs, never estimated from image appearance or a global gray-world assumption.", "G is the mean of the two Bayer green medians; map channel gains, control range, illuminant table and interpolation explicitly to the matched SDK.", "Distinct illuminants can share a CCT; do not silently collapse their spectral/gain differences."]}


def run_calibration(manifest, artifact_loader):
    """Platform-safe entrypoint: resolver receives only reviewed artifact IDs."""
    require_numpy()
    if not isinstance(manifest, dict) or set(manifest) - {"schema", "datasetId", "operation", "inputs", "options"} or manifest.get("schema") != SCHEMA:
        fail("task_manifest_invalid")
    dataset_id = identifier(manifest.get("datasetId"))
    operation = manifest.get("operation")
    inputs = manifest.get("inputs")
    options = manifest.get("options", {})
    if operation not in ("blc", "lsc", "ccm", "awb") or not isinstance(options, dict) or not isinstance(inputs, list) or not 1 <= len(inputs) <= 32:
        fail("task_operation_or_inputs_invalid")
    records, evidence, seen, total = [], [], set(), 0
    for item in inputs:
        if not isinstance(item, dict) or set(item) - {"artifactId", "sha256", "metadata", "capture"}:
            fail("artifact_reference_invalid")
        artifact_id = identifier(item.get("artifactId"))
        if artifact_id in seen:
            fail("duplicate_artifact_reference")
        seen.add(artifact_id)
        expected = item.get("sha256")
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            fail("input_hash_required")
        data = artifact_loader(artifact_id)
        if not isinstance(data, bytes):
            fail("artifact_bytes_required")
        total += len(data)
        if len(data) > MAX_FRAME_BYTES or total > MAX_DATASET_BYTES:
            fail("dataset_byte_limit")
        if sha(data) != expected:
            fail("input_hash_mismatch")
        evidence.append({"artifactId": artifact_id, "sha256": expected, "bytes": len(data)})
        if operation == "ccm":
            try:
                record = json.loads(data, parse_constant=lambda _value: fail("nonfinite_json"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail("measurement_json_invalid")
            records.append(record)
        else:
            pixels = decode_raw(data, item.get("metadata"))
            records.append({"pixels": pixels, "metadata": item["metadata"], "capture": item.get("capture", {})})
    if operation == "blc":
        computation = calibrate_blc(records, options)
    elif operation == "lsc":
        computation = calibrate_lsc(records, options.get("blackLevels"), options.get("grid", {}), options)
    elif operation == "ccm":
        if len(records) != 1 or not isinstance(records[0], dict):
            fail("one_ccm_measurement_artifact_required")
        computation = calibrate_ccm(records[0], options)
    else:
        computation = calibrate_awb(records, options.get("blackLevels"), options)
    result = {"schema": RESULT_SCHEMA, "datasetId": dataset_id, "operation": operation, "executor": "cpu-offline-numpy",
              "format": "sdk-neutral-calibration-values-v1", "status": "computed", "hardwareVerification": "unverified", "qualityVerification": "unverified",
              "inputArtifacts": evidence, "taskManifestSha256": sha(canonical(manifest)), "parameters": computation,
              "provenanceLimitation": "Input hashes verify bytes and recorded conditions, not physical acquisition or calibration quality; this result is not native ISP execution."}
    result["outputSha256"] = sha(canonical(result))  # Digest excludes only this self-referential field.
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--artifact-map", required=True, help="Local CLI only: JSON artifact ID -> filesystem path")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        require_numpy()
        if Path(args.manifest).stat().st_size > 1024 * 1024 or Path(args.artifact_map).stat().st_size > 1024 * 1024:
            fail("task_manifest_limit")
        manifest_bytes = Path(args.manifest).read_bytes()
        manifest = json.loads(manifest_bytes)
        mapping = json.loads(Path(args.artifact_map).read_text())
        if not isinstance(mapping, dict):
            fail("local_artifact_map_invalid")
        def load(artifact_id):
            filename = mapping.get(artifact_id)
            if not isinstance(filename, str):
                fail("local_artifact_missing")
            with open(filename, "rb") as source:
                return source.read(MAX_FRAME_BYTES + 1)
        result = run_calibration(manifest, load)
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical(result))
        print(json.dumps({"ok": True, "operation": result["operation"], "submittedManifestSha256": sha(manifest_bytes), "outputSha256": result["outputSha256"], "hardwareVerification": "unverified", "qualityVerification": "unverified"}))
        return 0
    except CalibrationError as error:
        print(json.dumps({"ok": False, "error": str(error)})); return 1
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({"ok": False, "error": "calibration_dataset_or_file_invalid"})); return 1


if __name__ == "__main__":
    raise SystemExit(main())
