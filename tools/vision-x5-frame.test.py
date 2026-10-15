#!/usr/bin/env python3
"""Deterministic conversion fixtures, not a hardware/camera acceptance test."""
import hashlib
import importlib.util
import json
import math
import random
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

MODULE = Path(__file__).with_name("vision-x5-frame.py")
spec = importlib.util.spec_from_file_location("vision_x5_frame", MODULE)
frame = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frame)


def png_rgb(data):
    """Independent PNG chunk/CRC/zlib decoder for this RGB8 fixture surface."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    offset = 8
    compressed = []
    dimensions = None
    while offset < len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        assert crc == zlib.crc32(kind + payload) & 0xFFFFFFFF
        if kind == b"IHDR":
            width, height, depth, color, compression, filters, interlace = struct.unpack(">IIBBBBB", payload)
            assert (depth, color, compression, filters, interlace) == (8, 2, 0, 0, 0)
            dimensions = (width, height)
        elif kind == b"IDAT":
            compressed.append(payload)
        offset += 12 + size
        if kind == b"IEND":
            assert offset == len(data)
            break
    width, height = dimensions
    pixels = zlib.decompress(b"".join(compressed))
    assert len(pixels) == height * (1 + width * 3)
    output = []
    for row in range(height):
        base = row * (1 + width * 3)
        assert pixels[base] == 0
        output.extend(tuple(pixels[base + 1 + column * 3:base + 4 + column * 3]) for column in range(width))
    return dimensions, output


class ConversionTests(unittest.TestCase):
    def convert(self, y, uv, **options):
        parameters = dict(width=2, height=2, y_stride=2, uv_stride=2, matrix="bt601", color_range="limited")
        parameters.update(options)
        return png_rgb(frame.nv12_to_png(y, uv, **parameters))

    def test_limited_black_white_and_full_range_gray_are_distinct(self):
        self.assertEqual(self.convert(bytes([16, 235, 16, 235]), bytes([128, 128]))[1], [(0, 0, 0), (255, 255, 255)] * 2)
        self.assertEqual(self.convert(bytes([16] * 4), bytes([128, 128]), color_range="full")[1], [(16, 16, 16)] * 4)

    def test_uv_order_and_chroma_blocks_preserve_red_blue_and_row_padding(self):
        y = bytes([81, 81, 41, 41, 123, 123, 81, 81, 41, 41, 255, 255])
        uv = bytes([90, 240, 240, 110, 15, 16])
        dimensions, pixels = self.convert(y, uv, width=4, y_stride=6, uv_stride=6)
        self.assertEqual(dimensions, (4, 2))
        self.assertEqual(pixels, [(254, 0, 0), (254, 0, 0), (0, 0, 255), (0, 0, 255)] * 2)

    def test_bt601_and_bt709_match_independent_float_equations_to_one_code_value(self):
        for matrix, kr, kb in (("bt601", .299, .114), ("bt709", .2126, .0722)):
            for quantization in ("limited", "full"):
                for y, u, v in ((90, 100, 180), (16, 240, 16), (235, 16, 240), (128, 128, 128)):
                    luminance = (y - 16) * 255 / 219 if quantization == "limited" else y
                    cb, cr = ((u - 128) * 255 / 224, (v - 128) * 255 / 224) if quantization == "limited" else (u - 128, v - 128)
                    expected = [luminance + 2 * (1 - kr) * cr,
                                luminance - 2 * kb * (1 - kb) / (1 - kr - kb) * cb - 2 * kr * (1 - kr) / (1 - kr - kb) * cr,
                                luminance + 2 * (1 - kb) * cb]
                    expected = [min(255, max(0, math.floor(value + .5))) for value in expected]
                    actual = self.convert(bytes([y] * 4), bytes([u, v]), matrix=matrix, color_range=quantization)[1][0]
                    self.assertTrue(all(abs(a - b) <= 1 for a, b in zip(actual, expected)))
        rgb601 = self.convert(bytes([90] * 4), bytes([100, 180]), matrix="bt601")[1]
        rgb709 = self.convert(bytes([90] * 4), bytes([100, 180]), matrix="bt709")[1]
        self.assertNotEqual(rgb601, rgb709)

    def test_chroma_row_selection_is_420_not_reused_for_all_rows(self):
        _, pixels = self.convert(bytes([81] * 8), bytes([90, 240, 128, 128]), height=4)
        self.assertEqual(pixels[:4], [(254, 0, 0)] * 4)
        self.assertEqual(pixels[4:], [(76, 76, 76)] * 4)

    def test_dimensions_exact_plane_bytes_and_explicit_colour_are_required(self):
        for y, uv, options in ((b"\x10" * 3, b"\x80" * 2, {}), (b"\x10" * 5, b"\x80" * 2, {}),
                               (b"\x10" * 4, b"\x80" * 3, {}), (b"\x10" * 4, b"\x80" * 2, {"y_stride": 1}),
                               (b"\x10" * 4, b"\x80" * 2, {"width": 3}), (b"", b"", {"width": 8192, "height": 8192}),
                               (b"\x10" * 4, b"\x80" * 2, {"matrix": "auto"}), (b"\x10" * 4, b"\x80" * 2, {"color_range": None}),
                               (b"", b"", {"y_stride": 96 * 1024 * 1024}), (b"", b"", {"width": True})):
            with self.assertRaises(frame.FrameError):
                self.convert(y, uv, **options)
        with self.assertRaises(TypeError):
            frame.nv12_to_png(b"\x10" * 4, b"\x80" * 2, width=2, height=2, y_stride=2, uv_stride=2)

    def test_saved_png_has_real_size_and_hash_without_hardware_or_quality_promotion(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "frame.png"
            metadata = frame.save_nv12_png(bytes([16] * 4), bytes([128, 128]), output_path=output,
                                             width=2, height=2, y_stride=2, uv_stride=2, matrix="bt709", color_range="limited")
            self.assertEqual(metadata["sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
            self.assertEqual(metadata["bytes"], output.stat().st_size)
            self.assertEqual(png_rgb(output.read_bytes())[0], (2, 2))
            self.assertEqual(metadata["hardwareVerification"], "unverified")
            self.assertEqual(metadata["colorAccuracy"], "not_calibrated")
            with self.assertRaises(FileExistsError):
                frame.save_nv12_png(bytes([16] * 4), bytes([128, 128]), output_path=output,
                                     width=2, height=2, y_stride=2, uv_stride=2, matrix="bt709", color_range="limited")

    def test_raw_alignment_endian_and_padding_produce_identical_unpacked_samples(self):
        values = [0, 1, 511, 1023]
        expected = struct.pack("<4H", *values)
        for alignment in ("left", "right"):
            for endian in ("little", "big"):
                words = [value << 6 if alignment == "left" else value for value in values]
                format_string = "<2H" if endian == "little" else ">2H"
                data = struct.pack(format_string, *words[:2]) + b"pad!" + struct.pack(format_string, *words[2:]) + b"more"
                actual = frame.raw16_container_to_unpacked16le(data, width=2, height=2, stride=8,
                                                               bit_depth=10, alignment=alignment, byteorder=endian)
                self.assertEqual(actual, expected)

    def test_raw_invalid_samples_are_rejected_instead_of_masked_or_guessed(self):
        for values, options in (([0, 0, 1024, 0], {}), ([0, 0, 65535, 0], {}),
                                ([0, 0, 65, 0], {"alignment": "left"}), ([0] * 4, {"alignment": "auto"}),
                                ([0] * 4, {"byteorder": "native"}), ([0] * 4, {"bit_depth": 9}),
                                ([0] * 4, {"stride": 3})):
            parameters = dict(width=2, height=2, stride=4, bit_depth=10, alignment="right", byteorder="little")
            parameters.update(options)
            with self.assertRaises(frame.FrameError):
                frame.raw16_container_to_unpacked16le(struct.pack("<4H", *values), **parameters)
        with self.assertRaises(frame.FrameError):
            frame.raw16_container_to_unpacked16le(b"\0" * 7, width=2, height=2, stride=4,
                                                   bit_depth=10, alignment="right", byteorder="little")

    def test_every_declared_raw_depth_preserves_zero_and_maximum_sample(self):
        for depth in (8, 10, 12, 14, 16):
            values = [0, 1, (1 << depth) - 2, (1 << depth) - 1]
            for alignment in ("left", "right"):
                words = [value << (16 - depth) if alignment == "left" else value for value in values]
                result = frame.raw16_container_to_unpacked16le(struct.pack("<4H", *words), width=2, height=2,
                                                                stride=4, bit_depth=depth, alignment=alignment, byteorder="little")
                self.assertEqual(result, struct.pack("<4H", *values))

    def test_cli_uses_explicit_layout_and_emits_only_conversion_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "y.bin").write_bytes(bytes([16] * 4))
            (root / "uv.bin").write_bytes(bytes([128, 128]))
            result = subprocess.run([sys.executable, str(MODULE), "nv12", "--width", "2", "--height", "2",
                                     "--y-input", str(root / "y.bin"), "--uv-input", str(root / "uv.bin"),
                                     "--y-stride", "2", "--uv-stride", "2", "--matrix", "bt601", "--range", "limited",
                                     "--output", str(root / "output.png")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertTrue(receipt["ok"])
            self.assertEqual(receipt["hardwareVerification"], "unverified")
            self.assertNotIn(temporary, result.stdout)
            (root / "raw.bin").write_bytes(struct.pack(">4H", 0, 64, 128, 65472))
            result = subprocess.run([sys.executable, str(MODULE), "raw16", "--width", "2", "--height", "2",
                                     "--input", str(root / "raw.bin"), "--stride", "4", "--bit-depth", "10",
                                     "--alignment", "left", "--byteorder", "big", "--output", str(root / "output.raw")],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "output.raw").read_bytes(), struct.pack("<4H", 0, 1, 2, 1023))
            self.assertEqual(json.loads(result.stdout)["packing"], "unpacked16le")

    def test_invalid_cli_raw_emits_specific_failure_and_does_not_create_an_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "bad.raw").write_bytes(struct.pack("<4H", 0, 0, 1024, 0))
            result = subprocess.run([sys.executable, str(MODULE), "raw16", "--width", "2", "--height", "2",
                                     "--input", str(root / "bad.raw"), "--stride", "4", "--bit-depth", "10",
                                     "--alignment", "right", "--byteorder", "little", "--output", str(root / "rejected.raw")],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "vision_x5_frame_raw_pixel_out_of_range"})
            self.assertEqual(result.stderr, "")
            self.assertFalse((root / "rejected.raw").exists())
            self.assertNotIn(temporary, result.stdout)


class AccelerationTests(unittest.TestCase):
    def test_numpy_path_is_pixel_exact_with_portable_path_for_padded_color_planes(self):
        if frame._optional_numpy() is None:
            self.skipTest("optional NumPy is unavailable; portable conversion remains supported")
        rng = random.Random(415)
        width, height, stride = 30, 18, 36
        y = rng.randbytes(stride * height)
        uv = rng.randbytes(stride * height // 2)
        for matrix in ("bt601", "bt709"):
            for color_range in ("full", "limited"):
                args = dict(width=width, height=height, y_stride=stride, uv_stride=stride, matrix=matrix, color_range=color_range)
                self.assertEqual(frame.nv12_to_png(y, uv, **args, _accelerated=True), frame.nv12_to_png(y, uv, **args, _accelerated=False))

    def test_numpy_raw_path_matches_portable_alignment_endian_and_padding(self):
        if frame._optional_numpy() is None:
            self.skipTest("optional NumPy is unavailable; portable conversion remains supported")
        rng = random.Random(415)
        for depth in (8, 10, 12, 14, 16):
            words = [rng.randrange(1 << depth) for _ in range(32)]
            for alignment in ("left", "right"):
                samples = [word << (16 - depth) if alignment == "left" else word for word in words]
                for byteorder, prefix in (("little", "<"), ("big", ">")):
                    data = b"".join(struct.pack(prefix + "8H", *samples[row:row + 8]) + b"pad!" for row in range(0, 32, 8))
                    args = dict(width=8, height=4, stride=20, bit_depth=depth, alignment=alignment, byteorder=byteorder)
                    self.assertEqual(frame.raw16_container_to_unpacked16le(data, **args, _accelerated=True),
                                     frame.raw16_container_to_unpacked16le(data, **args, _accelerated=False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
