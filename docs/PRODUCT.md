# Vibe Trade — Product Overview

> **Single source of truth** for what the product is, how it's
> organised, and what's actually in it. Start here if you're new to
> the codebase; follow the links for deeper dives.
>
> **Companion docs**: [ARCHITECTURE.md](./ARCHITECTURE.md) ·
> [AGENT_SWARM.md](./AGENT_SWARM.md) · [SKILLS.md](./SKILLS.md) ·
> [CANVAS.md](./CANVAS.md) · [PREDICT_ANALYSIS.md](./PREDICT_ANALYSIS.md)

---

## 1. What Vibe Trade is

Vibe Trade is an **AI-native trading workspace**. You load charts,
describe what you want in natural language (*"fetch AAPL daily for
2 years, find a double-bottom, backtest it with $10k"*), and a team of
LLM agents assembles, executes, and verifies the work for you. The
output is real: actual OHLC data on actual charts, pattern-detection
scripts that run in your browser, backtests with trade lists and
equity curves, 50-persona portfolio debates with citations.

What makes it different from a chat wrapper over a charting library:

- **Multi-chart canvas** — not one fixed chart; a freeform workspace
  that hosts N draggable, resizable chart windows. Skills operate
  across all of them.
- **Plan-first agent teams** — every skill invocation plans which
  specialised agents it needs before executing. Plan is shown in the
  trace UI before any work starts.
- **Closed-loop QA** — generated scripts are statically verified, and
  if they crash at runtime an Error Handler Agent diagnoses and fixes
  them automatically.
- **Real data, real execution** — scripts run in the browser's Web
  Worker sandbox against actual OHLCV data; backtests produce real
  trade lists; the swarm debate reads real news and references it.
- **Full transparency** — every agent message, every research query,
  every cross-examination question is inspectable in the UI.

The platform can be self-hosted via `pipx install vibe-trade`. The
CLI (`vibe-trade serve`) starts a FastAPI backend and serves a
bundled Next.js frontend from the same process — no Node.js required
at runtime.

---

## 2. The 3-layer architecture at a glance

```
╔══════════════════════════════════════════════════════════╗
║                   LAYER 1: CANVAS                        ║
║   The stage. Multi-chart workspace + side panels +       ║
║   bottom panel. Everything the user sees.                ║
║                                                          ║
║   Also hosts Canvas-level capabilities that every skill  ║
║   shares: the Planner, the Agent Swarm Service, and the  ║
║   swarm-tools registry.                                  ║
╠══════════════════════════════════════════════════════════╣
║                   LAYER 2: TOOLING                       ║
║   Two tool vocabularies:                                 ║
║                                                          ║
║   UI Tools (frontend verbs)   Swarm Tools (agent verbs)  ║
║   ─────────────────────────   ──────────────────────     ║
║   data.dataset.add            search_web                 ║
║   script_editor.load          fetch_url                  ║
║   chart.set_timeframe         fetch_pdf                  ║
║   chart.focus_range           run_indicator              ║
║   simulation.set_debate       compute_levels             ║
║   swarm.team_plan.set         fetch_news                 ║
║   ... (~20 total)             fetch_policy               ║
║                                                          ║
║   UI tools mutate the Canvas. Swarm tools give LLM       ║
║   agents research + analysis powers.                     ║
╠══════════════════════════════════════════════════════════╣
║                   LAYER 3: SKILLS                        ║
║   Extensions the Planner dispatches. Each skill          ║
║   declares WHAT team of agents it needs; the             ║
║   Canvas-level AgentSwarm service handles HOW.           ║
║                                                          ║
║   Current skills:                                        ║
║   • data_fetcher      — pull bars, spawn chart window    ║
║   • pattern           — generate detection script        ║
║   • strategy          — generate + backtest script       ║
║   • predict_analysis  — 50-persona debate                ║
╚══════════════════════════════════════════════════════════╝
```

Key shift from earlier versions: **agentic orchestration moved from
being a skill-private trick into a Canvas-level capability**. Every
skill can spawn agents, run them in parallel/sequential/discussion,
run closed QA loops, and recover from runtime errors — all through
one shared service.

---

## 3. Layer 1 — Canvas (detailed)

The Canvas is the entire visible product: the chart area, the side
panels, the bottom panel, and the Canvas-level capabilities hiding
under the UI.

### 3.1 UI regions

```
┌─────────────────────────────────────────────────────────────┐
│                        TopBar                               │
├──────────────┬───────────────────────────────┬──────────────┤
│              │      TimeframeSelector        │              │
│              ├───────────────────────────────┤              │
│   Left       │                               │   Right      │
│   Sidebar    │                               │   Sidebar    │
│              │        CANVAS WORKSPACE       │              │
│   Conversation│      (multi-chart area)      │   Chat +     │
│   list +     │      N freely-arranged        │   Script     │
│   mode       │      ChartWindows             │   editor     │
│   toggle     │                               │              │
│              │                               │              │
├──────────────┴───────────────────────────────┴──────────────┤
│                     BottomPanel (tabs)                      │
└─────────────────────────────────────────────────────────────┘
```

| Region | Component | Purpose |
|---|---|---|
| **Top bar** | `TopBar.tsx` | App title, sidebar toggles |
| **Left sidebar** | `LeftSidebar.tsx` | Conversation list, new-chat button, mode toggle |
| **Canvas** | `canvas/Canvas.tsx` + `ChartWindow.tsx` | Freeform workspace with N chart windows (drag/resize/close). See [CANVAS.md](./CANVAS.md) |
| **Drawing toolbar** | `DrawingToolbar.tsx` | Pattern select, trendline, rectangle, fibonacci, long/short position, etc. |
| **Timeframe selector** | `TimeframeSelector.tsx` | Resample focused chart between 1m/5m/15m/1h/1d/etc. |
| **Right sidebar** | `RightSidebar.tsx` | Chat input, chat messages, script editor with Run / Clear Chart / Reset buttons |
| **Bottom panel** | `BottomPanel.tsx` | Dockable tabs that change based on active skills (Pattern Analysis, Portfolio Analysis, Trade List, DAG Graph, Personalities, Debate Thread, Run Stats, etc.) |

### 3.2 Multi-chart workspace

Each `ChartWindow` is a freely-positioned rectangle wrapping a
lightweight-charts instance. Drag the title bar to move, drag corners
to resize, click × to close. Focus changes z-index. Chat `fetch`
commands auto-spawn windows (cascade offset). Full per-conversation
persistence — layouts survive thread switches and browser reloads.

### 3.3 Canvas-level capabilities (shared across skills)

Three services embedded in the Canvas that every skill can invoke:

- **Planner** (`core/agents/planner.py`) — decides which SKILLS run
  for a given user request
- **AgentSwarm Service** (`core/engine/agent_swarm.py`) — spawn,
  orchestrate, verify teams of LLM agents. See
  [AGENT_SWARM.md](./AGENT_SWARM.md)
- **Swarm Tools registry** (`core/agents/swarm_tools.py`) — shared
  tools any agent can call (web search, indicator math, etc.)

Also three specialised agent patterns available to every skill:

| Agent pattern | File | When it runs |
|---|---|---|
| **QA Agent** | `core/agents/qa_agent.py` | BEFORE script leaves backend — static + reasoning verification |
| **Error Handler** | `core/agents/error_handler_agent.py` | AFTER runtime crash — LLM diagnoses + fixes the script |
| **Team Planner** | `core/agents/team_planner.py` | Before team assembly — LLM picks which agents to spawn |

### 3.4 Conversation persistence

Every session detail is snapshotted per-conversation to localStorage:
chart windows (positions + sizes + dataset ids), drawings, pattern
matches, backtest results, debate results, chat messages, active skill
chips, selected timeframe. Switching threads restores the exact
workspace you left.

---

## 4. Layer 2 — Tooling (detailed)

Tools are the verbs. Two vocabularies.

### 4.1 UI Tools (frontend mutations)

Registered in `apps/web/src/lib/toolRegistry.ts`. Each is a handler
`(value: unknown, ctx: {skillId: string}) => void`. Skills emit these
in their `SkillResponse.tool_calls` to update the UI.

| Tool | Payload | What it does |
|---|---|---|
| `data.dataset.add` | `{dataset_id, bars, metadata, symbol, source, interval}` | Add dataset to store, auto-spawn chart window, mark synced |
| `data.fetch_market` | *(no-op, logged)* | Marker for backend-handled fetches |
| `data.indicators.add` | `{name, color, params, ...}` | Add indicator overlay to charts |
| `data.indicators.toggle` | indicator name string | Toggle visibility |
| `script_editor.load` | script string | Load JS into the code editor |
| `script_editor.run` | *(no-op — editor's Run button handles it)* | Signal intent |
| `chart.pattern_selector` | boolean | Enter/exit drag-to-select mode |
| `chart.highlight_matches` | match list | Highlight pattern matches on chart |
| `chart.draw_markers` | marker list | Draw ad-hoc price markers |
| `chart.focus_range` | `{startTime, endTime}` | Zoom focused chart to range |
| `chart.set_timeframe` | `"1h" / "1d" / null` | Resample focused chart |
| `chart.drawing.trendline` | — | Activate trendline tool |
| `chart.drawing.horizontal_line` | — | Activate horizontal-line tool |
| `chart.drawing.vertical_line` | — | Activate vertical-line tool |
| `chart.drawing.rectangle` | — | Activate rectangle tool |
| `chart.drawing.fibonacci` | — | Activate fibonacci retracement tool |
| `chart.drawing.long_position` | — | Activate long-position tool |
| `chart.drawing.short_position` | — | Activate short-position tool |
| `bottom_panel.activate_tab` | tab id | Switch to specific bottom-panel tab |
| `bottom_panel.set_data` | `{tab, data}` | Inject data into a tab |
| `chatbox.card.strategy_builder` | form payload | Render a strategy-form card in chat |
| `chatbox.card.generic` | `{title, body, ...}` | Render a generic info card in chat |
| `simulation.run_debate` | — | Trigger direct-REST `/debate` fallback path |
| `simulation.set_debate` | full debate payload | Map backend payload → `currentDebate` in store |
| `simulation.reset` | — | Clear `currentDebate` |
| `swarm.team_plan.set` | `TeamPlan` | Render the planned agent team in trace UI before execution |
| `notify.toast` | `{level, message}` | Transient toast notification |

**Allowed-tools validation**: each skill's `SKILL.md` frontmatter
lists which UI tools it may emit; the frontend drops any tool_call
outside that allowlist (with a console warning).

### 4.2 Swarm Tools (agent capabilities)

Registered in `core/agents/swarm_tools.py`. These are what LLM agents
can call mid-execution to gather information or run analysis. Each
returns a string that gets injected into the agent's next prompt.

| Tool | Signature | What it does |
|---|---|---|
| `web_search` | `(query, max_results=5)` | DuckDuckGo search (via `ddgs`) with multi-backend retry (auto / html / lite) and a 10s-per-attempt timeout |
| `fetch_url` | `(url, max_chars=5000)` | Fetch a URL, extract readable text via BeautifulSoup (strips scripts/styles/nav) |
| `fetch_pdf` | `(url, max_chars=5000)` | Download + extract text from a PDF via pypdf2 |
| `fetch_news` | `(asset_name, max_results=5)` | `web_search` specialised for news queries |
| `fetch_policy` | `(topic, max_results=3)` | `web_search` specialised for regulatory/policy queries |
| `run_indicator` | `(bars, indicator, params)` | Run a built-in indicator (SMA / EMA / RSI / MACD / Bollinger / ATR / VWAP) server-side and return a summary |
| `compute_levels` | `(bars)` | Extract support/resistance levels (swing highs/lows + volume profile) |

**Rate limiting**: a global `_search_lock` with a 0.5s minimum
interval serialises ALL DuckDuckGo calls to avoid IP blocks. Non-web
tools (indicator, levels) have no rate limit.

**Role-based tool access**: `ROLE_TOOL_MAP` in `swarm_tools.py`
pre-assigns which tools each agent role gets — a "technical" agent
gets `run_indicator + compute_levels`, a "macro" agent gets
`search_web + fetch_news + fetch_policy`, etc. The Team Planner can
override this per-request.

---

## 5. Layer 3 — Skills (detailed)

Each skill is a backend capability registered in
`core/agents/processors.py` and declared in `skills/<id>/SKILL.md`.
The Planner decides which skills run; users don't invoke skills
directly.

### 5.1 `data_fetcher`

**Purpose**: pull historical OHLCV bars and load them onto the Canvas.

**Team**: none. Pure backend operation (yfinance / ccxt) with no LLM
calls. Simplest skill type — no agent orchestration needed.

**Flow**:
1. Parse the user's message for ticker + interval + limit (regex-
   based via `core.data.fetcher.parse_query`)
2. Fetch bars via yfinance (stocks/ETFs/indices) or ccxt (crypto)
3. **Save bars to the backend store immediately** (with a
   backend-generated `dataset_id`) so the next skill's processor
   can find them without waiting for a frontend sync round-trip
4. Emit `tool_call: data.dataset.add` with the bars + dataset_id
5. Frontend auto-spawns a new chart window for the dataset

**Multi-chart behaviour**: each fetch spawns a new window, cascaded
+32/+32 from the previous. Fetching the same dataset twice refocuses
the existing window instead of duplicating.

**Triggers** (keyword fallback): "fetch", "load", "download",
"pull", "get data", "show chart".

**Example**:
> User: "fetch BTC/USDT 1h"
> → Loads ~500 bars of BTC/USDT at 1h from Binance via ccxt, spawns a chart window

### 5.2 `pattern`

**Purpose**: generate a JavaScript pattern-detection script from a
natural-language description, then auto-run it on every loaded chart.

**Team** (plan-first):

| Role | Mandatory | Tools | Added when |
|---|---|---|---|
| **Writer** | ✅ | — | Always. Uses the battle-tested `PATTERN_SYSTEM_PROMPT` as its system prompt |
| **QA Verifier** | ✅ | — | Always. Runs static analysis + reasoning check |
| **Researcher** | ⏳ optional | `search_web`, `fetch_url` | Added by the Team Planner when the pattern is unusual/academic (e.g. "Wyckoff accumulation phase") — skipped for well-known patterns |

**Flow**:
1. Team Planner picks the team based on the user's description
2. Emit `swarm.team_plan.set` → trace UI renders the plan
3. Researcher runs first if planned (timeout 90s) — its findings
   feed into the Writer's context
4. Writer drafts the script
5. QA verifies via static analyser (regex checks for forbidden APIs,
   missing return, hardcoded confidence, over-strict thresholds) +
   LLM reasoning on acceptance criteria
6. If fail, Writer reflects on feedback and iterates (max 3 rounds)
7. Final script emitted as `script_editor.load` tool_call
8. Frontend auto-runs the script against every loaded chart (Web
   Worker); matches stored per-dataset in `patternMatchesByDataset`
9. On runtime crash → Error Handler Agent fixes + re-runs once

**Triggers**: "detect pattern", "find X pattern", "engulfing",
"harmonic", etc.

**Example**:
> User: "detect bullish engulfing"
> → Team: Writer + QA. Script drafted, static-verified in 1-2 iterations.
> UI shows matches on every loaded chart (per-dataset), trace says
> "✓ QA-verified in 1 iteration(s)".

### 5.3 `strategy`

**Purpose**: generate a JavaScript backtest script from a structured
strategy config (entry/exit/TP/SL), then auto-run the backtest.

**Team** (plan-first):

| Role | Mandatory | Tools | Added when |
|---|---|---|---|
| **Writer** | ✅ | — | Always. Uses `STRATEGY_GENERATE_PROMPT` with the config baked in |
| **QA Verifier** | ✅ | — | Always. Static analyser + reasoning |
| **Risk Manager** | ⏳ optional | `run_indicator`, `compute_levels` | Added when the config has non-trivial risk params (leverage, aggressive DD, shorts) |
| **Portfolio Manager** | ⏳ optional | `search_web` | Added when the request references market conditions, regime, asset-class context |

**Flow**:
1. Team Planner picks the team
2. Plan emitted to trace UI
3. Risk Manager + Portfolio Manager run sequentially (per-agent timeout
   120s) — their analyses feed into the Writer's context
4. Writer drafts the strategy script
5. QA verifies (static: equity-pushed-every-bar, trade-shape, config
   respected, forbidden APIs, bounds checks)
6. Iterate up to 3× on failure
7. Frontend auto-runs the backtest (Web Worker) → `BacktestResult`
   with trade list, equity curve, metrics
8. On runtime crash → Error Handler Agent fixes + re-runs once

**Also has an "analyze" mode** (legacy single-call): takes
pre-computed backtest metrics and returns a natural-language
analysis + suggestion list.

**Triggers**: "backtest", "build a strategy", "profit factor",
"sharpe", "pnl".

**Example**:
> User (via strategy form): *Entry: RSI < 30, Exit: RSI > 70, TP 5%, SL 2%, $10k seed*
> → Team: Writer + QA (simple config, no Risk Manager added).
> Script drafted + verified + backtest runs → "42 trades, 54% win rate, 18% return, Sharpe 1.6".

### 5.4 `predict_analysis`

**Purpose**: run a 50-persona trading committee debate to predict
market direction and produce a trade recommendation.

> Renamed from `swarm_intelligence`. The old id still routes to the
> same processor via a backward-compat alias.

**Team**: 50+ agents across a 5-stage pipeline (full details in
[PREDICT_ANALYSIS.md](./PREDICT_ANALYSIS.md)). Stages:

1. **Context Analysis** — asset classifier + market regime extraction
2. **Intelligence Gathering** — 4 web searches → bull/bear briefing
3. **Persona Generation** — 50 personas with distinct backgrounds,
   biases, influence weights (0.5–3.0), specialisations, tool access
4. **Iterative Research** — each persona plans their own research
   queries (min 3, max 8 per agent)
5. **Multi-Round Debate** — 30 rounds × 15 speakers with per-agent
   memory and selective thread routing
6. **Cross-Examination** — press the 6–8 most divergent personas
7. **ReACT Report** — synthesise consensus + apply influence-weighted
   math override

**Multi-chart (portfolio) mode**: when the Canvas has multiple
windows, the focused chart is the primary asset; siblings are
summarised and injected into the intel briefing as portfolio context.
Personas reference them naturally ("ETH is up 8% — strengthens
rotation-away-from-BTC thesis").

**Output UI tabs** (bottom panel):
- **DAG Graph** — React Flow pipeline visualisation
- **Personalities** — 50 persona cards; click → expanded view with
  research trail, messages, cross-exam Q&A, live `/interview` chat
- **Debate Thread** — every message with sentiment, tool chips,
  agreement references
- **Run Stats** — consensus, briefing, market context, data feeds,
  cross-exam, convergence chart, PDF export (Summary / Full), Run
  Warnings banner for any errors/timeouts

**Reliability**: 4-layer timeout stack + structured `RunEvent`s
surfaced to the UI. See [PREDICT_ANALYSIS.md](./PREDICT_ANALYSIS.md)
§ Reliability.

**Triggers**: "predict", "forecast direction", "run swarm",
"committee", "debate", "panel debate".

**Typical run time**: 10–30 minutes for a full 50 × 30 preset.

**Example**:
> User: "run swarm intelligence on BTC"
> → 5 stages execute, UI shows team plan + progress per stage.
> Final: "Consensus: BULLISH 68%. Entry: $82k, Stop: $78k, Target:
> $92k. Position size: 2.5%."

---

## 6. Cross-cutting features

### 6.1 Planner (Level 1)

`core/agents/planner.py` — picks which SKILLS run per user message.
LLM-driven with a keyword-fallback safety net for common intents.

Prompts always see the full skill registry (not filtered by chip
selection) so typed intent always wins.

### 6.2 Team Planner (Level 2)

`core/agents/team_planner.py` — for each invoked skill, picks which
AGENTS the team needs. LLM reads role templates (mandatory + optional,
with allowed tools) and decides which optional roles to add based on
the specific request.

Plan is always emitted as `swarm.team_plan.set` tool_call so the UI
renders the team BEFORE execution starts. Users see who's being
assembled and what each agent will do.

Fallback: if the planner LLM is unavailable, mandatory-only plan with
default tasks — guaranteed executable.

### 6.3 Agent Swarm Service

`core/engine/agent_swarm.py` — the orchestration primitive. Exposes:

```python
swarm = AgentSwarm()
team = swarm.assemble([AgentSpec(role=..., persona=..., tools=...)])

await team.run_parallel(task, context)
await team.run_sequential(task, context, order)
await team.run_with_qa_loop(task, context, producer, verifier, max_iters)
await team.discussion(rounds, speakers_per_round, ...)
```

Handles all reliability (per-agent timeouts, retries, event
recording) so every skill using the service inherits the same
guarantees.

### 6.4 QA Agent pattern

`core/agents/qa_agent.py` — closed-loop verification. Producer drafts
→ verifier checks (static + reasoning) → producer reflects on
feedback → iterate up to N times. Used by Pattern + Strategy skills.

### 6.5 Error Handler Agent

`core/agents/error_handler_agent.py` — post-runtime-crash recovery.
When a pattern or strategy script throws in the Web Worker, the
frontend POSTs `/fix-script` with `{script, error, intent, script_type}`;
the LLM diagnoses + returns a fixed version; the harness re-runs once.
Bounded to one fix attempt per run.

### 6.6 Clear Chart button

Script-editor toolbar has two actions:
- **Clear Chart** — wipes visual output on all chart windows
  (pattern matches, chart focus, plotted trades, pine drawings) but
  keeps the script + backtest results + user-drawn drawings
- **Reset** — wipes everything (script, backtest, matches) and
  switches to chat view

---

## 7. Glossary

| Term | Meaning |
|---|---|
| **Canvas** | The freeform multi-chart workspace + its Canvas-level capabilities (Planner, AgentSwarm, swarm-tools) |
| **Chart Window** | One draggable/resizable rectangle on the Canvas showing one dataset |
| **Skill** | A registered capability the Planner can dispatch (data_fetcher, pattern, strategy, predict_analysis) |
| **UI Tool** | A frontend verb (tool_call) a skill emits to update the Canvas (script_editor.load, chart.set_timeframe, etc.) |
| **Swarm Tool** | A backend tool an LLM agent can call mid-execution (search_web, run_indicator, etc.) |
| **Agent** | One LLM instance with a persona, memory, and tool access, spawned from an AgentSpec |
| **Team** | A group of Agents assembled by AgentSwarm for a skill call |
| **TeamPlan** | The LLM-chosen selection of agents + tasks + tools for a specific request, rendered in the trace UI before execution |
| **RunEvent** | A structured error/warning/info event emitted during a skill run, surfaced to the UI Run Warnings banner |
| **QA loop** | Producer → verifier → reflect → verifier, bounded by max iterations |
| **Error Handler Agent** | Post-crash fixer that reads a broken script + runtime error + intent and returns a corrected script |

---

## 8. Release + install

```bash
# One-time install
pipx install vibe-trade
vibe-trade setup            # wizard: pick LLM provider + paste API key
vibe-trade serve            # starts backend + serves web UI

# Upgrade
vibe-trade update
```

Current version: see `pyproject.toml` / `vibe_trade/__init__.py`.
Release history: `RELEASE_NOTES_v*.md` files at repo root.

---

## 9. Where to look for details

If you want to understand... | read
---|---
The high-level architecture end-to-end | [ARCHITECTURE.md](./ARCHITECTURE.md)
How skills + planner + tools actually route | [SKILLS.md](./SKILLS.md)
The shared AgentSwarm service API | [AGENT_SWARM.md](./AGENT_SWARM.md)
Multi-chart canvas specifics | [CANVAS.md](./CANVAS.md)
The 50-persona debate pipeline | [PREDICT_ANALYSIS.md](./PREDICT_ANALYSIS.md)
Pre-v0.4 / v0.4.2 historical snapshots | [`docs/back/`](./back/)
