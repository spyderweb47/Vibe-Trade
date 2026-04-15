---
id: data_fetcher
name: Data Fetcher
tagline: Data
description: Fetch historical OHLC chart data from yfinance (stocks) or ccxt (crypto) and load it onto the chart.
version: 1.0.0
author: Vibe Trade Core
category: data
icon: download
color: "#3b82f6"

# Tools this skill is allowed to invoke
tools:
  - data.fetch_market
  - data.dataset.add
  - chart.set_timeframe
  - notify.toast
  - bottom_panel.activate_tab

# This skill doesn't contribute its own bottom panel tabs — it loads data
# that other skills (Pattern, Strategy) can then analyze.
output_tabs: []

store_slots:
  - datasets
  - activeDataset
  - chartData

input_hints:
  placeholder: "e.g. 'Fetch BTC/USDT hourly' or 'Get AAPL daily 2 years'..."
  supports_fingerprint: false
---

# Data Fetcher Skill

## Purpose

Pull historical (and near-realtime) OHLC market data from external sources
and load it directly onto the Vibe Trade chart canvas. Once loaded, every
other skill — Pattern detection, Strategy generation, backtesting — can
operate on the new dataset without the user having to upload a CSV.

This skill is the bridge between "I want to analyze X" and the rest of the
platform's tooling.

## When to use this skill

Vibe Trade should dispatch to the Data Fetcher when the user wants to:

- **Load a stock/ETF/index** ("Fetch AAPL daily", "Get SPY weekly data",
  "Load TSLA hourly for the last month")
- **Load a crypto pair** ("Fetch BTC/USDT 1h", "Get ETH 4h for last 1000 bars",
  "Pull DOGE 5m last 24 hours")
- **Refresh recent data** ("Get the last 100 bars of BTC", "Latest hourly
  data for Apple")
- **Compare assets** ("Load BTC and ETH" — fetch both as separate datasets)

## Data sources

| Source | Asset class | Examples | API key? |
|---|---|---|---|
| `yfinance` | US/HK stocks, ETFs, indices, forex | `AAPL`, `SPY`, `^GSPC`, `EURUSD=X` | No |
| `ccxt` (default: binance) | Crypto spot pairs | `BTC/USDT`, `ETH-USD`, `SOL` | No |

The skill auto-detects the right provider from the symbol shape:
- Pair separators (`/` or `-` with crypto quote) → `ccxt`
- `^INDEX` or `=X` → `yfinance`
- Bare crypto bases (`BTC`, `ETH`, ...) → `ccxt` with `USDT` quote
- Everything else → `yfinance`

## Inputs

| Key | Type | Meaning |
|---|---|---|
| `message` | string | Natural-language fetch request |
| `context.dataset_id` | string | Existing dataset (ignored — this skill creates new ones) |

## Outputs

Returns a `SkillResponse` with:

- `reply` — short confirmation ("Loaded 1000 bars of BTC/USDT 1h from binance.")
- `data.dataset` — the full fetched payload (symbol, source, interval, bars, metadata)
- `tool_calls`:
  1. `data.dataset.add` with the fetched payload — registers the dataset in the
     store and switches the chart to it
  2. `notify.toast` with a success message
  3. `bottom_panel.activate_tab` if a downstream skill has matching tabs

## Tools used

| Tool | When | Payload |
|---|---|---|
| `data.fetch_market` | Always — the actual fetch call | `{symbol, source, interval, limit, exchange}` |
| `data.dataset.add` | Always after a successful fetch | The fetched payload |
| `chart.set_timeframe` | After loading | The fetched native timeframe |
| `notify.toast` | Confirmation or error | `{level, message}` |

## Examples

**Crypto pair**
> "Fetch BTC/USDT hourly data, last 500 bars."

→ Calls `data.fetch_market(symbol="BTC/USDT", interval="1h", limit=500)`,
auto-routes to `ccxt:binance`, returns 500 hourly bars, emits
`data.dataset.add` to load them onto the chart.

**Stock**
> "Get AAPL daily for the last 2 years."

→ Calls `data.fetch_market(symbol="AAPL", interval="1d", limit=504)` (504 ≈
2 trading years), auto-routes to `yfinance`, loads onto the chart.

**Bare crypto base**
> "Pull ETH 4h."

→ Auto-completes to `ETH/USDT`, fetches via `ccxt:binance` at 4h timeframe,
default 1000 bars.

## Underlying implementation

Wired through `core/agents/processors.py::_data_fetcher_processor`, which:
1. Parses the user message via `core.data.fetcher.parse_query()` to extract
   `symbol`, `interval`, and `limit`
2. Calls `core.data.fetcher.fetch()` to pull bars from the right provider
3. Wraps the result in a `SkillResponse` with the right `tool_calls`

The fetcher in turn uses:
- **yfinance** for stocks/ETFs/indices/forex
- **ccxt** for crypto, defaulting to the Binance public API

Both libraries are pip-installable, key-less, and ship with the backend.
