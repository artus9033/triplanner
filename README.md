# Triplanner

A trip planner: a chat collects your dates, city, plans and budget, bots read each place's real web pages for hours and tickets through Apex (an LLM used via the Vercel AI SDK), and an optimizer (AMPL with HiGHS, or a heuristic fallback) builds a day-by-day schedule shown on a timeline and a map. Every trip has its own URL (`/trips/:id`) and all progress lives in MongoDB, so a reload or another browser shows the same trip and step.

It runs in dev mode with autorestart. Nothing below needs root or Docker. The design is in [design/04-plan-refined-v2.md](design/04-plan-refined-v2.md).

## Prerequisites

- **Node** at the version in `.nvmrc` (24.9.0). The scripts in `scripts/` are TypeScript run directly by Node, so an old Node cannot start them at all.
- **pnpm** at the version in `package.json` (`packageManager`, 12.6.0).
- **Optional:** `python3` (AMPL), Docker with compose (MongoDB), `ffmpeg` (non-WAV audio uploads). Without them the app still runs; see [Feature degradation](#feature-degradation).
- **Network** on first run, for packages, AMPL, possibly MongoDB, and the speech models.

## Commands

Run all of these from the repo root. All are idempotent.

| Command                 | What it does                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run bootstrap`    | Installs dependencies, creates `.env` from `.env.example` if absent (it never overwrites one), installs AMPL and HiGHS, installs `mongod` if nothing else can provide MongoDB, and prints the status table. Re-run it to restore anything that was removed. Exits nonzero only if the Node version is unusable or `pnpm install` fails. |
| `pnpm dev`              | Starts MongoDB if needed, then the backend and frontend with autorestart and prefixed output.                                                                                                                                                                                                                                           |
| `pnpm run check:env`    | Prints the status table. Exits nonzero only when something required is `missing`.                                                                                                                                                                                                                                                       |
| `pnpm run seed:demo`    | With MongoDB running, loads a finished Paris trip with no LLM calls and prints its path, `/trips/demo-paris`. Each run replaces the previous demo. Its hours and prices are illustrative and marked as demo data.                                                                                                                       |
| `pnpm test`             | All tests, including live ones. See [Tests](#tests).                                                                                                                                                                                                                                                                                    |
| `pnpm run typecheck`    | Type checks every package and the scripts.                                                                                                                                                                                                                                                                                              |
| `pnpm run format:check` | Prettier check.                                                                                                                                                                                                                                                                                                                         |

Typical first run:

```bash
pnpm run bootstrap
# put APEX_API_KEY in .env, keep the file at mode 600
pnpm run check:env
pnpm dev
pnpm run seed:demo   # in another terminal
```

## Ports and URLs

| Service              | Default           | Override      |
| -------------------- | ----------------- | ------------- |
| Frontend (open this) | `127.0.0.1:5173`  | `WEB_PORT`    |
| Backend              | `127.0.0.1:3000`  | `PORT`        |
| MongoDB              | `127.0.0.1:27017` | `MONGODB_URI` |

Both servers bind to 127.0.0.1. The frontend proxies `/api`, so the browser only talks to one origin. Health: `curl -fsS http://127.0.0.1:3000/api/health`.

If a port is taken, `pnpm dev` stops with a message and kills nothing. Set `PORT` or `WEB_PORT` to a free port.

## How `pnpm dev` behaves

**MongoDB**, first match wins:

1. A server already reachable at `MONGODB_URI` (default `127.0.0.1:27017`) is reused. It is left running on exit.
2. If Docker and compose work: `docker compose up -d mongo`, with a named volume. If that fails or the server does not become reachable, it moves on to step 3.
3. `mongod`, either the system's or the tarball under `TOOLS_DIR`, bound to 127.0.0.1. Data is in `TOOLS_DIR/mongodb-data` and the log is `TOOLS_DIR/mongod.log`.

A MongoDB that this run started (step 2 or 3) is stopped on exit, and its data stays. If the port is held by something that is not MongoDB, `pnpm dev` stops with a message.

**Autorestart.** The backend restarts when its files change (`tsx watch`) and the frontend hot-reloads (`vite`). A process that exits restarts with a growing delay. If the backend app crashes and stops listening, it restarts within about 20 seconds.

**Stopping.** Press Ctrl-C, or run the `kill <pid>` command that `pnpm dev` prints at startup. Signal that process, not `pnpm`: with some pnpm installs (a corepack shim, for example), `kill` on the pnpm process leaves the app running.

**AMPL.** `pnpm dev` sets `AMPL_BIN` and `PATH` for the backend from the venv, unless `AMPL_BIN` is already set. It does not write to `.env`.

## Environment variables

Set these in `.env`, which is git-ignored. Variables already in the environment win. Values are never printed.

| Variable              | Required           | Purpose                                                                                                |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| `APEX_API_KEY`        | For planning steps | The app's Apex API key.                                                                                |
| `AMPLKEY_UUID`        | No                 | AMPL Community Edition licence. Without it AMPL runs on its demo licence. Bootstrap activates it once. |
| `DEV_ACCESS_PASSWORD` | Before any tunnel  | Gates the app and API.                                                                                 |
| `PORT`, `WEB_PORT`    | No                 | Backend and frontend ports.                                                                            |
| `MONGODB_URI`         | No                 | Default `mongodb://127.0.0.1:27017/triplanner`.                                                        |
| `TOOLS_DIR`           | No                 | Default `/workspace/.tools` when `/workspace` is writable, else `~/.tools`.                            |
| `AMPL_BIN`            | No                 | Use this AMPL binary instead of the venv's.                                                            |
| `SKIP_SPEECH_LIVE`    | No                 | `1` skips the live speech test.                                                                        |

`TOOLS_DIR` holds `ampl-venv/`, `models/` (speech), `mongodb-<version>/` when the tarball was needed, `mongodb-data/` and `mongod.log`.

## Feature degradation

| Feature               | Without it                                                                                                                                                             | Status     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Apex API key          | Planning steps fail with on-screen errors. The demo trip still works. `check:env` exits nonzero.                                                                       | `missing`  |
| MongoDB               | The app cannot start. A server that is merely not running yet shows `degraded`, because `pnpm dev` will start it. With no way to start one, `check:env` exits nonzero. | `missing`  |
| AMPL / HiGHS          | Schedules come from the fallback heuristic, and the UI says so. With no Python, bootstrap reports this rather than failing.                                            | `degraded` |
| Speech models         | Downloaded on first use: about 130 MB in total, into `TOOLS_DIR/models`. Voice controls are disabled with a reason until then. The rest of the app is unaffected.      | `degraded` |
| ffmpeg                | Only WAV can be transcribed. Browser recordings and uploads are decoded to WAV by the frontend, so they keep working for formats the browser can decode.               | `degraded` |
| Docker                | Not needed. `mongod` runs directly.                                                                                                                                    | `degraded` |
| `DEV_ACCESS_PASSWORD` | Fine on 127.0.0.1. Required before opening a tunnel.                                                                                                                   | `degraded` |

Voice needs no microphone or speakers on the server. The speech models are English: Whisper tiny.en for speech to text and Kokoro (voice `af_heart`) for text to speech, both running on CPU. Text to read aloud is limited to 1,000 characters, and audio to transcribe to 10 minutes.

### Limitation: a "ready" key does not prove inference works

`check:env` and `/api/health` verify the key with the model list, which uses no tokens. A key that is valid but out of quota would still show `ready`. The first real check is the first chat message. The demo trip uses no LLM calls and cannot detect this either.

### Limitation: Apex has no web search

Place data comes from real pages that the backend fetches for the model, and the sources shown are the pages that loaded. A site that blocks the fetch, or a place whose site the model does not know, can fail with a visible error and a retry button. Suggestions in step 1 come from what the model knows, so they are checked only when the place is researched in step 2. Details are in [design/04-plan-refined-v2.md](design/04-plan-refined-v2.md).

Each bot makes outbound requests to the sites the model picks, and to OpenStreetMap Nominatim for coordinates, so the machine needs internet access. Private and internal addresses are refused.

## Tests

| Command          | What it runs                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`      | Everything, including live tests. The LLM ones make real Apex calls and need a working key. The speech one downloads the models if needed. |
| `pnpm test:fast` | Everything except `*.live.test.ts`. No network or credit needed.                                                                           |
| `pnpm test:live` | Only the backend's `*.live.test.ts`.                                                                                                       |

Tests that need a database start a throwaway MongoDB and never touch your data.

## Conventions

Lefthook hooks are installed by `pnpm install`. Pre-commit runs Prettier on staged files and the type check. Commit messages are checked by commitlint with the conventional config (`feat:`, `fix:`, `docs:` and so on).
