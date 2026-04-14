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

- Node.js 20+
- Python 3.12+
- An OpenAI API key

### Setup

```bash
# Clone
git clone https://github.com/spyderweb47/Vibe-Trade.git
cd Vibe-Trade

# Frontend
cd apps/web
npm install

# Backend
cd ../../services/api
pip install -r requirements.txt

# Environment
cp .env.example .env
# Add your OPENAI_API_KEY to .env
```

### Run

```bash
# Terminal 1 — Frontend (port 3000)
cd apps/web
npm run dev

# Terminal 2 — Backend (port 8000)
cd services/api
python main.py
```

Open [http://localhost:3000](http://localhost:3000).

### Quick Start

1. Click **+ Upload CSV** in the right sidebar and load an OHLC dataset (columns: time/date, open, high, low, close, volume).
2. **Building mode** — Use the Pattern or Strategy agent to analyze data.
3. **Playground mode** — Click the toggle in the header, press Play, and start trading with the demo wallet.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for pattern/strategy agents |

## License

MIT
