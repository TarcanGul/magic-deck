import asyncio
import io
import unittest
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException, UploadFile

from magenta_server import (
    DetectedKey,
    AubioUnavailableError,
    blend_style_vectors,
    build_conditioning,
    build_mrt_style_prompt,
    detect_key,
    detect_bpm,
    detect_bpm_from_file,
    embed_musiccoca_styles,
    frames_per_beat_for_bpm,
    normalize_to_full_scale,
    pitch_classes_for_key,
    post_process_generation,
    resolve_duration_seconds,
    resolve_stem_role,
)


class FakeAubio:
    def __init__(self, bpms, confidence=0.8):
        self.bpms = list(bpms)
        self.confidence = confidence

    def source(self, path, sample_rate, hop_size):
        class Source:
            samplerate = 48_000

            def __init__(self):
                self.calls = 0

            def __call__(self):
                self.calls += 1
                frames = hop_size if self.calls <= len(self_bpms) else 0
                return np.zeros(hop_size, dtype=np.float32), frames

        self_bpms = self.bpms
        return Source()

    def tempo(self, method, window_size, hop_size, sample_rate):
        class Tempo:
            def __init__(self):
                self.index = -1

            def __call__(self, samples):
                self.index += 1
                return self.index < len(self_bpms)

            def get_bpm(self):
                return self_bpms[self.index]

            def get_confidence(self):
                return self_confidence

        self_bpms = self.bpms
        self_confidence = self.confidence
        return Tempo()


class MagentaServerHelperTests(unittest.TestCase):
    def test_aubio_bpm_detection_returns_reliable_tempo(self):
        result = detect_bpm_from_file("track.wav", FakeAubio([119.8, 120.1, 120.0], 0.82))

        self.assertEqual(result, {"bpm": 120.0, "confidence": 0.82, "reliable": True})

    def test_aubio_bpm_detection_preserves_low_confidence_estimate(self):
        result = detect_bpm_from_file("track.wav", FakeAubio([127.9, 128.1], 0.31))

        self.assertEqual(result, {"bpm": 128.0, "confidence": 0.31, "reliable": False})

    def test_aubio_bpm_detection_returns_no_tempo_without_enough_beats(self):
        result = detect_bpm_from_file("track.wav", FakeAubio([120.0], 0.9))

        self.assertEqual(result, {"bpm": None, "confidence": 0.0, "reliable": False})

    def test_aubio_bpm_detection_rejects_unreadable_audio(self):
        class InvalidAubio:
            def source(self, path, sample_rate, hop_size):
                raise RuntimeError("invalid audio")

        upload = UploadFile(filename="broken.audio", file=io.BytesIO(b"not audio"))
        with patch("magenta_server.get_aubio_runtime", return_value=InvalidAubio()):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(detect_bpm(upload))

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Could not read audio file", raised.exception.detail)

    def test_aubio_unavailable_has_distinct_error(self):
        upload = UploadFile(filename="track.wav", file=io.BytesIO(b"audio"))
        with patch("magenta_server.get_aubio_runtime", side_effect=AubioUnavailableError("not installed")):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(detect_bpm(upload))

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Aubio BPM detection unavailable", raised.exception.detail)

    def test_embed_musiccoca_styles_uses_joint_model_without_mapper(self):
        audio_prompt = object()

        class FakeMusicCoCa:
            def __init__(self):
                self.calls = []

            def embed(self, prompts, **kwargs):
                self.calls.append((prompts, kwargs))
                return np.array([[3.0, 4.0], [5.0, 12.0]], dtype=np.float32)

        style_model = FakeMusicCoCa()
        audio_style, text_style = embed_musiccoca_styles(
            style_model,
            audio_prompt,
            "128 bpm tech house in A minor",
        )

        self.assertEqual(
            style_model.calls,
            [([audio_prompt, "128 bpm tech house in A minor"], {"use_mapper": False})],
        )
        np.testing.assert_array_equal(audio_style, np.array([3.0, 4.0], dtype=np.float32))
        np.testing.assert_array_equal(text_style, np.array([5.0, 12.0], dtype=np.float32))

    def test_embed_musiccoca_styles_rejects_non_batched_result(self):
        class FakeMusicCoCa:
            def embed(self, prompts, **kwargs):
                return np.array([3.0, 4.0], dtype=np.float32)

        with self.assertRaisesRegex(ValueError, "shape \\(2, embedding_dim\\)"):
            embed_musiccoca_styles(FakeMusicCoCa(), object(), "tech house")

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

    def test_blend_style_vectors_uses_arithmetic_midpoint(self):
        blended = blend_style_vectors(
            np.array([[2.0, 0.0]], dtype=np.float32),
            np.array([0.0, 6.0], dtype=np.float32),
        )

        np.testing.assert_allclose(blended, np.array([1.0, 3.0], dtype=np.float32))

    def test_frames_per_beat_changes_inversely_with_bpm(self):
        frames_at_80 = frames_per_beat_for_bpm(80)
        frames_at_120 = frames_per_beat_for_bpm(120)
        frames_at_160 = frames_per_beat_for_bpm(160)

        self.assertGreater(frames_at_80, 0)
        self.assertGreater(frames_at_120, 0)
        self.assertGreater(frames_at_160, 0)
        self.assertGreater(frames_at_80, frames_at_120)
        self.assertGreater(frames_at_120, frames_at_160)

    def test_full_scale_normalization_amplifies_quiet_signal(self):
        samples = np.array([[0.05], [-0.25], [0.10]], dtype=np.float32)

        normalized = normalize_to_full_scale(samples)

        self.assertAlmostEqual(float(np.max(np.abs(normalized))), 1.0)
        np.testing.assert_allclose(normalized[:, 0], np.array([0.2, -1.0, 0.4], dtype=np.float32))

    def test_full_scale_normalization_attenuates_over_range_signal(self):
        samples = np.array([[2.0], [-4.0], [1.0]], dtype=np.float32)

        normalized = normalize_to_full_scale(samples)

        self.assertAlmostEqual(float(np.max(np.abs(normalized))), 1.0)
        np.testing.assert_allclose(normalized[:, 0], np.array([0.5, -1.0, 0.25], dtype=np.float32))

    def test_full_scale_normalization_preserves_stereo_balance(self):
        samples = np.array(
            [
                [0.125, 0.25],
                [-0.25, -0.50],
            ],
            dtype=np.float32,
        )

        normalized = normalize_to_full_scale(samples)

        np.testing.assert_allclose(normalized, samples * 2.0)
        np.testing.assert_allclose(normalized[:, 0], normalized[:, 1] * 0.5)

    def test_full_scale_normalization_leaves_silence_finite(self):
        samples = np.zeros((8, 2), dtype=np.float32)

        normalized = normalize_to_full_scale(samples)

        np.testing.assert_array_equal(normalized, samples)
        self.assertTrue(np.all(np.isfinite(normalized)))

    def test_post_processing_returns_exact_duration_at_full_scale(self):
        samples = np.array(
            [[0.1], [0.2], [-0.4], [0.3], [0.1], [-0.2]],
            dtype=np.float32,
        )
        sample_rate = 100
        duration_seconds = 0.1

        processed = post_process_generation(
            samples,
            sample_rate,
            np.zeros_like(samples),
            duration_seconds,
            avoid_clash=False,
        )

        self.assertEqual(processed.shape, (10, 1))
        self.assertAlmostEqual(float(np.max(np.abs(processed))), 1.0)

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
