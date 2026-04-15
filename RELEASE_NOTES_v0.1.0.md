# Vibe Trade v0.1.0 — first public release

AI-powered trading agent platform. One `pipx install vibe-trade` gets you the
full stack: FastAPI backend, bundled Next.js web UI, skill-based agent system,
9 LLM providers, multi-step planner, pattern detection, strategy backtesting,
and multi-agent debate simulations.

## Highlights

- **One-command install.** `pipx install vibe-trade` then `vibe-trade serve`
  and the web UI is live at <http://localhost:8787>. Frontend bundle ships
  inside the wheel — no Node.js required at runtime.
- **Skill system.** Drop a `SKILL.md` into `skills/` and the backend
  auto-discovers it on startup; the frontend chip row + bottom-panel tabs
  populate from `/skills`. Three skills ship in v0.1.0: Pattern Detection,
  Strategy, Data Fetcher.
- **Built-in planner.** Multi-step requests like "fetch BTC 1h, find triple
  tops, then build a strategy from them" decompose into ordered steps that
  execute in sequence with real results flowing forward.
- **9 LLM providers.** OpenAI, Anthropic, Google, Mistral, Groq, Together,
  Fireworks, OpenRouter, and any OpenAI-compatible base URL. Configured via
  `.env`.
- **Data fetcher.** yfinance (stocks, indices, FX) and ccxt (crypto via
  Binance, Coinbase, etc.) behind one natural-language interface — "fetch BTC
  4h last 6 months" or "give me AAPL daily for 2024" both work.
- **Multi-agent debate simulations.** 5 personas argue an asset for N rounds,
  streamed live in the terminal or rendered in the web UI.

## Quick start

```bash
pipx install vibe-trade
vibe-trade serve              # opens http://localhost:8787
vibe-trade fetch BTC/USDT 1h  # fetch market data
vibe-trade simulate -a BTC    # run a multi-agent debate
vibe-trade skills list        # list registered skills
```

## What's in the box

- **CLI**: `vibe-trade serve`, `fetch`, `simulate`, `skills`, `tools`,
  `build-frontend`, `version`
- **Backend**: FastAPI on port 8787 with `/skills`, `/chat`, `/plan`,
  `/fetch-data`, `/api/status`, `/health`
- **Frontend**: Next.js static export, served from `/` by the same process
- **Core engine**: indicators (SMA, EMA, RSI, MACD, ATR, Bollinger, ...),
  backtesting, pattern executor, simulation engine, DAG orchestrator

## Requirements

- Python ≥ 3.10
- An LLM API key in `.env` (any of the 9 supported providers)

## Known limitations

- Hot-reload of skills requires a backend restart (v1)
- Single-skill dispatch per chat message — multi-select is a bottom-panel
  hint, not concurrent fan-out
- Tool permissions are enforced but not yet visualised in the UI

## Links

- Source: <https://github.com/spyderweb47/Vibe-Trade>
- Issues: <https://github.com/spyderweb47/Vibe-Trade/issues>
- README: <https://github.com/spyderweb47/Vibe-Trade#readme>
