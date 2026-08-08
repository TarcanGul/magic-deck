"""
Magenta RT2 FastAPI Server
--------------------------
Endpoints:
  POST /detect-bpm — detect tempo from an uploaded audio file with aubio
  POST /generate  — generate audio from audio file + text prompt
  GET  /health    — health check
"""

import io
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from typing import Any
import numpy as np
import librosa
import soundfile as sf

aubio_load_error: Exception | None = None
try:
    import aubio
except (ImportError, OSError) as e:
    aubio = None
    aubio_load_error = e

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn

# ---------------------------------------------------------------------------
# App & model initialisation
# ---------------------------------------------------------------------------

MAGENTA_HOME = os.environ.setdefault(
    "MAGENTA_HOME",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".magenta"),
)
MAGENTA_RT_HOME = os.path.join(MAGENTA_HOME, "magenta-rt-v2")
MAGENTA_MODEL = "mrt2_small"
MAGENTA_SAMPLE_RATE = 48_000
MRT_FRAMES_PER_SECOND = 25.0
BEATS_PER_BAR = 4
MIN_GENERATION_BPM = 40.0
MAX_GENERATION_BPM = 240.0
MIN_SAMPLING_TEMPERATURE = 0.0
MAX_SAMPLING_TEMPERATURE = 2.0
MIN_CFG_SCALE = -1.0
MAX_CFG_SCALE = 7.0
MIN_KEY_MODE_CONFIDENCE = 0.08
AUDIO_STYLE_WEIGHT = 0.25
TEXT_STYLE_WEIGHT = 0.75
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
MAJOR_SCALE = np.array([0, 2, 4, 5, 7, 9, 11], dtype=np.int16)
MINOR_SCALE = np.array([0, 2, 3, 5, 7, 8, 10], dtype=np.int16)
EQ_BANDS = {
    "low": (20.0, 250.0),
    "mid": (250.0, 4_000.0),
    "high": (4_000.0, 16_000.0),
}
STEM_ROLES = {"melody", "bass", "drums", "texture"}
PERCUSSION_ROLE = "percussion"
PERCUSSION_GRID_STEPS_PER_BEAT = 1
PERCUSSION_GRID_LABEL = "1/4"
DEFAULT_GRID_STEPS_PER_BEAT = 4
DEFAULT_GRID_LABEL = "1/16"
PERCUSSION_INSTRUMENT_PATTERNS = (
    ("conga", r"\bcongas?\b"),
    ("bongo", r"\bbongos?\b"),
    ("djembe", r"\bdjembes?\b"),
    ("timbale", r"\btimbales?\b"),
    ("shaker", r"\bshakers?\b"),
    ("tambourine", r"\btambourines?\b"),
    ("cowbell", r"\bcowbells?\b"),
    ("clave", r"\bclaves?\b"),
    ("agogo", r"\bagogos?\b"),
    ("maraca", r"\bmaracas?\b"),
    ("cabasa", r"\bcabasas?\b"),
    ("guiro", r"\bguiros?\b"),
    ("woodblock", r"\bwoodblocks?\b"),
    ("hand drum", r"\bhand[\s-]+drums?\b"),
    ("hand percussion", r"\bhand[\s-]+percussion\b"),
)
PERCUSSION_SLOT_TIE_PRIORITY = (1, 3, 0, 2)
ROLE_NOTE_RANGES = {
    "bass": range(36, 53),
    "texture": range(60, 85),
    "melody": range(55, 77),
}
MAJOR_KEY_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float32,
)
MINOR_KEY_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float32,
)
TONIC_KEY_WEIGHT = 0.08
CAPTURE_ALIGNMENT_CONFIDENCE_THRESHOLD = 0.12
ONSET_HOP_LENGTH = 256
MAX_PHASE_SHIFT_SECONDS = 0.08
MAX_MEDIAN_ALIGNMENT_MS = 20.0
MAX_P95_ALIGNMENT_MS = 40.0
PERCUSSION_MAX_MEDIAN_ALIGNMENT_MS = 15.0
PERCUSSION_MAX_P95_ALIGNMENT_MS = 30.0
BAR_LEVEL_TOLERANCE_DB = 1.5
MAX_BAR_LEVEL_ADJUSTMENT_DB = 9.0
BAR_LEVEL_TRANSITION_SECONDS = 0.12
TIMING_HEADER_NAMES = (
    "X-Magenta-Timing-Status",
    "X-Magenta-Timing-Warning",
    "X-Magenta-Alignment-Ms",
)

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Magenta RT2 API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=list(TIMING_HEADER_NAMES),
)

magenta_audio: Any | None = None
style_model: Any | None = None
mrt: Any | None = None


class AubioUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class DetectedKey:
    root_pitch_class: int
    mode: str
    major_score: float
    minor_score: float
    confidence: float

    @property
    def name(self) -> str:
        return f"{PITCH_CLASS_NAMES[self.root_pitch_class]} {self.mode}"


@dataclass(frozen=True)
class CaptureAlignment:
    samples: np.ndarray
    start_sample: int
    beat_phase_sample: int
    downbeat_phase: int
    confidence: float
    warning: str | None


@dataclass(frozen=True)
class OnsetAlignment:
    median_ms: float | None
    p95_ms: float | None
    phase_shift_samples: int
    phase_confidence: float


@dataclass(frozen=True)
class TimingCorrection:
    samples: np.ndarray
    correction_type: str
    phase_shift_ms: float
    alignment: OnsetAlignment
    fallback_warning: str | None


@dataclass
class TimingDiagnostics:
    capture_phase_samples: int
    capture_downbeat_phase: int
    capture_alignment_confidence: float
    model_frame_schedule: list[int]
    raw_duration_seconds: float
    corrected_duration_seconds: float
    correction_type: str
    phase_shift_ms: float
    residual_median_ms: float | None
    residual_p95_ms: float | None
    timing_status: str
    warning: str | None
    timing_grid: str = DEFAULT_GRID_LABEL
    resolved_instrument: str | None = None


def get_magenta_runtime() -> tuple[Any, Any, Any]:
    global magenta_audio, style_model, mrt

    if magenta_audio is None or style_model is None or mrt is None:
        from magenta_rt import audio, musiccoca
        from magenta_rt.mlx import system

        print("Loading MusicCoCa style model...")
        magenta_audio = audio
        style_model = musiccoca.MusicCoCa()

        print(f"Loading MagentaRT2SystemMlxfn ({MAGENTA_MODEL})...")
        mrt = system.MagentaRT2SystemMlxfn(size=MAGENTA_MODEL)

        print("Models loaded. Server ready.")

    return magenta_audio, style_model, mrt


def get_aubio_runtime() -> Any:
    """Load aubio independently from the much heavier Magenta runtime."""
    if aubio is None:
        raise AubioUnavailableError(str(aubio_load_error))
    return aubio


def detect_bpm_from_file(
    path: str,
    aubio_module: Any | None = None,
    log_result: bool = False,
) -> dict[str, float | bool | None]:
    aubio_module = aubio_module or get_aubio_runtime()
    window_size = 1024
    hop_size = 512
    source = aubio_module.source(path, 0, hop_size)
    tempo = aubio_module.tempo("default", window_size, hop_size, source.samplerate)
    estimates: list[float] = []
    confidences: list[float] = []

    while True:
        samples, frames_read = source()
        if tempo(samples):
            estimate = float(tempo.get_bpm())
            if math.isfinite(estimate) and estimate > 0:
                estimates.append(estimate)
                confidence = float(tempo.get_confidence())
                confidences.append(confidence)
        if frames_read < hop_size:
            break

    if len(estimates) < 2:
        return {"bpm": None, "confidence": 0.0, "reliable": False}

    bpm = float(np.median(estimates))
    relative_deviation = float(np.median(np.abs(np.asarray(estimates) - bpm))) / bpm
    if relative_deviation > 0.1:
        return {"bpm": None, "confidence": 0.0, "reliable": False}

    rounded_bpm = math.floor(bpm + 0.5)
    confidence = clamp01(float(np.median(confidences))) if confidences else 0.0
    reliable = confidence >= 0.5
    if log_result:
        logger.info(
            "BPM detection selected bpm=%d aubio_confidence=%s (%d%%) reliable=%s",
            rounded_bpm,
            confidence,
            round(confidence * 100),
            reliable,
        )
    return {
        "bpm": rounded_bpm,
        "confidence": confidence,
        "reliable": reliable,
    }


def validate_generation_bpm(bpm: float | None, required: bool = True) -> float | None:
    if bpm is None:
        if required:
            raise HTTPException(
                status_code=400,
                detail="bpm is required for beat-synced Magenta generation.",
            )
        return None

    if not math.isfinite(bpm):
        raise HTTPException(status_code=400, detail="bpm must be a finite number.")
    if bpm < MIN_GENERATION_BPM or bpm > MAX_GENERATION_BPM:
        raise HTTPException(
            status_code=400,
            detail=f"bpm must be between {MIN_GENERATION_BPM:g} and {MAX_GENERATION_BPM:g} for Magenta beat-synced generation.",
        )

    return bpm


def validate_sampling_parameters(
    temperature: float,
    top_k: int,
    cfg_notes: float,
    cfg_drums: float,
) -> tuple[float, int, float, float]:
    if not math.isfinite(temperature):
        raise HTTPException(status_code=400, detail="temperature must be a finite number.")
    if temperature < MIN_SAMPLING_TEMPERATURE or temperature > MAX_SAMPLING_TEMPERATURE:
        raise HTTPException(
            status_code=400,
            detail=(
                f"temperature must be between {MIN_SAMPLING_TEMPERATURE:g} "
                f"and {MAX_SAMPLING_TEMPERATURE:g}."
            ),
        )
    if top_k <= 0:
        raise HTTPException(status_code=400, detail="top_k must be greater than 0.")

    for name, value in (("cfg_notes", cfg_notes), ("cfg_drums", cfg_drums)):
        if not math.isfinite(value):
            raise HTTPException(status_code=400, detail=f"{name} must be a finite number.")
        if value < MIN_CFG_SCALE or value > MAX_CFG_SCALE:
            raise HTTPException(
                status_code=400,
                detail=f"{name} must be between {MIN_CFG_SCALE:g} and {MAX_CFG_SCALE:g}.",
            )

    return temperature, top_k, cfg_notes, cfg_drums


def resolve_sampling_parameters(
    temperature: float | None,
    top_k: int | None,
    cfg_notes: float | None,
    cfg_drums: float | None,
    percussion: bool,
) -> tuple[float, int, float, float]:
    resolved_temperature = (
        temperature
        if temperature is not None
        else (0.1 if percussion else 0.2)
    )
    resolved_top_k = top_k if top_k is not None else 40
    resolved_cfg_notes = (
        cfg_notes
        if cfg_notes is not None
        else (7.0 if percussion else 3.0)
    )
    resolved_cfg_drums = cfg_drums if cfg_drums is not None else 7.0
    return validate_sampling_parameters(
        resolved_temperature,
        resolved_top_k,
        resolved_cfg_notes,
        resolved_cfg_drums,
    )


def resolve_duration_seconds(duration_bars: int | None, bpm: float | None) -> float:
    bpm = validate_generation_bpm(bpm, required=True)
    if duration_bars is None:
        raise HTTPException(status_code=400, detail="duration_bars with bpm is required.")
    if duration_bars <= 0:
        raise HTTPException(status_code=400, detail="duration_bars must be greater than 0.")

    duration_seconds = (duration_bars * BEATS_PER_BAR * 60.0) / bpm
    if not math.isfinite(duration_seconds):
        raise HTTPException(status_code=400, detail="duration_seconds must be a finite number.")
    if duration_seconds < 1 or duration_seconds > 120:
        raise HTTPException(status_code=400, detail="duration_seconds must be between 1 and 120.")

    return duration_seconds


def format_bpm_for_style_prompt(bpm: float) -> str:
    rounded_bpm = round(bpm)
    if math.isclose(bpm, rounded_bpm, abs_tol=0.05):
        return str(rounded_bpm)
    return f"{bpm:.1f}"


def find_percussion_instrument(prompt: str) -> str | None:
    matches: list[tuple[int, int, str]] = []
    for pattern_index, (instrument, pattern) in enumerate(PERCUSSION_INSTRUMENT_PATTERNS):
        match = re.search(pattern, prompt, flags=re.IGNORECASE)
        if match:
            matches.append((match.start(), pattern_index, instrument))
    return min(matches)[2] if matches else None


def replace_beat_wording(prompt: str) -> str:
    prompt = re.sub(r"\bbeats\b", "rhythms", prompt, flags=re.IGNORECASE)
    return re.sub(r"\bbeat\b", "rhythm", prompt, flags=re.IGNORECASE)


def stem_prompt_constraint(stem_role: str | None) -> str:
    if stem_role in {"melody", "bass", "texture"}:
        role_name = {
            "melody": "solo monophonic synthesizer melody",
            "bass": "bass",
            "texture": "texture",
        }[stem_role]
        return f"isolated {role_name} stem, drumless, no percussion"
    if stem_role == "drums":
        return (
            "isolated drum stem, drums and percussion only, "
            "no pitched or melodic instruments"
        )
    return ""


def build_mrt_style_prompt(
    prompt: str,
    bpm: float,
    detected_key: DetectedKey,
    stem_role: str | None = None,
    percussion_instrument: str | None = None,
) -> str:
    clean_prompt = prompt.strip()
    if stem_role == PERCUSSION_ROLE:
        instrument = percussion_instrument or find_percussion_instrument(clean_prompt) or "hand percussion"
        rhythmic_prompt = replace_beat_wording(clean_prompt)
        return (
            f"{format_bpm_for_style_prompt(bpm)} bpm solo isolated {instrument} "
            "hand-percussion stem, single instrument, dry unaccompanied performance, "
            f"{rhythmic_prompt}, strict straight quarter-note grid"
        )

    stem_constraint = stem_prompt_constraint(stem_role)
    stem_prefix = f"{stem_constraint}, " if stem_constraint else ""
    grid_prompt = ""
    if stem_role == "drums":
        grid_prompt = ", tightly quantized to a straight 4/4 project grid"
    key_prompt = (
        f" in {detected_key.name}"
        if detected_key.confidence >= MIN_KEY_MODE_CONFIDENCE
        else f", centered on {PITCH_CLASS_NAMES[detected_key.root_pitch_class]}"
    )
    return f"{format_bpm_for_style_prompt(bpm)} bpm {stem_prefix}{clean_prompt}{grid_prompt}{key_prompt}"


def as_style_vector(style: Any) -> np.ndarray:
    vector = np.asarray(style, dtype=np.float32)
    if vector.ndim == 2 and vector.shape[0] == 1:
        vector = vector[0]
    return vector


def embed_musiccoca_styles(style_model: Any, audio_prompt: Any, text_prompt: str) -> tuple[np.ndarray, np.ndarray]:
    """Embed audio and text together in MusicCoCa's joint embedding space."""
    styles = np.asarray(
        style_model.embed([audio_prompt, text_prompt], use_mapper=False),
        dtype=np.float32,
    )
    if styles.ndim != 2 or styles.shape[0] != 2:
        raise ValueError(
            "MusicCoCa must return one audio and one text embedding "
            f"with shape (2, embedding_dim); got {styles.shape}."
        )
    return styles[0], styles[1]


def embed_musiccoca_text_style(style_model: Any, text_prompt: str) -> np.ndarray:
    """Embed only a constrained text prompt, excluding reference-audio style."""
    styles = np.asarray(
        style_model.embed([text_prompt], use_mapper=False),
        dtype=np.float32,
    )
    if styles.ndim != 2 or styles.shape[0] != 1:
        raise ValueError(
            "MusicCoCa must return one text embedding "
            f"with shape (1, embedding_dim); got {styles.shape}."
        )
    return styles[0]


def should_use_isolated_text_style(requested_role: str, resolved_role: str) -> bool:
    """Exclude full-mix timbre for explicit stems and isolated percussion routing."""
    normalized_requested_role = requested_role.lower().strip()
    return normalized_requested_role in STEM_ROLES or resolved_role == PERCUSSION_ROLE


def blend_style_vectors(audio_style: Any, text_style: Any) -> np.ndarray:
    styles = np.stack([as_style_vector(audio_style), as_style_vector(text_style)])
    weights = np.array([AUDIO_STYLE_WEIGHT, TEXT_STYLE_WEIGHT], dtype=np.float32)
    normalized_weights = weights / float(weights.sum())
    return np.sum(normalized_weights[:, np.newaxis] * styles, axis=0).astype(np.float32)


def log_style_embedding_norms(audio_style: Any, text_style: Any) -> None:
    weights = np.array([AUDIO_STYLE_WEIGHT, TEXT_STYLE_WEIGHT], dtype=np.float32)
    normalized_weights = weights / float(weights.sum())
    audio_vector = as_style_vector(audio_style)
    text_vector = as_style_vector(text_style)
    audio_norm = float(np.linalg.norm(audio_vector))
    text_norm = float(np.linalg.norm(text_vector))
    print(
        "MusicCoCa embedding norms: "
        f"audio={audio_norm:.3f}, text={text_norm:.3f}, "
        f"weighted_audio={audio_norm * float(normalized_weights[0]):.3f}, "
        f"weighted_text={text_norm * float(normalized_weights[1]):.3f}"
    )


def frames_per_beat_for_bpm(bpm: float) -> int:
    validated_bpm = validate_generation_bpm(bpm, required=True)
    seconds_per_beat = 60.0 / validated_bpm
    return max(1, int(round(MRT_FRAMES_PER_SECOND * seconds_per_beat)))


def model_frame_boundaries(
    bpm: float,
    total_steps: int,
    steps_per_beat: int = 1,
) -> list[int]:
    validated_bpm = validate_generation_bpm(bpm, required=True)
    if total_steps <= 0:
        raise ValueError("total_steps must be greater than 0")
    if steps_per_beat <= 0:
        raise ValueError("steps_per_beat must be greater than 0")

    frames_per_step = MRT_FRAMES_PER_SECOND * 60.0 / (validated_bpm * steps_per_beat)
    boundaries = [
        int(math.floor((step * frames_per_step) + 0.5))
        for step in range(total_steps + 1)
    ]
    if any(end <= start for start, end in zip(boundaries, boundaries[1:])):
        raise ValueError("BPM produces a zero-length Magenta frame chunk")
    return boundaries


def model_frame_schedule(
    bpm: float,
    total_steps: int,
    steps_per_beat: int = 1,
) -> list[int]:
    boundaries = model_frame_boundaries(bpm, total_steps, steps_per_beat)
    return [end - start for start, end in zip(boundaries, boundaries[1:])]


def clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return float(np.clip(value, 0.0, 1.0))


def load_reference_audio(path: str, sample_rate: int = MAGENTA_SAMPLE_RATE) -> np.ndarray:
    samples = librosa.load(path, sr=sample_rate, mono=False)[0]
    if samples.ndim == 1:
        samples = samples[:, np.newaxis]
    else:
        samples = samples.T
    if samples.size == 0:
        raise HTTPException(status_code=400, detail="Reference audio file is empty.")
    return samples.astype(np.float32, copy=False)


def trim_or_tile(samples: np.ndarray, target_samples: int) -> np.ndarray:
    if target_samples <= 0:
        return np.zeros((0, samples.shape[1]), dtype=np.float32)
    if len(samples) == 0:
        return np.zeros((target_samples, 1), dtype=np.float32)
    if len(samples) >= target_samples:
        return samples[:target_samples].astype(np.float32, copy=False)

    repeats = math.ceil(target_samples / len(samples))
    return np.tile(samples, (repeats, 1))[:target_samples].astype(np.float32, copy=False)


def normalize_vector(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    max_value = float(np.max(values)) if values.size else 0.0
    if max_value <= 1e-8:
        return np.zeros_like(values)
    return values / max_value


def onset_envelopes(
    mono: np.ndarray,
    sample_rate: int,
    hop_length: int = ONSET_HOP_LENGTH,
) -> tuple[np.ndarray, np.ndarray]:
    broadband = librosa.onset.onset_strength(
        y=mono,
        sr=sample_rate,
        hop_length=hop_length,
    )
    spectrum = np.abs(librosa.stft(mono, n_fft=2048, hop_length=hop_length))
    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=2048)
    low_bins = spectrum[frequencies <= 250.0]
    if low_bins.size:
        low_db = librosa.amplitude_to_db(low_bins, ref=np.max)
        low_frequency = librosa.onset.onset_strength(
            S=low_db,
            sr=sample_rate,
            hop_length=hop_length,
            aggregate=np.mean,
        )
    else:
        low_frequency = np.zeros_like(broadband)

    length = min(len(broadband), len(low_frequency))
    return normalize_vector(broadband[:length]), normalize_vector(low_frequency[:length])


def _sample_local_envelope_peaks(
    envelope: np.ndarray,
    positions: np.ndarray,
    radius: int,
) -> np.ndarray:
    values = np.zeros(len(positions), dtype=np.float32)
    for index, position in enumerate(positions):
        center = int(round(position))
        start = max(0, center - radius)
        end = min(len(envelope), center + radius + 1)
        if end > start:
            values[index] = float(np.max(envelope[start:end]))
    return values


def align_reference_capture(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    output_bars: int,
) -> CaptureAlignment:
    validated_bpm = validate_generation_bpm(bpm, required=True)
    target_samples = int(round(output_bars * BEATS_PER_BAR * 60.0 * sample_rate / validated_bpm))
    if len(samples) <= target_samples:
        return CaptureAlignment(
            samples=exact_length(samples, target_samples),
            start_sample=0,
            beat_phase_sample=0,
            downbeat_phase=0,
            confidence=0.0,
            warning="Capture was too short for confident downbeat alignment.",
        )

    mono = np.mean(samples, axis=1)
    try:
        broadband, low_frequency = onset_envelopes(mono, sample_rate)
    except Exception as error:
        logger.warning("Capture onset analysis failed: %s", error)
        return CaptureAlignment(
            samples=exact_length(samples[:target_samples], target_samples),
            start_sample=0,
            beat_phase_sample=0,
            downbeat_phase=0,
            confidence=0.0,
            warning="Downbeat detection was uncertain; using the best available beat phase.",
        )

    beat_frames = sample_rate * 60.0 / (validated_bpm * ONSET_HOP_LENGTH)
    phase_count = max(1, int(math.ceil(beat_frames)))
    combined = (0.58 * broadband) + (0.42 * low_frequency)
    local_peak_radius = max(1, int(round(0.08 * beat_frames)))
    phase_scores = np.zeros(phase_count, dtype=np.float64)
    for phase in range(phase_count):
        positions = phase + np.arange(
            max(0, int(math.floor((len(combined) - 1 - phase) / beat_frames)) + 1),
            dtype=np.float64,
        ) * beat_frames
        beat_values = _sample_local_envelope_peaks(
            combined,
            positions,
            local_peak_radius,
        )
        offbeat_values = _sample_local_envelope_peaks(
            combined,
            positions + (beat_frames * 0.5),
            local_peak_radius,
        )
        if beat_values.size:
            phase_scores[phase] = float(np.mean(beat_values) - (0.25 * np.mean(offbeat_values)))

    best_phase = int(np.argmax(phase_scores))
    beat_positions = best_phase + np.arange(
        max(0, int(math.floor((len(combined) - 1 - best_phase) / beat_frames)) + 1),
        dtype=np.float64,
    ) * beat_frames
    broadband_beats = _sample_local_envelope_peaks(
        broadband,
        beat_positions,
        local_peak_radius,
    )
    low_beats = _sample_local_envelope_peaks(
        low_frequency,
        beat_positions,
        local_peak_radius,
    )
    beat_strengths = (0.55 * broadband_beats) + (0.45 * low_beats)

    downbeat_scores = np.array(
        [
            float(np.mean(beat_strengths[phase::BEATS_PER_BAR]))
            if len(beat_strengths[phase::BEATS_PER_BAR])
            else 0.0
            for phase in range(BEATS_PER_BAR)
        ],
        dtype=np.float64,
    )
    downbeat_phase = int(np.argmax(downbeat_scores))
    sorted_downbeat_scores = np.sort(downbeat_scores)
    best_downbeat_score = float(sorted_downbeat_scores[-1]) if sorted_downbeat_scores.size else 0.0
    second_downbeat_score = float(sorted_downbeat_scores[-2]) if sorted_downbeat_scores.size > 1 else 0.0
    downbeat_confidence = (
        (best_downbeat_score - second_downbeat_score) / max(best_downbeat_score, 1e-8)
    )

    exclusion_radius = max(1, int(round(0.08 * beat_frames)))
    competing_scores = np.array(
        [
            score
            for index, score in enumerate(phase_scores)
            if min(abs(index - best_phase), phase_count - abs(index - best_phase)) > exclusion_radius
        ],
        dtype=np.float64,
    )
    best_phase_score = float(phase_scores[best_phase])
    second_phase_score = float(np.max(competing_scores)) if competing_scores.size else 0.0
    beat_phase_confidence = (
        (best_phase_score - second_phase_score) / max(abs(best_phase_score), 1e-8)
    )
    confidence = clamp01(0.25 * beat_phase_confidence + 0.75 * downbeat_confidence)

    beat_phase_sample = int(round(best_phase * ONSET_HOP_LENGTH))
    start_sample = int(round((best_phase + (downbeat_phase * beat_frames)) * ONSET_HOP_LENGTH))
    while start_sample + target_samples > len(samples) and start_sample >= int(
        round(BEATS_PER_BAR * beat_frames * ONSET_HOP_LENGTH)
    ):
        start_sample -= int(round(BEATS_PER_BAR * beat_frames * ONSET_HOP_LENGTH))
    start_sample = max(0, min(start_sample, len(samples) - target_samples))
    aligned = exact_length(samples[start_sample:start_sample + target_samples], target_samples)
    warning = None
    if confidence < CAPTURE_ALIGNMENT_CONFIDENCE_THRESHOLD:
        warning = "Downbeat detection was uncertain; using the best available beat phase."

    return CaptureAlignment(
        samples=aligned.astype(np.float32, copy=False),
        start_sample=start_sample,
        beat_phase_sample=beat_phase_sample,
        downbeat_phase=downbeat_phase,
        confidence=confidence,
        warning=warning,
    )


def grid_features(
    mono: np.ndarray,
    sample_rate: int,
    bpm: float,
    total_steps: int,
    steps_per_beat: int,
) -> tuple[np.ndarray, np.ndarray]:
    seconds_per_step = 60.0 / (bpm * steps_per_beat)
    energies = np.zeros(total_steps, dtype=np.float32)

    for step in range(total_steps):
        start = int(round(step * seconds_per_step * sample_rate))
        end = int(round((step + 1) * seconds_per_step * sample_rate))
        segment = mono[start:end]
        if segment.size:
            energies[step] = float(np.sqrt(np.mean(np.square(segment))))

    try:
        onset_env = librosa.onset.onset_strength(y=mono, sr=sample_rate, hop_length=512)
        onset_times = librosa.frames_to_time(np.arange(len(onset_env)), sr=sample_rate, hop_length=512)
        onset_density = np.zeros(total_steps, dtype=np.float32)
        for step in range(total_steps):
            start_time = step * seconds_per_step
            end_time = (step + 1) * seconds_per_step
            mask = (onset_times >= start_time) & (onset_times < end_time)
            if np.any(mask):
                onset_density[step] = float(np.mean(onset_env[mask]))
    except Exception:
        onset_density = np.zeros(total_steps, dtype=np.float32)

    return normalize_vector(energies), normalize_vector(onset_density)


def beat_grid_features(
    mono: np.ndarray,
    sample_rate: int,
    bpm: float,
    total_beats: int,
) -> tuple[np.ndarray, np.ndarray]:
    return grid_features(mono, sample_rate, bpm, total_beats, steps_per_beat=1)


def pitch_class_energy(mono: np.ndarray, sample_rate: int) -> np.ndarray:
    try:
        chroma = librosa.feature.chroma_cqt(y=mono, sr=sample_rate)
    except Exception:
        chroma = librosa.feature.chroma_stft(y=mono, sr=sample_rate)
    return normalize_vector(np.mean(chroma, axis=1))


def score_key_profile(chroma: np.ndarray, profile: np.ndarray, root_pitch_class: int) -> float:
    template = np.roll(profile, root_pitch_class)
    denominator = float(np.linalg.norm(chroma) * np.linalg.norm(template))
    if denominator <= 1e-8:
        return 0.0
    profile_score = float(np.dot(chroma, template) / denominator)
    return profile_score + (TONIC_KEY_WEIGHT * clamp01(float(chroma[root_pitch_class])))


def detect_key(chroma: np.ndarray) -> DetectedKey:
    chroma = normalize_vector(chroma)
    if chroma.size != 12 or float(np.max(chroma)) <= 1e-8:
        return DetectedKey(
            root_pitch_class=0,
            mode="major",
            major_score=0.0,
            minor_score=0.0,
            confidence=0.0,
        )

    candidates: list[tuple[float, int, str]] = []
    for root in range(12):
        candidates.append((score_key_profile(chroma, MAJOR_KEY_PROFILE, root), root, "major"))
        candidates.append((score_key_profile(chroma, MINOR_KEY_PROFILE, root), root, "minor"))

    candidates.sort(reverse=True, key=lambda item: item[0])
    best_score, root, mode = candidates[0]
    second_score = candidates[1][0] if len(candidates) > 1 else 0.0
    major_score = score_key_profile(chroma, MAJOR_KEY_PROFILE, root)
    minor_score = score_key_profile(chroma, MINOR_KEY_PROFILE, root)
    confidence = (best_score - second_score) / max(abs(best_score), 1e-8)

    return DetectedKey(
        root_pitch_class=root,
        mode=mode,
        major_score=major_score,
        minor_score=minor_score,
        confidence=float(confidence),
    )


def scale_pitch_classes_for_key(detected_key: DetectedKey) -> list[int]:
    scale = MINOR_SCALE if detected_key.mode == "minor" else MAJOR_SCALE
    return [int((detected_key.root_pitch_class + interval) % 12) for interval in scale]


def pitch_classes_for_key(detected_key: DetectedKey, chroma: np.ndarray | None = None) -> list[int]:
    pitch_classes = scale_pitch_classes_for_key(detected_key)
    if chroma is None or chroma.size != 12:
        return pitch_classes
    tonic = pitch_classes[0]
    remaining = sorted(pitch_classes[1:], key=lambda pc: float(chroma[pc]))
    return [tonic, *remaining]


def spectral_occupancy(mono: np.ndarray, sample_rate: int) -> dict[str, float]:
    spectrum = np.abs(librosa.stft(mono, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=2048)
    occupancy: dict[str, float] = {}
    for name, (lo, hi) in EQ_BANDS.items():
        mask = (freqs >= lo) & (freqs < hi)
        occupancy[name] = float(np.mean(spectrum[mask])) if np.any(mask) else 0.0

    max_value = max(occupancy.values()) if occupancy else 0.0
    if max_value > 1e-8:
        occupancy = {name: value / max_value for name, value in occupancy.items()}
    return occupancy


def analyze_reference(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    duration_bars: int | None,
    duration_seconds: float,
) -> dict[str, Any]:
    target_samples = int(round(duration_seconds * sample_rate))
    total_beats = max(1, int(duration_bars * BEATS_PER_BAR) if duration_bars else math.ceil(duration_seconds * bpm / 60.0))
    tiled = trim_or_tile(samples, target_samples)
    mono = np.mean(tiled, axis=1)
    beat_energy, onset_density = beat_grid_features(mono, sample_rate, bpm, total_beats)
    total_percussion_steps = total_beats * PERCUSSION_GRID_STEPS_PER_BEAT
    percussion_grid_energy, percussion_grid_onset_density = grid_features(
        mono,
        sample_rate,
        bpm,
        total_percussion_steps,
        PERCUSSION_GRID_STEPS_PER_BEAT,
    )
    chroma = pitch_class_energy(mono, sample_rate)
    detected_key = detect_key(chroma)

    return {
        "reference": tiled,
        "mono": mono,
        "total_beats": total_beats,
        "beat_energy": beat_energy,
        "onset_density": onset_density,
        "total_percussion_steps": total_percussion_steps,
        "percussion_grid_energy": percussion_grid_energy,
        "percussion_grid_onset_density": percussion_grid_onset_density,
        "pitch_classes": chroma,
        "detected_key": detected_key,
        "spectral": spectral_occupancy(mono, sample_rate),
    }


def resolve_stem_role(
    stem_role: str,
    spectral: dict[str, float],
    onset_density: np.ndarray,
    beat_energy: np.ndarray | None = None,
    prompt: str = "",
) -> str:
    role = stem_role.lower().strip()
    if role in STEM_ROLES:
        return role
    if role == "auto" and find_percussion_instrument(prompt):
        return PERCUSSION_ROLE

    onset = np.clip(np.asarray(onset_density, dtype=np.float32), 0.0, 1.0)
    energy = np.clip(
        np.asarray(beat_energy if beat_energy is not None else onset_density, dtype=np.float32),
        0.0,
        1.0,
    )
    mean_onset = float(np.mean(onset)) if onset.size else 0.0
    mean_energy = float(np.mean(energy)) if energy.size else 0.0
    rhythmic_gap = 1.0 - mean_onset
    dynamic_gap = 1.0 - mean_energy
    spectral_gap = {band: 1.0 - clamp01(float(spectral.get(band, 0.0))) for band in EQ_BANDS}

    role_scores = {
        "drums": (1.05 * rhythmic_gap) + (0.20 * dynamic_gap),
        "bass": spectral_gap["low"] + (0.08 * dynamic_gap) - (0.12 * mean_onset),
        "melody": spectral_gap["mid"] + (0.08 * rhythmic_gap),
        "texture": spectral_gap["high"] + (0.05 * rhythmic_gap),
    }
    if mean_onset > 0.62:
        role_scores["drums"] -= 0.35

    return max(("drums", "bass", "melody", "texture"), key=lambda candidate: role_scores[candidate])


def note_range_for_role(role: str) -> range:
    return ROLE_NOTE_RANGES.get(role, ROLE_NOTE_RANGES["melody"])


def choose_midi_note(pitch_class: int, midi_range: range) -> int:
    candidates = [note for note in midi_range if note % 12 == pitch_class]
    if not candidates:
        return midi_range.start
    return candidates[len(candidates) // 2]


def beat_space_scores(beat_energy: np.ndarray, onset_density: np.ndarray, role: str) -> np.ndarray:
    energy = np.clip(np.asarray(beat_energy, dtype=np.float32), 0.0, 1.0)
    onset = np.clip(np.asarray(onset_density, dtype=np.float32), 0.0, 1.0)
    activity = np.maximum(energy, onset)
    space = 1.0 - activity
    beats = np.arange(len(space))
    downbeats = (beats % BEATS_PER_BAR == 0).astype(np.float32)
    backbeats = (beats % BEATS_PER_BAR == 2).astype(np.float32)
    pickups = (beats % BEATS_PER_BAR == 3).astype(np.float32)
    even_beats = (beats % 2 == 0).astype(np.float32)

    if role == "drums":
        phrase_bonus = (0.16 * downbeats) + (0.10 * backbeats) + (0.08 * pickups)
    elif role == "bass":
        phrase_bonus = (0.20 * downbeats) + (0.08 * pickups)
    elif role == "texture":
        phrase_bonus = (0.16 * downbeats) + (0.08 * even_beats)
    else:
        phrase_bonus = (0.14 * downbeats) + (0.12 * pickups)

    return np.clip((0.76 * space) + phrase_bonus, 0.0, 1.25).astype(np.float32)


def conditioning_threshold(fill_scores: np.ndarray, role: str) -> float:
    if len(fill_scores) <= 1:
        return 0.0
    quantiles = {
        "drums": 0.42,
        "bass": 0.55,
        "melody": 0.50,
        "texture": 0.62,
    }
    return float(np.quantile(fill_scores, quantiles.get(role, 0.50)))


def pitch_class_for_stem_beat(role: str, beat: int, scale_pcs: list[int], complementary_pcs: list[int]) -> int:
    bar = beat // BEATS_PER_BAR
    beat_in_bar = beat % BEATS_PER_BAR
    if role == "bass":
        progression_degrees = (0, 4, 5, 3)
        if beat_in_bar == 0:
            return scale_pcs[progression_degrees[bar % len(progression_degrees)]]
        return complementary_pcs[(bar + beat_in_bar) % len(complementary_pcs)]
    if role == "texture":
        progression_degrees = (0, 3, 4, 5)
        return scale_pcs[progression_degrees[bar % len(progression_degrees)]]
    return complementary_pcs[(beat + bar) % len(complementary_pcs)]


def add_texture_chord(notes: list[int], root_pc: int, scale_pcs: list[int], midi_range: range, intensity: int) -> None:
    root_degree = scale_pcs.index(root_pc) if root_pc in scale_pcs else 0
    previous_note = -1
    for degree_offset in (0, 2, 4):
        pc = scale_pcs[(root_degree + degree_offset) % len(scale_pcs)]
        note = choose_midi_note(pc, midi_range)
        while note <= previous_note and note + 12 < midi_range.stop:
            note += 12
        if note in midi_range and 0 <= note < 128:
            notes[note] = intensity
            previous_note = note


def strongest_reference_pitch_class(
    detected_key: DetectedKey,
    chroma: np.ndarray,
) -> int:
    values = np.asarray(chroma, dtype=np.float32)
    if (
        detected_key.confidence < MIN_KEY_MODE_CONFIDENCE
        and values.size == 12
        and float(np.max(values)) > 1e-8
    ):
        return int(np.argmax(values))
    return detected_key.root_pitch_class


def quiet_percussion_slots(
    grid_energy: np.ndarray,
    grid_onset_density: np.ndarray,
    total_bars: int,
) -> set[int]:
    energy = np.clip(np.asarray(grid_energy, dtype=np.float32), 0.0, 1.0)
    onset = np.clip(np.asarray(grid_onset_density, dtype=np.float32), 0.0, 1.0)
    total_slots = total_bars * BEATS_PER_BAR * PERCUSSION_GRID_STEPS_PER_BEAT
    if len(energy) != total_slots or len(onset) != total_slots:
        raise ValueError("percussion analysis must contain four slots per bar")

    tie_priority = {
        slot: priority
        for priority, slot in enumerate(PERCUSSION_SLOT_TIE_PRIORITY)
    }
    selected: set[int] = set()
    slots_per_bar = BEATS_PER_BAR * PERCUSSION_GRID_STEPS_PER_BEAT
    for bar in range(total_bars):
        bar_start = bar * slots_per_bar
        ranked = sorted(
            range(slots_per_bar),
            key=lambda slot: (
                float(energy[bar_start + slot] + onset[bar_start + slot]),
                tie_priority[slot],
            ),
        )
        selected.update(bar_start + slot for slot in ranked[:4])
    return selected


def build_percussion_conditioning(
    analysis: dict[str, Any],
) -> list[tuple[list[int], list[int]]]:
    total_beats = int(analysis["total_beats"])
    total_bars = max(1, math.ceil(total_beats / BEATS_PER_BAR))
    total_slots = total_beats * PERCUSSION_GRID_STEPS_PER_BEAT
    grid_energy = np.asarray(
        analysis.get(
            "percussion_grid_energy",
            np.repeat(analysis["beat_energy"], PERCUSSION_GRID_STEPS_PER_BEAT),
        ),
        dtype=np.float32,
    )[:total_slots]
    grid_onset = np.asarray(
        analysis.get(
            "percussion_grid_onset_density",
            np.repeat(analysis["onset_density"], PERCUSSION_GRID_STEPS_PER_BEAT),
        ),
        dtype=np.float32,
    )[:total_slots]
    selected = quiet_percussion_slots(grid_energy, grid_onset, total_bars)
    return [
        ([0] * 128, [1 if slot in selected else 0])
        for slot in range(total_slots)
    ]


def build_conditioning(analysis: dict[str, Any], stem_role: str) -> list[tuple[list[int], list[int]]]:
    if stem_role == PERCUSSION_ROLE:
        return build_percussion_conditioning(analysis)

    role = resolve_stem_role(stem_role, analysis["spectral"], analysis["onset_density"], analysis["beat_energy"])
    beat_energy = analysis["beat_energy"]
    onset_density = analysis["onset_density"]
    total_beats = int(analysis["total_beats"])
    scale_pcs = scale_pitch_classes_for_key(analysis["detected_key"])
    complementary_pcs = pitch_classes_for_key(analysis["detected_key"], analysis["pitch_classes"])
    midi_range = note_range_for_role(role)
    fill_scores = beat_space_scores(beat_energy, onset_density, role)
    threshold = conditioning_threshold(fill_scores, role)
    conditioning: list[tuple[list[int], list[int]]] = []
    held_note: int | None = None
    motif_root_pc = strongest_reference_pitch_class(
        analysis["detected_key"],
        analysis["pitch_classes"],
    )
    motif_pitch_classes = (motif_root_pc, (motif_root_pc + 7) % 12)

    for beat in range(total_beats):
        notes = [0] * 128
        drums = [0]
        beat_in_bar = beat % BEATS_PER_BAR
        is_downbeat = beat_in_bar == 0
        should_fill = fill_scores[beat] >= threshold

        if role == "drums":
            sparse_beat = onset_density[beat] < 0.68
            trigger_drum = is_downbeat or ((should_fill or beat_in_bar == 2) and sparse_beat)
            drums = [1 if trigger_drum else 0]
        elif role == "melody":
            bar = beat // BEATS_PER_BAR
            note = choose_midi_note(
                motif_pitch_classes[bar % len(motif_pitch_classes)],
                midi_range,
            )
            if beat_in_bar == 0:
                notes[note] = 2
            elif beat_in_bar == 1:
                notes[note] = 1
        else:
            should_anchor = is_downbeat and (role in {"bass", "texture"} or fill_scores[beat] > 0.20)
            if should_fill or should_anchor:
                pc = pitch_class_for_stem_beat(role, beat, scale_pcs, complementary_pcs)
                note = choose_midi_note(pc, midi_range)
                if role == "texture":
                    add_texture_chord(notes, pc, scale_pcs, midi_range, 3 if is_downbeat else 1)
                    held_note = note
                else:
                    notes[note] = 1 if held_note == note else 2
                    held_note = note
            else:
                held_note = None

        conditioning.append((notes, drums))

    return conditioning


def generate_conditioned_chunks(
    mrt_runtime: Any,
    style: np.ndarray,
    conditioning: list[tuple[list[int], list[int]]],
    frame_schedule: list[int],
    temperature: float = 0.2,
    top_k: int = 40,
    cfg_notes: float = 3.0,
    cfg_drums: float = 7.0,
) -> list[Any]:
    if len(conditioning) != len(frame_schedule):
        raise ValueError("conditioning and frame_schedule must have the same length")

    chunks: list[Any] = []
    state = None
    for (notes, drums), frames in zip(conditioning, frame_schedule):
        chunk, state = mrt_runtime.generate(
            style=style,
            drums=drums,
            notes=notes,
            top_k=top_k,
            state=state,
            frames=frames,
            temperature=temperature,
            cfg_notes=cfg_notes,
            cfg_drums=cfg_drums,
        )
        chunks.append(chunk)
    return chunks


def waveform_to_samples(waveform: Any) -> tuple[np.ndarray, int]:
    buf = io.BytesIO()
    waveform.write(buf, format="WAV")
    buf.seek(0)
    samples, sample_rate = sf.read(buf, dtype="float32", always_2d=True)
    return samples.astype(np.float32, copy=False), int(sample_rate)


def build_beat_time_map(
    frame_boundaries: list[int],
    source_samples: int,
    target_samples: int,
) -> list[tuple[int, int]]:
    if len(frame_boundaries) < 2 or frame_boundaries[0] != 0:
        raise ValueError("frame_boundaries must begin at zero and contain at least one beat")
    if source_samples <= 0 or target_samples <= 0:
        raise ValueError("source_samples and target_samples must be greater than zero")
    total_frames = frame_boundaries[-1]
    if total_frames <= 0:
        raise ValueError("final model-frame boundary must be greater than zero")

    total_beats = len(frame_boundaries) - 1
    time_map = [
        (
            int(round((boundary / total_frames) * source_samples)),
            int(round((beat / total_beats) * target_samples)),
        )
        for beat, boundary in enumerate(frame_boundaries)
    ]
    time_map[0] = (0, 0)
    time_map[-1] = (source_samples, target_samples)
    return time_map


def _run_rubberband_time_map(
    samples: np.ndarray,
    sample_rate: int,
    target_samples: int,
    time_map: list[tuple[int, int]],
    executable: str,
) -> np.ndarray:
    duration_seconds = target_samples / sample_rate
    with tempfile.TemporaryDirectory(prefix="magenta-timing-") as temp_dir:
        input_path = os.path.join(temp_dir, "input.wav")
        output_path = os.path.join(temp_dir, "output.wav")
        map_path = os.path.join(temp_dir, "timemap.txt")
        sf.write(input_path, samples, sample_rate, subtype="FLOAT")
        with open(map_path, "w", encoding="utf-8") as map_file:
            map_file.write(
                "\n".join(f"{source_frame} {target_frame}" for source_frame, target_frame in time_map)
            )
            map_file.write("\n")

        completed = subprocess.run(
            [
                executable,
                "--fine",
                "--duration",
                f"{duration_seconds:.9f}",
                "--timemap",
                map_path,
                input_path,
                output_path,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout).strip()
            raise RuntimeError(f"Rubber Band exited with {completed.returncode}: {detail}")
        corrected, corrected_sample_rate = sf.read(output_path, dtype="float32", always_2d=True)
        if corrected_sample_rate != sample_rate:
            raise RuntimeError(
                f"Rubber Band changed the sample rate from {sample_rate} to {corrected_sample_rate}"
            )
        return exact_length(corrected.astype(np.float32, copy=False), target_samples)


def librosa_global_time_stretch(samples: np.ndarray, target_samples: int) -> np.ndarray:
    if target_samples <= 0:
        raise ValueError("target_samples must be greater than zero")
    if len(samples) == target_samples:
        return samples.astype(np.float32, copy=True)
    rate = len(samples) / target_samples
    stretched = librosa.effects.time_stretch(samples.T, rate=rate).T
    return exact_length(stretched.astype(np.float32, copy=False), target_samples)


def _confident_onset_samples(
    samples: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, np.ndarray]:
    mono = np.mean(samples, axis=1)
    envelope = librosa.onset.onset_strength(
        y=mono,
        sr=sample_rate,
        hop_length=ONSET_HOP_LENGTH,
    )
    if envelope.size == 0 or float(np.max(envelope)) <= 1e-8:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=envelope,
        sr=sample_rate,
        hop_length=ONSET_HOP_LENGTH,
        backtrack=False,
        units="frames",
    )
    if onset_frames.size == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
    strengths = envelope[onset_frames].astype(np.float32)
    threshold = float(np.quantile(strengths, 0.35))
    mask = strengths >= threshold
    return (onset_frames[mask] * ONSET_HOP_LENGTH).astype(np.int64), strengths[mask]


def analyze_onset_alignment(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    steps_per_beat: int = DEFAULT_GRID_STEPS_PER_BEAT,
) -> OnsetAlignment:
    onset_samples, strengths = _confident_onset_samples(samples, sample_rate)
    if onset_samples.size == 0:
        return OnsetAlignment(
            median_ms=None,
            p95_ms=None,
            phase_shift_samples=0,
            phase_confidence=0.0,
        )

    grid_samples = sample_rate * 60.0 / (bpm * steps_per_beat)
    signed_errors = (
        (onset_samples + (grid_samples / 2.0)) % grid_samples
    ) - (grid_samples / 2.0)
    absolute_errors_ms = np.abs(signed_errors) * 1000.0 / sample_rate
    angles = signed_errors * (2.0 * math.pi / grid_samples)
    weights = strengths / max(float(np.sum(strengths)), 1e-8)
    mean_vector = np.sum(weights * np.exp(1j * angles))
    phase_confidence = float(np.abs(mean_vector))
    phase_error_samples = (
        float(np.angle(mean_vector)) * grid_samples / (2.0 * math.pi)
        if phase_confidence > 1e-8
        else 0.0
    )
    max_shift_samples = int(round(MAX_PHASE_SHIFT_SECONDS * sample_rate))
    phase_shift_samples = 0
    if phase_confidence >= 0.58:
        phase_shift_samples = int(
            round(np.clip(-phase_error_samples, -max_shift_samples, max_shift_samples))
        )

    return OnsetAlignment(
        median_ms=float(np.median(absolute_errors_ms)),
        p95_ms=float(np.percentile(absolute_errors_ms, 95)),
        phase_shift_samples=phase_shift_samples,
        phase_confidence=phase_confidence,
    )


def apply_circular_phase_shift(samples: np.ndarray, shift_samples: int) -> np.ndarray:
    if shift_samples == 0 or len(samples) == 0:
        return samples
    bounded_shift = int(
        np.clip(shift_samples, -len(samples) + 1, len(samples) - 1)
    )
    return np.roll(samples, bounded_shift, axis=0)


def residual_alignment_exceeds_threshold(
    alignment: OnsetAlignment,
    max_median_ms: float = MAX_MEDIAN_ALIGNMENT_MS,
    max_p95_ms: float = MAX_P95_ALIGNMENT_MS,
) -> bool:
    if alignment.median_ms is None or alignment.p95_ms is None:
        return False
    return (
        alignment.median_ms > max_median_ms
        or alignment.p95_ms > max_p95_ms
    )


def add_confident_subdivision_anchors(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    base_time_map: list[tuple[int, int]],
    steps_per_beat: int = DEFAULT_GRID_STEPS_PER_BEAT,
) -> list[tuple[int, int]]:
    onset_samples, strengths = _confident_onset_samples(samples, sample_rate)
    if onset_samples.size == 0:
        return base_time_map

    source_points = np.array([point[0] for point in base_time_map], dtype=np.float64)
    target_points = np.array([point[1] for point in base_time_map], dtype=np.float64)
    grid_samples = sample_rate * 60.0 / (bpm * steps_per_beat)
    candidate_anchors: list[tuple[int, int]] = []
    strong_threshold = float(np.quantile(strengths, 0.35))
    maximum_anchor_error = min(
        0.45 * grid_samples,
        MAX_PHASE_SHIFT_SECONDS * sample_rate,
    )
    for onset_sample, strength in zip(onset_samples, strengths):
        if strength < strong_threshold:
            continue
        mapped_target = float(np.interp(onset_sample, source_points, target_points))
        quantized_target = int(round(mapped_target / grid_samples) * grid_samples)
        if abs(mapped_target - quantized_target) <= maximum_anchor_error:
            candidate_anchors.append((int(onset_sample), quantized_target))

    dense_map = [base_time_map[0]]
    for left_anchor, right_anchor in zip(base_time_map, base_time_map[1:]):
        interval_candidates = sorted(
            (
                anchor
                for anchor in candidate_anchors
                if left_anchor[0] < anchor[0] < right_anchor[0]
                and left_anchor[1] < anchor[1] < right_anchor[1]
            ),
            key=lambda point: (point[0], point[1]),
        )
        for anchor in interval_candidates:
            if anchor[0] > dense_map[-1][0] and anchor[1] > dense_map[-1][1]:
                dense_map.append(anchor)
        dense_map.append(right_anchor)
    return dense_map


def replace_confident_grid_anchors(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    base_time_map: list[tuple[int, int]],
    steps_per_beat: int,
) -> list[tuple[int, int]]:
    """Replace each grid slot's source anchor with its strongest nearby attack."""
    onset_samples, strengths = _confident_onset_samples(samples, sample_rate)
    if onset_samples.size == 0 or len(base_time_map) < 3:
        return base_time_map

    source_points = np.array([point[0] for point in base_time_map], dtype=np.float64)
    target_points = np.array([point[1] for point in base_time_map], dtype=np.float64)
    grid_samples = sample_rate * 60.0 / (bpm * steps_per_beat)
    maximum_anchor_error = min(
        0.45 * grid_samples,
        MAX_PHASE_SHIFT_SECONDS * sample_rate,
    )
    strongest_by_slot: dict[int, tuple[int, float]] = {}
    for onset_sample, strength in zip(onset_samples, strengths):
        mapped_target = float(np.interp(onset_sample, source_points, target_points))
        slot = int(round(mapped_target / grid_samples))
        if slot <= 0 or slot >= len(base_time_map) - 1:
            continue
        slot_target = float(base_time_map[slot][1])
        if abs(mapped_target - slot_target) > maximum_anchor_error:
            continue
        previous = strongest_by_slot.get(slot)
        if previous is None or float(strength) > previous[1]:
            strongest_by_slot[slot] = (int(onset_sample), float(strength))

    replaced = list(base_time_map)
    for slot in sorted(strongest_by_slot):
        source_sample = strongest_by_slot[slot][0]
        if replaced[slot - 1][0] < source_sample < replaced[slot + 1][0]:
            replaced[slot] = (source_sample, replaced[slot][1])
    return replaced


def onset_alignment_improves(
    candidate: OnsetAlignment,
    baseline: OnsetAlignment,
) -> bool:
    candidate_values = (candidate.median_ms, candidate.p95_ms)
    baseline_values = (baseline.median_ms, baseline.p95_ms)
    if all(value is None for value in candidate_values):
        return False
    if all(value is None for value in baseline_values):
        return True

    candidate_error = np.array(
        [
            value if value is not None else math.inf
            for value in candidate_values
        ],
        dtype=np.float64,
    )
    baseline_error = np.array(
        [
            value if value is not None else math.inf
            for value in baseline_values
        ],
        dtype=np.float64,
    )
    return bool(
        np.all(candidate_error <= baseline_error)
        and np.any(candidate_error < baseline_error)
    )


def _phase_correct_and_measure(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    steps_per_beat: int = DEFAULT_GRID_STEPS_PER_BEAT,
) -> tuple[np.ndarray, float, OnsetAlignment]:
    initial_alignment = analyze_onset_alignment(samples, sample_rate, bpm, steps_per_beat)
    shifted = apply_circular_phase_shift(samples, initial_alignment.phase_shift_samples)
    phase_shift_ms = initial_alignment.phase_shift_samples * 1000.0 / sample_rate
    final_alignment = (
        analyze_onset_alignment(shifted, sample_rate, bpm, steps_per_beat)
        if initial_alignment.phase_shift_samples
        else initial_alignment
    )
    return shifted, phase_shift_ms, final_alignment


def correct_generation_timing(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    duration_seconds: float,
    frame_boundaries: list[int],
    rubberband_executable: str | None = None,
    quantize_transients: bool = False,
    grid_steps_per_beat: int = DEFAULT_GRID_STEPS_PER_BEAT,
    replace_grid_anchors: bool = False,
    max_median_ms: float = MAX_MEDIAN_ALIGNMENT_MS,
    max_p95_ms: float = MAX_P95_ALIGNMENT_MS,
) -> TimingCorrection:
    target_samples = int(round(duration_seconds * sample_rate))
    beat_time_map = build_beat_time_map(frame_boundaries, len(samples), target_samples)
    executable = (
        shutil.which("rubberband")
        if rubberband_executable is None
        else rubberband_executable
    )
    fallback_warning: str | None = None

    if executable:
        try:
            corrected = _run_rubberband_time_map(
                samples,
                sample_rate,
                target_samples,
                beat_time_map,
                executable,
            )
            corrected, phase_shift_ms, alignment = _phase_correct_and_measure(
                corrected,
                sample_rate,
                bpm,
                grid_steps_per_beat,
            )
            correction_type = "rubberband_beat_map"
            if quantize_transients or residual_alignment_exceeds_threshold(
                alignment,
                max_median_ms,
                max_p95_ms,
            ):
                if replace_grid_anchors:
                    dense_time_map = replace_confident_grid_anchors(
                        samples,
                        sample_rate,
                        bpm,
                        beat_time_map,
                        grid_steps_per_beat,
                    )
                else:
                    dense_time_map = add_confident_subdivision_anchors(
                        samples,
                        sample_rate,
                        bpm,
                        beat_time_map,
                        grid_steps_per_beat,
                    )
                if dense_time_map != beat_time_map:
                    dense = _run_rubberband_time_map(
                        samples,
                        sample_rate,
                        target_samples,
                        dense_time_map,
                        executable,
                    )
                    dense, dense_phase_shift_ms, dense_alignment = _phase_correct_and_measure(
                        dense,
                        sample_rate,
                        bpm,
                        grid_steps_per_beat,
                    )
                    if onset_alignment_improves(dense_alignment, alignment):
                        corrected = dense
                        phase_shift_ms = dense_phase_shift_ms
                        alignment = dense_alignment
                        correction_type = (
                            "rubberband_quarter_map"
                            if replace_grid_anchors and grid_steps_per_beat == 1
                            else "rubberband_subdivision_map"
                        )
            return TimingCorrection(
                samples=exact_length(corrected, target_samples),
                correction_type=correction_type,
                phase_shift_ms=phase_shift_ms,
                alignment=alignment,
                fallback_warning=None,
            )
        except Exception as error:
            logger.warning("Rubber Band timing correction failed; using librosa fallback: %s", error)
            fallback_warning = "Rubber Band correction failed; used librosa timing fallback."
    else:
        logger.warning("Rubber Band is unavailable; using librosa timing fallback")
        fallback_warning = "Rubber Band is unavailable; used librosa timing fallback."

    corrected = librosa_global_time_stretch(samples, target_samples)
    corrected, phase_shift_ms, alignment = _phase_correct_and_measure(
        corrected,
        sample_rate,
        bpm,
        grid_steps_per_beat,
    )
    return TimingCorrection(
        samples=exact_length(corrected, target_samples),
        correction_type="librosa_global",
        phase_shift_ms=phase_shift_ms,
        alignment=alignment,
        fallback_warning=fallback_warning,
    )


def exact_length(samples: np.ndarray, target_samples: int) -> np.ndarray:
    if len(samples) > target_samples:
        return samples[:target_samples]
    if len(samples) < target_samples:
        pad = np.zeros((target_samples - len(samples), samples.shape[1]), dtype=np.float32)
        return np.vstack([samples, pad])
    return samples


def smooth_loop_boundary(samples: np.ndarray, sample_rate: int, fade_seconds: float = 0.04) -> np.ndarray:
    fade_samples = min(int(round(fade_seconds * sample_rate)), len(samples) // 4)
    if fade_samples <= 1:
        return samples

    output = samples.copy()
    fade = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)[:, np.newaxis]
    output[-fade_samples:] = (output[-fade_samples:] * (1.0 - fade)) + (output[:fade_samples] * fade)
    return output


def bar_rms_db(samples: np.ndarray, total_bars: int) -> np.ndarray:
    if total_bars <= 0:
        raise ValueError("total_bars must be greater than zero")

    boundaries = np.linspace(0, len(samples), total_bars + 1, dtype=np.int64)
    levels = np.full(total_bars, -math.inf, dtype=np.float64)
    for bar, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        segment = samples[start:end]
        if segment.size:
            rms = float(np.sqrt(np.mean(np.square(segment, dtype=np.float64))))
            if rms > 1e-8:
                levels[bar] = 20.0 * math.log10(rms)
    return levels


def level_bar_dynamics(
    samples: np.ndarray,
    sample_rate: int,
    total_bars: int,
    tolerance_db: float = BAR_LEVEL_TOLERANCE_DB,
    max_adjustment_db: float = MAX_BAR_LEVEL_ADJUSTMENT_DB,
    transition_seconds: float = BAR_LEVEL_TRANSITION_SECONDS,
) -> np.ndarray:
    if total_bars <= 1 or len(samples) == 0:
        return samples.astype(np.float32, copy=True)
    if tolerance_db < 0 or max_adjustment_db < 0 or transition_seconds < 0:
        raise ValueError("Bar leveling settings must not be negative")

    levels_db = bar_rms_db(samples, total_bars)
    finite_levels = levels_db[np.isfinite(levels_db)]
    if finite_levels.size < 2:
        return samples.astype(np.float32, copy=True)

    loudest_db = float(np.max(finite_levels))
    usable_mask = np.isfinite(levels_db) & (levels_db >= loudest_db - 40.0)
    usable_levels = levels_db[usable_mask]
    if usable_levels.size < 2:
        return samples.astype(np.float32, copy=True)

    target_db = float(np.median(usable_levels))
    lower_db = target_db - tolerance_db
    upper_db = target_db + tolerance_db
    adjustments_db = np.zeros(total_bars, dtype=np.float64)
    for bar, level_db in enumerate(levels_db):
        if not usable_mask[bar]:
            continue
        if level_db < lower_db:
            adjustments_db[bar] = min(lower_db - level_db, max_adjustment_db)
        elif level_db > upper_db:
            adjustments_db[bar] = max(upper_db - level_db, -max_adjustment_db)

    if np.allclose(adjustments_db, 0.0):
        return samples.astype(np.float32, copy=True)

    gains = np.power(10.0, adjustments_db / 20.0)
    boundaries = np.linspace(0, len(samples), total_bars + 1, dtype=np.int64)
    envelope = np.ones(len(samples), dtype=np.float64)
    for bar, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        envelope[start:end] = gains[bar]

    transition_samples = max(0, int(round(transition_seconds * sample_rate)))
    for boundary_index, bar_boundary in enumerate(boundaries[1:-1], start=1):
        half_transition = min(
            transition_samples // 2,
            int(bar_boundary - boundaries[boundary_index - 1]),
            int(boundaries[boundary_index + 1] - bar_boundary),
        )
        if half_transition <= 0:
            continue
        start = int(bar_boundary - half_transition)
        end = int(bar_boundary + half_transition)
        phase = np.linspace(0.0, 1.0, end - start, endpoint=False)
        blend = 0.5 - (0.5 * np.cos(np.pi * phase))
        left_gain = gains[boundary_index - 1]
        right_gain = gains[boundary_index]
        envelope[start:end] = left_gain + ((right_gain - left_gain) * blend)

    logger.info(
        "Magenta bar leveling: levels_db=%s target_db=%.2f adjustments_db=%s",
        [round(float(level), 2) if math.isfinite(level) else None for level in levels_db],
        target_db,
        [round(float(adjustment), 2) for adjustment in adjustments_db],
    )
    return (samples * envelope[:, np.newaxis]).astype(np.float32)


def apply_spectral_ducking(samples: np.ndarray, reference: np.ndarray, sample_rate: int) -> np.ndarray:
    ref_mono = np.mean(reference, axis=1)
    ref_mag = np.mean(np.abs(librosa.stft(ref_mono, n_fft=2048, hop_length=512)), axis=1)
    ref_profile = normalize_vector(ref_mag)
    attenuation = 1.0 - (0.38 * np.power(ref_profile, 0.65))
    attenuation = np.clip(attenuation, 0.55, 1.0)[:, np.newaxis]

    processed = np.zeros_like(samples, dtype=np.float32)
    for channel in range(samples.shape[1]):
        spectrum = librosa.stft(samples[:, channel], n_fft=2048, hop_length=512)
        ducked = spectrum * attenuation
        processed[:, channel] = librosa.istft(ducked, hop_length=512, length=len(samples)).astype(np.float32)
    return processed


def normalize_to_full_scale(samples: np.ndarray) -> np.ndarray:
    max_abs = float(np.max(np.abs(samples))) if samples.size else 0.0
    if max_abs > 1e-8:
        samples = samples / max_abs
    return np.clip(samples, -1.0, 1.0).astype(np.float32, copy=False)


def post_process_generation(
    samples: np.ndarray,
    sample_rate: int,
    reference: np.ndarray,
    duration_seconds: float,
    avoid_clash: bool,
    duration_bars: int | None = None,
    stem_role: str | None = None,
) -> np.ndarray:
    target_samples = int(round(duration_seconds * sample_rate))
    output = exact_length(samples, target_samples)
    if avoid_clash and stem_role != PERCUSSION_ROLE:
        output = apply_spectral_ducking(output, trim_or_tile(reference, target_samples), sample_rate)
    if duration_bars is not None:
        output = level_bar_dynamics(output, sample_rate, duration_bars)
    output = smooth_loop_boundary(output, sample_rate)
    return normalize_to_full_scale(exact_length(output, target_samples))


def safe_filename(prompt: str) -> str:
    clean = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in prompt[:30])
    return clean.strip("_") or "magic"


def combine_timing_warnings(*warnings: str | None) -> str | None:
    unique: list[str] = []
    for warning in warnings:
        if warning and warning not in unique:
            unique.append(warning)
    return " ".join(unique) if unique else None


def timing_response_headers(diagnostics: TimingDiagnostics) -> dict[str, str]:
    headers = {"X-Magenta-Timing-Status": diagnostics.timing_status}
    if diagnostics.warning:
        headers["X-Magenta-Timing-Warning"] = diagnostics.warning
    if diagnostics.residual_median_ms is not None:
        headers["X-Magenta-Alignment-Ms"] = f"{diagnostics.residual_median_ms:.2f}"
    return headers


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MAGENTA_MODEL,
        "magenta_home": MAGENTA_RT_HOME,
    }


@app.post("/detect-bpm")
async def detect_bpm(audio_file: UploadFile = File(..., description="Original audio file")):
    try:
        aubio_module = get_aubio_runtime()
    except AubioUnavailableError as e:
        raise HTTPException(status_code=503, detail=f"Aubio BPM detection unavailable: {e}") from e

    suffix = os.path.splitext(audio_file.filename or "")[-1] or ".audio"
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            contents = await audio_file.read()
            if not contents:
                raise HTTPException(status_code=400, detail="Could not read audio file: file is empty.")
            tmp.write(contents)
        try:
            return detect_bpm_from_file(tmp_path, aubio_module, log_result=True)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read audio file: {e}") from e
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass


@app.post("/generate")
async def generate(
    audio_file: UploadFile = File(..., description="Reference audio file (WAV, 48kHz preferred)"),
    prompt: str = Form(..., description="Text style prompt e.g. 'dark trap 808s'"),
    duration_bars: int | None = Form(None, description="Output duration in bars"),
    bpm: float | None = Form(None, description="Project tempo in beats per minute"),
    stem_role: str = Form("auto", description="Complementary stem role: auto, melody, bass, drums, or texture"),
    avoid_clash: bool = Form(True, description="Apply spectral anti-clash processing"),
    temperature: float | None = Form(None, description="MRT sampling temperature"),
    top_k: int | None = Form(None, description="MRT top-k sampling threshold"),
    cfg_notes: float | None = Form(None, description="MRT notes classifier-free guidance"),
    cfg_drums: float | None = Form(None, description="MRT drums classifier-free guidance"),
):
    """
    Generate music blending an uploaded audio file with a text prompt.
    Returns a WAV file.
    """

    # --- Resolve and validate duration ---
    generation_bpm = validate_generation_bpm(bpm, required=True)
    duration_seconds = resolve_duration_seconds(duration_bars, bpm)
    requested_role = stem_role.lower().strip()
    percussion_instrument = find_percussion_instrument(prompt)
    prompt_routes_to_percussion = requested_role == "auto" and percussion_instrument is not None
    temperature, top_k, cfg_notes, cfg_drums = resolve_sampling_parameters(
        temperature,
        top_k,
        cfg_notes,
        cfg_drums,
        prompt_routes_to_percussion,
    )

    try:
        audio, style_model, mrt = get_magenta_runtime()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Magenta runtime unavailable: {e}") from e

    # --- Save uploaded file to temp ---
    suffix = os.path.splitext(audio_file.filename or "")[-1] or ".wav"
    uploaded_audio = await audio_file.read()
    if not uploaded_audio:
        raise HTTPException(status_code=400, detail="Reference audio file is empty.")
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(uploaded_audio)
        tmp_path = tmp.name

    aligned_path: str | None = None
    try:
        # --- Load and align the five-bar capture to a four-bar downbeat ---
        try:
            reference_samples = load_reference_audio(tmp_path, MAGENTA_SAMPLE_RATE)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read audio file: {e}")
        capture_alignment = align_reference_capture(
            reference_samples,
            MAGENTA_SAMPLE_RATE,
            generation_bpm,
            int(duration_bars),
        )
        analysis = analyze_reference(
            capture_alignment.samples,
            MAGENTA_SAMPLE_RATE,
            generation_bpm,
            duration_bars,
            duration_seconds,
        )
        resolved_stem_role = resolve_stem_role(
            stem_role,
            analysis["spectral"],
            analysis["onset_density"],
            analysis["beat_energy"],
            prompt,
        )
        conditioning = build_conditioning(analysis, resolved_stem_role)
        detected_key: DetectedKey = analysis["detected_key"]
        scale_pitch_classes = pitch_classes_for_key(detected_key, analysis["pitch_classes"])
        print(
            "Reference key detected: "
            f"{detected_key.name} "
            f"(root_pc={detected_key.root_pitch_class}, "
            f"major_score={detected_key.major_score:.3f}, "
            f"minor_score={detected_key.minor_score:.3f}, "
            f"confidence={detected_key.confidence:.3f}, "
            f"scale_pcs={scale_pitch_classes})"
        )
        resolved_instrument = (
            percussion_instrument
            if resolved_stem_role == PERCUSSION_ROLE
            else None
        )
        print(
            f"Resolved stem role: {resolved_stem_role}; "
            f"instrument: {resolved_instrument or 'n/a'}"
        )

        # --- Condition style ---
        mrt_style_prompt = build_mrt_style_prompt(
            prompt,
            generation_bpm,
            detected_key,
            resolved_stem_role,
            resolved_instrument,
        )
        print(f"MRT style prompt: {mrt_style_prompt}")
        isolated_text_style = should_use_isolated_text_style(
            requested_role,
            resolved_stem_role,
        )
        conditioning_description = (
            "isolated text-only"
            if isolated_text_style
            else "blended reference-audio and text"
        )
        print(f"Style conditioning: {conditioning_description}")
        if isolated_text_style:
            generation_style = embed_musiccoca_text_style(style_model, mrt_style_prompt)
            print(
                "MusicCoCa text-only embedding norm: "
                f"{float(np.linalg.norm(generation_style)):.3f}"
            )
        else:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as aligned_file:
                aligned_path = aligned_file.name
            sf.write(
                aligned_path,
                capture_alignment.samples,
                MAGENTA_SAMPLE_RATE,
                subtype="FLOAT",
            )
            try:
                my_audio = audio.Waveform.from_file(aligned_path)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Could not prepare aligned audio: {e}")
            audio_style, text_style = embed_musiccoca_styles(style_model, my_audio, mrt_style_prompt)
            log_style_embedding_norms(audio_style, text_style)
            generation_style = blend_style_vectors(audio_style, text_style)

        # --- Generate grid-aligned chunks ---
        steps_per_beat = (
            PERCUSSION_GRID_STEPS_PER_BEAT
            if resolved_stem_role == PERCUSSION_ROLE
            else 1
        )
        frame_boundaries = model_frame_boundaries(
            generation_bpm,
            len(conditioning),
            steps_per_beat,
        )
        frame_schedule = [
            end - start
            for start, end in zip(frame_boundaries, frame_boundaries[1:])
        ]
        chunks = generate_conditioned_chunks(
            mrt,
            generation_style,
            conditioning,
            frame_schedule,
            temperature,
            top_k,
            cfg_notes,
            cfg_drums,
        )

        # --- Concatenate & return as WAV bytes ---
        output_waveform = audio.concatenate(chunks)
        samples, sample_rate = waveform_to_samples(output_waveform)
        timing_correction = correct_generation_timing(
            samples,
            sample_rate,
            generation_bpm,
            duration_seconds,
            frame_boundaries,
            quantize_transients=resolved_stem_role in {"drums", "melody", PERCUSSION_ROLE},
            grid_steps_per_beat=(
                PERCUSSION_GRID_STEPS_PER_BEAT
                if resolved_stem_role == PERCUSSION_ROLE
                else DEFAULT_GRID_STEPS_PER_BEAT
            ),
            replace_grid_anchors=resolved_stem_role == PERCUSSION_ROLE,
            max_median_ms=(
                PERCUSSION_MAX_MEDIAN_ALIGNMENT_MS
                if resolved_stem_role == PERCUSSION_ROLE
                else MAX_MEDIAN_ALIGNMENT_MS
            ),
            max_p95_ms=(
                PERCUSSION_MAX_P95_ALIGNMENT_MS
                if resolved_stem_role == PERCUSSION_ROLE
                else MAX_P95_ALIGNMENT_MS
            ),
        )
        processed = post_process_generation(
            timing_correction.samples,
            sample_rate,
            analysis["reference"],
            duration_seconds,
            avoid_clash,
            duration_bars,
            resolved_stem_role,
        )
        residual_warning = None
        max_median_ms = (
            PERCUSSION_MAX_MEDIAN_ALIGNMENT_MS
            if resolved_stem_role == PERCUSSION_ROLE
            else MAX_MEDIAN_ALIGNMENT_MS
        )
        max_p95_ms = (
            PERCUSSION_MAX_P95_ALIGNMENT_MS
            if resolved_stem_role == PERCUSSION_ROLE
            else MAX_P95_ALIGNMENT_MS
        )
        if residual_alignment_exceeds_threshold(
            timing_correction.alignment,
            max_median_ms,
            max_p95_ms,
        ):
            residual_warning = "Residual onset alignment remains above the timing target."
        warning = combine_timing_warnings(
            capture_alignment.warning,
            timing_correction.fallback_warning,
            residual_warning,
        )
        if timing_correction.fallback_warning:
            timing_status = "fallback"
        elif capture_alignment.warning or residual_warning:
            timing_status = "uncertain"
        else:
            timing_status = "aligned"
        diagnostics = TimingDiagnostics(
            capture_phase_samples=capture_alignment.beat_phase_sample,
            capture_downbeat_phase=capture_alignment.downbeat_phase,
            capture_alignment_confidence=capture_alignment.confidence,
            model_frame_schedule=frame_schedule,
            raw_duration_seconds=len(samples) / sample_rate,
            corrected_duration_seconds=len(processed) / sample_rate,
            correction_type=timing_correction.correction_type,
            phase_shift_ms=timing_correction.phase_shift_ms,
            residual_median_ms=timing_correction.alignment.median_ms,
            residual_p95_ms=timing_correction.alignment.p95_ms,
            timing_status=timing_status,
            warning=warning,
            timing_grid=(
                PERCUSSION_GRID_LABEL
                if resolved_stem_role == PERCUSSION_ROLE
                else DEFAULT_GRID_LABEL
            ),
            resolved_instrument=resolved_instrument,
        )
        logger.info(
            "Magenta timing diagnostics: %s",
            json.dumps(asdict(diagnostics), sort_keys=True),
        )

        buf = io.BytesIO()
        sf.write(buf, processed, sample_rate, format="WAV", subtype="PCM_16")
        buf.seek(0)

        filename = f"magenta_{safe_filename(prompt)}.wav"
        response_headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            **timing_response_headers(diagnostics),
        }
        return StreamingResponse(
            buf,
            media_type="audio/wav",
            headers=response_headers,
        )

    finally:
        for path in (aligned_path, tmp_path):
            if path is not None:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run("magenta_server:app", host="0.0.0.0", port=8000, reload=False)
