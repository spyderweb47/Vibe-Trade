---
id: strategy
name: Strategy Skill
tagline: Strategy
description: Generates and analyzes trading strategies from a structured config. Produces runnable JS + portfolio analysis.
version: 1.0.0
author: Vibe Trade Core
category: generation
icon: briefcase
color: "#26a69a"

# Tools this skill is allowed to invoke (must exist in skills/tools.py).
tools:
  - chatbox.card.strategy_builder
  - script_editor.load
  - script_editor.run
  - bottom_panel.activate_tab
  - bottom_panel.set_data
  - chart.draw_markers
  - notify.toast

output_tabs:
  - id: portfolio
    label: Portfolio
    component: PortfolioAnalysis
  - id: trades
    label: Trade List
    component: TradeList
  - id: pine_script
    label: Pine Script
    component: PineScriptPanel

store_slots:
  - backtestResults
  - currentScript

input_hints:
  placeholder: "Describe a trading strategy..."
  supports_fingerprint: false
---

# Strategy Skill

## Purpose

Take a structured strategy configuration — entry/exit conditions, TP/SL,
drawdown limits, seed capital — and produce a **runnable JavaScript strategy
script** that returns `{trades, equity}`. After the script is backtested,
the same skill can analyze the results and suggest concrete improvements.

This skill is the counterpart to the Pattern Skill: instead of *finding*
historical patterns, it *trades* them (or any other hypothesis).

## When to use this skill

Vibe Trade should dispatch to the Strategy Skill when the user:

- Wants to **build a new strategy** from scratch — activate
  `chatbox.card.strategy_builder` to show the structured form in the chat
- Has submitted the **Strategy Builder form** — generate the JS from
  `context.strategy_config`
- Asks to **analyze backtest results** — use `context.analyze_results` plus
  the strategy config to produce an assessment + suggestions
- Wants to **iterate** on an existing strategy (tweak TP/SL, change the
  entry rule) — regenerate from the updated config

## Instructions

1. **If no `strategy_config` is in context**, show the structured form:
   - Emit `chatbox.card.strategy_builder` to inject the form into the chat
   - Respond with a brief prompt like "Fill in the fields and I'll generate
     a runnable strategy for you."

2. **If `strategy_config` is present and `mode = "generate"`** (default):
   - Generate a JS strategy script that:
     - Defines every indicator helper it uses (don't assume `sma()` exists)
     - Handles edge cases (bounds check, initial lookback period)
     - Tracks `maxAdverseExcursion` / `maxFavorableExcursion` per trade
     - Pushes to the `equity` array on every bar (not just on trade events)
     - Respects the max drawdown limit
   - Emit `script_editor.load` with the full script
   - Emit `bottom_panel.activate_tab` → `portfolio`

3. **If `mode = "analyze"`** (backtest results in `context.analyze_results`):
   - Produce a 2–3 sentence overall assessment (profitability + risk)
   - Call out specific strengths and weaknesses in the metrics
   - Return 3–5 concrete improvement suggestions as `data.suggestions`
   - Do NOT regenerate the script — only analysis in this mode

4. **Never** touch the script generation without a config. Free-form
   strategy chat (without a structured config) should be handled as a
   general chat fallback, not by this skill.

## Inputs

| Key | Type | Meaning |
|---|---|---|
| `context.mode` | `"generate"` \| `"analyze"` | Which operation to run (default: generate) |
| `context.strategy_config` | object | Full strategy config from the form |
| `context.analyze_results` | object | Backtest metrics (analyze mode only) |

`strategy_config` shape:

```js
{
  entryCondition: string,
  exitCondition: string,
  takeProfit: { type: "percentage" | "absolute", value: number },
  stopLoss: { type: "percentage" | "absolute", value: number },
  maxDrawdown: number,    // percent
  seedAmount: number,     // USD
  specialInstructions: string
}
```

## Outputs

**Generate mode:**
- `reply` — short confirmation ("Strategy script generated.")
- `script` — JavaScript strategy returning `{trades, equity}`
- `script_type` — `"strategy"`
- `data.config` — echoes the config (for persistence)
- `tool_calls` — load + activate portfolio tab

**Analyze mode:**
- `reply` — 2–3 sentence assessment
- `data.suggestions` — 3–5 improvement suggestions
- `tool_calls` — none (analyze is read-only)

## Tools used

| Tool | When | Payload |
|---|---|---|
| `chatbox.card.strategy_builder` | User wants to build a strategy but no config yet | — |
| `script_editor.load` | Strategy generated | The JS source |
| `script_editor.run` | User asks to backtest immediately | — |
| `bottom_panel.activate_tab` | After generating | `"portfolio"` |
| `bottom_panel.set_data` | Push analysis data into a tab | `{target, data}` |
| `chart.draw_markers` | Visualize entry/exit points on the chart | `Marker[]` |
| `notify.toast` | Status updates ("Backtest complete: 42 trades") | `{level, message}` |

## Examples

**Generate**
Config: Entry = `SMA(20) > SMA(50)`, Exit = `SMA(20) < SMA(50)`, TP = 5%,
SL = 2%, Max DD = 20%, Seed = $10,000.

→ Returns a strategy script with inline `sma()` helper, golden-cross entry
logic, per-trade PnL + MAE/MFE tracking, equity-curve pushes on every bar.
Loads into the editor; bottom panel switches to Portfolio.

**Analyze**
Metrics: 42 trades, 38% win rate, 1.1 profit factor, -18% max drawdown.

→ "Marginal profitability, asymmetric losses are hurting overall returns."
Suggestions: tighten stop to 1.5%, add an ATR volatility filter, require
`ADX > 25` for trend regime, etc.

## Underlying implementation

Wired through `core/agents/processors.py::_strategy_processor`, which calls
`core/agents/strategy_agent.py::StrategyAgent.generate_from_config` or
`.analyze_results` depending on `context.mode`. The agent owns
`STRATEGY_GENERATE_PROMPT` and `STRATEGY_ANALYSIS_PROMPT`.
