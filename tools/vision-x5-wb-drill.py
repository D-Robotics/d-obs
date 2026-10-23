#!/usr/bin/env python3
"""X5 IMX415 classroom white-balance drill: A1 -> bounded B-gain -> B -> restore -> A2, with B/G and R/G ratios.

Runs on the X5 board against the local camera daemon (vision-x5-camera.py contract). Two phases:
  phase A: qualification checks, bringup, baseline frame A1, controls dump; daemon stays running.
  phase B: bounded B-gain adjustment, candidate frame B, restore, frame A2, restore verification, stop,
           then the A1/B/A2 ratio table with drift against A1.
Formal acceptance records belong to wb_paper_observation.py; this drill is the rehearsal and ratio readout.

Usage: python3 vision-x5-wb-drill.py --config camera.json --phase A [--out DIR] [--step 0.25]
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

BOOT_BINDING_KEYS = ("sdkVersion", "cameraMode", "sensorConfig", "csiPort")
RESTORE_DRIFT_LIMIT = 0.02


def paper_ratios(image_bytes):
    """Median B/G and R/G over unsaturated white-paper pixels; usable=False when too few pixels."""
    image = np.asarray(Image.open(__import__("io").BytesIO(image_bytes)).convert("RGB")).astype(float)
    mask = (image.min(2) > 120) & (image.max(2) < 245) & (np.ptp(image, axis=2) < 60)
    if int(mask.sum()) < 100:
        return {"paperPixels": int(mask.sum()), "BoverGMedian": None, "RoverGMedian": None,
                "clippedAt255Fraction": None, "usable": False}
    values = image[mask]
    return {"paperPixels": int(mask.sum()),
            "BoverGMedian": round(float(np.median(values[:, 2] / np.maximum(1, values[:, 1]))), 5),
            "RoverGMedian": round(float(np.median(values[:, 0] / np.maximum(1, values[:, 1]))), 5),
            "clippedAt255Fraction": round(float(np.mean(values.max(axis=1) == 255)), 5),
            "usable": bool(np.mean(values[:, 1] == 0) == 0 and np.mean(values.max(axis=1) == 255) <= 0.01)}


def bounded_adjust(current, low, high, step):
    """One bounded step from current, clamped to [low, high]."""
    if not all(isinstance(value, (int, float)) for value in (current, low, high, step)):
        raise ValueError("numeric_bounds_required")
    if not low < high or step == 0:
        raise ValueError("invalid_bounds_or_step")
    proposed = current + step
    clamped = min(high, max(low, proposed))
    return {"from": current, "to": clamped, "clamped": clamped != proposed, "withinBounds": low <= clamped <= high}


def summarize(phases):
    """Ratio table across A1/B/A2 with drift from A1 and a restore check within RESTORE_DRIFT_LIMIT."""
    baseline = next((phase["ratios"] for phase in phases if phase["label"] == "A1"), None)
    if not baseline or not baseline.get("usable"):
        raise ValueError("baseline_unusable")
    table = {}
    for phase in phases:
        ratios = phase["ratios"]
        drift = None if not ratios.get("usable") else {
            "BoverG": round(ratios["BoverGMedian"] - baseline["BoverGMedian"], 5),
            "RoverG": round(ratios["RoverGMedian"] - baseline["RoverGMedian"], 5)}
        table[phase["label"]] = {"ratios": ratios, "driftFromA1": drift}
    restored = table.get("A2", {})
    return {"table": table,
            "restoredWithinDrift": bool(restored.get("ratios", {}).get("usable") and
                                        abs(restored["driftFromA1"]["BoverG"]) <= RESTORE_DRIFT_LIMIT and
                                        abs(restored["driftFromA1"]["RoverG"]) <= RESTORE_DRIFT_LIMIT)}


def pick_blue_gain(values):
    """Locate the blue gain control with bounds from a controls dump."""
    entries = values.get("values", values) if isinstance(values, dict) else values
    if not isinstance(entries, dict):
        raise ValueError("controls_shape_unrecognized")
    for key, entry in sorted(entries.items()):
        name = key.lower()
        if ("blue" in name or "bgain" in name) and isinstance(entry, dict) and "value" in entry:
            bounds = entry.get("range") or entry.get("bounds") or {}
            low, high = bounds.get("min", entry.get("min")), bounds.get("max", entry.get("max"))
            if low is None or high is None:
                raise ValueError("blue_gain_bounds_missing")
            return {"key": key, "value": entry["value"], "low": low, "high": high}
    raise ValueError("blue_gain_control_not_found")


def confirm_restore(before, after, key):
    def extract(payload):
        entries = payload.get("values", payload) if isinstance(payload, dict) else {}
        entry = entries.get(key) if isinstance(entries, dict) else None
        return entry.get("value") if isinstance(entry, dict) else entry
    value = extract(before)
    return value is not None and value == extract(after)


def preflight_adjustment_route(controls_result, tuning_probe):
    """Classify why (or whether) the bounded WB adjustment can run on this daemon posture.

    Returns a verdict dict; blocked is True with a reason when the operator must change
    qualification posture (modeReadbackEvidence) before the adjustment leg can run."""
    controls = (controls_result or {}).get("controls", controls_result) if isinstance(controls_result, dict) else {}
    entries = controls.get("values", controls) if isinstance(controls, dict) else {}
    writable = [key for key, entry in (entries or {}).items()
                if isinstance(entry, dict) and entry.get("writable") and key.lower() not in ("autoexposure", "autowhitebalance")]
    blue = None
    try:
        blue = pick_blue_gain(entries or {})
    except ValueError:
        blue = None
    full_isp = isinstance(tuning_probe, dict) and tuning_probe.get("ok")
    if blue is not None and blue.get("writable", True):
        return {"blocked": False, "route": "controls", "blueKey": blue["key"]}
    if full_isp:
        return {"blocked": False, "route": "tuning", "blueKey": None}
    reasons = []
    if not writable:
        reasons.append("controls_not_writable")
    if blue is None:
        reasons.append("per_channel_wb_gain_absent")
    if not full_isp:
        reasons.append("full_isp_readback_gated: " + json.dumps((tuning_probe or {}).get("error", ""))[:160])
    return {"blocked": True, "route": None, "reasons": reasons,
            "remedy": "configure modeReadbackEvidence (exposure+awb) in the daemon private config per qualification flow"}


def load_camera_module(root):
    spec = importlib.util.spec_from_file_location("camera", root / "vision-x5-camera.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def binding_checks(root, cfg, module, boot_id=None):
    """Boot, native library, profile binding and camera ownership checks; returns the qualified config."""
    binding = json.loads((root / "formal-qualified-config-patch-binding.json").read_text())
    boot = boot_id or pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if boot != binding["bootId"]:
        raise RuntimeError("boot_changed_requalify")
    if hashlib.sha256(pathlib.Path(cfg["nativeLibrary"]).read_bytes()).hexdigest() != binding["nativeLibrarySha256"]:
        raise RuntimeError("native_library_changed_requalify")
    if any(cfg.get(key) != binding.get(key) for key in BOOT_BINDING_KEYS):
        raise RuntimeError("profile_binding_mismatch")
    owner = subprocess.run("fuser /dev/vin* /dev/isp* /dev/video* 2>/dev/null", shell=True, capture_output=True, text=True)
    if owner.stdout.strip():
        raise RuntimeError("camera_owner_present: " + owner.stdout.strip())
    patch = json.loads((root / "formal-qualified-config-patch.json").read_text())
    return module.validate_config(dict(cfg, **patch)), boot


def daemon_call(cfg, token, module, operation, inputs=None):
    task = {"contract": module.CONTRACT, "operation": operation,
            "context": {**{key: cfg[key] for key in module.IDENTITY},
                        "jobId": "wb-drill-" + operation, "experimentId": "wb-drill-rehearsal"},
            "inputs": inputs or {}}
    request = urllib.request.Request("http://127.0.0.1:" + str(cfg["port"]) + "/execute",
                                     data=json.dumps(task).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=40) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return json.load(error)


def wait_for_port(port):
    for _ in range(40):
        try:
            socket.create_connection(("127.0.0.1", port), 1).close()
            return
        except OSError:
            time.sleep(0.5)
    raise RuntimeError("daemon_did_not_listen")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--phase", required=True, choices=["A", "B"])
    parser.add_argument("--out", default=None)
    parser.add_argument("--step", type=float, default=0.25)
    arguments = parser.parse_args()
    root = pathlib.Path(arguments.config).resolve().parent
    out = pathlib.Path(arguments.out) if arguments.out else root / ("wb-drill-" + arguments.phase.lower())
    if arguments.phase == "A":
        out.mkdir(mode=0o700, exist_ok=False)
    else:
        out.mkdir(mode=0o700, exist_ok=True)
    cfg = json.loads(pathlib.Path(arguments.config).read_text())
    module = load_camera_module(root)
    state_path = root / "wb-drill-state.json"
    receipt = {"schema": "rdk.wb-classroom-drill.v1", "phase": arguments.phase, "frames": {}, "calls": []}

    if arguments.phase == "A":
        qualified, boot = binding_checks(root, cfg, module, boot_id=os.environ.get("WB_DRILL_TEST_BOOT_ID"))
        receipt["bootId"] = boot
        (root / "camera-before.json").write_text(json.dumps(cfg))
        (root / "camera.json").write_text(json.dumps(qualified))
        pathlib.Path(root / "camera.json").chmod(0o600)
        cfg = qualified
        log = (out / "daemon.log").open("wb")
        daemon = subprocess.Popen([sys.executable, str(root / "vision-x5-camera.py"), "--config", str(root / "camera.json")],
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            wait_for_port(cfg["port"])
        except RuntimeError:
            daemon.terminate()
            raise
        state_path.write_text(json.dumps({"port": cfg["port"], "token": cfg["token"], "out": str(out), "bootId": boot}))
        token = cfg["token"]
    else:
        state = json.loads(state_path.read_text())
        cfg["port"], token, boot = state["port"], state["token"], state["bootId"]
        receipt["bootId"] = boot
        out.mkdir(mode=0o700, exist_ok=True)
        phase_a_receipt = json.loads((pathlib.Path(state["out"]) / "receipt.json").read_text())
        if "A1" not in phase_a_receipt.get("frames", {}):
            raise RuntimeError("phase_a_baseline_missing")

    def call(operation, inputs=None):
        body = daemon_call(cfg, token, module, operation, inputs)
        receipt["calls"].append({"operation": operation, "ok": bool(body.get("ok")), "error": body.get("error")})
        return body

    def capture(label):
        body = call("preview_frame")
        result = body.get("result", {})
        if not body.get("ok") or "contentBase64" not in result:
            raise RuntimeError("frame_failed: " + json.dumps(body.get("error")))
        data = base64.b64decode(result.pop("contentBase64"))
        (out / (label + ".png")).write_bytes(data)
        receipt["frames"][label] = {"sha256": hashlib.sha256(data).hexdigest(), "ratios": paper_ratios(data)}

    try:
        if arguments.phase == "A":
            for operation in ("probe", "preview_start", "controls_get"):
                body = call(operation)
                if not body.get("ok"):
                    raise RuntimeError(operation + "_failed: " + json.dumps(body.get("error")))
            capture("A1")
            print(json.dumps({"phase": "A", "out": str(out), "A1": receipt["frames"]["A1"]["ratios"], "ok": True}))
        else:
            controls = call("controls_get")
            if not controls.get("ok"):
                raise RuntimeError("controls_get_failed")
            receipt["controlsBefore"] = controls.get("result")
            tuning_probe = call("tuning_get")
            verdict = preflight_adjustment_route(receipt["controlsBefore"], tuning_probe)
            receipt["adjustmentRoute"] = verdict
            if verdict.get("blocked"):
                print(json.dumps({"phase": "B", "verdict": verdict, "ok": False}))
                sys.exit(2)
            blue = pick_blue_gain(receipt["controlsBefore"])
            adjustment = bounded_adjust(blue["value"], blue["low"], blue["high"], arguments.step)
            receipt["adjustment"] = adjustment
            applied = call("controls_set", {"values": {blue["key"]: adjustment["to"]}})
            if not applied.get("ok"):
                raise RuntimeError("controls_set_failed: " + json.dumps(applied.get("error")))
            capture("B")
            restored = call("controls_set", {"values": {blue["key"]: blue["value"]}})
            if not restored.get("ok"):
                raise RuntimeError("restore_failed_no_retry: " + json.dumps(restored.get("error")))
            capture("A2")
            verified = call("controls_get")
            receipt["controlsAfter"] = verified.get("result")
            receipt["restoredConfirmed"] = confirm_restore(receipt["controlsBefore"], receipt["controlsAfter"], blue["key"])
            if receipt["restoredConfirmed"]:
                call("preview_stop")
            baseline = {"label": "A1", "ratios": phase_a_receipt_frames_A1(phase_a_receipt)}
            phases = [baseline] + [{"label": label, "ratios": entry["ratios"]} for label, entry in receipt["frames"].items()]
            receipt["summary"] = summarize(phases)
            print(json.dumps({"phase": "B", "out": str(out), "summary": receipt["summary"], "ok": True}))
    finally:
        (out / "receipt.json").write_text(json.dumps(receipt, indent=1))


def phase_a_receipt_frames_A1(phase_a_receipt):
    return phase_a_receipt["frames"]["A1"]["ratios"]


if __name__ == "__main__":
    main()
