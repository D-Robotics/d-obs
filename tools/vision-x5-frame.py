#!/usr/bin/env python3
"""Explicit linear NV12/RAW16 conversion; no camera or ISP success is inferred.

NV12 layout and Y'CbCr coefficients:
https://docs.kernel.org/userspace-api/media/v4l/pixfmt-yuv-planar.html
https://docs.kernel.org/userspace-api/media/v4l/colorspaces-details.html
RGB samples retain the input transfer function. No calibrated colour accuracy,
HDR conversion, chroma resiting or sRGB profile is asserted.
"""
import argparse
import hashlib
import json
import os
import struct
import zlib

MAX_PIXELS = 32 * 1024 * 1024
MAX_PLANE_BYTES = 96 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_numpy = False


def _optional_numpy():
    global _numpy
    if _numpy is False:
        try:
            import numpy
            _numpy = numpy
        except ImportError:
            _numpy = None
    return _numpy


class FrameError(ValueError):
    pass


def _integer(value, minimum, maximum, name):
    if type(value) is not int or not minimum <= value <= maximum:
        raise FrameError("vision_x5_frame_invalid_" + name)
    return value


def _shape(width, height):
    _integer(width, 2, 16384, "width")
    _integer(height, 2, 16384, "height")
    if width % 2 or height % 2 or width * height > MAX_PIXELS:
        raise FrameError("vision_x5_frame_invalid_dimensions")


def _plane(data, stride, rows, row_bytes):
    _integer(stride, row_bytes, MAX_PLANE_BYTES, "stride")
    expected = stride * rows
    if expected > MAX_PLANE_BYTES:
        raise FrameError("vision_x5_frame_plane_limit")
    if not isinstance(data, bytes) or len(data) != expected:
        raise FrameError("vision_x5_frame_plane_length_mismatch")


def _chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def _nv12_tables(matrix, color_range):
    if matrix not in ("bt601", "bt709") or color_range not in ("limited", "full"):
        raise FrameError("vision_x5_frame_explicit_color_parameters_required")
    kr, kb = (0.299, 0.114) if matrix == "bt601" else (0.2126, 0.0722)
    kg = 1 - kr - kb
    y_scale, c_scale, offset = (255 / 219, 255 / 224, 16) if color_range == "limited" else (1, 1, 0)
    scale = 1 << 16
    coefficients = [round(value * scale) for value in (
        y_scale, 2 * (1 - kr) * c_scale, 2 * (1 - kb) * c_scale,
        -2 * kb * (1 - kb) / kg * c_scale, -2 * kr * (1 - kr) / kg * c_scale,
    )]
    yc, rc, bc, gu, gv = coefficients
    return ([int((value - offset) * yc) for value in range(256)],
            [(value - 128) * rc for value in range(256)],
            [(value - 128) * bc for value in range(256)],
            [(value - 128) * gu for value in range(256)],
            [(value - 128) * gv for value in range(256)])


def nv12_to_png(y_plane: bytes, uv_plane: bytes, *, width: int, height: int,
                y_stride: int, uv_stride: int, matrix: str, color_range: str, _accelerated=True) -> bytes:
    """Convert linear 8-bit NV12 (Cb then Cr), using explicit strides and colour.

    Each plane has exactly stride * effective plane height bytes. Row padding is
    ignored, not required to be zero. Separate planes avoid guessing DMA offsets.
    Chroma is replicated over its corresponding 2x2 luma block. Tiled formats,
    NV21, P010 and unknown quantization are not detected or silently substituted.
    """
    _shape(width, height)
    _plane(y_plane, y_stride, height, width)
    _plane(uv_plane, uv_stride, height // 2, width)
    y_table, r_table, b_table, gu_table, gv_table = _nv12_tables(matrix, color_range)
    np = _optional_numpy() if _accelerated else None
    if np is not None:
        tables = [np.asarray(table, dtype=np.int32) for table in (y_table, r_table, b_table, gu_table, gv_table)]
    compressor = zlib.compressobj(6)
    compressed = []
    for row in range(height):
        y_offset = row * y_stride
        uv_offset = (row // 2) * uv_stride
        if np is not None:
            # Row vectors keep peak memory bounded. Use exactly the integer
            # coefficients/rounding of the portable path, not a library's
            # implicit color matrix or range.
            y = tables[0][np.frombuffer(y_plane, dtype=np.uint8, count=width, offset=y_offset)]
            uv = np.frombuffer(uv_plane, dtype=np.uint8, count=width, offset=uv_offset)
            u, v = np.repeat(uv[::2], 2), np.repeat(uv[1::2], 2)
            rgb = np.stack(((y + tables[1][v] + 32768) >> 16,
                            (y + tables[3][u] + tables[4][v] + 32768) >> 16,
                            (y + tables[2][u] + 32768) >> 16), axis=1)
            compressed.append(compressor.compress(b"\x00" + np.clip(rgb, 0, 255).astype(np.uint8).tobytes()))
            continue
        scanline = bytearray(1 + width * 3)  # PNG filter 0, followed by RGB8.
        for column in range(0, width, 2):
            u, v = uv_plane[uv_offset + column], uv_plane[uv_offset + column + 1]
            r_add, b_add = r_table[v], b_table[u]
            g_add = gu_table[u] + gv_table[v]
            for pixel in (column, column + 1):
                y = y_table[y_plane[y_offset + pixel]]
                offset = 1 + pixel * 3
                scanline[offset] = min(255, max(0, (y + r_add + 32768) >> 16))
                scanline[offset + 1] = min(255, max(0, (y + g_add + 32768) >> 16))
                scanline[offset + 2] = min(255, max(0, (y + b_add + 32768) >> 16))
        compressed.append(compressor.compress(scanline))
    compressed.append(compressor.flush())
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", b"".join(compressed)) + _chunk(b"IEND", b"")


def raw16_container_to_unpacked16le(data: bytes, *, width: int, height: int,
                                    stride: int, bit_depth: int, alignment: str,
                                    byteorder: str, _accelerated=True) -> bytes:
    """Remove padding from an explicitly described 16-bit Bayer sample container.

    This accepts already unpacked 16-bit words, never MIPI packed RAW10/RAW12.
    HBN container alignment and byte order must come from the actual SDK mode.
    Right alignment rejects nonzero high bits; left rejects unused nonzero low
    bits. Values are validated before conversion instead of masked into range.
    """
    _shape(width, height)
    if bit_depth not in (8, 10, 12, 14, 16) or type(bit_depth) is not int:
        raise FrameError("vision_x5_frame_invalid_bit_depth")
    if alignment not in ("right", "left") or byteorder not in ("little", "big"):
        raise FrameError("vision_x5_frame_explicit_raw_layout_required")
    _plane(data, stride, height, width * 2)
    shift = 16 - bit_depth
    mask = (1 << bit_depth) - 1
    unused_mask = (1 << shift) - 1
    little = byteorder == "little"
    np = _optional_numpy() if _accelerated else None
    output = bytearray(width * height * 2)
    destination = 0
    for row in range(height):
        base = row * stride
        if np is not None:
            samples = np.frombuffer(data, dtype="<u2" if little else ">u2", count=width, offset=base)
            if alignment == "left":
                if (samples & unused_mask).any():
                    raise FrameError("vision_x5_frame_raw_alignment_mismatch")
                samples = samples >> shift
            if (samples > mask).any():
                raise FrameError("vision_x5_frame_raw_pixel_out_of_range")
            output[destination:destination + width * 2] = samples.astype("<u2").tobytes()
            destination += width * 2
            continue
        for column in range(width):
            index = base + column * 2
            value = data[index] | (data[index + 1] << 8) if little else (data[index] << 8) | data[index + 1]
            if alignment == "left":
                if value & unused_mask:
                    raise FrameError("vision_x5_frame_raw_alignment_mismatch")
                value >>= shift
            if value > mask:
                raise FrameError("vision_x5_frame_raw_pixel_out_of_range")
            output[destination] = value & 255
            output[destination + 1] = value >> 8
            destination += 2
    return bytes(output)


def _save(data, output_path):
    # Generated job outputs are new files; a failed conversion cannot replace an
    # earlier artifact, and existing paths/symlinks are not followed for writing.
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


def save_nv12_png(y_plane: bytes, uv_plane: bytes, *, output_path,
                   width: int, height: int, y_stride: int, uv_stride: int,
                   matrix: str, color_range: str) -> dict:
    png = nv12_to_png(y_plane, uv_plane, width=width, height=height,
                       y_stride=y_stride, uv_stride=uv_stride, matrix=matrix,
                       color_range=color_range)
    _save(png, output_path)
    return {"width": width, "height": height, "mimeType": "image/png", "sha256": hashlib.sha256(png).hexdigest(),
            "bytes": len(png), "sourceFormat": "NV12", "yStride": y_stride, "uvStride": uv_stride,
            "colorMatrix": matrix, "colorRange": color_range, "chromaReconstruction": "2x2-block-replication",
            "yPlaneSha256": hashlib.sha256(y_plane).hexdigest(), "uvPlaneSha256": hashlib.sha256(uv_plane).hexdigest(),
            "verification": "conversion_only", "hardwareVerification": "unverified", "colorAccuracy": "not_calibrated"}


def _read_exact(filename, expected):
    if expected > MAX_PLANE_BYTES:
        raise FrameError("vision_x5_frame_plane_limit")
    with open(filename, "rb") as stream:
        data = stream.read(expected + 1)
    if len(data) != expected:
        raise FrameError("vision_x5_frame_plane_length_mismatch")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    nv12 = commands.add_parser("nv12")
    raw = commands.add_parser("raw16")
    for command in (nv12, raw):
        command.add_argument("--width", type=int, required=True)
        command.add_argument("--height", type=int, required=True)
        command.add_argument("--output", required=True)
    nv12.add_argument("--y-input", required=True)
    nv12.add_argument("--uv-input", required=True)
    nv12.add_argument("--y-stride", type=int, required=True)
    nv12.add_argument("--uv-stride", type=int, required=True)
    nv12.add_argument("--matrix", choices=("bt601", "bt709"), required=True)
    nv12.add_argument("--range", dest="color_range", choices=("limited", "full"), required=True)
    raw.add_argument("--input", required=True)
    raw.add_argument("--stride", type=int, required=True)
    raw.add_argument("--bit-depth", type=int, required=True)
    raw.add_argument("--alignment", choices=("right", "left"), required=True)
    raw.add_argument("--byteorder", choices=("little", "big"), required=True)
    args = parser.parse_args(argv)
    try:
        _shape(args.width, args.height)
        if args.operation == "nv12":
            _integer(args.y_stride, args.width, MAX_PLANE_BYTES, "stride")
            _integer(args.uv_stride, args.width, MAX_PLANE_BYTES, "stride")
            result = save_nv12_png(_read_exact(args.y_input, args.y_stride * args.height),
                                    _read_exact(args.uv_input, args.uv_stride * (args.height // 2)),
                                    output_path=args.output, width=args.width, height=args.height,
                                    y_stride=args.y_stride, uv_stride=args.uv_stride,
                                    matrix=args.matrix, color_range=args.color_range)
        else:
            _integer(args.stride, args.width * 2, MAX_PLANE_BYTES, "stride")
            data = _read_exact(args.input, args.stride * args.height)
            output = raw16_container_to_unpacked16le(data, width=args.width, height=args.height,
                                                     stride=args.stride, bit_depth=args.bit_depth,
                                                     alignment=args.alignment, byteorder=args.byteorder)
            _save(output, args.output)
            result = {"width": args.width, "height": args.height, "stride": args.width * 2,
                      "bitDepth": args.bit_depth, "packing": "unpacked16le", "sha256": hashlib.sha256(output).hexdigest(),
                      "sourceSha256": hashlib.sha256(data).hexdigest(), "bytes": len(output),
                      "containerAlignment": args.alignment, "containerByteorder": args.byteorder,
                      "verification": "conversion_only", "hardwareVerification": "unverified"}
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
        return 0
    except FrameError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    except OSError:
        # No bytes, device paths, credentials or unredacted OS errors in receipts.
        print(json.dumps({"ok": False, "error": "vision_x5_frame_conversion_failed"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
