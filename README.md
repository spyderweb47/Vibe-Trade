<div align="center">

# ⚡ Vibe Trade

**The AI-native trading platform. One agent. Unlimited skills.**

Chart data → pattern detection → strategy generation → backtesting, all driven by a single conversational agent that plans multi-step workflows and runs real JavaScript scripts in your browser.

[![GitHub stars](https://img.shields.io/github/stars/spyderweb47/Vibe-Trade?style=for-the-badge&color=ff6b00)](https://github.com/spyderweb47/Vibe-Trade/stargazers)
[![License](https://img.shields.io/github/license/spyderweb47/Vibe-Trade?style=for-the-badge&color=26a69a)](./LICENSE)
[![Python](https://img.shields.io/badge/python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Next.js](https://img.shields.io/badge/next.js-16-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110-009688?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge)](./CONTRIBUTING.md)

[**Install**](#-install) · [**Quick start**](#-quick-start) · [**Skills**](#-the-skill-system) · [**CLI**](#-cli-reference) · [**Architecture**](#-architecture) · [**Contributing**](#-contributing)

https://github.com/user-attachments/assets/4683d6cf-3e97-4e0c-866b-9760eebcb1b7

</div>

---

## 🌟 What is Vibe Trade?

Vibe Trade is an AI trading platform built around **one default agent with pluggable skills**. You don't learn a rigid workflow — you just **tell the agent what you want**:

> *"Fetch BTC 1h data for the last week, find bullish engulfing patterns, then build a strategy that takes long entries on each match with $1000 starting capital."*

The agent plans a three-step workflow, fetches real market data from Binance, generates a detection script, runs it against the data, generates a strategy script, backtests it, and shows you the equity curve and trade list — **in one chat turn**.

Every step is real code executed in real sandboxes. No mock data, no fake fills, no "your strategy will be simulated soon." The scripts run in Web Workers, the backtests produce real PnL, and the chart shows real candles.

## ✨ Feature Highlights

<table>
<tr>
<td width="33%" valign="top">

### 🧠 Built-in Planner
The default agent decomposes multi-step requests into a plan and executes each step **in your browser**, running generated scripts between steps and feeding real results forward. A Claude-style trace box streams live progress and auto-collapses when done.

</td>
<td width="33%" valign="top">

### 🎯 Skill System
Skills are pure `SKILL.md` files — drop a folder, declare the tools you need, restart. The central `TOOL_CATALOG` exposes 23 reusable product features (chart drawing, script editor, bottom panel tabs, notifications, data access) that any skill can call.

</td>
<td width="33%" valign="top">

### 📊 Data Fetcher
Pull OHLC data from **yfinance** (stocks, ETFs, indices, forex, commodities) or **ccxt** (100+ crypto exchanges) — no API key needed. LLM-resolved symbols ("gold", "dogecoin", "xauusd") auto-route to the right provider.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### 🔍 Pattern Detection
Describe a pattern in natural language or draw one on the chart. The agent generates a JavaScript detection script, runs it in a Web Worker, and overlays matches with a mandatory top-K fallback so you always see results.

</td>
<td width="33%" valign="top">

### 💼 Strategy Backtesting
Structured form for entry/exit/TP/SL/drawdown/seed. The agent generates a runnable strategy script, backtests it locally, and renders portfolio metrics, equity curve, trade list, and MAE/MFE per trade.

</td>
<td width="33%" valign="top">

### 🎭 Multi-Agent Simulation
Run an AI committee debate on any asset. 15 personas with distinct backgrounds, biases, and personalities argue across 8 rounds and produce a consensus with confidence, price targets, and a concrete recommendation.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### 💬 Conversation History
Every chat is a persistent thread with its own code, dataset, patterns, and backtest results. ChatGPT-style sidebar with new chat, rename, delete, auto-title from first message, all saved to localStorage.

</td>
<td width="33%" valign="top">

### 🎮 Playground Mode
Replay historical data bar-by-bar (0.5× to Max). Hyperliquid-style trading panel with 1-20× leverage, market/limit orders, TP/SL, liquidation engine. Demo wallet with real margin + fee simulation.

</td>
<td width="33%" valign="top">

### 📜 Pine Script Support
Paste TradingView Pine Script indicators and run them natively via PineTS, with an LLM fallback for unsupported syntax. Pre-computed plots and drawings render alongside the candlesticks.

</td>
</tr>
</table>

## 🚀 Install

### One-liner via pipx *(recommended)*

```bash
pipx install vibe-trade
```

Or with plain pip:

```bash
pip install vibe-trade
```

That's it. Set an LLM key in your `.env` and run:

```bash
vibe-trade serve
```

A Rich banner prints, uvicorn starts, the web UI opens at `http://localhost:8787`. The Python package bundles the pre-built Next.js frontend — **no Node.js required** at runtime.

### From source (for contributors)

```bash
git clone https://github.com/spyderweb47/Vibe-Trade.git
cd Vibe-Trade

# Backend
python -m venv venv
source venv/bin/activate              # Windows: .\venv\Scripts\Activate.ps1
pip install -e .

# Frontend (dev server on :3001)
cd apps/web && npm install && npm run dev
```

Then in a separate terminal: `python -m uvicorn services.api.main:app --reload --port 8001`

Or for a static-export dev flow:

```bash
cd apps/web && npm run export   # produces apps/web/out/
vibe-trade serve                 # picks up apps/web/out automatically
```

## 🏁 Quick Start

### 1. Set your LLM key

Vibe Trade supports **9 LLM providers**. Put one of these in `.env`:

```env
OPENAI_API_KEY=sk-...
# or ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, GEMINI_API_KEY,
#    OPENROUTER_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY, or run Ollama locally
```

### 2. Start the server

```bash
vibe-trade serve
```

### 3. Try the default agent with a multi-step request

With **no skills selected**, type into the chatbox:

> *fetch btc 1h data from last week and find bullish engulfing pattern then build a strategy with 1000 dollar capital*

Watch the trace box stream three steps: `data_fetcher → pattern → strategy`. Each generated script runs against real Binance data in a Web Worker. After the plan completes you'll see:

- **Chart** with 168 BTC 1h candles + pattern match markers + trade position boxes
- **Pattern Analysis tab** — N bullish engulfing matches with confidence scores
- **Portfolio tab** — Total trades, win rate, profit factor, Sharpe, max drawdown, total return, equity curve
- **Trade List tab** — Every trade with entry/exit, PnL, MAE/MFE, holding bars

All from one prompt. No manual chips, no manual runs.

### 4. Or pick a specific skill

Click the **+ Skill** button and select a chip to restrict the agent:
- **Data Fetcher** — only pull market data
- **Pattern Skill** — only detect patterns on the current chart
- **Strategy Skill** — only generate strategies from a structured form

Zero skills = planner mode (all skills available). One skill = direct dispatch. Two or more = planner mode restricted to your selection.

## 🧩 The Skill System

Skills are **pure documentation + a handful of declared tools**. There's no Python boilerplate, no registration code, no framework magic — you drop a `SKILL.md` file into `skills/<id>/`, reference tools from the central catalog, and the backend auto-discovers it at startup.

### Anatomy of a skill

```
skills/pattern/
└── SKILL.md            # Purpose · When to use · Instructions · Tools · Examples
```

```yaml
---
id: pattern
name: Pattern Skill
tagline: Pattern
description: Detects chart patterns in OHLC data from natural-language hypotheses or visual chart selections.
version: 1.0.0
author: Vibe Trade Core
category: analysis
icon: chart-line
color: "#ff6b00"

tools:
  - chart.pattern_selector
  - chart.highlight_matches
  - chart.draw_markers
  - chart.focus_range
  - script_editor.load
  - script_editor.run
  - bottom_panel.activate_tab
  - bottom_panel.set_data
  - notify.toast

output_tabs:
  - id: pattern_analysis
    label: Pattern Analysis
    component: PatternContent
  - id: pine_script
    label: Pine Script
    component: PineScriptPanel

input_hints:
  placeholder: "Describe a pattern to detect..."
  supports_fingerprint: true
---

# Pattern Skill

## Purpose
Turn a trader's pattern idea into a runnable JavaScript detection script...

## When to use this skill
- The user wants to detect a known technical pattern
- The user drew a region on the chart via the pattern selector
- The user wants to build a custom indicator
- The user pasted Pine Script to convert

## Instructions
1. If the message is a fingerprint, first analyze...
2. On confirmation, generate a detection script...
...
```

That's the **entire skill**. No `handler.py`, no imports, no class hierarchy. The registry validates the declared tools against the central catalog, loads the markdown, and the skill is live.

### The central tool catalog (`skills/tools.py`)

**23 reusable tools** across 7 categories that any skill can declare and invoke:

| Category | Tools |
|---|---|
| **script_editor** | `load`, `run` |
| **bottom_panel** | `activate_tab`, `set_data` |
| **chart** | `pattern_selector`, `highlight_matches`, `draw_markers`, `focus_range`, `set_timeframe` |
| **chart.drawing** | `trendline`, `horizontal_line`, `vertical_line`, `rectangle`, `fibonacci`, `long_position`, `short_position` |
| **chatbox.card** | `strategy_builder`, `generic` |
| **data** | `indicators.add`, `indicators.toggle`, `fetch_market`, `dataset.add` |
| **notify** | `toast` |

A skill declares which tools it's allowed to invoke in its `tools:` list. The frontend registry enforces the allowlist — any tool call for an id not in the skill's declared list is rejected with a console warning. This gives skills **capability-based security**: the Pattern skill literally can't open a fetch modal or overwrite a backtest result because those tools aren't in its list.

### Add your own skill in 3 minutes

```bash
# 1. Copy the template
cp -r skills/_template skills/my_skill

# 2. Edit skills/my_skill/SKILL.md — change id, name, description,
#    pick tools from the catalog, write the instructions

# 3. Add a processor to core/agents/processors.py:
#
#    async def _my_skill_processor(message, context, tools):
#        # your logic
#        return SkillResponse(reply="...", tool_calls=[...])
#
#    PROCESSORS = { ..., "my_skill": _my_skill_processor }

# 4. Restart the backend
vibe-trade serve
```

The new skill appears as a chip in the frontend **with zero frontend code changes**. The chip row, bottom-panel tabs, tool allowlist, and input placeholder all render from the skill's metadata.

## 📦 CLI Reference

The `vibe-trade` command exposes every core capability from the terminal:

### `serve` — launch the web UI + backend

```bash
vibe-trade serve                         # web UI on http://localhost:8787
vibe-trade serve --port 9000             # custom port
vibe-trade serve --no-open               # don't auto-open browser
vibe-trade serve --backend-only          # JSON API only
vibe-trade serve --reload                # dev auto-reload
```

### `fetch` — download market data

```bash
vibe-trade fetch BTC/USDT 1h --limit 500         # 500 hourly BTC bars
vibe-trade fetch gold 1d --limit 100 -o gold.csv # save COMEX gold futures to CSV
vibe-trade fetch AAPL 1d --limit 252             # 1 trading year of Apple
vibe-trade fetch dogecoin 5m                     # auto-resolves to DOGE/USDT
vibe-trade fetch ^GSPC 1d --limit 365            # S&P 500 index
vibe-trade fetch EURUSD=X 1h                     # EUR/USD forex
vibe-trade fetch SI=F 1d --limit 500             # silver futures
```

### `simulate` — multi-agent committee debate

```bash
vibe-trade simulate --asset BTC --rounds 8       # 8-round BTC debate in the terminal
vibe-trade simulate -a gold -c "Fed cut rates"   # seed with a news context
vibe-trade simulate                              # interactive prompt
```

### `skills` — inspect the registry

```bash
vibe-trade skills list                    # table of every skill + tool/tab counts
vibe-trade skills show pattern            # full SKILL.md rendered in the terminal
```

### `tools` — list the central tool catalog

```bash
vibe-trade tools                          # 23 tools grouped by category
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Next.js)                      │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ LeftSidebar  │  │  Chart       │  │  RightSidebar      │    │
│  │ · Brand      │  │  · Candles   │  │  · Chat            │    │
│  │ · New Chat   │  │  · Overlays  │  │  · Skill chips     │    │
│  │ · Mode       │  │  · Drawings  │  │  · Script editor   │    │
│  │ · History    │  │  · Primitives│  │  · Trace box       │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
│                                                                 │
│  ┌─────────────────────┐  ┌────────────────────────────────┐   │
│  │ Tool Registry       │  │ Plan Executor                  │   │
│  │ · script_editor.*   │  │ · get plan from /plan          │   │
│  │ · chart.*           │  │ · walk steps sequentially      │   │
│  │ · bottom_panel.*    │  │ · dispatch to /chat per step   │   │
│  │ · data.*            │  │ · run generated scripts in     │   │
│  │ · notify.*          │  │   Web Workers between steps    │   │
│  │ · chart.drawing.*   │  │ · feed results forward         │   │
│  └─────────────────────┘  └────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↕ HTTP
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND (FastAPI)                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ VibeTrade (default agent)                               │   │
│  │ · dispatch(skill_id, message, context)                  │   │
│  │ · try_plan_and_execute(message, context)                │   │
│  │                                                         │   │
│  │   ┌──────────────┐       ┌──────────────┐               │   │
│  │   │ SkillRegistry│──────▶│ Processors   │               │   │
│  │   │ · auto-     │       │ · _pattern_  │               │   │
│  │   │   discover  │       │ · _strategy_ │               │   │
│  │   │ · load      │       │ · _data_     │               │   │
│  │   │   SKILL.md  │       │    fetcher_  │               │   │
│  │   └──────────────┘       └──────────────┘               │   │
│  │          │                      │                      │   │
│  │          ▼                      ▼                      │   │
│  │   ┌──────────────┐       ┌──────────────┐               │   │
│  │   │ Tool catalog │       │ Planner      │               │   │
│  │   │ (23 tools)   │       │ · LLM-based  │               │   │
│  │   └──────────────┘       └──────────────┘               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Core modules                                             │  │
│  │ · core/data/fetcher.py    (yfinance + ccxt + LLM parser) │  │
│  │ · core/agents/             (pattern, strategy, planner)  │  │
│  │ · core/agents/llm_client.py (9 provider fan-out)         │  │
│  │ · skills/                  (SKILL.md files)              │  │
│  │ · services/api/routers/    (HTTP surface)                │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ↕
              ┌───────────────────────────────────┐
              │ External data sources (no API key)│
              │ · yfinance (US/HK/forex/commods)  │
              │ · ccxt (100+ crypto exchanges)    │
              └───────────────────────────────────┘
```

### Key design choices

**Skills are docs, tools are code.** The "what" lives in markdown (SKILL.md), the "how" lives in the central tool catalog + processor functions. This means contributors can write a new skill without touching any TypeScript or React.

**Plan execution in the browser.** The backend builds the plan structure but doesn't execute it — the frontend walks the steps one at a time via `/chat`, runs the generated scripts in Web Workers, captures real results (pattern matches, backtest trades), and feeds them into the next step's context. This is the only way to get closed-loop results in one chat turn without a JS runtime on the backend.

**Skill-scoped tool allowlist.** Every skill declares which tools it can invoke. The frontend tool registry enforces the allowlist. If a Pattern-skill-generated `tool_calls` response tries to call `chatbox.card.strategy_builder`, it's rejected with a console warning — the skill literally can't escape its declared scope.

**Pre-built frontend bundle.** `npm run export` produces a static site in `apps/web/out/`. The release wheel copies it into `vibe_trade/web_static/` and FastAPI mounts it as a `StaticFiles` route at `/`. Users get the full app from `pipx install vibe-trade` with no Node.js setup.

## 🌐 LLM Provider Configuration

Vibe Trade supports **9 LLM providers**. Default is OpenAI but you can swap by changing one `.env` variable.

| Provider | Default model | API key env var | Best for |
|---|---|---|---|
| `openai` *(default)* | `gpt-4o-mini` | `OPENAI_API_KEY` | General purpose |
| `anthropic` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` | Highest quality reasoning |
| `openrouter` | `openai/gpt-4o-mini` | `OPENROUTER_API_KEY` | 100+ models via one key |
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` | Cheapest strong reasoning |
| `groq` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | ~5× faster inference |
| `gemini` | `gemini-2.0-flash` | `GOOGLE_API_KEY` | Free tier |
| `together` | `llama-3.3-70b` | `TOGETHER_API_KEY` | Open-source models |
| `fireworks` | `llama-v3p3-70b` | `FIREWORKS_API_KEY` | Fast OSS inference |
| `ollama` | `llama3.2` | *(none)* | 100% local, private |

Switch providers by editing `.env`:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Or override the model:

```env
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-opus-4-6
```

### Local/private mode with Ollama

```bash
ollama pull llama3.2 && ollama serve
```

```env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Nothing leaves your machine. No API key. No telemetry.

## 🗺️ Roadmap

- [x] Skill system with auto-discovery and central tool catalog
- [x] Built-in planner with closed-loop frontend execution
- [x] Data Fetcher skill (yfinance + ccxt, 23 tools)
- [x] Multi-agent committee simulation
- [x] Persistent conversation history
- [x] Claude-style trace box with auto-collapse
- [x] CLI packaging via pipx
- [x] 9 LLM provider fan-out
- [ ] Backtest execution on the backend (server-side JS runtime)
- [ ] Live paper trading with real-time data streams
- [ ] Per-conversation tool permissions UI
- [ ] Skill marketplace / remote skill loading
- [ ] Strategy fine-tuning from backtest feedback
- [ ] Browser-native indicator authoring
- [ ] Community skill gallery

## 📂 Project Structure

```
trading-platform/
├── pyproject.toml                # Package manifest (pipx install target)
├── vibe_trade/                   # CLI package
│   ├── cli.py                    # Typer app with all subcommands
│   ├── serve_cmd.py              # backend + static frontend
│   ├── fetch_cmd.py              # market data CLI
│   ├── simulate_cmd.py           # multi-agent debate CLI
│   ├── skills_cmd.py             # skill registry inspector
│   └── tools_cmd.py              # tool catalog lister
├── skills/                       # Skill files (first-class, top-level)
│   ├── __init__.py               # SkillRegistry auto-discovery
│   ├── base.py                   # Skill, SkillMetadata, SkillResponse types
│   ├── tools.py                  # Central TOOL_CATALOG
│   ├── _template/SKILL.md        # Fork-me starter
│   ├── data_fetcher/SKILL.md
│   ├── pattern/SKILL.md
│   └── strategy/SKILL.md
├── core/
│   ├── agents/
│   │   ├── vibe_trade_agent.py   # Default agent (dispatch + planner)
│   │   ├── planner.py            # LLM-based plan builder
│   │   ├── processors.py         # Skill processor registry
│   │   ├── pattern_agent.py      # Pattern detection LLM prompts
│   │   ├── strategy_agent.py     # Strategy generation LLM prompts
│   │   ├── simulation_agents.py  # Multi-agent debate engine
│   │   └── llm_client.py         # 9-provider fan-out
│   └── data/
│       └── fetcher.py            # yfinance + ccxt + LLM parse_query
├── services/api/                 # FastAPI backend
│   ├── main.py                   # app entry
│   └── routers/chat.py           # /chat, /plan, /fetch-data, /skills, /tools
├── apps/web/                     # Next.js frontend
│   ├── src/
│   │   ├── app/                  # App Router pages
│   │   ├── components/
│   │   │   ├── LeftSidebar.tsx   # Chat history + mode toggle
│   │   │   ├── TopBar.tsx        # GitHub badge + conversation title
│   │   │   ├── RightSidebar.tsx  # Chat + code editor + trace
│   │   │   ├── TraceMessage.tsx  # Collapsible agent-process trace
│   │   │   ├── ChatInputBar.tsx  # Skill chip row + chatbox
│   │   │   ├── BottomPanel.tsx   # Dynamic tabs from skill metadata
│   │   │   └── Chart.tsx         # Main chart with primitives
│   │   ├── lib/
│   │   │   ├── toolRegistry.ts   # Frontend tool executors
│   │   │   ├── planExecutor.ts   # Closed-loop plan execution
│   │   │   ├── api.ts            # Backend client
│   │   │   ├── scriptExecutor.ts # Pattern script runner
│   │   │   └── strategyExecutor.ts
│   │   ├── store/useStore.ts     # Zustand store (convos, skills, state)
│   │   └── types/
│   └── package.json
├── setup.sh / setup.ps1          # First-time install scripts
├── README.md
└── .env.example                  # Provider keys template
```

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **CLI** | Typer, Rich |
| **Backend** | FastAPI, Uvicorn, Pydantic |
| **Data** | yfinance, ccxt, pandas, numpy |
| **AI / LLM** | 9-provider fan-out (OpenAI, Anthropic, DeepSeek, Groq, Gemini, OpenRouter, Together, Fireworks, Ollama) |
| **Skill storage** | YAML-frontmatter markdown (`SKILL.md`) |
| **Frontend** | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| **State** | Zustand 5 with localStorage conversation persistence |
| **Charting** | lightweight-charts v5 + custom `ISeriesPrimitive` renderers |
| **Pine Script** | PineTS (native) with LLM fallback |
| **Script sandbox** | Web Workers with 30s timeout |
| **Package** | `pipx install vibe-trade` |

## 🤝 Contributing

Contributions are very welcome. The skill system is designed specifically so you can add new capabilities without touching the frontend or the core agent dispatch.

**Quick contribution paths:**

1. **New skill** — drop a `SKILL.md` in `skills/<your-id>/`, add a processor to `core/agents/processors.py`, PR it.
2. **New tool** — add a `ToolDef` to `skills/tools.py::TOOL_CATALOG` and a matching executor in `apps/web/src/lib/toolRegistry.ts`.
3. **New LLM provider** — add a branch to `core/agents/llm_client.py::_get_openai_compat_client` or native client, document in README.
4. **New data source** — add a `_fetch_<provider>` function in `core/data/fetcher.py` and wire it through `detect_provider()`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for coding standards and PR guidelines.

## 🐛 Troubleshooting

<details>
<summary><b>"Failed to fetch" in the browser</b></summary>

The backend isn't running. Check the `vibe-trade serve` output for errors, or run `curl http://localhost:8787/skills` to verify the API is up.
</details>

<details>
<summary><b>"Agent chat returns 'API error: OpenAI API key not configured'"</b></summary>

Your `.env` is missing or not loaded. Confirm `.env` exists at the project root (where you run `vibe-trade` from) and contains a valid `OPENAI_API_KEY=sk-...` or any other supported provider key. Restart the server.
</details>

<details>
<summary><b>"Cannot read properties of undefined (reading 'time')" in Chart.tsx</b></summary>

This was a conversation-switch mismatch bug — fixed as of v0.1.0. If you see it on older checkouts, `git pull` and restart.
</details>

<details>
<summary><b>yfinance returns 7 days when I asked for "1m last month"</b></summary>

yfinance caps intraday (1m/5m) data at 7–60 days upstream — this is a Yahoo limitation, not a bug. For longer gold/stock histories, use `1h` or `1d` intervals. Crypto 1m data works for months+ via ccxt/Binance.
</details>

<details>
<summary><b>The planner doesn't trigger for a multi-step query</b></summary>

The planner only runs when **zero or 2+** skills are active. Single-skill selection goes through direct dispatch for speed. Deselect all chips or add a second one to enable planning.
</details>

## 📜 License

MIT — see [LICENSE](./LICENSE).

## ⭐ Support

If you find Vibe Trade useful, **give it a star on GitHub** — it genuinely helps the project reach more traders and contributors.

<div align="center">

**[⬆ Back to top](#-vibe-trade)**

Built with 🧠 by [Vibe Trade Core](https://github.com/spyderweb47/Vibe-Trade) · Powered by Claude, GPT-4, DeepSeek, Llama, and community skills.

</div>
