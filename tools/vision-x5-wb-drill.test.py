"""Unit tests for the classroom white-balance drill pure functions. Run: python3 vision-x5-wb-drill.test.py"""
import importlib.util
import io
import json
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("wb_drill", Path(__file__).parent / "vision-x5-wb-drill.py")
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


def png_bytes(pixels, size=(640, 480)):
    image = Image.new("RGB", size, pixels)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _encode(array):
    buffer = io.BytesIO()
    Image.fromarray(array).save(buffer, format="PNG")
    return buffer.getvalue()


class PaperRatioTests(unittest.TestCase):
    def test_neutral_paper_reads_unit_ratios(self):
        ratios = drill.paper_ratios(png_bytes((210, 210, 210)))
        self.assertTrue(ratios["usable"])
        self.assertEqual(ratios["BoverGMedian"], 1.0)
        self.assertEqual(ratios["RoverGMedian"], 1.0)
        self.assertGreater(ratios["paperPixels"], 100)

    def test_blue_tint_reads_boverg_above_one(self):
        neutral = drill.paper_ratios(png_bytes((200, 200, 200)))
        blue = drill.paper_ratios(png_bytes((190, 200, 230)))
        self.assertGreater(blue["BoverGMedian"], neutral["BoverGMedian"])
        self.assertLess(blue["RoverGMedian"], neutral["RoverGMedian"])

    def test_dark_scene_reports_unusable_instead_of_guessing(self):
        ratios = drill.paper_ratios(png_bytes((30, 30, 30)))
        self.assertFalse(ratios["usable"])
        self.assertIsNone(ratios["BoverGMedian"])


class BoundedAdjustTests(unittest.TestCase):
    def test_journal_step_applies_exactly(self):
        result = drill.bounded_adjust(2.6455078125, 1.0, 4.0, -0.25)
        self.assertAlmostEqual(result["to"], 2.3955078125)
        self.assertFalse(result["clamped"])

    def test_clamps_at_lower_bound(self):
        result = drill.bounded_adjust(1.1, 1.0, 4.0, -0.25)
        self.assertEqual(result["to"], 1.0)
        self.assertTrue(result["clamped"])
        self.assertTrue(result["withinBounds"])

    def test_rejects_non_numeric_and_inverted_bounds(self):
        with self.assertRaises(ValueError):
            drill.bounded_adjust("2.0", 1.0, 4.0, -0.25)
        with self.assertRaises(ValueError):
            drill.bounded_adjust(2.0, 4.0, 1.0, -0.25)


class SummarizeTests(unittest.TestCase):
    def ratios(self, blue):
        return {"usable": True, "BoverGMedian": blue, "RoverGMedian": 1.0, "paperPixels": 5000}

    def test_restore_within_drift_passes(self):
        summary = drill.summarize([
            {"label": "A1", "ratios": self.ratios(1.163)},
            {"label": "B", "ratios": self.ratios(1.011)},
            {"label": "A2", "ratios": self.ratios(1.166)},
        ])
        self.assertAlmostEqual(summary["table"]["B"]["driftFromA1"]["BoverG"], -0.152)
        self.assertTrue(summary["restoredWithinDrift"])

    def test_failed_restore_flags(self):
        summary = drill.summarize([
            {"label": "A1", "ratios": self.ratios(1.163)},
            {"label": "B", "ratios": self.ratios(1.011)},
            {"label": "A2", "ratios": self.ratios(1.05)},
        ])
        self.assertFalse(summary["restoredWithinDrift"])

    def test_unusable_baseline_rejected_but_unusable_candidate_recorded(self):
        with self.assertRaises(ValueError):
            drill.summarize([{"label": "A1", "ratios": {"usable": False}}, {"label": "B", "ratios": self.ratios(1.0)}])
        summary = drill.summarize([
            {"label": "A1", "ratios": self.ratios(1.163)},
            {"label": "B", "ratios": {"usable": False, "BoverGMedian": None}},
        ])
        self.assertIsNone(summary["table"]["B"]["driftFromA1"])


class BlueGainTests(unittest.TestCase):
    def test_locates_blue_gain_with_bounds(self):
        values = {"values": {"ae_mode": {"value": "auto"}, "wb_bgain": {"value": 2.6, "range": {"min": 1.0, "max": 4.0}}}}
        found = drill.pick_blue_gain(values)
        self.assertEqual(found["key"], "wb_bgain")
        self.assertEqual(found["low"], 1.0)

    def test_missing_bounds_or_key_raise(self):
        with self.assertRaises(ValueError):
            drill.pick_blue_gain({"values": {"wb_bgain": {"value": 2.6}}})
        with self.assertRaises(ValueError):
            drill.pick_blue_gain({"values": {"wb_rgain": {"value": 1.9, "range": {"min": 1.0, "max": 4.0}}}})

    def test_confirm_restore_compares_actual_values(self):
        before = {"values": {"wb_bgain": {"value": 2.6}}}
        self.assertTrue(drill.confirm_restore(before, {"values": {"wb_bgain": {"value": 2.6}}}, "wb_bgain"))
        self.assertFalse(drill.confirm_restore(before, {"values": {"wb_bgain": {"value": 2.4}}}, "wb_bgain"))


if __name__ == "__main__":
    unittest.main()
