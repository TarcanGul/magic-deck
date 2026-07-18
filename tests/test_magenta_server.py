import unittest

import numpy as np

from magenta_server import (
    DetectedKey,
    blend_style_vectors,
    build_conditioning,
    build_mrt_style_prompt,
    detect_key,
    frames_per_beat_for_bpm,
    pitch_classes_for_key,
    resolve_duration_seconds,
    resolve_stem_role,
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

    def test_build_mrt_style_prompt_can_include_stem_role(self):
        detected_key = DetectedKey(
            root_pitch_class=9,
            mode="minor",
            major_score=0.0,
            minor_score=1.0,
            confidence=1.0,
        )

        self.assertEqual(
            build_mrt_style_prompt("tech house", 128.0, detected_key, "bass"),
            "128 bpm bass stem, tech house in A minor",
        )

    def test_resolve_duration_seconds_for_4_bars(self):
        cases = [
            (80, 12.0),
            (120, 8.0),
            (160, 6.0),
        ]

        for bpm, expected_seconds in cases:
            with self.subTest(bpm=bpm):
                self.assertEqual(
                    resolve_duration_seconds(4, bpm),
                    expected_seconds,
                )

    def test_blend_style_vectors_uses_weighted_sum(self):
        blended = blend_style_vectors(
            np.array([[2.0, 0.0]], dtype=np.float32),
            np.array([0.0, 6.0], dtype=np.float32),
            1.0,
            3.0,
        )

        np.testing.assert_allclose(blended, np.array([0.5, 4.5], dtype=np.float32))

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

    def test_auto_stem_role_prefers_drums_for_sparse_reference(self):
        spectral = {"low": 0.6, "mid": 0.6, "high": 0.6}
        onset_density = np.full(16, 0.05, dtype=np.float32)
        beat_energy = np.full(16, 0.2, dtype=np.float32)

        self.assertEqual(resolve_stem_role("auto", spectral, onset_density, beat_energy), "drums")

    def test_auto_stem_role_prefers_bass_when_low_band_has_space(self):
        spectral = {"low": 0.05, "mid": 0.85, "high": 0.9}
        onset_density = np.full(16, 0.8, dtype=np.float32)
        beat_energy = np.full(16, 0.5, dtype=np.float32)

        self.assertEqual(resolve_stem_role("auto", spectral, onset_density, beat_energy), "bass")

    def test_build_conditioning_creates_four_bar_bass_phrase(self):
        chroma = np.zeros(12, dtype=np.float32)
        chroma[[0, 2, 3, 5, 7, 8, 10]] = 1.0
        analysis = {
            "total_beats": 16,
            "beat_energy": np.array([0.2, 0.8, 0.5, 0.3] * 4, dtype=np.float32),
            "onset_density": np.array([0.2, 0.7, 0.6, 0.2] * 4, dtype=np.float32),
            "pitch_classes": chroma,
            "detected_key": DetectedKey(
                root_pitch_class=0,
                mode="minor",
                major_score=0.0,
                minor_score=1.0,
                confidence=1.0,
            ),
            "spectral": {"low": 0.1, "mid": 0.8, "high": 0.8},
        }

        conditioning = build_conditioning(analysis, "bass")
        first_beat_notes = [note for note, value in enumerate(conditioning[0][0]) if value != -1]

        self.assertEqual(len(conditioning), 16)
        self.assertTrue(first_beat_notes)
        self.assertTrue(all(36 <= note <= 52 for note in first_beat_notes))
        self.assertTrue(all(len(notes) == 128 and len(drums) == 1 for notes, drums in conditioning))


if __name__ == "__main__":
    unittest.main()
