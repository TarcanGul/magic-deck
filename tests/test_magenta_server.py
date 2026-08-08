import asyncio
import io
import math
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
    bar_rms_db,
    blend_style_vectors,
    build_beat_time_map,
    build_conditioning,
    build_mrt_style_prompt,
    build_percussion_conditioning,
    correct_generation_timing,
    detect_key,
    detect_bpm,
    detect_bpm_from_file,
    embed_musiccoca_styles,
    embed_musiccoca_text_style,
    find_percussion_instrument,
    frames_per_beat_for_bpm,
    generate,
    generate_conditioned_chunks,
    level_bar_dynamics,
    model_frame_boundaries,
    model_frame_schedule,
    normalize_to_full_scale,
    onset_alignment_improves,
    pitch_classes_for_key,
    post_process_generation,
    quiet_percussion_slots,
    replace_confident_grid_anchors,
    resolve_duration_seconds,
    resolve_sampling_parameters,
    resolve_stem_role,
    should_use_isolated_text_style,
    stem_prompt_constraint,
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

    def test_text_only_musiccoca_embedding_excludes_audio_prompt(self):
        class FakeMusicCoCa:
            def __init__(self):
                self.calls = []

            def embed(self, prompts, **kwargs):
                self.calls.append((prompts, kwargs))
                return np.array([[5.0, 12.0]], dtype=np.float32)

        style_model = FakeMusicCoCa()
        style = embed_musiccoca_text_style(style_model, "solo isolated conga")

        self.assertEqual(
            style_model.calls,
            [(["solo isolated conga"], {"use_mapper": False})],
        )
        np.testing.assert_array_equal(style, np.array([5.0, 12.0], dtype=np.float32))

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

    def test_build_mrt_style_prompt_isolates_bass_stem(self):
        detected_key = DetectedKey(
            root_pitch_class=9,
            mode="minor",
            major_score=0.0,
            minor_score=1.0,
            confidence=1.0,
        )

        self.assertEqual(
            build_mrt_style_prompt("tech house", 128.0, detected_key, "bass"),
            "128 bpm isolated bass stem, drumless, no percussion, tech house in A minor",
        )

    def test_non_drum_style_prompts_are_drumless_and_percussion_free(self):
        detected_key = DetectedKey(9, "minor", 0.0, 1.0, 1.0)

        for role in ("melody", "bass", "texture"):
            with self.subTest(role=role):
                prompt = build_mrt_style_prompt(
                    "warm analog house",
                    128.0,
                    detected_key,
                    role,
                )

                self.assertIn("isolated", prompt)
                self.assertIn(f"{role if role != 'melody' else 'melody'} stem", prompt)
                self.assertIn("drumless", prompt)
                self.assertIn("no percussion", prompt)
                self.assertIn("warm analog house", prompt)
                self.assertIn("A minor", prompt)

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
        self.assertIn("isolated drum stem", prompt)
        self.assertIn("drums and percussion only", prompt)
        self.assertIn("no pitched or melodic instruments", prompt)
        self.assertIn("tech house", prompt)
        self.assertIn("A minor", prompt)

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

    def test_standard_explicit_roles_use_text_only_style_conditioning(self):
        for role in ("melody", "bass", "texture", "drums"):
            with self.subTest(role=role):
                self.assertTrue(should_use_isolated_text_style(role, role))

    def test_auto_role_resolution_retains_blended_style_conditioning(self):
        for resolved_role in ("melody", "bass", "texture", "drums"):
            with self.subTest(resolved_role=resolved_role):
                self.assertFalse(
                    should_use_isolated_text_style("auto", resolved_role)
                )

    def test_percussion_routing_retains_text_only_style_conditioning(self):
        self.assertTrue(should_use_isolated_text_style("auto", "percussion"))
        self.assertTrue(should_use_isolated_text_style("percussion", "percussion"))

    def test_unknown_role_has_no_standard_stem_constraint(self):
        self.assertEqual(stem_prompt_constraint("auto"), "")

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

    def test_percussion_prompt_is_isolated_rhythmic_and_keyless(self):
        detected_key = DetectedKey(9, "minor", 0.0, 1.0, 1.0)

        prompt = build_mrt_style_prompt(
            "afro house style groovy conga beats",
            123.0,
            detected_key,
            "percussion",
            "conga",
        )

        self.assertEqual(
            prompt,
            "123 bpm solo isolated conga hand-percussion stem, single instrument, "
            "dry unaccompanied performance, afro house style groovy conga rhythms, "
            "strict straight quarter-note grid",
        )
        self.assertNotIn("A minor", prompt)

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

    def test_percussion_sampling_defaults_are_deterministic_and_overridable(self):
        self.assertEqual(
            resolve_sampling_parameters(None, None, None, None, percussion=True),
            (0.1, 40, 7.0, 7.0),
        )
        self.assertEqual(
            resolve_sampling_parameters(0.75, 17, 4.2, 6.0, percussion=True),
            (0.75, 17, 4.2, 6.0),
        )
        self.assertEqual(
            resolve_sampling_parameters(None, None, None, None, percussion=False),
            (0.2, 40, 3.0, 7.0),
        )

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

    def test_percussion_quarter_note_schedule_has_16_positive_stateful_calls(self):
        class FakeMrt:
            def __init__(self):
                self.calls = []

            def generate(self, **kwargs):
                self.calls.append(kwargs)
                return object(), f"state-{len(self.calls)}"

        bpm = 123
        total_quarter_notes = 16
        schedule = model_frame_schedule(bpm, total_quarter_notes, steps_per_beat=1)
        conditioning = [([0] * 128, [1]) for _ in range(total_quarter_notes)]
        fake_mrt = FakeMrt()

        generate_conditioned_chunks(
            fake_mrt,
            np.ones(4, dtype=np.float32),
            conditioning,
            schedule,
            temperature=0.1,
            top_k=40,
            cfg_notes=7.0,
            cfg_drums=7.0,
        )

        self.assertEqual(len(fake_mrt.calls), 16)
        self.assertTrue(all(frames > 0 for frames in schedule))
        self.assertEqual(
            sum(schedule),
            int(math.floor((16 * 25.0 * 60.0 / bpm) + 0.5)),
        )
        self.assertAlmostEqual(16 * 60.0 / bpm, 7.804878048780488)
        self.assertIsNone(fake_mrt.calls[0]["state"])
        self.assertEqual(fake_mrt.calls[-1]["state"], "state-15")
        for call in fake_mrt.calls:
            self.assertEqual(call["temperature"], 0.1)
            self.assertEqual(call["top_k"], 40)
            self.assertEqual(call["cfg_notes"], 7.0)
            self.assertEqual(call["cfg_drums"], 7.0)

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

    def test_quarter_grid_anchor_replacement_uses_strongest_attack_per_slot(self):
        sample_rate = 8_000
        bpm = 120
        total_samples = 64_000
        base_map = build_beat_time_map(
            model_frame_boundaries(bpm, 16, steps_per_beat=1),
            total_samples,
            total_samples,
        )

        with patch(
            "magenta_server._confident_onset_samples",
            return_value=(
                np.array([4_100, 4_200, 8_150], dtype=np.int64),
                np.array([0.5, 1.0, 0.8], dtype=np.float32),
            ),
        ):
            replaced = replace_confident_grid_anchors(
                np.zeros((total_samples, 1), dtype=np.float32),
                sample_rate,
                bpm,
                base_map,
                steps_per_beat=1,
            )

        self.assertEqual(replaced[0], base_map[0])
        self.assertEqual(replaced[-1], base_map[-1])
        self.assertEqual(replaced[1], (4_200, 4_000))
        self.assertEqual(replaced[2], (8_150, 8_000))
        self.assertTrue(
            all(
                source_end > source_start and target_end > target_start
                for (source_start, target_start), (source_end, target_end)
                in zip(replaced, replaced[1:])
            )
        )

    def test_quarter_grid_warp_is_retained_only_when_alignment_improves(self):
        samples = np.zeros((31_000, 1), dtype=np.float32)
        base_output = np.ones((32_000, 1), dtype=np.float32)
        quarter_output = np.full((32_000, 1), 2.0, dtype=np.float32)
        boundaries = model_frame_boundaries(120, 16, steps_per_beat=1)
        base_map = build_beat_time_map(boundaries, len(samples), 32_000)
        quarter_map = list(base_map)
        quarter_map[1] = (quarter_map[1][0] + 10, quarter_map[1][1])
        baseline = OnsetAlignment(18.0, 35.0, 0, 1.0)
        better = OnsetAlignment(10.0, 25.0, 0, 1.0)

        with (
            patch(
                "magenta_server._run_rubberband_time_map",
                side_effect=[base_output, quarter_output],
            ),
            patch(
                "magenta_server.replace_confident_grid_anchors",
                return_value=quarter_map,
            ),
            patch(
                "magenta_server._phase_correct_and_measure",
                side_effect=[
                    (base_output, 0.0, baseline),
                    (quarter_output, 0.0, better),
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
                grid_steps_per_beat=1,
                replace_grid_anchors=True,
                max_median_ms=15.0,
                max_p95_ms=30.0,
            )

        self.assertEqual(correction.correction_type, "rubberband_quarter_map")
        np.testing.assert_array_equal(correction.samples, quarter_output)

    def test_quarter_grid_alignment_reports_percussion_target_accuracy(self):
        sample_rate = 8_000
        grid_samples = 4_000
        attacks = np.arange(0, 16 * grid_samples, grid_samples) + 80
        with patch(
            "magenta_server._confident_onset_samples",
            return_value=(
                attacks.astype(np.int64),
                np.ones(len(attacks), dtype=np.float32),
            ),
        ):
            alignment = analyze_onset_alignment(
                np.zeros((16 * grid_samples, 1), dtype=np.float32),
                sample_rate,
                120,
                steps_per_beat=1,
            )

        self.assertAlmostEqual(alignment.median_ms, 10.0)
        self.assertAlmostEqual(alignment.p95_ms, 10.0)

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
            timing_grid="1/4",
            resolved_instrument="conga",
        )

        headers = timing_response_headers(diagnostics)

        self.assertEqual(headers["X-Magenta-Timing-Status"], "fallback")
        self.assertEqual(headers["X-Magenta-Timing-Warning"], "Rubber Band unavailable.")
        self.assertEqual(headers["X-Magenta-Alignment-Ms"], "12.35")
        self.assertEqual(diagnostics.timing_grid, "1/4")
        self.assertEqual(diagnostics.resolved_instrument, "conga")

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

    def test_bar_leveling_reduces_large_loudness_difference(self):
        sample_rate = 1_000
        bar_samples = 2_000
        phase = np.arange(bar_samples, dtype=np.float32) / sample_rate
        tone = np.sin(2.0 * np.pi * 20.0 * phase)
        samples = np.concatenate(
            [tone * amplitude for amplitude in (0.10, 0.11, 0.03, 0.35)]
        )[:, np.newaxis]

        before = bar_rms_db(samples, 4)
        leveled = level_bar_dynamics(samples, sample_rate, 4)
        after = bar_rms_db(leveled, 4)

        self.assertGreater(float(np.ptp(before)), 15.0)
        self.assertLessEqual(float(np.ptp(after)), 4.5)
        self.assertEqual(leveled.shape, samples.shape)

    def test_bar_leveling_leaves_modest_dynamics_unchanged(self):
        samples = np.concatenate(
            [
                np.full((100, 1), amplitude, dtype=np.float32)
                for amplitude in (0.10, 0.11, 0.09, 0.10)
            ]
        )

        leveled = level_bar_dynamics(samples, 100, 4)

        np.testing.assert_array_equal(leveled, samples)

    def test_bar_leveling_bounds_gain_and_preserves_stereo_balance(self):
        quiet = np.full(1_000, 0.001, dtype=np.float32)
        normal = np.full(1_000, 0.1, dtype=np.float32)
        mono = np.concatenate([quiet, normal, normal, normal])
        samples = np.column_stack([mono, mono * 0.5])

        leveled = level_bar_dynamics(
            samples,
            sample_rate=1_000,
            total_bars=4,
            tolerance_db=0.0,
            max_adjustment_db=9.0,
            transition_seconds=0.0,
        )

        measured_gain = float(leveled[500, 0] / samples[500, 0])
        self.assertAlmostEqual(20.0 * math.log10(measured_gain), 9.0, places=4)
        np.testing.assert_allclose(leveled[:, 1], leveled[:, 0] * 0.5)

    def test_bar_leveling_does_not_amplify_silent_bar(self):
        samples = np.concatenate(
            [
                np.zeros((100, 1), dtype=np.float32),
                np.full((300, 1), 0.1, dtype=np.float32),
            ]
        )

        leveled = level_bar_dynamics(samples, 100, 4)

        np.testing.assert_array_equal(leveled[:100], samples[:100])
        self.assertTrue(np.all(np.isfinite(leveled)))

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

    def test_post_processing_applies_bar_leveling_when_duration_is_known(self):
        samples = np.concatenate(
            [
                np.full((100, 1), amplitude, dtype=np.float32)
                for amplitude in (0.10, 0.10, 0.09, 0.35)
            ]
        )

        processed = post_process_generation(
            samples,
            sample_rate=100,
            reference=np.zeros_like(samples),
            duration_seconds=4.0,
            avoid_clash=False,
            duration_bars=4,
        )

        self.assertLessEqual(float(np.ptp(bar_rms_db(processed, 4))), 4.5)

    def test_percussion_post_processing_bypasses_spectral_ducking(self):
        mono = np.linspace(-0.5, 0.5, 400, dtype=np.float32)
        samples = np.column_stack([mono, mono * 0.5])

        with patch("magenta_server.apply_spectral_ducking") as ducking:
            processed = post_process_generation(
                samples,
                sample_rate=100,
                reference=np.ones_like(samples),
                duration_seconds=4.0,
                avoid_clash=True,
                duration_bars=4,
                stem_role="percussion",
            )

        ducking.assert_not_called()
        self.assertEqual(processed.shape, (400, 2))
        self.assertAlmostEqual(float(np.max(np.abs(processed))), 1.0)
        np.testing.assert_allclose(processed[:, 1], processed[:, 0] * 0.5)

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

    def test_auto_routes_all_supported_hand_percussion_terms(self):
        spectral = {"low": 0.05, "mid": 0.85, "high": 0.9}
        onset_density = np.full(16, 0.8, dtype=np.float32)
        beat_energy = np.full(16, 0.5, dtype=np.float32)
        keywords = (
            "conga",
            "bongo",
            "djembe",
            "timbale",
            "shaker",
            "tambourine",
            "cowbell",
            "clave",
            "agogo",
            "maraca",
            "cabasa",
            "guiro",
            "woodblock",
            "hand drum",
            "hand percussion",
        )

        for keyword in keywords:
            with self.subTest(keyword=keyword):
                self.assertEqual(
                    resolve_stem_role(
                        "auto",
                        spectral,
                        onset_density,
                        beat_energy,
                        f"afro house {keyword} beat",
                    ),
                    "percussion",
                )

    def test_percussion_instrument_uses_earliest_prompt_match(self):
        self.assertEqual(
            find_percussion_instrument("shaker groove followed by conga fills"),
            "shaker",
        )
        self.assertEqual(
            find_percussion_instrument("conga groove with early shaker accents"),
            "conga",
        )

    def test_explicit_role_overrides_percussion_prompt_routing(self):
        spectral = {"low": 0.5, "mid": 0.5, "high": 0.5}
        activity = np.zeros(16, dtype=np.float32)

        self.assertEqual(
            resolve_stem_role(
                "texture",
                spectral,
                activity,
                activity,
                "isolated conga beat",
            ),
            "texture",
        )

    def test_quarter_note_percussion_selects_every_grid_slot(self):
        selected = quiet_percussion_slots(
            np.zeros(16, dtype=np.float32),
            np.zeros(16, dtype=np.float32),
            total_bars=4,
        )

        for bar in range(4):
            bar_start = bar * 4
            self.assertEqual(
                {slot - bar_start for slot in selected if bar_start <= slot < bar_start + 4},
                {0, 1, 2, 3},
            )

    def test_percussion_conditioning_triggers_each_quarter_note(self):
        energy = np.tile(
            np.array([0.8, 0.1, 0.7, 0.2], dtype=np.float32),
            4,
        )
        onset = np.zeros(16, dtype=np.float32)
        analysis = {
            "total_beats": 16,
            "beat_energy": np.zeros(16, dtype=np.float32),
            "onset_density": np.zeros(16, dtype=np.float32),
            "percussion_grid_energy": energy,
            "percussion_grid_onset_density": onset,
        }

        conditioning = build_percussion_conditioning(analysis)

        self.assertEqual(len(conditioning), 16)
        self.assertTrue(all(notes == [0] * 128 for notes, _ in conditioning))
        for bar in range(4):
            bar_drums = [
                drums[0]
                for _, drums in conditioning[bar * 4:(bar + 1) * 4]
            ]
            self.assertEqual(bar_drums, [1, 1, 1, 1])

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
