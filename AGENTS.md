# Repository Guidelines

## Project Structure & Module Organization

This repository contains a single Vite/TypeScript Audiotool API app in `nexus-app/src`. It authenticates with Audiotool, connects to an Audiotool DAW project, and syncs controls through `@audiotool/nexus`.
The connected Audiotool project is the source of truth for project state. UI controls that represent project settings should read from and write to Nexus/Audiotool entities rather than relying only on local app state.
Key files are:

- `nexus-app/src/main.ts`: app state, Nexus authentication, DAW project connection, deck controls, audio engine, and UI events.
- `nexus-app/src/index.html`: single-page HTML shell and control markup.
- `nexus-app/src/style.css`: global styling, layout, and component classes.
- `nexus-app/src/vite.config.ts` and `tsconfig.json`: local dev server and TypeScript configuration.

Keep generated build output out of source control. Put future assets under `nexus-app/src/assets/`.

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
