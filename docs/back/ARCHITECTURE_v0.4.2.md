# Vibe Trade — Architecture (v0.4.2 baseline)

> **Scope**: this document is the canonical snapshot of the system as of
> commit **`653a51d`** (post-Phase-3 canvas + multi-chart swarm). It's the
> reference for rebuilding / refactoring from scratch. Subsystem-specific
> docs live alongside:
>
> - `SKILLS.md` — skill system, planner, processors, tool registry
> - `SWARM_PIPELINE.md` — deep-dive on the multi-agent debate
> - `CANVAS.md` — the multi-chart workspace (added in Phase 3)
>
> Superseded versions of these docs are archived in `docs/back/`.

## 1. Elevator pitch

Vibe Trade is an AI-powered trading research platform. A user describes
what they want in natural language ("fetch AAPL 1d last 2 years, find a
double-bottom, backtest it with $10k, then run a swarm debate"); a
planner LLM decomposes that into a sequence of **skill** invocations;
each skill runs on the backend, returns a chat reply plus a list of
**tool calls** that mutate frontend state (load a chart, render matches,
open a bottom-panel tab, set a timeframe, etc.). The UI renders multiple
chart windows on a freeform canvas, with a bottom panel that swaps in
skill-specific tabs.

## 2. Tech stack

### Backend (Python 3.12+)
- **FastAPI** — HTTP API (`services/api`)
- **pandas / numpy** — OHLC data wrangling
- **yfinance + ccxt** — market data providers (`core/data/fetcher.py`)
- **openai / anthropic SDKs** — LLM calls, provider-agnostic via
  `core/agents/llm_client.py`
- **ddgs** (DuckDuckGo) — web research for swarm personas
- **BeautifulSoup + pypdf2** — HTML/PDF scraping for fetch_url / fetch_pdf tools

### Frontend (Next.js 16 App Router)
- **React 19** + **TypeScript**
- **Zustand** — state store (`apps/web/src/store/useStore.ts`)
- **lightweight-charts v5** — candlestick rendering via Series/Pane
  Primitives (all drawing tools are custom, no proprietary library)
- **react-rnd** — drag/resize of chart windows on the canvas
- **React Flow** — Swarm DAG visualization
- **Tailwind v4** — styling
- **jsPDF** — native text-based PDF export of Run Stats reports

### CLI (installable via `pipx install vibe-trade`)
- **Typer** — subcommand routing
- **Rich** — terminal output
- `vibe-trade serve` bundles the built Next.js export and serves it
  from the FastAPI process so the end user doesn't need Node.

## 3. The 3-layer mental model

The codebase is organised in layers that the user explicitly maintains:

```
┌──────────────────────────────────────────────────────┐
│                       CANVAS                         │
│   (main chart area, now a multi-window workspace)    │
├──────────────────────────────────────────────────────┤
│                        TOOLS                         │
│  (tool_calls the skills emit to mutate UI state —    │
│   data.dataset.add, script_editor.load, chart.set_*, │
│   simulation.set_debate, notify.toast, etc.)         │
├──────────────────────────────────────────────────────┤
│                       SKILLS                         │
│  (registered handlers for the 4 core capabilities:   │
│   data_fetcher, pattern, strategy, swarm_intel)      │
└──────────────────────────────────────────────────────┘
```

- **Canvas** is the stage — holds N freely-positioned chart windows +
  per-window state + user-drawn overlays. Everything else eventually
  lands here or in the bottom panel.
- **Tools** are the *verbs* a skill can use to affect the UI. Each is
  registered with a handler in `apps/web/src/lib/toolRegistry.ts`. The
  backend just emits `{tool: "data.dataset.add", value: {...}}` in the
  `tool_calls` list — the frontend tool executor does the actual work.
- **Skills** are the *nouns* — registered capabilities the planner can
  invoke. Each skill has a Python processor (`core/agents/processors.py`)
  and a metadata file (`skills/<id>/SKILL.md` + `skill.yaml`).

## 4. End-to-end request flow

A typical request: user types *"run swarm intelligence"* with two
charts on the canvas.

```
User                                                Frontend
─────                                               ────────
types "run swarm intelligence"                       RightSidebar.handleSubmit()
                                                             │
                                                             ▼
                                                     Adds user message;
                                                     Posts interim trace
                                                     "Planning your request..."
                                                             │
                                                             ▼
                                          POST /plan ────────┐
                                                              ▼
                                                    Backend: planner.plan()
                                                    ├─ LLM (if available)
                                                    └─ keyword fallback:
                                                       "swarm" → swarm_intelligence
                                                             │
                                                             ▼
                                         returns [{skill: "swarm_intelligence",
                                                   message: "run swarm intelligence",
                                                   rationale: ..., context: {}}]
                                                             │
                                                             ▼
                                             planExecutor.executePlanInBrowser()
                                                 ├─ collectDatasetIds()
                                                 │   → ["btc_id","cl_id"]
                                                 │   (all canvas windows
                                                 │    with datasets)
                                                 ├─ stepContext =
                                                 │   { dataset_id: focused_id,
                                                 │     dataset_ids: [...],
                                                 │     ... }
                                                 └─ sendChat(step.message,
                                                            "swarm_intelligence",
                                                            stepContext)
                                                             │
                                          POST /chat ────────┘
                                                              ▼
                                              services/api/routers/chat.py
                                                             │
                                              processors._swarm_intelligence_processor()
                                                             │
                                     ┌───────────────────────┼──────────────────┐
                                     ▼                       ▼                  ▼
                              normalise dataset_ids   load each from      build portfolio
                              (focused → index 0)     services.api.store   report_text
                                                             │
                                             DebateOrchestrator.run(bars, symbol,
                                                                    report_text)
                                                             │
                          ┌──────────┬──────────┬───────────┼────────┬─────────┐
                          ▼          ▼          ▼           ▼        ▼         ▼
                       Stage1    Stage1.5   Stage2     Stage2.5  Stage3     Stage4/5
                       context   intel      personas   research  debate     cross/report
                                                             │
                                                             ▼
                                        returns {entities, thread, summary,
                                                 intel_briefing, cross_exam_results,
                                                 market_context, data_feeds,
                                                 agent_research, convergence_timeline,
                                                 events}
                                                             │
                                                             ▼
                                           SkillResponse with tool_calls:
                                           [simulation.set_debate,
                                            bottom_panel.activate_tab,
                                            notify.toast]
                                                             │
                                              JSON ◄─────────┘
                                                │
                                                ▼
                                 toolRegistry executes each tool_call:
                                  - simulation.set_debate →
                                      setCurrentDebate(mapped)
                                  - bottom_panel.activate_tab →
                                      activate DAG Graph tab
                                  - notify.toast → show toast
                                                │
                                                ▼
                                 Bottom panel tabs render:
                                  DAG Graph, Personalities,
                                  Debate Thread, Run Stats
```

## 5. Directory map

```
trading-platform/
├── core/                      # Python business logic (no FastAPI here)
│   ├── agents/                # LLM agents + skill processors
│   │   ├── llm_client.py      # Provider-agnostic chat_completion
│   │   ├── planner.py         # LLM planner + keyword fallback
│   │   ├── processors.py      # Entry point for each skill
│   │   ├── simulation_agents.py  # All swarm agent classes
│   │   ├── swarm_tools.py     # Web search, indicators, etc.
│   │   ├── pattern_agent.py   # Pattern detection logic
│   │   └── strategy_agent.py  # Strategy generation logic
│   ├── engine/
│   │   ├── dag_orchestrator.py  # Swarm 5-stage orchestrator
│   │   └── simulation_engine.py # Bar-by-bar replay simulator
│   ├── data/fetcher.py        # yfinance / ccxt wrappers
│   ├── indicators/            # Built-in + custom indicator scripts
│   └── skill_registry.py      # Loads skills/*/skill.yaml into registry
│
├── services/api/              # FastAPI HTTP layer
│   ├── main.py                # App + routers + StaticFiles mount
│   ├── store.py               # In-memory dataset store (DataFrame cache)
│   └── routers/
│       ├── chat.py            # /chat, /plan, /fetch-data
│       ├── simulation.py      # /debate, /interview
│       ├── upload.py          # /upload-csv, /datasets/sync
│       ├── patterns.py        # /run-pattern
│       ├── strategies.py      # /run-strategy
│       ├── backtest.py        # /run-backtest
│       ├── analysis.py        # /run-analysis
│       └── indicators.py      # /run-indicator
│
├── skills/                    # Declarative skill definitions
│   ├── data_fetcher/SKILL.md + skill.yaml
│   ├── pattern/SKILL.md + skill.yaml
│   ├── strategy/SKILL.md + skill.yaml
│   ├── swarm_intelligence/SKILL.md + skill.yaml
│   └── _template/             # Copy-this-to-add-a-new-skill
│
├── apps/web/                  # Next.js frontend
│   ├── src/
│   │   ├── app/page.tsx       # Root layout (sidebars + canvas + panel)
│   │   ├── components/
│   │   │   ├── canvas/        # NEW (Phase 3) — Canvas + ChartWindow
│   │   │   ├── tabs/          # Bottom-panel tab implementations
│   │   │   ├── playground/    # Paper-trading UI
│   │   │   ├── simulation/    # Swarm settings / DAG host
│   │   │   ├── Chart.tsx      # One lightweight-charts instance
│   │   │   ├── DrawingToolbar.tsx
│   │   │   ├── RightSidebar.tsx     # Chat + script editor
│   │   │   ├── LeftSidebar.tsx      # Conversation list + mode toggle
│   │   │   ├── BottomPanel.tsx      # Dockable bottom panel
│   │   │   ├── TopBar.tsx
│   │   │   └── TimeframeSelector.tsx
│   │   ├── lib/
│   │   │   ├── api.ts         # Typed HTTP client for the FastAPI
│   │   │   ├── planExecutor.ts  # Step-by-step plan execution + trace
│   │   │   ├── toolRegistry.ts  # Tool-call → store-mutation router
│   │   │   ├── scriptExecutor.ts  # Pattern script Web Worker
│   │   │   ├── strategyExecutor.ts # Backtest Web Worker
│   │   │   ├── chart-primitives/  # Custom lightweight-charts plugins
│   │   │   └── csv/              # Upload + resampling logic
│   │   ├── store/useStore.ts   # All zustand state + actions
│   │   └── types/index.ts      # Shared TypeScript types
│   └── package.json
│
├── vibe_trade/                # The CLI package (pip-installable)
│   ├── cli.py                 # Typer app
│   ├── serve_cmd.py           # vibe-trade serve
│   ├── fetch_cmd.py           # vibe-trade fetch
│   ├── simulate_cmd.py        # vibe-trade simulate
│   ├── setup_cmd.py           # vibe-trade setup (API key wizard)
│   ├── update_cmd.py          # vibe-trade update (pipx-aware)
│   ├── build_frontend.py      # Triggers npm run build on serve if no bundle
│   ├── user_config.py         # XDG-compliant config/env resolution
│   └── web_static/            # Bundled Next.js static export (release)
│
├── docs/                      # This folder
│   ├── ARCHITECTURE.md        # You are here
│   ├── SKILLS.md
│   ├── SWARM_PIPELINE.md
│   ├── CANVAS.md
│   └── back/                  # Archive of pre-refactor docs
│
└── pyproject.toml             # vibe-trade Python package
```

## 6. Frontend state model

All UI state lives in a single Zustand store: `apps/web/src/store/useStore.ts`.
Key slices (with their authoritative types in `src/types/index.ts`):

### Conversations
- `conversations: Conversation[]` — persisted to localStorage
- `activeConversationId: string | null`
- Actions: `createConversation`, `switchConversation`, `deleteConversation`,
  `hydrateConversations`

Each `Conversation` snapshots a complete session: messages, active
dataset, chart windows, datasets, drawings, debate results, etc.
Switching threads restores this snapshot verbatim (see
`_snapshotLiveStateInto` + restoration paths in useStore).

### Datasets
- `datasets: Dataset[]` — per-session
- `datasetChartData: Record<id, OHLCBar[]>` — **what chart windows render**
- `datasetRawData: Record<id, OHLCBar[]>` — source of truth (pre-resample)
- `syncedDatasets: Set<id>` — which are confirmed in the backend store
- `activeDataset: string | null` — focused window's dataset, kept in sync

### Canvas (Phase 3)
- `chartWindows: ChartWindow[]` — each `{id, datasetId, x, y, width, height, zIndex}`
- `focusedWindowId: string | null`
- Actions: `addChartWindow`, `removeChartWindow`, `updateChartWindow`,
  `focusChartWindow`, `setChartWindowDataset`. Each mutation snapshots.

### Per-dataset feature state (Phase 3 multi-chart)
- `patternMatchesByDataset: Record<id, PatternMatch[]>` — so each
  window shows only its own pattern matches
- `chartFocusByDataset: Record<id, Focus | null>` — so clicking a
  pattern match only zooms the chart that owns it
- Legacy `patternMatches` + `chartFocus` kept as fallbacks for
  single-chart UI paths

### Skill messages / chat
- `patternMessages: Message[]` + `strategyMessages: Message[]`
- `messages: Message[]` (derived view of current mode)
- Actions: `addMessage`, `updateMessage`, `addMessageToConversation`

### Script editor + results
- `currentScript: string`
- `strategyConfig: StrategyConfig | null`
- `backtestResults: BacktestResult | null`
- `lastScriptResult: { ran, error? } | null`

### Drawings + indicators
- `drawings: Drawing[]` (global across all charts — flagged for Phase 4 to be per-window)
- `indicators: IndicatorConfig[]` (global)
- `pineDrawings`, `pineDrawingsPlotData`

### Simulation / Swarm
- `currentDebate: SimulationDebate | null`
- `expandedAgentId: string | null` — which persona card is open
- `agentInterviews: Record<agentId, Turn[]>` — chat with each agent
- `agentInterviewLoading: Record<agentId, boolean>`

### Playground (paper-trading)
- `playgroundWallet`, `playgroundPositions`, `playgroundOrders`,
  `playgroundTrades`, `playgroundReplay`
- Drives a bar-by-bar replay loop via `usePlaygroundReplay`

## 7. Data flow for the 4 core skills

### data_fetcher
1. Backend processor calls `core.data.fetcher.fetch(symbol, interval, limit)`
   → yfinance/ccxt normalized bars
2. Processor **saves bars into `services.api.store`** with a generated
   `dataset_id` (backend has the data *before* the response returns)
3. Emits `tool_call: data.dataset.add` with `{dataset_id, bars, metadata, ...}`
4. Frontend toolRegistry uses the backend-supplied id; calls
   `addDataset(dataset, bars, bars)`; `markSynced(id)` immediately
5. `addDataset` auto-spawns a new ChartWindow on the canvas (cascaded
   +32/+32 from the previous window, 560×360 default)

### pattern
1. User types "detect engulfing pattern"
2. Backend `_pattern_processor` generates a JS pattern script via LLM
3. Emits `tool_call: script_editor.load` + `tool_call: bottom_panel.activate_tab: pattern_analysis`
4. Frontend `planExecutor` detects `result.script` and `step.skill === "pattern"`;
   iterates over every canvas window with loaded bars, running
   `executePatternScript(script, bars)` against each via Web Worker
5. Calls `setPatternMatchesForDataset(dsid, matches)` per chart
6. Each ChartWindow reads `patternMatchesByDataset[w.datasetId]` for
   its highlights
7. Bottom panel's **Pattern Analysis** tab merges all per-dataset match
   lists into one flat table with Asset column; row clicks set
   `chartFocusByDataset[owner_id]` so only that chart zooms

### strategy
1. User describes strategy + config (TP/SL, seed amount, instructions)
2. Backend `_strategy_processor` generates a JS strategy script
3. Frontend `planExecutor` runs `executeStrategy(script, chartData, config)`
   in a Web Worker → `BacktestResult` with trades, equity curve, metrics
4. Populates `backtestResults` — rendered in the bottom-panel
   Portfolio Analysis / Trade List tabs
5. **Multi-chart strategy is Phase 3.5 (deferred)** — currently backtests
   against the focused chart only

### swarm_intelligence
Full pipeline documented in `SWARM_PIPELINE.md`. Summary:
1. Processor receives `dataset_id` (focused) and `dataset_ids` (all canvas)
2. Promotes focused to index 0; loads each from `services.api.store`
3. For len(loaded) > 1, builds a portfolio context block appended to `report_text`
4. `DebateOrchestrator.run()` runs 5 stages:
   - Stage 1: Context Analysis (classifier + market context)
   - Stage 1.5: Intelligence Gathering (web search + briefing synth)
   - Stage 2: Persona Generation (50 agents)
   - Stage 2.5: Iterative Research (each agent plans own queries)
   - Stage 3: Multi-Round Debate (30 × 15 speakers)
   - Stage 4: Cross-Examination (divergent agents pressed)
   - Stage 5: ReACT Report
5. Processor wraps orchestrator result with `{debate_id, symbol, bars_analyzed, events}`
   and emits `tool_call: simulation.set_debate`
6. toolRegistry maps snake_case→camelCase → `setCurrentDebate(mapped)`
7. Four bottom-panel tabs render: DAG Graph, Personalities (click →
   AgentDetailPanel with live `/interview` chat), Debate Thread, Run Stats

## 8. HTTP API

All mounted under the base FastAPI app in `services/api/main.py`. Key routes:

| Method | Path | Purpose |
|---|---|---|
| POST | `/chat` | Dispatch a skill with a message + context |
| POST | `/plan` | Build a multi-step plan (no execution) |
| POST | `/fetch-data` | Raw yfinance/ccxt fetch (bypasses skills) |
| POST | `/upload-csv` | Upload OHLCV CSV → store |
| POST | `/datasets/sync` | Frontend pushes bars to backend store |
| POST | `/run-pattern` | Run pattern detection server-side (alternative to Web Worker) |
| POST | `/run-strategy` | Generate strategy script server-side |
| POST | `/run-backtest` | Run backtest server-side |
| POST | `/run-indicator` | Run indicator script |
| POST | `/run-analysis` | Run multi-analysis (indicators, patterns, etc.) |
| POST | `/debate` | Full swarm debate (direct REST, alternative to skill path) |
| POST | `/interview` | Live Q&A with a specific debate agent |
| GET | `/api/status` | Health + active LLM provider info |
| GET | `/skills` | List registered skills |
| GET | `/tools` | List registered tools |

## 9. Reliability

### Timeouts (layered)

| Level | Budget (default) | Configurable via |
|---|---|---|
| Per-LLM-call HTTP | 90 s | `LLM_CALL_TIMEOUT_S` |
| LLM retries on transient failures | 2 | `LLM_MAX_RETRIES` |
| Per-swarm-speaker | 180 s | — |
| Swarm Stage 4 (cross-exam) | 300 s | — |
| Swarm Stage 5 (report) | 480 s, with 240 s per-call override | — |
| Outer `/debate` endpoint | 45 min | `DEBATE_TIMEOUT_S` |

### RunEvents
Every failure / timeout / warning inside the Swarm pipeline is recorded
as a `RunEvent` `{timestamp, level, stage, message}`. Returned in the
`/debate` response (and surfaced via HTTPException detail on outer
timeout). Rendered as a red/amber banner at the top of the **Run
Stats** bottom-panel tab and as a Rich panel at the end of `vibe-trade
simulate` CLI runs.

### Fallbacks
- Swarm Stage 5 report failure → `_fallback_summary_from_thread` builds
  a real summary from the debate thread (top bullish / bearish excerpts
  + median price predictions + consensus from `_compute_consensus`)
  instead of a useless NEUTRAL stub
- Swarm planner LLM failure → keyword fallback in `planner._keyword_fallback`
  guarantees common intents ("fetch X", "run swarm", "find pattern")
  still produce a plan
- DuckDuckGo rate limit → multi-backend retry (`auto/html/lite`) +
  exponential backoff in `swarm_tools.web_search`
- Windows / uvicorn noise on startup → targeted `warnings.filter` +
  `sys.unraisablehook` for the known-benign `_ssock` / coroutine warnings

## 10. Persistence

- **Backend dataset store** (`services/api/store.py`) — in-memory only.
  No disk persistence. Each server restart clears it; the frontend
  re-syncs datasets on demand.
- **Frontend conversations** — persisted to `localStorage` via
  `savePersistedConversations`. Hydrated on mount via
  `hydrateConversations`. Each conversation carries: messages, active
  dataset, datasets + chart data, drawings, chart windows (Phase 3),
  selected timeframe, debate results.
- **User API keys** — written to the user config dir via
  `vibe_trade.user_config`:
  - Linux/Mac: `~/.config/vibe-trade/.env`
  - Windows: `%APPDATA%\vibe-trade\.env`

## 11. What's intentionally NOT here (yet)

- **Per-window indicators / drawings** (currently global — applies to
  every chart). Flagged for Phase 4.
- **Per-window timeframe selector** (TimeframeSelector affects only
  the focused chart's dataset; there's one toolbar for the whole canvas).
- **Multi-chart strategy backtest** (runs against the focused chart only;
  Phase 3.5 will add cross-asset equity curves + combined drawdown).
- **Dataset persistence** across server restarts (backend store is
  purely in-memory).
- **Streaming swarm progress** (frontend shows a timer-based fake
  progress; real per-round updates require SSE or WebSocket).
- **Drag-from-sidebar to spawn chart** (all charts come via chat
  `data_fetcher` today).
- **Per-window interview drawer** (interviews live in a bottom-panel
  flow, not anchored to a window).

## 12. Release process

See `RELEASE_NOTES_v0.4.{0,1,2}.md` for templates. Steps:
1. Bump `version` in `pyproject.toml` + `vibe_trade/__init__.py`
2. Write `RELEASE_NOTES_v<X>.md`
3. Commit
4. `python -m vibe_trade.cli build-frontend --force` to refresh the bundled UI
5. `python -m build` to produce wheel + sdist in `dist/`
6. `python -m twine check dist/*`
7. Create annotated tag `git tag -a v<X> -m "..."`
8. Push `main` + tag
9. `python -m twine upload dist/*` (needs PyPI token)
10. `gh release create v<X> --title ... --notes-file RELEASE_NOTES_v<X>.md`
    + drag the wheel/sdist as release assets
