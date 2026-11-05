The purpose of this project is a trip planner web app (React web) & backend (NodeJS), gui with MUI, state with zustand, routing with react-router.

We should be able to run this all in dev mode with autorestart of backend + frontend. Use MongoDB for DB. Always write in typescript, use prettier + lefthook and commitlint.

All LLM calls use Apex through the Vercel AI SDK, with the key in `.env` as `APEX_API_KEY`. This replaces the Claude API; see "LLM: Apex", which supersedes "LLM: Claude API" below wherever they differ.

## Runtime target: Grok Bot VM

The main GUI is a chat with Grok Bot. The app runs in dev mode on the bot's cloud VM, the bot clicks through it in the VM's browser on my behalf, and I can take manual control at any time. The paste-in prompt that sets this up is [03-grok-bot-deploy-prompt.md](03-grok-bot-deploy-prompt.md).

What the VM gives us: a persistent Linux computer with a browser, a filesystem and a terminal. The bot is a non-root user, and all bots on the account share the machine. Only `/workspace` should be treated as durable; installed packages and temp directories are disposable. Docker, sudo and public ports are not documented, so nothing below may depend on them.

The app must meet these requirements so a bot can deploy and operate it:

- **Commands.** All are idempotent, run from the repo root, and work without root or Docker:
  - `pnpm run bootstrap`: installs dependencies and tools, creates `.env` from `.env.example` without overwriting an existing one, and prints a table of each feature's status (ready, degraded or missing, with the reason).
  - `pnpm dev`: starts MongoDB if needed, plus backend and frontend with autorestart.
  - `pnpm run check:env`: checks versions, keys, MongoDB, AMPL and the speech models.
  - `pnpm run seed:demo`: loads a finished demo trip with no LLM calls, for smoke testing without API spend.
- **Pinned toolchain.** `.nvmrc` pins Node and the `packageManager` field pins pnpm.
- **Tool location.** Tools install under `TOOLS_DIR`, which defaults to `/workspace/.tools` when it is writable and `~/.tools` otherwise. Re-running bootstrap must fully restore anything a VM update removed.
- **MongoDB.** Use `docker compose` when a working Docker exists. Otherwise run the official `mongod` tarball from `TOOLS_DIR`, with its data directory beside it, so trips survive restarts.
- **AMPL.** This overrides the Docker-only setup in 02 §4.5. Use the Docker image when available. Otherwise install AMPL and HiGHS without root (for example amplpy modules in a venv under `TOOLS_DIR`) and point `AMPL_BIN` at the binary. The licence comes from `AMPLKEY_UUID` in `.env` (AMPL Community Edition). If AMPL is unavailable, the app uses the 02 §4.8 fallback heuristic and the UI says so.
- **Ports and origin.** Frontend on 5173, backend on 3000, both bound to 127.0.0.1. The Vite dev server proxies `/api`, so the browser only ever talks to one origin. `GET /api/health` returns status for the DB, AMPL, speech and LLM key. `PORT` and `WEB_PORT` override the defaults, since the VM is shared.
- **State lives on the server.** Every trip has its own URL (`/trips/:id`), and all progress is persisted in MongoDB, with zustand only caching it. Reloading the page, or opening it in another browser, must restore the same trip and step. This is what makes handover between bot and human safe.
- **Bot-friendly UI.** Use real labels and ARIA roles throughout. Add stable `data-testid`s: `new-trip`, `trip-list`, `chat-input`, `chat-send`, `steps-timeline`, `place-option`, `places-confirm`, `place-card`, `map-pin`, `optimization-status`, `final-timeline`. Every wait state shows visible progress, and every failure shows visible text. The bot cannot read a console error it does not know to look for.
- **Remote access gate.** If `DEV_ACCESS_PASSWORD` is set, the app and API require it. Tunnel access (see the prompt) is only allowed with this set, because the app has no user accounts and anyone reaching it can spend the LLM key.
- **Secrets.** `.env` is git-ignored and never logged.

## LLM: Apex

Apex replaced the Claude API. It is an OpenAI-compatible endpoint (`https://api.callstack.ai/v1`, model `callstack/Apex`), used through the Vercel AI SDK. Constants are in `backend/src/config/llm.ts`. These facts were checked against the live API:

- **Use `provider.chat(...)`.** The SDK's default `/responses` route returns a 400 on the follow-up request of a tool loop.
- **Effort goes in `providerOptions.openai.reasoningEffort`.** The key `callstack` is dropped silently, so the request runs at the default effort.
- **Apex has no web search.** A `web_search` tool is accepted and ignored. It also believes the date is months earlier than it is, so prompts state the date.

**Research.** The only tool is `fetch_page`, which runs in the backend and loads a public page by URL. It rejects private and internal addresses, re-checks each redirect, and limits size and time.

**Hours and prices come from pages, not memory.** The extract call has no tools and receives only the text of pages that loaded, not the model's notes. A place with no loaded page fails visibly with a retry button. `sources` lists only pages that loaded.

**No hours found is not the same as closed.** A place with no usable hours is assumed open 08:00–22:00 on every trip day, within the daily window, and the UI marks that visit "hours not confirmed". This replaces design 02's rule for that one case. A missing date still means closed when other dates have hours, and a place whose own pages say it is shut for the whole trip stays out of the schedule.

**Step 1 is weaker than the original design.** With no search, suggestions come from what the model knows, checked against pages when it fetches any. Step 2 then verifies each chosen place on real pages. Adding a search API would mean adding a second tool beside `fetch_page`.

**Coordinates and links are not from the model.** Coordinates come from OpenStreetMap Nominatim, one request per second as its usage policy requires. Google Maps links are search URLs built from the name.

## LLM: Claude API (superseded)

The rest of this section describes the original design, and is kept for reference.

Grok Bot remains the operator on the VM. The app's own LLM calls all go to the Claude API.

**Libraries**

- `@langchain/anthropic` for the step 0 chat and state filling.
- The official `@anthropic-ai/sdk` for every web search call (steps 1 and 2). These calls need `pause_turn` handling, refusal handling and citations, which the SDK documents and LangChain's docs do not cover for web search.

**Config constants** (`backend/src/config/llm.ts`)

| Constant | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for all calls |
| `INTAKE_EFFORT` | `low` | Effort for the step 0 chat |
| `SEARCH_EFFORT` | `medium` | Effort for steps 1 and 2 |
| `PROPOSAL_SEARCH_MAX_USES` | 10 | Search limit per step 1 request |
| `PLACE_SEARCH_MAX_USES` | 5 | Search limit per place in step 2 |

Always set effort explicitly. Tune these values against real trips, and record the cost and time per place when doing so.

**The only tool** is exactly this, defined once and used at every search call site:

```ts
{ type: "web_search_20250305", name: "web_search", max_uses: N }
```

Use this basic version on purpose. Newer versions (`web_search_20260209` and later) run search through server-side code execution by default, which breaks the "only web search" rule. A test asserts that this is the only tool sent, and that responses contain no code execution blocks. Do not add `web_fetch`.

**Search and extraction are two separate calls**, because web search results always carry citations and the API returns a 400 when citations are enabled with `output_config.format`. The docs do not cover this exact combination, so two calls is the safe design:

1. **Research:** a call with the web search tool and no output format. It returns text with citations. Save the cited URLs and titles.
2. **Extract:** a `client.messages.parse` call with `output_config.format: zodOutputFormat(schema)`, no tools, and the research text as input. Web content that tries to instruct the model reaches a call with no tools.

Both calls together must fit the 1-minute budget in step 2. Steps 1 and 2 use the same pattern.

**Sources.** The backend, not the model, attaches the cited URLs and titles to each stored place as `sources`. The UI shows them as links on the place card, so the user can check hours and prices at the source.

**Handling every response**

- Branch on `stop_reason` before reading content:
  - `refusal`: the place fails visibly, with the retry button. The output may not match the schema.
  - `max_tokens`: the output may be incomplete, so do not store it.
  - `pause_turn` (research only): send the paused assistant content back unchanged, with the same tools. Cap the number of continuations.
- Search errors arrive as HTTP 200, with a `web_search_tool_result` whose `content` is an error object instead of a list. Check for this. An empty list means no results, not an error.
- The research call sends `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta, so a declined request is re-run on another model. Log which model answered.
- Treat all web-derived text as untrusted: render it as plain text, and only link `http` and `https` URLs.

**API rules that return a 400 on this model** (LangChain configuration included)

- Do not send `temperature`, `top_p` or `top_k`.
- Do not send a thinking budget or `thinking: { type: "disabled" }`. Effort is the only control.
- Do not force a tool with `tool_choice` `any` or `tool`. Use `withStructuredOutput(schema, { method: "jsonSchema" })` in LangChain, not its function calling mode. An integration test covers this with the pinned `@langchain/anthropic` version.

**Schema limits.** Structured outputs do not support numeric or string length constraints. The SDK removes them from the schema it sends and validates them client-side, so the 120-character description limit still holds, and a violation counts as a failed extraction. Compare enum values case-insensitively.

**Health check.** `check:env` and `/api/health` verify the key with the Models API (`client.models.retrieve(CLAUDE_MODEL)`), which uses no tokens. An administrator can disable web search for the organization in the Claude Console. That returns a 400 on the first search, so show it as a clear on-screen error.

**Cost.** Each search costs $0.01 ($10 per 1,000), so up to $0.05 per place in step 2. Tokens are extra: $4 per million input and $20 per million output on Opus 5.5, and search results count as input tokens.

## Steps

### 0. Trip intake chat

The user is presented a minimal nice (non resembling any existing) web chat UI with slogan "Where do you want to travel?" / "When do you want to travel?" / "Quo vadis?" that is cycling with a nice delicate animation.

The user can chat about their trip, they first start with a guided state machine tour that wants to collect some information about the trip: when (date ranges), city, what plans they have, the $ budget they have (optional, if they have no limits, fill in `null`). The plans can be less or more specific, like "I want to visit a museum" or "I want to visit a museum and a restaurant", or "I want to visit modern art museums", or "I want to visit the Louvre - specifically the Richelieu wing - and then some nice modern art galleries", and so on.
If they lack some information, the state machine will ask them for it. Do not overstate and build a sensible prompt, use langchain and a state machine with chat history + structured state filling + allow user to have different trips (conversations like).

Integrate a small whisper OSS model for speech to text + a small model text to speech with a nice voice for user to be able to type with voice + read aloud the messages from AI. Voice is optional: the app must be fully usable without it, and it must not fail when the machine has no microphone or speakers, which is the normal case on the VM. Download the models lazily and show the voice controls as disabled, with a tooltip giving the reason, when a model or device is missing. Support transcribing an uploaded audio file through the same backend path, so speech to text can be tested on the VM.

A MUI https://mui.com/material-ui/react-timeline/ showing all the steps of planning this trip should stay visible beside the chat, with help tooltips when you hover. It has one item each for steps 0, 1, 2, 3 and 5. Steps 3 and 4 run at the same time, so the optimization (step 4) sits inside timeline item 3 instead of having its own item.

### 1. Place refinement

First step after completion - refinement of the trip plan with the user based on the chat history and the state machine. If the user was not specific about the place, Claude over the API with web search tool (NO OTHER TOOLS ALLOWED) should search and propose the places, then the user should be shown a multiselect component with places + 1 link per place to google maps / website if not on google maps. The user should be able to select the places and the state machine should update the trip plan with the selected places.

If the user was specific about the places and there is no need for search, this step should skip.

Tool allowlisting is enforced in code at every call site, not just asked for in the prompt (see "LLM: Claude API").

### 2. Place data bots

We spawn predefined number of bots (say in a config constants file, default up to 5) and those bots take the stuff from the trip plan and each uses Claude over the API with ONLY web search tool to search on place's website and collect the information about the place. The information should be extracted to structured data ONLY pertaining to the possible dates when the user is travelling:

```json
{
  "place": "name of the place",
  "category": "museum | gallery | restaurant | viewpoint | other",
  "address": "address of the place",
  "lat": 48.8606,
  "lng": 2.3376,
  "phone": "phone number of the place, or null",
  "website": "website of the place, or null",
  "hours": [
    {
      "date": "YYYY-MM-DD",
      "start": "HH:MM",
      "end": "HH:MM"
    }
  ],
  "description": "description of the place in max 120 characters",
  "visit_duration_min": 120,
  "google_place_id": "google place id of the place, or null",
  "google_maps_url": "google maps url of the place, or null",
  "place_image_url": "image url of the place, or null",
  "tickets": [
    {
      "type": "free | paid | reduced",
      "price": "price of the ticket in the currency of the place, including the currency e.g. 20USD",
      "condition": "null if free or condition in few words e.g. 'under 18 free', or 'on tuesday it is free', or 'under 25 reduced'"
    }
  ],
  "needs_reservation": true
}
```

Fields the bot cannot find are `null`, never invented, and each result is validated with a zod schema before it is stored. `lat`, `lng`, `category` and `visit_duration_min` are needed by the map and the optimizer (02 §4.1); `visit_duration_min` may be `null`, which selects the per-category default.

These bots drain all places to be visited one by one and collect the information about the place. The information is stored in a database. The prompt should say the time budget for each agent is tops 1 minute. The backend also enforces this as a hard timeout across the research and extract calls together, using one abort signal, because the SDK retries timed-out requests and per-request timeouts could add up to more than a minute. A place that times out is shown as failed with a retry button.

The research prompt prefers the place's official website for hours and prices. No `allowed_domains` filter is set, because coordinates and some ticket details are often on other sites; the stored `sources` show where each result came from.

### 3. Place review

At this step, the structured data above should be presented to user visually + sidebar with map and loose points with tooltips hover + info should pop on hover. The map is Leaflet with OpenStreetMap tiles, so it needs no API key.

### 4. Schedule optimization

In the meantime, optimization of trip schedule: using the structured data, we should launch AMPL. This step runs alongside step 3 and is shown under timeline item 3.

Use plan from 02-optimization-design-out.md as guide to how the optimization should be done.

### 5. Final view

A user should be able to click on the timeline item to see the details of the place and the ticket, on an interactive map in web app.

Final view should show https://mui.com/material-ui/react-timeline/ with the whole trip, hover each should highlight map pin + open popup.
