# Repository Guidelines

## Project Structure & Module Organization

This repository contains a single Vite/TypeScript Audiotool API app in `nexus-app/src`. It authenticates with Audiotool, connects to an Audiotool DAW project, and syncs controls through `@audiotool/nexus`.
The connected Audiotool project is the source of truth for project state. UI controls that represent project settings should read from and write to Nexus/Audiotool entities rather than relying only on local app state.
Key files are:

- `magenta_server.py`: FastAPI Magenta RT2 server for live audio generation.
- `nexus-app/src/main.ts`: app state, Nexus authentication, DAW project connection, deck controls, audio engine, and UI events.
- `nexus-app/src/index.html`: single-page HTML shell and control markup.
- `nexus-app/src/style.css`: global styling, layout, and component classes.
- `nexus-app/src/vite.config.ts` and `tsconfig.json`: local dev server and TypeScript configuration.
- `tests/test_magenta_server.py`: focused helper tests for generation parameter handling.

Keep generated build output out of source control. Put future assets under `nexus-app/src/assets/`.

## Magenta Generation Process

`magenta_server.py` exposes `POST /generate`, which returns a generated WAV by blending a reference audio clip with a text style prompt. The server uses Magenta RT2 model `mrt2_small`, 48 kHz audio, an internal 25 fps generation frame rate, and 4 beats per bar. The Magenta runtime loads lazily on the first request: `musiccoca.MusicCoCa()` embeds the reference audio style, and `system.MagentaRT2SystemMlxfn(size="mrt2_small")` performs generation.

The frontend currently sends only these request fields from `generateMagicAudio`: `audio_file`, `prompt`, `audio_weight`, `text_weight`, `duration_bars`, `bpm`, `stem_role`, and `avoid_clash`. `audio_file` is the last 8 seconds from deck 1 or deck 2. `duration_bars` is fixed at 16, `bpm` comes from the Audiotool project tempo, `stem_role` is always `auto`, and `avoid_clash` is always `true`. The frontend does not send `temperature`, `top_k`, `cfg_notes`, or `cfg_drums`, so server defaults apply.

The `/generate` form parameters are:

- `audio_file`: required reference audio file; WAV at 48 kHz is preferred.
- `prompt`: required text prompt. The server trims it and later expands it with BPM and detected key.
- `audio_weight`: default `0.5`; validated from `0` to `1`.
- `text_weight`: default `1.0`; validated from `1` to `5`.
- `duration_bars`: required; must be greater than `0`.
- `bpm`: required; must be finite and between `40` and `240`.
- `stem_role`: default `auto`; explicit roles are `melody`, `bass`, `drums`, and `texture`.
- `avoid_clash`: default `true`; enables spectral ducking against the reference.
- `temperature`: default `0.2`; passed directly to `mrt.generate`.
- `top_k`: default `40`; must be greater than `0`.
- `cfg_notes`: default `1.0`; passed directly to `mrt.generate`.
- `cfg_drums`: default `1.0`; passed directly to `mrt.generate`.

Generation duration is derived from bars and tempo as `duration_seconds = duration_bars * 4 * 60 / bpm`; 16 bars at 120 BPM yields 32 seconds. The reference audio is loaded twice: once as a Magenta waveform for MusicCoCa style embedding, and once through librosa at 48 kHz for analysis and post-processing. Analysis trims or tiles the reference to the target duration, computes per-beat energy and onset density, estimates chroma pitch-class energy, detects a simple key, and measures low/mid/high spectral occupancy.

Conditioning is generated one beat at a time. Each beat gets a 128-item MIDI `notes` control list initialized to `-1` and a one-item `drums` list. In `auto` mode, low average onset density selects `drums`; otherwise the quietest spectral band chooses a complementary role: low implies `bass`, high implies `texture`, and mid implies `melody`. Notes are selected from the detected key using role-specific ranges: bass uses MIDI 36-52, texture uses 60-84, and melody uses 55-76.

The style prompt sent to Magenta is formatted as `"{bpm} bpm {prompt} in {detected_key}"`, for example `128 bpm tech house in A minor`. The server embeds the uploaded reference audio with MusicCoCa, embeds the expanded text prompt with `mrt.embed_style(..., use_mapper=True)`, normalizes the user weights, and combines both vectors into `blended_style`.

The actual audio loop calls `mrt.generate` once per beat, carrying `state` from one beat to the next. Each call receives `style=blended_style`, the current beat's `notes` and `drums`, `cfg_notes`, `cfg_drums`, `temperature`, `top_k`, and `frames=round(25 * 60 / bpm)`. Chunks are concatenated, trimmed or padded to exact duration, smoothed at the loop boundary with a 40 ms fade, optionally spectrally ducked against the reference, normalized to 0.89 peak, and returned as 16-bit PCM WAV.

One current implementation detail to revisit: the style blend applies normalized weights and then uses `.mean(axis=0)`, which halves the weighted vector magnitude. A conventional weighted blend would use `.sum(axis=0)`, so this may weaken both audio and text conditioning.

## Build, Test, and Development Commands

Run commands from `nexus-app/src`:

- `npm install`: install Vite, TypeScript, and `@audiotool/nexus`.
- `npm run dev`: start the Vite dev server at `http://127.0.0.1:5173`.
- `npm run build`: run TypeScript checking and create a production build.
- `npm run preview`: serve the production build locally for inspection.

## Coding Style & Naming Conventions

Use TypeScript with strict typing. Follow `main.ts`: two-space indentation, single quotes, no semicolons, explicit interfaces, and focused helper functions. Prefer DOM IDs and constants that match UI labels, such as `btnConnect`, `magicGain`, and `deckPlay`.

CSS uses custom properties in `:root`, kebab-case selectors, and section comments for major UI areas. Keep color and font tokens centralized instead of duplicating literals.

## Testing Guidelines

No automated test runner is configured yet. Use `npm run build` as the required verification step. Manually test the Vite app in a browser with an Audiotool DAW project when changing UI, authentication, audio playback, drag-and-drop loading, canvas drawing, or Nexus sync behavior.

If tests are added later, place them near covered code or in `tests`, and name files with a `.test.ts` suffix.

## Commit & Pull Request Guidelines

Recent commits use short, imperative messages such as `move nexus-app` and `initial draft`. Keep commit subjects concise and action-oriented; add a body only when the change needs context.

Pull requests should include a short summary, verification commands, and notes about browser, Audiotool API, or Audiotool DAW behavior tested manually. Include screenshots or recordings for visible UI changes, and link related issues when applicable.

## Security & Configuration Tips

Avoid committing personal OAuth client IDs, tokens, project URLs, or generated audio files. The app currently targets `http://127.0.0.1:5173/` for OAuth redirects, so keep local dev server settings aligned with `vite.config.ts` and the Audiotool client configuration. Changes should preserve compatibility with Audiotool DAW project URLs and Nexus document sync.
