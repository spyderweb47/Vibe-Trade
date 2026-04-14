# Vibe Trade

AI-powered trading pattern detection, strategy building, and replay-based practice platform. Upload historical OHLC data, detect patterns with AI agents, generate and backtest strategies, then practice discretionary trading in a simulated real-time environment.

## Demo



https://github.com/user-attachments/assets/4683d6cf-3e97-4e0c-866b-9760eebcb1b7


## Features

### Building Mode
- **Pattern Agent** — Describe a chart pattern in natural language; an AI agent generates a JavaScript detection script that scans your dataset and highlights every match on the chart.
- **Strategy Agent** — Fill in a structured form (entry condition, TP/SL, max drawdown, seed capital) and the AI generates a backtest script. Run it locally in a Web Worker, then review portfolio metrics, an equity curve, per-trade analysis, and AI-generated improvement suggestions.
- **Pine Script Support** — Paste TradingView Pine Script indicators; they run natively via PineTS with an LLM fallback for unsupported syntax.
- **Drawing Tools** — Trendlines, horizontals, verticals, rectangles, Fibonacci retracements, long/short position boxes, and a pattern selector tool.
- **Chart** — lightweight-charts v5 with candlesticks, volume histogram, multiple indicator overlays, dark/light theme, and timeframe resampling (1m to 1W).

### Playground Mode
- **Bar-by-bar Replay** — Play historical data forward one candle at a time with configurable speed (0.5x to Max). Pause, step, seek, and restart.
- **Hyperliquid-style Trading Panel** — Long/Short toggle, Market/Limit orders, 1x-20x leverage slider, TP/SL, reduce-only, quick-fill size buttons.
- **Demo Wallet** — $10,000 paper balance with live equity, margin tracking, and fee simulation (0.045% taker).
- **Matching Engine** — TP/SL auto-fills, limit order fills on bar high/low, and leveraged liquidation at the correct price.
- **Positions / Orders / Trade History / Wallet** — Full bottom-panel tabs matching a real exchange UI.
- **Draw into the Future** — Trend lines and drawings extend past the replay cursor into unrevealed bars, just like on a live chart.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Charting | lightweight-charts v5, custom ISeriesPrimitive renderers |
| State | Zustand 5 |
| Pine Script | PineTS (native) + LLM fallback |
| Script Execution | Web Workers with 30s timeout sandbox |
| Backend | Python, FastAPI, Uvicorn |
| AI | OpenAI GPT via Python agents (pattern, strategy, analysis) |
| CSV Parsing | PapaParse (streaming) |

## Project Structure

```
trading-platform/
├── apps/web/                 # Next.js frontend
│   ├── src/
│   │   ├── app/              # Next.js App Router (page, layout, globals)
│   │   ├── components/       # React components
│   │   │   ├── playground/   # Playground mode (TradingPanel, Controls, tabs)
│   │   │   ├── Chart.tsx     # Main chart with primitives
│   │   │   ├── TopBar.tsx    # Header with Building/Playground toggle
│   │   │   ├── RightSidebar.tsx  # Agent chat, datasets, resources, trading panel
│   │   │   └── BottomPanel.tsx   # Contextual tabs per mode
│   │   ├── hooks/            # usePlaygroundReplay
│   │   ├── lib/
│   │   │   ├── chart-primitives/ # Custom chart renderers (patterns, trades, drawings, Pine)
│   │   │   ├── playground/       # Replay engine, liquidation math
│   │   │   ├── pine/             # PineTS runner + LLM fallback
│   │   │   ├── csv/              # OHLC resampling
│   │   │   ├── strategyExecutor.ts
│   │   │   └── scriptExecutor.ts
│   │   ├── store/            # Zustand store (all app state)
│   │   └── types/            # TypeScript interfaces
│   └── package.json
├── core/                     # Python AI agents
│   ├── agents/               # pattern_agent.py, strategy_agent.py
│   ├── analysis/
│   ├── backtesting/
│   ├── engine/
│   ├── indicators/
│   └── utils/
├── services/api/             # FastAPI backend
│   ├── main.py               # Uvicorn entry (port 8000)
│   ├── routers/chat.py       # Chat endpoint for pattern/strategy agents
│   └── requirements.txt
├── .env                      # OPENAI_API_KEY (not committed)
└── .gitignore
```

## Getting Started

### Prerequisites

Install these before you start:

| Requirement | Version | Check command | Install link |
|---|---|---|---|
| **Node.js** | 20 or newer | `node --version` | [nodejs.org](https://nodejs.org/) |
| **Python** | 3.12 or newer | `python --version` | [python.org](https://www.python.org/downloads/) |
| **Git** | any | `git --version` | [git-scm.com](https://git-scm.com/) |
| **OpenAI API key** | — | — | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

> **Windows users**: Use PowerShell or Git Bash. If `python` doesn't work, try `py` instead.
> **Mac/Linux users**: You may need `python3` instead of `python`.

### Step 1 — Clone the repo

```bash
git clone https://github.com/spyderweb47/Vibe-Trade.git
cd Vibe-Trade
```

### Step 2 — Set up environment variables

Copy the example file and add your OpenAI API key:

```bash
# Mac/Linux
cp .env.example .env

# Windows (PowerShell)
copy .env.example .env
```

Then open `.env` in any text editor and replace `sk-...` with your actual OpenAI key:

```
OPENAI_API_KEY=sk-proj-your-real-key-here
```

### Step 3 — Install the backend (Python)

Run these from the **project root** (`Vibe-Trade/`), not from inside `services/api/`:

```bash
# Create a virtual environment (recommended)
python -m venv venv

# Activate it
# Mac/Linux:
source venv/bin/activate
# Windows (PowerShell):
.\venv\Scripts\Activate.ps1
# Windows (Git Bash):
source venv/Scripts/activate

# Install dependencies
pip install -r services/api/requirements.txt
```

### Step 4 — Install the frontend (Node.js)

In a **separate terminal** (keep the Python venv terminal for step 5):

```bash
cd apps/web
npm install
```

### Step 5 — Run both servers

You need **two terminals running at the same time**.

**Terminal 1 — Backend** (from project root, with venv activated):

```bash
python -m uvicorn services.api.main:app --reload --host 0.0.0.0 --port 8000
```

You should see: `Uvicorn running on http://0.0.0.0:8000`

**Terminal 2 — Frontend** (from `apps/web/`):

```bash
npm run dev
```

You should see: `Local: http://localhost:3000`

### Step 6 — Open the app

Go to [http://localhost:3000](http://localhost:3000) in your browser. The app should load with the Topstep-themed dark UI.

### Quick Start

1. Click **+ Upload CSV** in the right sidebar and load an OHLC dataset (columns: `time`/`date`, `open`, `high`, `low`, `close`, `volume`).
2. **Building mode** — use the Pattern or Strategy agent to analyze the data with natural language.
3. **Playground mode** — press the mode toggle in the header, hit Play, and start paper trading with the demo wallet.
4. **Simulation mode** — run a multi-agent committee debate on your loaded dataset.

## Troubleshooting

**"Failed to fetch" error in the browser**
The backend isn't running or isn't reachable. Check Terminal 1 — you should see `Uvicorn running on http://0.0.0.0:8000`. If it crashed, scroll up for the error.

**Backend crashes with `ModuleNotFoundError: No module named 'services'`**
You're running from the wrong directory. Run the uvicorn command from the **project root** (`Vibe-Trade/`), not from inside `services/api/`.

**Backend crashes with `ModuleNotFoundError: No module named 'dotenv'`**
You're missing a dependency. Re-run `pip install -r services/api/requirements.txt` with your venv activated.

**Frontend install fails with ENOENT or network errors**
Delete `apps/web/node_modules` and `apps/web/package-lock.json`, then run `npm install` again. If you're behind a corporate proxy, set `npm config set registry https://registry.npmjs.org/`.

**Agent chat returns "API error: OpenAI API key not configured"**
Your `.env` file is missing or the key wasn't loaded. Confirm `.env` exists at the project root (not inside `services/api/`) and contains `OPENAI_API_KEY=sk-...`. Restart the backend.

**Dataset 'xyz' not found**
The backend was restarted and its in-memory store is empty. The app auto-resyncs on most actions, but if you see this error, refresh the browser tab and try again.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for pattern/strategy agents |

## License

MIT
