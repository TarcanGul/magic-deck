import unittest

import numpy as np

from magenta_server import (
    DetectedKey,
    build_mrt_style_prompt,
    detect_key,
    frames_per_beat_for_bpm,
    pitch_classes_for_key,
    resolve_duration_seconds,
    validate_generation_weights,
)


class MagentaServerHelperTests(unittest.TestCase):
    def test_build_mrt_style_prompt_includes_bpm_prompt_and_key(self):
        detected_key = DetectedKey(
            root_pitch_class=9,
            mode="minor",
            major_score=0.0,
            minor_score=1.0,
            confidence=1.0,
        )

        self.assertEqual(
            build_mrt_style_prompt("tech house", 128.0, detected_key),
            "128 bpm tech house in A minor",
        )

    def test_resolve_duration_seconds_for_16_bars(self):
        cases = [
            (80, 48.0),
            (120, 32.0),
            (160, 24.0),
        ]

        for bpm, expected_seconds in cases:
            with self.subTest(bpm=bpm):
                self.assertEqual(
                    resolve_duration_seconds(16, bpm),
                    expected_seconds,
                )

    def test_rejects_audio_weight_outside_zero_to_one(self):
        for audio_weight in (-0.1, 1.1):
            with self.subTest(audio_weight=audio_weight):
                with self.assertRaisesRegex(Exception, "audio_weight must be between 0 and 1"):
                    validate_generation_weights(audio_weight, 1.0)

    def test_rejects_text_weight_outside_one_to_five(self):
        for text_weight in (0.9, 5.1):
            with self.subTest(text_weight=text_weight):
                with self.assertRaisesRegex(Exception, "text_weight must be between 1 and 5"):
                    validate_generation_weights(0.5, text_weight)

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
