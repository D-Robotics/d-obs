#!/usr/bin/env python3
"""Filesystem/protocol fixtures; no connected board, camera or native SDK validation."""
import importlib.util
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("vision-x5-preflight.py")
spec = importlib.util.spec_from_file_location("vision_x5_preflight", SCRIPT)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="x5-preflight-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def write(self, logical, content):
        path = self.root / logical.lstrip("/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    def board(self):
        self.write("/sys/firmware/devicetree/base/model", b"D-Robotics RDK X5\0")
        self.write("/sys/firmware/devicetree/base/compatible", b"hobot,sunrise5\0")
        self.write("/etc/os-release", 'ID=ubuntu\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04 LTS"\nPRIVATE_TOKEN=do-not-project\n')
        self.write("/proc/sys/kernel/osrelease", "6.1.83-fixture")
        self.write("/etc/rdk_version", "3.5.1")

    def library(self, name="libcam.so", machine=183):
        header = bytearray(64)
        header[:4] = b"\x7fELF"; header[4] = 2; header[5] = 1
        header[18:20] = struct.pack("<H", machine)
        return self.write("/usr/lib/" + name, bytes(header))

    def sensor(self, bound=False):
        node = "/sys/firmware/devicetree/base/soc/i2c@1/imx415@1a"
        self.write(node + "/compatible", b"sony,imx415\0")
        self.write(node + "/reg", struct.pack(">I", 0x1a))
        self.write(node + "/status", b"okay\0")
        self.write(node + "/port/endpoint/data-lanes", struct.pack(">IIII", 1, 2, 3, 4))
        csi = "/sys/firmware/devicetree/base/soc/mipi-csi@0"
        self.write(csi + "/compatible", b"hobot,mipi-csi\0")
        self.write(csi + "/status", b"okay\0")
        self.write("/sys/class/i2c-adapter/i2c-1/name", "fixture-adapter")
        self.write("/sys/bus/i2c/devices/1-001a/name", "imx415")
        if bound:
            driver = self.root / "sys/bus/i2c/drivers/imx415"
            driver.mkdir(parents=True)
            (self.root / "sys/bus/i2c/devices/1-001a/driver").symlink_to("../../drivers/imx415")
        self.write("/sys/class/video4linux/video0/name", "fixture-vin")

    def test_empty_sysroot_is_explicitly_unready_without_host_fallback(self):
        result = preflight.collect_preflight(self.root)
        self.assertEqual(result["source"], "fixture-filesystem")
        self.assertFalse(result["ready"])
        self.assertFalse(result["hardwareVerified"])
        self.assertFalse(result["facts"]["board"]["identified"])
        self.assertIsNone(result["facts"]["system"]["kernel"])
        self.assertEqual(result["facts"]["sdk"]["libraries"], [])
        self.assertIn("native_sdk_files", result["blockingReasons"])

    def test_default_tuning_records_exact_file_hash_without_claiming_load_or_returning_contents(self):
        result = preflight.collect_preflight(self.root)
        self.assertFalse(result["facts"]["sdk"]["defaultTuningFiles"][0]["present"])
        raw = b'{"cproc":{"state":1},"private_test_marker":"do-not-project"}'
        self.write("/usr/hobot/lib/sensor/imx415_tuning.json", raw)
        record = preflight.collect_preflight(self.root)["facts"]["sdk"]["defaultTuningFiles"][0]
        self.assertEqual(record["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(record["bytes"], len(raw))
        self.assertTrue(record["jsonObject"])
        self.assertFalse(record["sdkLoadedVerified"])
        self.assertFalse(record["schemaVerified"])
        self.assertNotIn("do-not-project", json.dumps(record))
        self.write("/usr/hobot/lib/sensor/imx415_tuning.json", b'{"invalid":NaN}')
        self.assertFalse(preflight.collect_preflight(self.root)["facts"]["sdk"]["defaultTuningFiles"][0]["jsonObject"])

    def test_actual_fixture_versions_are_read_and_os_fields_are_allowlisted(self):
        self.board()
        result = preflight.collect_preflight(self.root)
        self.assertTrue(result["facts"]["board"]["identified"])
        self.assertEqual(result["facts"]["system"]["kernel"], "6.1.83-fixture")
        self.assertEqual(result["facts"]["system"]["VERSION_ID"], "22.04")
        self.assertEqual(result["facts"]["vendorRosPrerequisites"]["rdkosVersion"], "3.5.1")
        self.assertTrue(result["facts"]["vendorRosPrerequisites"]["rdkosSatisfied"])
        self.assertNotIn("do-not-project", json.dumps(result))
        self.assertIsNone(result["facts"]["sdk"]["version"])

    def test_legacy_tuning_location_is_hashed_without_claiming_sdk_load(self):
        raw = b'{"CP_1_2":{"contrast":1}}'
        self.write("/usr/hobot/bin/imx415_tuning.json", raw)
        rows = preflight.collect_preflight(self.root)["facts"]["sdk"]["defaultTuningFiles"]
        self.assertFalse(rows[0]["present"])
        self.assertTrue(rows[1]["present"])
        self.assertEqual(rows[1]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertFalse(rows[1]["sdkLoadedVerified"])

    def test_old_header_cannot_be_mistaken_for_native_adapter_compatibility(self):
        self.write("/usr/include/hbn_isp_api.h", "int hbn_isp_get_color_process_attr(void);\n/* int hbn_isp_get_ee_attr(void); */")
        facts = preflight.collect_preflight(self.root)["facts"]["sdk"]["nativeAdapterCompatibility"]
        self.assertEqual(facts["status"], "incompatible")
        self.assertIn("hbn_isp_get_ee_attr", facts["headers"][0]["missingRequiredApis"])
        self.assertFalse(facts["compiled"])
        self.assertFalse(facts["abiVerified"])

    def test_header_api_floor_is_not_a_compile_or_abi_success(self):
        self.write("/usr/include/vio/hbn_isp_api.h", "\n".join("int " + name + "(void);" for name in preflight.NATIVE_ISP_FLOOR))
        facts = preflight.collect_preflight(self.root)["facts"]["sdk"]["nativeAdapterCompatibility"]
        self.assertEqual(facts["status"], "unverified")
        self.assertEqual(facts["headers"][0]["missingRequiredApis"], [])
        self.assertFalse(facts["compiled"])
        self.assertFalse(facts["abiVerified"])

    def test_same_name_libraries_in_different_locations_require_link_verification(self):
        source = self.library("libvpf.so")
        self.write("/usr/hobot/lib/libvpf.so", source.read_bytes())
        facts = preflight.collect_preflight(self.root)["facts"]["sdk"]
        self.assertEqual(facts["duplicateLibraryNames"][0]["paths"], ["/usr/lib/libvpf.so", "/usr/hobot/lib/libvpf.so"])
        self.assertFalse(facts["duplicateLibraryNames"][0]["selectedLibraryVerified"])

    def test_vcon_properties_preserve_bus_and_rx_phy_without_guessing_camera_index(self):
        node = "/sys/firmware/devicetree/base/soc/cam/vcon@2"
        self.write(node + "/bus", struct.pack(">I", 4))
        self.write(node + "/rx_phy", struct.pack(">II", 1, 2))
        row = preflight.collect_preflight(self.root)["facts"]["deviceTree"]["csi"][0]["connectorProperties"]
        self.assertEqual(row["bus"], [4])
        self.assertEqual(row["rxPhy"], [1, 2])
        self.assertFalse(row["mappingVerified"])

    def test_dt_address_and_lanes_are_observed_without_claiming_connected_sensor(self):
        self.board(); self.sensor()
        result = preflight.collect_preflight(self.root)
        sensor = result["facts"]["deviceTree"]["sensors"][0]
        self.assertEqual(sensor["reg"], [0x1a])
        self.assertEqual(sensor["endpoints"][0]["dataLanes"], [1, 2, 3, 4])
        self.assertEqual(result["facts"]["i2c"]["clients"][0]["address"], "0x1a")
        self.assertFalse(result["facts"]["sensor"]["registered"])
        self.assertIn("imx415_driver_registered", result["blockingReasons"])
        self.assertFalse(result["facts"]["i2c"]["busScanned"])
        self.assertFalse(result["facts"]["i2c"]["registersAccessed"])

    def test_bound_driver_and_sdk_files_are_observations_not_frame_or_abi_proof(self):
        self.board(); self.sensor(bound=True); self.library()
        tuning = self.write("/usr/bin/tuning_tool", "#!/bin/sh\nexit 0\n")
        tuning.chmod(0o755)
        result = preflight.collect_preflight(self.root)
        self.assertTrue(result["facts"]["sensor"]["registered"])
        self.assertEqual(result["facts"]["i2c"]["clients"][0]["driver"], "imx415")
        self.assertTrue(result["facts"]["sdk"]["libraries"][0]["aarch64"])
        self.assertFalse(result["facts"]["sdk"]["libraries"][0]["loaded"])
        self.assertTrue(result["facts"]["sdk"]["tools"][0]["executableBit"])
        self.assertFalse(result["facts"]["sdk"]["tools"][0]["executed"])
        self.assertEqual(result["blockingReasons"], ["sdk_runtime_verified", "actual_frame_verified"])
        self.assertFalse(result["ready"])
        self.assertFalse(result["passed"])
        self.assertEqual(result["executedCommands"], [])

    def test_library_architecture_and_non_elf_placeholders_cannot_pass_sdk_observation(self):
        self.board(); self.library(machine=62)
        self.write("/usr/lib/libhbmem.so", "not an ELF library")
        result = preflight.collect_preflight(self.root)
        self.assertFalse(any(row["aarch64"] for row in result["facts"]["sdk"]["libraries"]))
        self.assertIn("native_sdk_files", result["blockingReasons"])

    def test_only_installed_package_versions_count_and_ros_versions_do_not_set_sdk_version(self):
        self.board()
        self.write("/var/lib/dpkg/status", "Package: tros-humble-mipi-cam\nStatus: install ok installed\nVersion: 2.4.1-1\nArchitecture: arm64\n\nPackage: tros-humble-hobot-stereonet\nStatus: deinstall ok config-files\nVersion: 2.4.9\n\nPackage: private-service\nStatus: install ok installed\nVersion: 99.9.9\nDescription: private data\n")
        result = preflight.collect_preflight(self.root)
        requirements = result["facts"]["vendorRosPrerequisites"]["packages"]
        self.assertTrue(requirements[0]["satisfied"])
        self.assertFalse(requirements[1]["satisfied"])
        self.assertIsNone(requirements[1]["installedVersion"])
        self.assertNotIn("private-service", json.dumps(result))
        self.assertIsNone(result["facts"]["sdk"]["version"])

    def test_conflicting_rdk_version_files_remain_unknown(self):
        self.board(); self.write("/etc/rdk-release", "VERSION=3.4.2")
        result = preflight.collect_preflight(self.root)
        self.assertIsNone(result["facts"]["vendorRosPrerequisites"]["rdkosVersion"])
        self.assertFalse(result["facts"]["vendorRosPrerequisites"]["rdkosSatisfied"])
        self.assertEqual(len(result["facts"]["vendorRosPrerequisites"]["rdkosVersionSources"]), 2)

    def test_multiversion_release_does_not_choose_a_kernel_version_as_rdkos(self):
        self.write("/etc/version", "Kernel=6.1.83 RDKOS=3.5.0")
        result = preflight.collect_preflight(self.root)
        self.assertIsNone(result["facts"]["vendorRosPrerequisites"]["rdkosVersion"])
        self.assertFalse(result["facts"]["vendorRosPrerequisites"]["rdkosSatisfied"])

    def test_tool_inventory_uses_exact_paths_even_when_bin_directory_is_large(self):
        for index in range(520):
            self.write("/usr/bin/a-fixture-" + str(index), "unrelated")
        self.write("/usr/bin/tuning_tool", "fixture").chmod(0o755)
        result = preflight.collect_preflight(self.root)
        self.assertEqual([tool["path"] for tool in result["facts"]["sdk"]["tools"]], ["/usr/bin/tuning_tool"])

    def test_different_sensor_address_is_not_assumed_to_match_module_address(self):
        self.board(); self.sensor(bound=True)
        (self.root / "sys/bus/i2c/devices/1-001a").rename(self.root / "sys/bus/i2c/devices/1-0020")
        result = preflight.collect_preflight(self.root)
        self.assertTrue(result["facts"]["sensor"]["registered"])
        self.assertIn("imx415_expected_i2c_address", result["blockingReasons"])

    def test_fixture_symlinks_cannot_read_host_files_or_libraries(self):
        self.board()
        with tempfile.TemporaryDirectory(prefix="x5-preflight-outside-") as other:
            sentinel = Path(other) / "private"
            sentinel.write_text("outside-root-secret")
            path = self.root / "usr/lib/libcam.so"
            path.parent.mkdir(parents=True)
            path.symlink_to(sentinel)
            (self.root / "etc/rdk-release").symlink_to(sentinel)
            result = preflight.collect_preflight(self.root)
        self.assertNotIn("outside-root-secret", json.dumps(result))
        self.assertEqual(result["facts"]["sdk"]["libraries"], [])
        self.assertTrue(any(error["reason"] == "unreadable_or_outside_root" for error in result["readErrors"]))

    def test_no_commands_register_devices_or_writes_are_used(self):
        self.board(); self.sensor(bound=True); self.library()
        original_open = Path.open
        opened = []
        def reading(path, mode="r", *args, **kwargs):
            self.assertNotIn("w", mode); self.assertNotIn("a", mode); self.assertNotIn("+", mode)
            self.assertTrue(path.is_relative_to(self.root.resolve()))
            self.assertNotIn("/dev/", str(path))
            opened.append(path)
            return original_open(path, mode, *args, **kwargs)
        with mock.patch.object(Path, "open", reading), mock.patch("subprocess.run", side_effect=AssertionError("command execution forbidden")), mock.patch("subprocess.Popen", side_effect=AssertionError("process execution forbidden")):
            result = preflight.collect_preflight(self.root)
        self.assertTrue(opened)
        self.assertEqual(result["executedCommands"], [])

    def test_cli_unready_exit_and_probe_collection_do_not_change_truth(self):
        for extra, exit_code in [([], 2), (["--allow-unready-exit-zero"], 0)]:
            run = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), *extra], capture_output=True, text=True)
            self.assertEqual(run.returncode, exit_code, run.stderr)
            report = json.loads(run.stdout)
            self.assertFalse(report["ready"])
            self.assertFalse(report["passed"])
            self.assertFalse(report["hardwareVerified"])
            self.assertEqual(report["source"], "fixture-filesystem")
            self.assertNotIn(str(self.root), run.stdout)

    def test_invalid_root_is_a_failed_receipt_and_path_traversal_is_rejected(self):
        run = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root / "missing")], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(run.stdout)["error"], "preflight_invalid_root")
        with self.assertRaisesRegex(ValueError, "invalid_logical_path"):
            preflight.ReadOnlyRoot(self.root).read("/../etc/passwd")


if __name__ == "__main__":
    unittest.main()
