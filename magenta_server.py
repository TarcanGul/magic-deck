"""
Magenta RT2 FastAPI Server
--------------------------
Endpoints:
  POST /generate  — generate audio from audio file + text prompt
  GET  /health    — health check
"""

import io
import math
import tempfile
import os
from dataclasses import dataclass
from typing import Any
import numpy as np
import librosa
import soundfile as sf

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
PITCH_CLASS_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
MAJOR_SCALE = np.array([0, 2, 4, 5, 7, 9, 11], dtype=np.int16)
MINOR_SCALE = np.array([0, 2, 3, 5, 7, 8, 10], dtype=np.int16)
EQ_BANDS = {
    "low": (20.0, 250.0),
    "mid": (250.0, 4_000.0),
    "high": (4_000.0, 16_000.0),
}
STEM_ROLES = {"melody", "bass", "drums", "texture"}
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

app = FastAPI(title="Magenta RT2 API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

magenta_audio: Any | None = None
style_model: Any | None = None
mrt: Any | None = None


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


def validate_generation_weights(audio_weight: float, text_weight: float) -> tuple[float, float]:
    if not math.isfinite(audio_weight):
        raise HTTPException(status_code=400, detail="audio_weight must be a finite number.")
    if audio_weight < 0 or audio_weight > 1:
        raise HTTPException(status_code=400, detail="audio_weight must be between 0 and 1.")
    if not math.isfinite(text_weight):
        raise HTTPException(status_code=400, detail="text_weight must be a finite number.")
    if text_weight < 1 or text_weight > 5:
        raise HTTPException(status_code=400, detail="text_weight must be between 1 and 5.")

    return audio_weight, text_weight


def format_bpm_for_style_prompt(bpm: float) -> str:
    rounded_bpm = round(bpm)
    if math.isclose(bpm, rounded_bpm, abs_tol=0.05):
        return str(rounded_bpm)
    return f"{bpm:.1f}"


def build_mrt_style_prompt(prompt: str, bpm: float, detected_key: DetectedKey, stem_role: str | None = None) -> str:
    clean_prompt = prompt.strip()
    stem_prefix = ""
    if stem_role:
        role_name = "drum" if stem_role == "drums" else stem_role
        stem_prefix = f"{role_name} stem, "
    return f"{format_bpm_for_style_prompt(bpm)} bpm {stem_prefix}{clean_prompt} in {detected_key.name}"


def as_style_vector(style: Any) -> np.ndarray:
    vector = np.asarray(style, dtype=np.float32)
    if vector.ndim == 2 and vector.shape[0] == 1:
        vector = vector[0]
    return vector


def blend_style_vectors(audio_style: Any, text_style: Any, audio_weight: float, text_weight: float) -> np.ndarray:
    weights = np.array([audio_weight, text_weight], dtype=np.float32)
    weight_sum = float(weights.sum())
    if weight_sum <= 0:
        raise HTTPException(status_code=400, detail="audio_weight and text_weight must sum to greater than 0.")

    styles = np.stack([as_style_vector(audio_style), as_style_vector(text_style)])
    weights_norm = weights / weight_sum
    return np.sum(weights_norm[:, np.newaxis] * styles, axis=0).astype(np.float32)


def frames_per_beat_for_bpm(bpm: float) -> int:
    validated_bpm = validate_generation_bpm(bpm, required=True)
    seconds_per_beat = 60.0 / validated_bpm
    return max(1, int(round(MRT_FRAMES_PER_SECOND * seconds_per_beat)))


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


def beat_grid_features(mono: np.ndarray, sample_rate: int, bpm: float, total_beats: int) -> tuple[np.ndarray, np.ndarray]:
    seconds_per_beat = 60.0 / bpm
    energies = np.zeros(total_beats, dtype=np.float32)

    for beat in range(total_beats):
        start = int(round(beat * seconds_per_beat * sample_rate))
        end = int(round((beat + 1) * seconds_per_beat * sample_rate))
        segment = mono[start:end]
        if segment.size:
            energies[beat] = float(np.sqrt(np.mean(np.square(segment))))

    try:
        onset_env = librosa.onset.onset_strength(y=mono, sr=sample_rate, hop_length=512)
        onset_times = librosa.frames_to_time(np.arange(len(onset_env)), sr=sample_rate, hop_length=512)
        onset_density = np.zeros(total_beats, dtype=np.float32)
        for beat in range(total_beats):
            start_time = beat * seconds_per_beat
            end_time = (beat + 1) * seconds_per_beat
            mask = (onset_times >= start_time) & (onset_times < end_time)
            if np.any(mask):
                onset_density[beat] = float(np.mean(onset_env[mask]))
    except Exception:
        onset_density = np.zeros(total_beats, dtype=np.float32)

    return normalize_vector(energies), normalize_vector(onset_density)


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
    chroma = pitch_class_energy(mono, sample_rate)
    detected_key = detect_key(chroma)

    return {
        "reference": tiled,
        "mono": mono,
        "total_beats": total_beats,
        "beat_energy": beat_energy,
        "onset_density": onset_density,
        "pitch_classes": chroma,
        "detected_key": detected_key,
        "spectral": spectral_occupancy(mono, sample_rate),
    }


def resolve_stem_role(
    stem_role: str,
    spectral: dict[str, float],
    onset_density: np.ndarray,
    beat_energy: np.ndarray | None = None,
) -> str:
    role = stem_role.lower().strip()
    if role in STEM_ROLES:
        return role

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


def build_conditioning(analysis: dict[str, Any], stem_role: str) -> list[tuple[list[int], list[int]]]:
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

    for beat in range(total_beats):
        notes = [-1] * 128
        drums = [0]
        beat_in_bar = beat % BEATS_PER_BAR
        is_downbeat = beat_in_bar == 0
        should_fill = fill_scores[beat] >= threshold

        if role == "drums":
            sparse_beat = onset_density[beat] < 0.68
            trigger_drum = is_downbeat or ((should_fill or beat_in_bar == 2) and sparse_beat)
            drums = [1 if trigger_drum else 0]
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

            if is_downbeat and onset_density[beat] < 0.35 and fill_scores[beat] > 0.55:
                drums = [1]

        conditioning.append((notes, drums))

    return conditioning


def waveform_to_samples(waveform: Any) -> tuple[np.ndarray, int]:
    buf = io.BytesIO()
    waveform.write(buf, format="WAV")
    buf.seek(0)
    samples, sample_rate = sf.read(buf, dtype="float32", always_2d=True)
    return samples.astype(np.float32, copy=False), int(sample_rate)


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


def normalize_with_headroom(samples: np.ndarray, peak: float = 0.89) -> np.ndarray:
    max_abs = float(np.max(np.abs(samples))) if samples.size else 0.0
    if max_abs > 1e-8:
        samples = samples * min(1.0, peak / max_abs)
    return np.clip(samples, -1.0, 1.0).astype(np.float32, copy=False)


def post_process_generation(
    samples: np.ndarray,
    sample_rate: int,
    reference: np.ndarray,
    duration_seconds: float,
    avoid_clash: bool,
) -> np.ndarray:
    target_samples = int(round(duration_seconds * sample_rate))
    output = exact_length(samples, target_samples)
    output = smooth_loop_boundary(output, sample_rate)
    if avoid_clash:
        output = apply_spectral_ducking(output, trim_or_tile(reference, target_samples), sample_rate)
    return normalize_with_headroom(exact_length(output, target_samples))


def safe_filename(prompt: str) -> str:
    clean = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in prompt[:30])
    return clean.strip("_") or "magic"

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


@app.post("/generate")
async def generate(
    audio_file: UploadFile = File(..., description="Reference audio file (WAV, 48kHz preferred)"),
    prompt: str = Form(..., description="Text style prompt e.g. 'dark trap 808s'"),
    audio_weight: float = Form(0.5, description="Weight for audio prompt (default 0.5)"),
    text_weight: float = Form(1.0, description="Weight for text prompt (default 1.0)"),
    duration_bars: int | None = Form(None, description="Output duration in bars"),
    bpm: float | None = Form(None, description="Project tempo in beats per minute"),
    stem_role: str = Form("auto", description="Complementary stem role: auto, melody, bass, drums, or texture"),
    avoid_clash: bool = Form(True, description="Apply spectral anti-clash processing"),
    temperature: float = Form(0.2, description="MRT sampling temperature"),
    top_k: int = Form(40, description="MRT top-k sampling threshold"),
    cfg_notes: float = Form(1.0, description="MRT notes classifier-free guidance"),
    cfg_drums: float = Form(1.0, description="MRT drums classifier-free guidance"),
):
    """
    Generate music blending an uploaded audio file with a text prompt.
    Returns a WAV file.
    """

    # --- Resolve and validate duration ---
    generation_bpm = validate_generation_bpm(bpm, required=True)
    duration_seconds = resolve_duration_seconds(duration_bars, bpm)
    validate_generation_weights(audio_weight, text_weight)
    if top_k <= 0:
        raise HTTPException(status_code=400, detail="top_k must be greater than 0.")

    try:
        audio, style_model, mrt = get_magenta_runtime()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Magenta runtime unavailable: {e}") from e

    # --- Save uploaded file to temp ---
    suffix = os.path.splitext(audio_file.filename)[-1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await audio_file.read())
        tmp_path = tmp.name

    try:
        # --- Load audio ---
        try:
            my_audio = audio.Waveform.from_file(tmp_path)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read audio file: {e}")
        reference_samples = load_reference_audio(tmp_path, MAGENTA_SAMPLE_RATE)
        analysis = analyze_reference(reference_samples, MAGENTA_SAMPLE_RATE, generation_bpm, duration_bars, duration_seconds)
        resolved_stem_role = resolve_stem_role(
            stem_role,
            analysis["spectral"],
            analysis["onset_density"],
            analysis["beat_energy"],
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
        print(f"Resolved stem role: {resolved_stem_role}")

        # --- Blend styles ---
        mrt_style_prompt = build_mrt_style_prompt(prompt, generation_bpm, detected_key, resolved_stem_role)
        print(f"MRT style prompt: {mrt_style_prompt}")
        audio_style = style_model.embed([my_audio])
        text_style = mrt.embed_style(mrt_style_prompt, use_mapper=True)
        blended_style = blend_style_vectors(audio_style, text_style, audio_weight, text_weight)

        # --- Generate beat-grid chunks ---
        chunks = []
        state = None
        frames_per_beat = frames_per_beat_for_bpm(generation_bpm)
        for notes, drums in conditioning:
            chunk, state = mrt.generate(
                style=blended_style,
                notes=notes,
                drums=drums,
                cfg_notes=cfg_notes,
                cfg_drums=cfg_drums,
                temperature=temperature,
                top_k=top_k,
                state=state,
                frames=frames_per_beat,
            )
            chunks.append(chunk)

        # --- Concatenate & return as WAV bytes ---
        output_waveform = audio.concatenate(chunks)
        samples, sample_rate = waveform_to_samples(output_waveform)
        processed = post_process_generation(
            samples,
            sample_rate,
            analysis["reference"],
            duration_seconds,
            avoid_clash,
        )

        buf = io.BytesIO()
        sf.write(buf, processed, sample_rate, format="WAV", subtype="PCM_16")
        buf.seek(0)

        filename = f"magenta_{safe_filename(prompt)}.wav"
        return StreamingResponse(
            buf,
            media_type="audio/wav",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    finally:
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run("magenta_server:app", host="0.0.0.0", port=8000, reload=False)
