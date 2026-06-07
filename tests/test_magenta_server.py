import unittest

import numpy as np

from magenta_server import (
    detect_key,
    frames_per_beat_for_bpm,
    pitch_classes_for_key,
    resolve_duration_seconds,
)


class MagentaServerHelperTests(unittest.TestCase):
    def test_resolve_duration_seconds_for_16_bars(self):
        cases = [
            (80, 48.0),
            (120, 32.0),
            (160, 24.0),
        ]

        for bpm, expected_seconds in cases:
            with self.subTest(bpm=bpm):
                self.assertEqual(
                    resolve_duration_seconds(None, 16, 4, bpm),
                    expected_seconds,
                )

    def test_frames_per_beat_changes_inversely_with_bpm(self):
        frames_at_80 = frames_per_beat_for_bpm(80)
        frames_at_120 = frames_per_beat_for_bpm(120)
        frames_at_160 = frames_per_beat_for_bpm(160)

        self.assertGreater(frames_at_80, 0)
        self.assertGreater(frames_at_120, 0)
        self.assertGreater(frames_at_160, 0)
        self.assertGreater(frames_at_80, frames_at_120)
        self.assertGreater(frames_at_120, frames_at_160)

    def test_pitch_classes_for_c_major_chroma(self):
        chroma = np.zeros(12, dtype=np.float32)
        chroma[[0, 2, 4, 5, 7, 9, 11]] = 1.0
        chroma[0] = 1.2

        detected_key = detect_key(chroma)

        self.assertEqual(detected_key.root_pitch_class, 0)
        self.assertEqual(detected_key.mode, "major")
        self.assertEqual(set(pitch_classes_for_key(detected_key, chroma)), {0, 2, 4, 5, 7, 9, 11})

    def test_pitch_classes_for_a_minor_chroma(self):
        chroma = np.zeros(12, dtype=np.float32)
        chroma[[9, 11, 0, 2, 4, 5, 7]] = 1.0
        chroma[9] = 1.2

        detected_key = detect_key(chroma)

        self.assertEqual(detected_key.root_pitch_class, 9)
        self.assertEqual(detected_key.mode, "minor")
        self.assertEqual(set(pitch_classes_for_key(detected_key, chroma)), {9, 11, 0, 2, 4, 5, 7})


if __name__ == "__main__":
    unittest.main()
