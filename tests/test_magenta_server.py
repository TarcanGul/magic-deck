import asyncio
import io
import shutil
import unittest
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException, UploadFile

from magenta_server import (
    DetectedKey,
    AubioUnavailableError,
    OnsetAlignment,
    TimingDiagnostics,
    add_confident_subdivision_anchors,
    align_reference_capture,
    analyze_onset_alignment,
    blend_style_vectors,
    build_beat_time_map,
    build_conditioning,
    build_mrt_style_prompt,
    correct_generation_timing,
    detect_key,
    detect_bpm,
    detect_bpm_from_file,
    embed_musiccoca_styles,
    frames_per_beat_for_bpm,
    generate,
    generate_conditioned_chunks,
    model_frame_boundaries,
    model_frame_schedule,
    normalize_to_full_scale,
    onset_alignment_improves,
    pitch_classes_for_key,
    post_process_generation,
    resolve_duration_seconds,
    resolve_stem_role,
    timing_response_headers,
    validate_sampling_parameters,
)


class FakeAubio:
    def __init__(self, bpms, confidence=0.8):
        self.bpms = list(bpms)
        self.confidences = (
            list(confidence)
            if isinstance(confidence, (list, tuple))
            else [confidence] * len(self.bpms)
        )

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
                return self_confidences[self.index]

        self_bpms = self.bpms
        self_confidences = self.confidences
        return Tempo()


class MagentaServerHelperTests(unittest.TestCase):
    @staticmethod
    def synthetic_capture(
        bpm=120,
        sample_rate=8_000,
        offset_seconds=0.17,
        downbeat_phase=0,
        downbeat_gain=1.0,
        beat_gain=0.25,
    ):
        samples_per_beat = sample_rate * 60.0 / bpm
        total_samples = int(round(5 * 4 * samples_per_beat))
        samples = np.zeros((total_samples, 1), dtype=np.float32)
        offset_samples = int(round(offset_seconds * sample_rate))
        window = np.hanning(160).astype(np.float32)[:80]
        for beat in range(20):
            position = int(round(offset_samples + (beat * samples_per_beat)))
            if position >= total_samples:
                break
            gain = downbeat_gain if beat % 4 == downbeat_phase else beat_gain
            length = min(len(window), total_samples - position)
            samples[position:position + length, 0] += gain * window[:length]
        return samples, offset_samples

    def test_aubio_bpm_detection_returns_reliable_tempo(self):
        result = detect_bpm_from_file("track.wav", FakeAubio([119.8, 120.1, 120.0], 0.8234))

        self.assertEqual(result, {"bpm": 120, "confidence": 0.8234, "reliable": True})
        self.assertIsInstance(result["bpm"], int)

    def test_aubio_bpm_detection_preserves_low_confidence_estimate(self):
        result = detect_bpm_from_file("track.wav", FakeAubio([127.9, 128.1], 0.31))

        self.assertEqual(result, {"bpm": 128, "confidence": 0.31, "reliable": False})

    def test_differing_bpm_candidates_do_not_reduce_aubio_confidence(self):
        result = detect_bpm_from_file(
            "track.wav",
            FakeAubio([123.6, 123.7, 124.6, 124.7], 0.91),
        )

        self.assertEqual(result, {"bpm": 124, "confidence": 0.91, "reliable": True})

    def test_aubio_bpm_detection_uses_median_tracker_confidence(self):
        result = detect_bpm_from_file(
            "track.wav",
            FakeAubio([119.8, 120.0, 120.2], [0.2, 0.9, 0.6]),
        )

        self.assertEqual(result, {"bpm": 120, "confidence": 0.6, "reliable": True})

    def test_aubio_bpm_detection_clamps_median_tracker_confidence(self):
        result = detect_bpm_from_file(
            "track.wav",
            FakeAubio([119.8, 120.2], [0.8, 1.4]),
        )

        self.assertEqual(result, {"bpm": 120, "confidence": 1.0, "reliable": True})

    def test_logged_aubio_confidence_matches_result(self):
        with self.assertLogs("uvicorn.error", level="INFO") as captured:
            result = detect_bpm_from_file(
                "track.wav",
                FakeAubio([119.8, 120.2], 0.8234),
                log_result=True,
            )

        self.assertEqual(len(captured.output), 1)
        self.assertIn(f"aubio_confidence={result['confidence']}", captured.output[0])
        self.assertIn("bpm=120", captured.output[0])
        self.assertIn("reliable=True", captured.output[0])

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

    def test_detect_bpm_api_returns_helper_confidence(self):
        upload = UploadFile(filename="track.wav", file=io.BytesIO(b"audio"))
        expected = {"bpm": 120, "confidence": 0.8234, "reliable": True}

        with (
            patch("magenta_server.get_aubio_runtime", return_value=object()),
            patch("magenta_server.detect_bpm_from_file", return_value=expected) as helper,
        ):
            result = asyncio.run(detect_bpm(upload))

        self.assertEqual(result, expected)
        helper.assert_called_once()
        self.assertTrue(helper.call_args.kwargs["log_result"])

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

    def test_drum_style_prompt_requests_straight_project_grid(self):
        detected_key = DetectedKey(
            root_pitch_class=9,
            mode="minor",
            major_score=0.0,
            minor_score=1.0,
            confidence=1.0,
        )

        prompt = build_mrt_style_prompt(
            "tech house",
            128.0,
            detected_key,
            "drums",
        )

        self.assertIn("tightly quantized to a straight 4/4 project grid", prompt)

    def test_melody_style_prompt_requests_solo_monophonic_synthesizer(self):
        detected_key = DetectedKey(
            root_pitch_class=0,
            mode="major",
            major_score=1.0,
            minor_score=0.0,
            confidence=1.0,
        )

        prompt = build_mrt_style_prompt(
            "ambient house",
            123.0,
            detected_key,
            "melody",
        )

        self.assertIn("solo monophonic synthesizer melody stem", prompt)

    def test_low_confidence_key_prompt_omits_mode_claim(self):
        detected_key = DetectedKey(
            root_pitch_class=4,
            mode="minor",
            major_score=0.2,
            minor_score=0.21,
            confidence=0.01,
        )

        prompt = build_mrt_style_prompt("ambient house", 123.0, detected_key, "melody")

        self.assertIn("centered on E", prompt)
        self.assertNotIn("major", prompt)
        self.assertNotIn("minor", prompt)

    def test_sampling_parameters_accept_supported_boundaries(self):
        self.assertEqual(
            validate_sampling_parameters(0.0, 1, -1.0, 7.0),
            (0.0, 1, -1.0, 7.0),
        )
        self.assertEqual(
            validate_sampling_parameters(2.0, 40, 7.0, -1.0),
            (2.0, 40, 7.0, -1.0),
        )

    def test_sampling_parameters_reject_unsupported_ranges(self):
        invalid_cases = (
            (-0.01, 40, 3.0, 7.0, "temperature"),
            (2.01, 40, 3.0, 7.0, "temperature"),
            (float("nan"), 40, 3.0, 7.0, "temperature"),
            (0.2, 0, 3.0, 7.0, "top_k"),
            (0.2, 40, -1.01, 7.0, "cfg_notes"),
            (0.2, 40, 7.01, 7.0, "cfg_notes"),
            (0.2, 40, 3.0, float("inf"), "cfg_drums"),
        )

        for temperature, top_k, cfg_notes, cfg_drums, field in invalid_cases:
            with self.subTest(field=field):
                with self.assertRaises(HTTPException) as raised:
                    validate_sampling_parameters(
                        temperature,
                        top_k,
                        cfg_notes,
                        cfg_drums,
                    )
                self.assertEqual(raised.exception.status_code, 400)
                self.assertIn(field, raised.exception.detail)

    def test_generate_rejects_sampling_parameters_before_loading_runtime(self):
        upload = UploadFile(filename="reference.wav", file=io.BytesIO(b"audio"))

        with patch("magenta_server.get_magenta_runtime") as get_runtime:
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(
                    generate(
                        audio_file=upload,
                        prompt="ambient house",
                        duration_bars=4,
                        bpm=120.0,
                        stem_role="melody",
                        avoid_clash=True,
                        temperature=2.01,
                        top_k=40,
                        cfg_notes=3.0,
                        cfg_drums=7.0,
                    )
                )

        self.assertEqual(raised.exception.status_code, 400)
        get_runtime.assert_not_called()

    def test_generation_calls_receive_default_sampling_parameters_and_state(self):
        class FakeMrt:
            def __init__(self):
                self.calls = []

            def generate(self, **kwargs):
                self.calls.append(kwargs)
                return f"chunk-{len(self.calls)}", f"state-{len(self.calls)}"

        fake_mrt = FakeMrt()
        conditioning = [
            ([0] * 128, [0]),
            ([0] * 128, [1]),
        ]

        chunks = generate_conditioned_chunks(
            fake_mrt,
            np.array([1.0], dtype=np.float32),
            conditioning,
            [12, 13],
        )

        self.assertEqual(chunks, ["chunk-1", "chunk-2"])
        self.assertEqual([call["temperature"] for call in fake_mrt.calls], [0.2, 0.2])
        self.assertEqual([call["top_k"] for call in fake_mrt.calls], [40, 40])
        self.assertEqual([call["cfg_notes"] for call in fake_mrt.calls], [3.0, 3.0])
        self.assertEqual([call["cfg_drums"] for call in fake_mrt.calls], [7.0, 7.0])
        self.assertEqual([call["drums"] for call in fake_mrt.calls], [[0], [1]])
        self.assertIsNone(fake_mrt.calls[0]["state"])
        self.assertEqual(fake_mrt.calls[1]["state"], "state-1")
        self.assertTrue(all("cfg_musiccoca" not in call for call in fake_mrt.calls))

    def test_generation_calls_receive_submitted_sampling_parameters(self):
        class FakeMrt:
            def __init__(self):
                self.calls = []

            def generate(self, **kwargs):
                self.calls.append(kwargs)
                return object(), object()

        fake_mrt = FakeMrt()
        conditioning = [([0] * 128, [0])] * 3

        generate_conditioned_chunks(
            fake_mrt,
            np.array([1.0], dtype=np.float32),
            conditioning,
            [12, 13, 12],
            temperature=0.75,
            top_k=17,
            cfg_notes=4.2,
            cfg_drums=6.0,
        )

        for call in fake_mrt.calls:
            self.assertEqual(call["temperature"], 0.75)
            self.assertEqual(call["top_k"], 17)
            self.assertEqual(call["cfg_notes"], 4.2)
            self.assertEqual(call["cfg_drums"], 6.0)

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

    def test_blend_style_vectors_uses_25_75_weighting(self):
        blended = blend_style_vectors(
            np.array([[2.0, 0.0]], dtype=np.float32),
            np.array([0.0, 6.0], dtype=np.float32),
        )

        np.testing.assert_allclose(blended, np.array([0.5, 4.5], dtype=np.float32))

    def test_frames_per_beat_changes_inversely_with_bpm(self):
        frames_at_80 = frames_per_beat_for_bpm(80)
        frames_at_120 = frames_per_beat_for_bpm(120)
        frames_at_160 = frames_per_beat_for_bpm(160)

        self.assertGreater(frames_at_80, 0)
        self.assertGreater(frames_at_120, 0)
        self.assertGreater(frames_at_160, 0)
        self.assertGreater(frames_at_80, frames_at_120)
        self.assertGreater(frames_at_120, frames_at_160)

    def test_fractional_frame_schedule_alternates_at_120_bpm(self):
        schedule = model_frame_schedule(120, 16)

        self.assertEqual(schedule, [13, 12] * 8)

    def test_fractional_frame_schedules_are_positive_exact_and_bounded(self):
        for bpm in (80, 120, 124, 128, 160):
            with self.subTest(bpm=bpm):
                total_beats = 16
                frames_per_beat = 25.0 * 60.0 / bpm
                boundaries = model_frame_boundaries(bpm, total_beats)
                schedule = model_frame_schedule(bpm, total_beats)

                self.assertTrue(all(chunk_frames > 0 for chunk_frames in schedule))
                self.assertEqual(sum(schedule), int(np.floor(total_beats * frames_per_beat + 0.5)))
                for beat, boundary in enumerate(boundaries):
                    self.assertLessEqual(abs(boundary - (beat * frames_per_beat)), 0.5)

    def test_beat_time_maps_cover_exact_source_and_target_lengths(self):
        for bpm in (80, 120, 124, 128, 160):
            with self.subTest(bpm=bpm):
                boundaries = model_frame_boundaries(bpm, 16)
                time_map = build_beat_time_map(boundaries, 385_123, 384_000)

                self.assertEqual(time_map[0], (0, 0))
                self.assertEqual(time_map[-1], (385_123, 384_000))
                self.assertEqual(len(time_map), 17)
                self.assertTrue(
                    all(
                        source_end > source_start and target_end > target_start
                        for (source_start, target_start), (source_end, target_end)
                        in zip(time_map, time_map[1:])
                    )
                )

    def test_five_bar_capture_is_cropped_to_four_bars_from_downbeat(self):
        samples, offset_samples = self.synthetic_capture(downbeat_phase=0)

        alignment = align_reference_capture(samples, 8_000, 120, 4)

        self.assertEqual(len(alignment.samples), 64_000)
        self.assertEqual(alignment.downbeat_phase, 0)
        self.assertLessEqual(abs(alignment.start_sample - offset_samples), 512)
        self.assertIsNone(alignment.warning)

    def test_downbeat_scoring_selects_expected_four_beat_phase(self):
        samples, offset_samples = self.synthetic_capture(downbeat_phase=2)

        alignment = align_reference_capture(samples, 8_000, 120, 4)

        expected_start = offset_samples + (2 * 8_000 * 60 / 120)
        self.assertEqual(alignment.downbeat_phase, 2)
        self.assertLessEqual(abs(alignment.start_sample - expected_start), 512)

    def test_ambiguous_capture_continues_with_uncertain_warning(self):
        samples, _ = self.synthetic_capture(
            downbeat_gain=0.5,
            beat_gain=0.5,
        )

        alignment = align_reference_capture(samples, 8_000, 120, 4)

        self.assertEqual(len(alignment.samples), 64_000)
        self.assertIsNotNone(alignment.warning)
        self.assertLess(alignment.confidence, 0.12)

    def test_librosa_fallback_reaches_exact_duration(self):
        samples, _ = self.synthetic_capture(sample_rate=4_000)
        raw = samples[:31_123]
        duration_seconds = 8.0
        boundaries = model_frame_boundaries(120, 16)

        correction = correct_generation_timing(
            raw,
            4_000,
            120,
            duration_seconds,
            boundaries,
            rubberband_executable="",
        )

        self.assertEqual(correction.samples.shape, (32_000, 1))
        self.assertEqual(correction.correction_type, "librosa_global")
        self.assertIn("librosa", correction.fallback_warning)

    def test_successful_rubberband_time_map_is_used(self):
        samples = np.zeros((31_000, 1), dtype=np.float32)
        boundaries = model_frame_boundaries(120, 16)

        with patch(
            "magenta_server._run_rubberband_time_map",
            return_value=np.zeros((32_000, 1), dtype=np.float32),
        ) as run_rubberband:
            correction = correct_generation_timing(
                samples,
                4_000,
                120,
                8.0,
                boundaries,
                rubberband_executable="/usr/bin/rubberband",
            )

        self.assertEqual(correction.samples.shape, (32_000, 1))
        self.assertEqual(correction.correction_type, "rubberband_beat_map")
        self.assertIsNone(correction.fallback_warning)
        run_rubberband.assert_called_once()

    def test_drum_timing_attempts_subdivision_warp_without_residual_error(self):
        samples = np.zeros((31_000, 1), dtype=np.float32)
        boundaries = model_frame_boundaries(120, 16)
        base_map = build_beat_time_map(boundaries, len(samples), 32_000)
        dense_map = [
            base_map[0],
            (base_map[1][0] // 2, base_map[1][1] // 2),
            *base_map[1:],
        ]

        with (
            patch(
                "magenta_server._run_rubberband_time_map",
                return_value=np.zeros((32_000, 1), dtype=np.float32),
            ) as run_rubberband,
            patch(
                "magenta_server.add_confident_subdivision_anchors",
                return_value=dense_map,
            ) as add_anchors,
        ):
            correct_generation_timing(
                samples,
                4_000,
                120,
                8.0,
                boundaries,
                rubberband_executable="/usr/bin/rubberband",
                quantize_transients=True,
            )

        add_anchors.assert_called_once()
        self.assertEqual(run_rubberband.call_count, 2)
        self.assertEqual(run_rubberband.call_args_list[1].args[3], dense_map)

    def test_rubberband_correction_is_exact_at_requested_tempos(self):
        sample_rate = 2_000

        def fake_rubberband(samples, source_rate, target_samples, time_map, executable):
            self.assertEqual(source_rate, sample_rate)
            self.assertEqual(time_map[-1][1], target_samples)
            return np.zeros((target_samples, samples.shape[1]), dtype=np.float32)

        with patch(
            "magenta_server._run_rubberband_time_map",
            side_effect=fake_rubberband,
        ):
            for bpm in (80, 120, 124, 128, 160):
                with self.subTest(bpm=bpm):
                    duration_seconds = 16 * 60 / bpm
                    target_samples = int(round(duration_seconds * sample_rate))
                    correction = correct_generation_timing(
                        np.zeros((target_samples + 37, 1), dtype=np.float32),
                        sample_rate,
                        bpm,
                        duration_seconds,
                        model_frame_boundaries(bpm, 16),
                        rubberband_executable="/usr/bin/rubberband",
                    )

                    self.assertEqual(
                        correction.samples.shape,
                        (target_samples, 1),
                    )

    @unittest.skipUnless(shutil.which("rubberband"), "Rubber Band is not installed")
    def test_installed_rubberband_produces_exact_sample_count(self):
        sample_rate = 8_000
        target_samples = sample_rate * 8
        samples = np.zeros((target_samples + 257, 1), dtype=np.float32)
        samples[::4_000, 0] = 0.5

        correction = correct_generation_timing(
            samples,
            sample_rate,
            120,
            8.0,
            model_frame_boundaries(120, 16),
            rubberband_executable=shutil.which("rubberband"),
        )

        self.assertEqual(correction.samples.shape, (target_samples, 1))
        self.assertTrue(correction.correction_type.startswith("rubberband_"))
        self.assertIsNone(correction.fallback_warning)

    def test_rubberband_failure_uses_librosa_fallback(self):
        samples = np.zeros((31_000, 1), dtype=np.float32)
        boundaries = model_frame_boundaries(120, 16)

        with patch(
            "magenta_server._run_rubberband_time_map",
            side_effect=RuntimeError("failed"),
        ):
            correction = correct_generation_timing(
                samples,
                4_000,
                120,
                8.0,
                boundaries,
                rubberband_executable="/usr/bin/rubberband",
            )

        self.assertEqual(correction.samples.shape, (32_000, 1))
        self.assertEqual(correction.correction_type, "librosa_global")
        self.assertIn("failed", correction.fallback_warning)

    def test_onset_phase_shift_is_bounded(self):
        samples, _ = self.synthetic_capture(offset_seconds=0.06)
        four_bars = samples[:64_000]

        alignment = analyze_onset_alignment(four_bars, 8_000, 120)

        self.assertLessEqual(abs(alignment.phase_shift_samples), 640)

    def test_subdivision_anchors_preserve_time_map_endpoints(self):
        samples, _ = self.synthetic_capture()
        base_map = build_beat_time_map(
            model_frame_boundaries(120, 16),
            len(samples),
            64_000,
        )

        dense_map = add_confident_subdivision_anchors(
            samples,
            8_000,
            120,
            base_map,
        )

        self.assertEqual(dense_map[0], base_map[0])
        self.assertEqual(dense_map[-1], base_map[-1])
        self.assertTrue(all(anchor in dense_map for anchor in base_map))
        self.assertTrue(
            all(
                source_end > source_start and target_end > target_start
                for (source_start, target_start), (source_end, target_end)
                in zip(dense_map, dense_map[1:])
            )
        )

    def test_displaced_attacks_add_monotonic_sixteenth_anchors(self):
        sample_rate = 8_000
        bpm = 120
        total_samples = 64_000
        sixteenth_samples = 1_000
        displaced_attacks = np.arange(1_000, total_samples, 4_000) + 200
        base_map = build_beat_time_map(
            model_frame_boundaries(bpm, 16),
            total_samples,
            total_samples,
        )

        with patch(
            "magenta_server._confident_onset_samples",
            return_value=(
                displaced_attacks,
                np.ones(len(displaced_attacks), dtype=np.float32),
            ),
        ):
            dense_map = add_confident_subdivision_anchors(
                np.zeros((total_samples, 1), dtype=np.float32),
                sample_rate,
                bpm,
                base_map,
            )

        added_anchors = [anchor for anchor in dense_map if anchor not in base_map]
        self.assertTrue(added_anchors)
        self.assertEqual(dense_map[0], (0, 0))
        self.assertEqual(dense_map[-1], (total_samples, total_samples))
        self.assertTrue(all(target % sixteenth_samples == 0 for _, target in added_anchors))
        self.assertTrue(
            all(
                source_end > source_start and target_end > target_start
                for (source_start, target_start), (source_end, target_end)
                in zip(dense_map, dense_map[1:])
            )
        )

    def test_subdivision_alignment_must_improve_before_replacement(self):
        baseline = OnsetAlignment(18.0, 35.0, 0, 1.0)
        worse = OnsetAlignment(12.0, 45.0, 0, 1.0)
        better = OnsetAlignment(10.0, 25.0, 0, 1.0)

        self.assertFalse(onset_alignment_improves(worse, baseline))
        self.assertTrue(onset_alignment_improves(better, baseline))

    def test_worse_subdivision_warp_keeps_beat_map_result(self):
        samples = np.zeros((31_000, 1), dtype=np.float32)
        base_output = np.ones((32_000, 1), dtype=np.float32)
        dense_output = np.full((32_000, 1), 2.0, dtype=np.float32)
        boundaries = model_frame_boundaries(120, 16)
        dense_map = [
            (0, 0),
            (1_000, 1_000),
            *build_beat_time_map(boundaries, len(samples), 32_000)[1:],
        ]
        baseline = OnsetAlignment(18.0, 35.0, 0, 1.0)
        worse = OnsetAlignment(12.0, 45.0, 0, 1.0)

        with (
            patch(
                "magenta_server._run_rubberband_time_map",
                side_effect=[base_output, dense_output],
            ),
            patch(
                "magenta_server.add_confident_subdivision_anchors",
                return_value=dense_map,
            ),
            patch(
                "magenta_server._phase_correct_and_measure",
                side_effect=[
                    (base_output, 0.0, baseline),
                    (dense_output, 0.0, worse),
                ],
            ),
        ):
            correction = correct_generation_timing(
                samples,
                4_000,
                120,
                8.0,
                boundaries,
                rubberband_executable="/usr/bin/rubberband",
                quantize_transients=True,
            )

        self.assertEqual(correction.correction_type, "rubberband_beat_map")
        np.testing.assert_array_equal(correction.samples, base_output)

    def test_timing_headers_include_status_warning_and_alignment(self):
        diagnostics = TimingDiagnostics(
            capture_phase_samples=256,
            capture_downbeat_phase=1,
            capture_alignment_confidence=0.05,
            model_frame_schedule=[13, 12],
            raw_duration_seconds=8.04,
            corrected_duration_seconds=8.0,
            correction_type="librosa_global",
            phase_shift_ms=-4.0,
            residual_median_ms=12.345,
            residual_p95_ms=26.0,
            timing_status="fallback",
            warning="Rubber Band unavailable.",
        )

        headers = timing_response_headers(diagnostics)

        self.assertEqual(headers["X-Magenta-Timing-Status"], "fallback")
        self.assertEqual(headers["X-Magenta-Timing-Warning"], "Rubber Band unavailable.")
        self.assertEqual(headers["X-Magenta-Alignment-Ms"], "12.35")

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
        first_beat_notes = [note for note, value in enumerate(conditioning[0][0]) if value > 0]

        self.assertEqual(len(conditioning), 16)
        self.assertTrue(first_beat_notes)
        self.assertTrue(all(36 <= note <= 52 for note in first_beat_notes))
        self.assertTrue(all(len(notes) == 128 and len(drums) == 1 for notes, drums in conditioning))

    def test_explicit_stems_have_no_masked_pitches_or_non_drum_triggers(self):
        chroma = np.zeros(12, dtype=np.float32)
        chroma[0] = 1.0
        analysis = {
            "total_beats": 16,
            "beat_energy": np.array([0.2, 0.8, 0.5, 0.3] * 4, dtype=np.float32),
            "onset_density": np.array([0.2, 0.7, 0.6, 0.2] * 4, dtype=np.float32),
            "pitch_classes": chroma,
            "detected_key": DetectedKey(0, "major", 1.0, 0.0, 1.0),
            "spectral": {"low": 0.1, "mid": 0.8, "high": 0.8},
        }

        for role in ("melody", "bass", "drums", "texture"):
            with self.subTest(role=role):
                conditioning = build_conditioning(analysis, role)
                self.assertTrue(
                    all(
                        value in {0, 1, 2, 3}
                        for notes, _ in conditioning
                        for value in notes
                    )
                )
                if role != "drums":
                    self.assertTrue(all(drums == [0] for _, drums in conditioning))

    def test_melody_conditioning_is_sparse_monophonic_and_one_onset_per_bar(self):
        chroma = np.zeros(12, dtype=np.float32)
        chroma[0] = 1.0
        analysis = {
            "total_beats": 16,
            "beat_energy": np.zeros(16, dtype=np.float32),
            "onset_density": np.zeros(16, dtype=np.float32),
            "pitch_classes": chroma,
            "detected_key": DetectedKey(0, "major", 1.0, 0.0, 1.0),
            "spectral": {"low": 0.5, "mid": 0.5, "high": 0.5},
        }

        conditioning = build_conditioning(analysis, "melody")

        for bar in range(4):
            bar_beats = conditioning[bar * 4:(bar + 1) * 4]
            active_counts = [
                sum(value > 0 for value in notes)
                for notes, _ in bar_beats
            ]
            onset_counts = [
                sum(value == 2 for value in notes)
                for notes, _ in bar_beats
            ]
            self.assertEqual(active_counts, [1, 1, 0, 0])
            self.assertEqual(sum(onset_counts), 1)

    def test_low_confidence_melody_uses_strongest_pitch_and_its_fifth(self):
        chroma = np.zeros(12, dtype=np.float32)
        chroma[4] = 1.0
        analysis = {
            "total_beats": 8,
            "beat_energy": np.zeros(8, dtype=np.float32),
            "onset_density": np.zeros(8, dtype=np.float32),
            "pitch_classes": chroma,
            "detected_key": DetectedKey(0, "minor", 0.1, 0.11, 0.01),
            "spectral": {"low": 0.5, "mid": 0.5, "high": 0.5},
        }

        conditioning = build_conditioning(analysis, "melody")
        onset_pitch_classes = [
            note % 12
            for notes, _ in conditioning
            for note, value in enumerate(notes)
            if value == 2
        ]

        self.assertEqual(onset_pitch_classes, [4, 11])


if __name__ == "__main__":
    unittest.main()
