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
from typing import Any
import numpy as np

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


def resolve_duration_seconds(
    duration_seconds: float | None,
    duration_bars: int | None,
    beats_per_bar: int,
    bpm: float | None,
) -> float:
    if duration_bars is not None:
        if duration_bars <= 0:
            raise HTTPException(status_code=400, detail="duration_bars must be greater than 0.")
        if beats_per_bar <= 0:
            raise HTTPException(status_code=400, detail="beats_per_bar must be greater than 0.")
        if bpm is None or bpm <= 0:
            raise HTTPException(status_code=400, detail="bpm must be greater than 0 when duration_bars is provided.")
        duration_seconds = (duration_bars * beats_per_bar * 60.0) / bpm

    if duration_seconds is None:
        raise HTTPException(status_code=400, detail="duration_seconds or duration_bars with bpm is required.")
    if duration_seconds <= 0 or duration_seconds > 120:
        raise HTTPException(status_code=400, detail="duration_seconds must be between 1 and 120.")

    return duration_seconds

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
    audio_weight: float = Form(2.0, description="Weight for audio prompt (default 2.0)"),
    text_weight: float = Form(1.0, description="Weight for text prompt (default 1.0)"),
    duration_seconds: float | None = Form(None, description="Output duration in seconds"),
    duration_bars: int | None = Form(None, description="Output duration in bars"),
    beats_per_bar: int = Form(4, description="Beats per bar"),
    bpm: float | None = Form(None, description="Project tempo in beats per minute"),
):
    """
    Generate music blending an uploaded audio file with a text prompt.
    Returns a WAV file.
    """

    # --- Resolve and validate duration ---
    duration_seconds = resolve_duration_seconds(duration_seconds, duration_bars, beats_per_bar, bpm)

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

        # --- Blend styles ---
        weighted_styles = [
            (audio_weight, my_audio),
            (text_weight, prompt),
        ]
        weights = np.array([w for w, _ in weighted_styles])
        styles = style_model.embed([s for _, s in weighted_styles])
        weights_norm = weights / weights.sum()
        blended_style = (weights_norm[:, np.newaxis] * styles).mean(axis=0).astype(np.float32)

        # --- Generate chunks ---
        # Each call to mrt.generate() produces ~2 seconds (25 frames)
        frames_per_chunk = 25
        seconds_per_chunk = 2.0
        num_chunks = math.ceil(duration_seconds / seconds_per_chunk)

        chunks = []
        state = None
        for _ in range(num_chunks):
            chunk, state = mrt.generate(
                style=blended_style,
                state=state,
                frames=frames_per_chunk,
            )
            chunks.append(chunk)

        # --- Concatenate & return as WAV bytes ---
        output_waveform = audio.concatenate(chunks)

        buf = io.BytesIO()
        output_waveform.write(buf, format="WAV")
        buf.seek(0)

        filename = f"magenta_{prompt[:30].replace(' ', '_')}.wav"
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
