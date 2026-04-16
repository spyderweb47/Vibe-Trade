---
id: swarm_intelligence
name: Swarm Intelligence
tagline: Swarm
description: >
  Multi-agent debate simulation — 30+ AI personas with distinct backgrounds,
  biases, and trading styles argue an asset across 20 rounds with 10 speakers
  each, referencing each other by name, requesting chart data mid-debate, and
  converging on a consensus direction with price targets and a trade recommendation.
version: 1.0.0
author: Vibe Trade Core
category: simulation
icon: users
color: "#8b5cf6"
tools:
  - simulation.run_debate
  - simulation.set_debate
  - simulation.reset
  - bottom_panel.activate_tab
  - bottom_panel.set_data
  - data.fetch_market
  - notify.toast
output_tabs:
  - id: dag_graph
    label: DAG Graph
    component: DAGGraphTab
  - id: personalities
    label: Personalities
    component: PersonalitiesTab
  - id: debate_thread
    label: Debate Thread
    component: DebateThreadTab
  - id: run_stats
    label: Run Stats
    component: RunStatsTab
store_slots:
  - currentDebate
  - debateHistory
input_hints:
  placeholder: "Run a swarm debate on an asset..."
  supports_fingerprint: false
---

# Swarm Intelligence Skill

Runs a multi-agent debate (a.k.a. "swarm") on the currently loaded dataset.

## Pipeline

The 6-stage debate pipeline runs on the backend via `DebateOrchestrator`:

1. **Asset Classification** — determines the asset class (crypto, equity, FX, commodity) from the dataset name and price range.
2. **Chart Support** — resamples OHLC data to daily/weekly timeframes and computes technical summaries (SMA, RSI, range).
3. **Entity Generation** — creates 30-35 unique personas spanning hedge fund PMs, quant researchers, retail traders, domain experts, contrarians, media voices, insiders, academics, and more.
4. **Forum Discussion** — up to 20 rounds with 10 speakers each. Each persona speaks 5+ times across the debate. Entities respond to each other by name, express sentiment on a -1.0 to +1.0 scale, and optionally give price predictions. Mid-debate data requests inject fresh data.
5. **Convergence Check** — if the last 4 rounds have a sentiment spread < 0.10, the debate ends early (consensus reached). Requires at least 10 rounds before checking.
6. **Summary** — a final summary agent synthesizes the thread into a consensus direction, confidence %, price targets, key arguments, dissenting views, and a trade recommendation.

## Tool calls

After the debate finishes, the skill emits:

1. `simulation.set_debate` — pushes the full `SimulationDebate` object into the store so all 4 bottom-panel tabs can read it.
2. `bottom_panel.activate_tab("dag_graph")` — switches to the DAG Graph tab so the user sees the entity network immediately.

## Output tabs

| Tab | Component | Shows |
|-----|-----------|-------|
| DAG Graph | `DAGGraphTab` | ReactFlow network: entities as circular nodes, center status node, summary node, agree/disagree edges |
| Personalities | `PersonalitiesTab` | Card grid of all entities with name, role, bias, personality, last sentiment |
| Debate Thread | `DebateThreadTab` | Scrollable conversation with round badges, sentiment colors, price predictions, agree/disagree links |
| Run Stats | `RunStatsTab` | Consensus badge, confidence %, price targets (low/mid/high), key arguments, dissenting views, risk factors, recommendation |

## Input

- Natural language: "run a swarm debate on BTC", "what does the committee think about AAPL?"
- Requires a dataset loaded on the chart (the debate needs OHLC bars to analyse).
- Optional context: "Fed just cut rates by 50bps" — injected into every entity's system prompt.
