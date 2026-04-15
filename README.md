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

You only need three things installed on your machine before running the setup script:

| Requirement | Version | Install link |
|---|---|---|
| **Python** | 3.12 or newer | [python.org/downloads](https://www.python.org/downloads/) — on Windows, **check "Add Python to PATH"** during install |
| **Node.js** | 20 or newer | [nodejs.org](https://nodejs.org/) |
| **Git** | any | [git-scm.com](https://git-scm.com/) |

You also need an **OpenAI API key** — get one from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

### Quick install (recommended)

The setup script does everything: checks your Python/Node versions, creates a virtual environment, installs all dependencies, and creates your `.env` file.

**Step 1** — Clone the repo:

```bash
git clone https://github.com/spyderweb47/Vibe-Trade.git
cd Vibe-Trade
```

**Step 2** — Run the setup script for your OS:

<details>
<summary><b>Mac / Linux</b></summary>

```bash
bash setup.sh
```

</details>

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
.\setup.ps1
```

If you get `cannot be loaded because running scripts is disabled`, run this once first:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

</details>

<details>
<summary><b>Windows (Git Bash)</b></summary>

```bash
bash setup.sh
```

</details>

**Step 3** — Open `.env` in any text editor and set your OpenAI key:

```
OPENAI_API_KEY=sk-proj-your-real-key-here
```

**Step 4** — Start the backend (from project root):

```bash
# Mac/Linux/Git Bash:
source venv/bin/activate
# Windows PowerShell:
.\venv\Scripts\Activate.ps1

python -m uvicorn services.api.main:app --reload --port 8000
```

**Step 5** — In a **new terminal**, start the frontend:

```bash
cd apps/web
npm run dev
```

**Step 6** — Open [http://localhost:3000](http://localhost:3000).

### Manual install (if the script doesn't work)

<details>
<summary>Click to expand manual steps</summary>

```bash
# 1. Clone
git clone https://github.com/spyderweb47/Vibe-Trade.git
cd Vibe-Trade

# 2. Copy env file and add your key
cp .env.example .env   # Windows: copy .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...

# 3. Python backend (from project root — NOT inside services/api/)
python -m venv venv
source venv/bin/activate        # Mac/Linux/Git Bash
# .\venv\Scripts\Activate.ps1   # Windows PowerShell
pip install -r services/api/requirements.txt

# 4. Frontend (in a separate terminal)
cd apps/web
npm install
```

Then run the two servers exactly as in steps 4-6 of the quick install above.

</details>

### Quick Start

1. Click **+ Upload CSV** in the right sidebar and load an OHLC dataset (columns: `time`/`date`, `open`, `high`, `low`, `close`, `volume`).
2. **Building mode** — use the Pattern or Strategy agent to analyze the data with natural language.
3. **Playground mode** — press the mode toggle in the header, hit Play, and start paper trading with the demo wallet.
4. **Simulation mode** — run a multi-agent committee debate on your loaded dataset.

## LLM Provider Configuration

Vibe Trade supports **9 LLM providers** out of the box. OpenAI is the default, but you can swap to any other provider by changing one line in your `.env`.

### Supported providers

| Provider | Default model | API key env var | Best for |
|---|---|---|---|
| `openai` *(default)* | `gpt-4o-mini` | `OPENAI_API_KEY` | General purpose, reliable |
| `anthropic` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` | Highest quality reasoning |
| `openrouter` | `openai/gpt-4o-mini` | `OPENROUTER_API_KEY` | Access 100+ models via one key |
| `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` | Cheapest, strong reasoning |
| `groq` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Fastest inference (~5× faster) |
| `gemini` | `gemini-2.0-flash` | `GOOGLE_API_KEY` | Google's models, free tier |
| `together` | `llama-3.3-70b` | `TOGETHER_API_KEY` | Open-source models |
| `fireworks` | `llama-v3p3-70b` | `FIREWORKS_API_KEY` | Fast open-source inference |
| `ollama` | `llama3.2` | *(none)* | 100% local, private, free |

### How to switch providers

Edit your `.env` file and set two variables:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

Restart the backend and you're done. All agents (pattern detection, strategy generation, simulation, committee debate) will now use Claude.

### Override the model

Every provider has a sensible default, but you can override it:

```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o              # use full gpt-4o instead of gpt-4o-mini
```

```env
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-opus-4-6    # use Claude Opus through OpenRouter
```

### Local/private mode with Ollama

Run models entirely on your own machine, no API key, no data leaves your computer:

1. Install [Ollama](https://ollama.com/)
2. Pull a model: `ollama pull llama3.2`
3. Start Ollama: `ollama serve`
4. Set in `.env`:
   ```env
   LLM_PROVIDER=ollama
   LLM_MODEL=llama3.2
   OLLAMA_BASE_URL=http://localhost:11434/v1
   ```

See `.env.example` for the full list of providers with links to get API keys.

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
