#!/usr/bin/env python3
"""Read-only X5/IMX415 filesystem preflight; never probes an I2C bus or loads SDK code.

Use --root to inspect an explicitly supplied fixture/sysroot. File presence and
driver registration are observations, never a claim that a camera streams.
"""
import argparse
import hashlib
from itertools import islice
import json
from pathlib import Path
import re
import stat
import struct

SCHEMA = "rdk.vision-x5-preflight.v1"
LIBRARY_DIRS = ("/usr/lib", "/usr/lib/aarch64-linux-gnu", "/usr/local/lib", "/usr/hobot/lib")
TOOL_DIRS = ("/usr/bin", "/usr/local/bin", "/usr/hobot/bin", "/app/multimedia_samples")
LIBRARY_NAME = re.compile(r"^lib(?:cam|hbmem|hbn|mm|isp|vio|vin|vpf)(?:[-_.].*)?\.so(?:\..*)?$")
TOOL_NAME = re.compile(r"^(?:tuning_tool|tuning_server|TuningServer|sample_(?:vin|vio|hbn)|capture_raw|dump_raw|v4l2-ctl|media-ctl)$")
VERSION = re.compile(r"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9])")
ISP_HEADERS = ("/usr/include/hbn_isp_api.h", "/usr/include/vio/hbn_isp_api.h")
# A missing declaration rules out the current adapter. Presence is only a
# necessary condition: the native build checks all fields, APIs and layouts.
NATIVE_ISP_FLOOR = tuple("hbn_isp_" + action + "_" + family + "_attr"
                        for family in ("cproc", "ee", "2dnr", "3dnr") for action in ("get", "set"))


class ReadOnlyRoot:
    """Contain every read inside one root; never follow a fixture link into the host."""
    def __init__(self, root="/"):
        self.root = Path(root).resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("preflight_root_not_directory")
        self.errors = []

    def path(self, logical):
        if not isinstance(logical, str) or not logical.startswith("/") or ".." in Path(logical).parts:
            raise ValueError("preflight_invalid_logical_path")
        result = self.root / logical.lstrip("/")
        try:
            resolved = result.resolve(strict=True)
            resolved.relative_to(self.root)
            return resolved
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            self.errors.append({"path": logical, "reason": "unreadable_or_outside_root"})
            return None

    def read(self, logical, limit=8192):
        path = self.path(logical)
        if path is None:
            return None
        try:
            if not stat.S_ISREG(path.stat().st_mode):
                self.errors.append({"path": logical, "reason": "not_regular_file"})
                return None
            with path.open("rb") as stream:
                value = stream.read(limit + 1)
            if len(value) > limit:
                self.errors.append({"path": logical, "reason": "read_limit"})
                return None
            return value
        except OSError:
            self.errors.append({"path": logical, "reason": "unreadable"})
            return None

    def text(self, logical, limit=8192):
        value = self.read(logical, limit)
        return None if value is None else value.decode("utf-8", "replace").replace("\x00", " ").strip()

    def entries(self, logical, limit=512):
        path = self.path(logical)
        if path is None:
            return []
        try:
            result = sorted(islice(path.iterdir(), limit + 1), key=lambda item: item.name)
            if len(result) > limit:
                self.errors.append({"path": logical, "reason": "directory_limit"})
            return [logical.rstrip("/") + "/" + item.name for item in result[:limit]]
        except OSError:
            self.errors.append({"path": logical, "reason": "unreadable_directory"})
            return []

    def directories(self, logical, depth=12, maximum=4096):
        """Bounded tree walk, resolving each directory through the root fence."""
        pending = [(logical, 0)]; result = []; seen = set()
        while pending and len(result) < maximum:
            current, level = pending.pop()
            physical = self.path(current)
            if physical is None or not physical.is_dir() or physical in seen:
                continue
            seen.add(physical); result.append(current)
            if level < depth:
                for child in reversed(self.entries(current)):
                    resolved = self.path(child)
                    if resolved is not None and resolved.is_dir():
                        pending.append((child, level + 1))
        if pending:
            self.errors.append({"path": logical, "reason": "tree_limit"})
        return result


def properties(raw):
    result = {}
    for line in (raw or "").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            result[key] = value.strip().strip("\"'")
    return result


def version_at_least(value, minimum):
    match = VERSION.search(value or "")
    return bool(match and tuple(map(int, match.group(1).split("."))) >= minimum)


def package_records(root):
    raw = root.text("/var/lib/dpkg/status", 16 * 1024 * 1024)
    result = []
    for block in re.split(r"\n\s*\n", raw or ""):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(" "))
        name = fields.get("Package", "")
        if fields.get("Status") != "install ok installed" or not re.fullmatch(r"(?:hobot[-a-z0-9]*|rdk[-a-z0-9]*|tros-humble-(?:mipi-cam|hobot-stereonet))", name):
            continue
        result.append({"name": name, "version": fields.get("Version"), "architecture": fields.get("Architecture")})
    return result[:128]


def dt_words(root, logical):
    raw = root.read(logical)
    return [] if raw is None else [word.decode("utf-8", "replace") for word in raw.split(b"\x00") if word]


def dt_numbers(root, logical):
    raw = root.read(logical)
    if not raw or len(raw) % 4:
        return None
    return list(struct.unpack(">" + "I" * (len(raw) // 4), raw))


def device_tree(root):
    base = next((path for path in ("/sys/firmware/devicetree/base", "/proc/device-tree") if root.path(path)), None)
    if not base:
        return {"available": False, "model": None, "compatible": [], "sensors": [], "csi": []}
    sensors = []; csi = []
    for node in root.directories(base):
        compatible = dt_words(root, node + "/compatible")
        identifier = " ".join([Path(node).name, *compatible]).lower()
        kind = sensors if "imx415" in identifier else csi if re.search(r"(?:mipi|csi|dphy|vcon)", identifier) else None
        if kind is None:
            continue
        entry = {"path": node, "compatible": compatible, "status": root.text(node + "/status") or "unspecified", "reg": dt_numbers(root, node + "/reg"), "endpoints": []}
        if "vcon" in identifier:
            entry["connectorProperties"] = {"bus": dt_numbers(root, node + "/bus"),
                "rxPhy": dt_numbers(root, node + "/rx_phy"), "gpioOther": dt_numbers(root, node + "/gpio_oth"),
                "mappingVerified": False}
        for child in root.directories(node, depth=5, maximum=128):
            if Path(child).name.startswith("endpoint"):
                entry["endpoints"].append({"path": child, "dataLanes": dt_numbers(root, child + "/data-lanes"), "remoteEndpoint": dt_numbers(root, child + "/remote-endpoint")})
        kind.append(entry)
    return {"available": True, "model": root.text(base + "/model"), "compatible": dt_words(root, base + "/compatible"), "sensors": sensors[:32], "csi": csi[:32]}


def i2c_inventory(root):
    adapters = [{"name": Path(path).name, "label": root.text(path + "/name")} for path in root.entries("/sys/class/i2c-adapter") if re.fullmatch(r"i2c-[0-9]+", Path(path).name)]
    clients = []
    for logical in root.entries("/sys/bus/i2c/devices"):
        match = re.fullmatch(r"([0-9]+)-([0-9a-f]{4})", Path(logical).name)
        if not match:
            continue
        name = root.text(logical + "/name")
        compatible = dt_words(root, logical + "/of_node/compatible")
        driver = root.path(logical + "/driver")
        driver_name = driver.name if driver is not None and driver.is_dir() else None
        clients.append({"bus": int(match.group(1)), "address": "0x" + match.group(2).lstrip("0") if int(match.group(2), 16) else "0x0", "name": name, "compatible": compatible, "driver": driver_name, "imx415": "imx415" in " ".join([name or "", driver_name or "", *compatible]).lower()})
    return {"method": "kernel_sysfs_inventory_only", "busScanned": False, "registersAccessed": False, "adapters": adapters[:64], "clients": clients[:128]}


def sdk_inventory(root):
    libraries = []; tools = []
    for directory in LIBRARY_DIRS:
        for logical in root.entries(directory, limit=8192):
            if not LIBRARY_NAME.fullmatch(Path(logical).name):
                continue
            path = root.path(logical)
            if path is None or not path.is_file():
                continue
            try:
                with path.open("rb") as stream:
                    header = stream.read(64)
            except OSError:
                continue
            elf = len(header) >= 20 and header[:4] == b"\x7fELF" and header[5] in (1, 2)
            machine = struct.unpack("<H" if header[5:6] == b"\x01" else ">H", header[18:20])[0] if elf else None
            libraries.append({"path": logical, "elf": elf, "elfClass": header[4] if elf else None, "machine": machine, "aarch64": elf and machine == 183 and header[4] == 2, "loaded": False})
    for directory in TOOL_DIRS:
        for candidate in root.directories(directory, depth=2, maximum=64) if directory == "/app/multimedia_samples" else [directory]:
            for name in ("tuning_tool", "tuning_server", "TuningServer", "sample_vin", "sample_vio", "sample_hbn", "capture_raw", "dump_raw", "v4l2-ctl", "media-ctl"):
                logical = candidate.rstrip("/") + "/" + name
                path = root.path(logical)
                try:
                    if path is not None and path.is_file():
                        tools.append({"path": logical, "executableBit": bool(path.stat().st_mode & 0o111), "executed": False})
                except OSError:
                    root.errors.append({"path": logical, "reason": "unreadable"})
    releases = []
    for logical in ("/etc/hobot-release", "/etc/hobot_release", "/usr/hobot/version", "/usr/hobot/VERSION"):
        raw = root.text(logical, 4096)
        if raw:
            versions = sorted(set(VERSION.findall(raw)))
            if versions:
                releases.append({"path": logical, "versionTokens": versions, "sdkVersionConfirmed": False})
    duplicates = []
    for name in sorted({Path(row["path"]).name for row in libraries}):
        paths = [row["path"] for row in libraries if Path(row["path"]).name == name]
        if len({root.path(path) for path in paths}) > 1:
            duplicates.append({"name": name, "paths": paths, "selectedLibraryVerified": False})
    return {"libraries": libraries[:128], "duplicateLibraryNames": duplicates,
        "nativeAdapterCompatibility": native_adapter_headers(root),
        "tools": tools[:128], "packages": package_records(root), "releaseFiles": releases, "abiVerified": False, "version": None, "versionReason": "No SDK API was invoked; package and release versions must be matched to the installed SDK."}


def native_adapter_headers(root):
    headers = []
    for path in ISP_HEADERS:
        text = root.text(path, 2 * 1024 * 1024)
        if text is None:
            continue
        declarations = re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.S)
        missing = [name for name in NATIVE_ISP_FLOOR if not re.search(r"\b" + name + r"\s*\(", declarations)]
        headers.append({"path": path, "missingRequiredApis": missing})
    incompatible = bool(headers) and all(row["missingRequiredApis"] for row in headers)
    return {"status": "incompatible" if incompatible else "unverified", "headers": headers,
        "requiredApiFloor": list(NATIVE_ISP_FLOOR), "compiled": False, "abiVerified": False,
        "reason": "required_public_isp_declarations_missing" if incompatible else "native_compile_and_runtime_check_required"}


def default_tuning_inventory(root):
    """Candidate locations only; neither file presence nor JSON proves loading."""
    rows = []
    for path, basis in (("/usr/hobot/lib/sensor/imx415_tuning.json", "x5_sdk_doc_v2.0.0_camera_api"),
                        ("/usr/hobot/bin/imx415_tuning.json", "x5_rdkos_3.1.1_installed_camera_files")):
        raw = root.read(path, 16 * 1024 * 1024)
        row = {"path": path, "lookupBasis": basis, "present": raw is not None,
               "sdkLoadedVerified": False, "schemaVerified": False}
        if raw is not None:
            row.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            try:
                parsed = json.loads(raw, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("nonfinite_json")))
                row["jsonObject"] = isinstance(parsed, dict)
            except (ValueError, UnicodeError):
                row["jsonObject"] = False
        rows.append(row)
    return rows


def collect_preflight(root="/"):
    filesystem = ReadOnlyRoot(root)
    tree = device_tree(filesystem); i2c = i2c_inventory(filesystem); sdk = sdk_inventory(filesystem)
    sdk["defaultTuningFiles"] = default_tuning_inventory(filesystem)
    os_fields = properties(filesystem.text("/etc/os-release"))
    rdk_sources = []
    for logical in ("/etc/rdk_version", "/etc/rdk-release", "/etc/rdk_release", "/etc/version"):
        raw = filesystem.text(logical, 4096)
        if raw:
            tokens = sorted(set(VERSION.findall(raw)))
            if tokens:
                rdk_sources.append({"path": logical, "version": tokens[0] if len(tokens) == 1 else None, "versionTokens": tokens})
    versions = sorted(set(item["version"] for item in rdk_sources if item["version"]))
    rdk_version = versions[0] if len(versions) == 1 and all(item["version"] for item in rdk_sources) else None
    model = " ".join([tree.get("model") or "", *tree.get("compatible", [])]).lower()
    x5 = bool(re.search(r"(?:\bx5\b|sunrise[-_ ]?5)", model))
    bound = [client for client in i2c["clients"] if client["imx415"] and client["driver"]]
    media = [{"node": Path(path).name, "name": filesystem.text(path + "/name")} for path in filesystem.entries("/sys/class/video4linux") if re.fullmatch(r"(?:video|v4l-subdev)[0-9]+", Path(path).name)]
    checks = [
        {"name": "x5_identity", "passed": x5, "reason": "Device-tree model/compatible identifies X5." if x5 else "No X5 identity was observed."},
        {"name": "native_sdk_files", "passed": any(row["aarch64"] for row in sdk["libraries"]), "reason": "AArch64 multimedia library files observed; this is not an ABI check." if any(row["aarch64"] for row in sdk["libraries"]) else "No supported AArch64 multimedia library file observed."},
        {"name": "imx415_driver_registered", "passed": bool(bound), "reason": "IMX415 kernel client has a bound driver; physical streaming remains unverified." if bound else "No bound IMX415 kernel client observed; a DT declaration is insufficient."},
        {"name": "imx415_expected_i2c_address", "passed": any(client["address"] == "0x1a" for client in bound), "reason": "The module's documented 0x1a address must match an observed bound IMX415 client."},
        {"name": "sdk_runtime_verified", "passed": False, "reason": "Read-only filesystem inspection does not load SDK libraries or call hardware APIs."},
        {"name": "actual_frame_verified", "passed": False, "reason": "No frame was captured by this preflight."},
    ]
    packages = {package["name"]: package["version"] for package in sdk["packages"]}
    prerequisites = {"route": "vendor_ros_bringup", "rdkosMinVersion": "3.5.0", "rdkosVersion": rdk_version,
        "rdkosVersionSources": rdk_sources, "rdkosSatisfied": version_at_least(rdk_version, (3, 5, 0)),
        "packages": [{"name": name, "installedVersion": packages.get(name), "minimumVersion": "2.4.1", "satisfied": version_at_least(packages.get(name), (2, 4, 1))} for name in ("tros-humble-mipi-cam", "tros-humble-hobot-stereonet")],
        "note": "These vendor ROS prerequisites do not determine the native SDK version or prove camera compatibility."}
    return {"contract": SCHEMA, "source": "host-filesystem" if filesystem.root == Path("/") else "fixture-filesystem", "ready": False, "passed": False, "hardwareVerified": False,
        "facts": {"board": {"target": "RDK X5", "observedModel": tree.get("model"), "identified": x5}, "sensor": {"target": "Sony IMX415", "registered": bool(bound), "streamingVerified": False}, "system": {**{key: os_fields[key] for key in ("ID", "VERSION_ID", "PRETTY_NAME") if key in os_fields}, "kernel": filesystem.text("/proc/sys/kernel/osrelease")}, "sdk": sdk, "deviceTree": tree, "i2c": i2c, "media": media, "vendorRosPrerequisites": prerequisites},
        "checks": checks, "blockingReasons": [check["name"] for check in checks if not check["passed"]], "readErrors": filesystem.errors, "executedCommands": [], "limitations": ["Device-tree declarations and driver bindings do not prove a connected or streaming camera.", "The preflight does not invoke SDK APIs, start capture, scan I2C, or access registers."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="/", help="Filesystem root; non-/ roots are explicitly marked fixtures.")
    parser.add_argument("--allow-unready-exit-zero", action="store_true", help="For collecting a probe receipt only; does not change readiness.")
    args = parser.parse_args(argv)
    try:
        report = collect_preflight(args.root)
    except (OSError, ValueError):
        print(json.dumps({"contract": SCHEMA, "ready": False, "error": "preflight_invalid_root"}))
        return 2
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    return 0 if args.allow_unready_exit_zero else 2


if __name__ == "__main__":
    raise SystemExit(main())
