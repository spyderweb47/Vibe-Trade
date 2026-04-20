# Swarm Intelligence — pipeline deep-dive

> **Baseline**: commit `653a51d`. Supersedes `docs/back/SWARM_PIPELINE.md`
> which described the pre-timeout pre-multi-chart version.

## 1. What it is

A **multi-agent trading committee**: 50 LLM-generated personas
(technical analysts, macro traders, quants, regulators, sentiment
watchers) debate an asset across 30 rounds, with per-agent memory,
selective message routing, and a ReACT-style final report. Output is a
consensus direction + trade recommendation, plus a transparent
breakdown of every message, every persona, every cross-exam, and every
tool call the agents made along the way.

Inspired by MiroFish — the finding that a diverse adversarial panel
tends to reach better trading decisions than a single model acting
alone, because dissent is not censored mid-debate.

## 2. File map

```
core/engine/dag_orchestrator.py      # The 5-stage orchestrator (entry point)
core/agents/simulation_agents.py     # All the agent classes
core/agents/swarm_tools.py           # Web search, indicator, level tools
core/agents/llm_client.py            # Provider-agnostic chat_completion
core/agents/processors.py
  └ _swarm_intelligence_processor    # Skill entry: loads datasets, calls run()

services/api/routers/simulation.py   # /debate + /interview endpoints
                                     # + Pydantic response models

apps/web/src/lib/toolRegistry.ts
  └ "simulation.set_debate" mapper   # Backend snake_case → frontend camelCase
apps/web/src/store/useStore.ts
  └ setCurrentDebate + runDebate     # Store integration
apps/web/src/types/index.ts
  └ SimulationDebate / DiscussionMessage / etc.

apps/web/src/components/tabs/
  ├ DAGGraphTab.tsx                  # React Flow pipeline visualisation
  ├ PersonalitiesTab.tsx             # Grid of 50 persona cards
  ├ AgentDetailPanel.tsx             # Expanded persona + live /interview chat
  ├ DebateThreadTab.tsx              # Flat list of all messages
  └ RunStatsTab.tsx                  # Consensus, briefing, PDF export, events

vibe_trade/simulate_cmd.py           # vibe-trade simulate CLI wrapper
```

## 3. Configuration constants

All in `DebateOrchestrator` (`core/engine/dag_orchestrator.py`):

```python
MAX_ROUNDS = 30
SPEAKERS_PER_ROUND = 15     # → up to 30 × 15 = 450 messages
```

Persona generation target (`core/agents/simulation_agents.py::EntityGenerator`):
```python
TARGET_ENTITIES = 50
```

Research iteration bounds (`core/agents/simulation_agents.py::IterativeResearcher`):
```python
MIN_ITERATIONS = 3
MAX_ITERATIONS = 8
```

Timeouts (documented in `ARCHITECTURE.md` § 9).

## 4. The 5 stages in detail

### Stage 1 — Context Analysis
Two parallel LLM calls:

- **`AssetClassifier.classify(symbol, price_range, bar_count)`** returns
  `{asset_class, asset_name, description, price_drivers}`. The
  price_range hint lets the LLM guess if a bare `BTC` is crypto
  (5-figure prices) vs a stock.
- **`ContextAnalyzer.analyze(bars, symbol, report_text)`** reads the
  OHLC bars and extracts:
  - `market_regime` (trending/ranging/volatile/accumulation)
  - `key_price_levels.strong_support / strong_resistance / recent_pivot`
  - `technical_signals` (list of 3-5 observations)
  - `volume_analysis`
  - `key_themes`, `risk_events`

In parallel (same asyncio.gather):

- **`DataFeedBuilder.build_feeds(bars, symbol)`** — precomputes 6
  specialization-specific data feeds: `general`, `technical`, `volume`,
  `quant`, `macro`, `structure`. Each is a multi-line text blob sized
  for that specialist's prompt.

### Stage 1.5 — Intelligence Gathering
**`IntelligenceGatherer.gather(asset_name, asset_class, bars)`** runs
up to 4 DuckDuckGo searches:
- Recent news
- Market analysis / commentary
- Regulatory / policy updates
- Technical indicator + key level summary

Results feed an LLM that synthesises the **intel briefing**:

```python
{
  "executive_summary": "...",
  "bull_case": ["...", "...", ...],       # 5 items
  "bear_case": ["...", ...],
  "key_events": ["...", ...],             # upcoming catalysts
  "sentiment_reading": "cautiously bullish",
  "data_points": ["...", ...],            # concrete numbers to cite
  "raw_findings": {
    "recent_news": "...",
    "market_analysis": "...",
    "regulatory": "...",
    "technical_indicators": "...",
    "key_levels": "..."
  }
}
```

This briefing is later injected into every agent's Stage 3 prompt.

### Stage 2 — Persona Generation
**`EntityGenerator.generate(asset_info, main_summary, report_text)`**
asks an LLM for **50 personas**. Done in 5 parallel batches of 10 for
speed.

Each persona:

```python
{
  "id": "marcus_wei",
  "name": "Marcus Wei",
  "role": "Macro Trader",
  "background": "Ex-Goldman macro desk, 15 years across FX/rates...",
  "bias": "hawkish",
  "personality": "Blunt, numbers-first, little patience for narrative",
  "stance": "bear",            # bull / bear / neutral / observer
  "influence": 2.4,            # 0.5 - 3.0, used in consensus weighting
  "specialization": "macro",   # technical/macro/fundamental/sentiment/
                               # quant/geopolitical/industry
  "tools": ["web_search", "fetch_news", "fetch_policy"]
                               # from ROLE_TOOL_MAP in swarm_tools.py
}
```

The stance distribution is skewed by the asset's momentum (uptrending
asset → more bears to force dissent; downtrending → more bulls).

### Stage 2.5 — Iterative Research
**`IterativeResearcher.research(entity, asset_info, main_summary)`**

For each of the 50 personas (actually, only those with `web_*` / `fetch_*`
tools), run an **iterative research loop** that plans its own queries:

```
iteration 1:
  LLM: "Given you're a macro trader looking at CL=F, what do you
        want to know? Pick ONE query."
  → query: "crude oil OPEC production cuts October 2025"
  → execute via search_web tool
  → summarise result

iteration 2:
  LLM: "Given your findings so far, what's the NEXT thing to check?
        Or say 'enough' if you have what you need."
  → query: "Iran Israel oil tanker strait of hormuz"
  → execute + summarise

... (up to 8 iterations, min 3)
```

MIN_ITERATIONS = 3 prevents early "enough" responses for shallow
coverage. MAX_ITERATIONS = 8 caps total research cost.

Parallelised in batches of 10 agents (rate-limiter-friendly for the
global DuckDuckGo serialiser).

Output per agent, cached for the debate:
```python
{
  "total_iterations": N,
  "summary": "...multi-query synthesis for this persona...",
  "findings": [
    {"iteration": 1, "query": ..., "reasoning": ..., "tool": ..., "result": ...},
    ...
  ]
}
```

### Stage 3 — Multi-Round Debate
Up to **30 rounds × 15 speakers = 450 messages**. Per round:

1. **Rotate speakers** through the 50-persona pool:
   ```python
   start_idx = ((round_num - 1) * SPEAKERS_PER_ROUND) % n_entities
   speaker_indices = [(start_idx + j) % n_entities
                      for j in range(SPEAKERS_PER_ROUND)]
   ```
   Ensures every persona gets multiple turns across the debate.

2. **Per-agent context** built for each of the 15 speakers:
   - **Personal memory** — list of their own last 5 messages
   - **Filtered thread** — last 4 rounds of messages, scored by
     relevance (mentions of this agent = +10, role keyword overlap,
     recency bonus, influence bonus). Capped at 6k chars.
   - **Specialization data feed** — from `DataFeedBuilder` map:
     - technical → "technical" feed
     - macro → "macro" feed
     - quant → "quant" feed
     - fundamental/industry → "structure"
     - sentiment → "volume"
     - geopolitical → "macro"
   - **Intel briefing** (Stage 1.5 output) capped at 2000 chars
   - **Research summary** (Stage 2.5 output) — round 1 only
   - **Tool call log** — populated as the agent uses tools during
     the debate (round 1 only for local tools like `run_indicator`)

3. **Parallel speak**:
   ```python
   agents = [DiscussionAgent(entity, asset_info) for entity, ... in agents_with_context]
   results = await asyncio.gather(
       *[_run_speaker(a, ctx) for a, ctx in zip(agents, agents_with_context)]
   )
   ```
   Each `_run_speaker` wraps `asyncio.to_thread(agent.speak, ...)` in
   `asyncio.wait_for(..., 180s)`. On timeout, the speaker is logged as
   a no-show for that round; the other 14 continue.

4. **Message shape** returned by `DiscussionAgent.speak`:
   ```python
   {
     "content": "...",
     "sentiment": 0.65,           # -1 (extreme bear) to +1 (extreme bull)
     "price_prediction": 82500.0, # optional $
     "agreed_with": ["jane_doe"], # other persona ids
     "disagreed_with": [],
     "tools_used": ["search_web", "compute_levels"],
     "tool_results": {"search_web": "...", "compute_levels": "..."},
     "data_request": None         # agent can request extra data
   }
   ```

5. **Append to thread** + update `agent_memory[eid]` (keep last 5).

6. **Convergence check** — from round 20 onward:
   ```python
   if spread_of_last_5_round_avg_sentiments < 0.05:
       break  # converged early
   ```

### Stage 4 — Cross-Examination
**`CrossExaminer.examine(thread, entities, asset_info, market_summary)`**

Picks the 6-8 most **divergent** agents (those whose final sentiment
is furthest from the emerging consensus, weighted by influence). For
each, asks one pointed LLM question challenging their thesis.

Per-agent result:
```python
{
  "entity_id": ...,
  "entity_name": ...,
  "entity_role": ...,
  "question": "You said BTC breaks 100k this quarter...",
  "response": "I stand by it because...",
  "conviction_change": "strengthened",   # unchanged|strengthened|weakened|reversed
  "new_sentiment": 0.78
}
```

Wrapped in `asyncio.wait_for(..., 300s)`. On timeout / error, logs an
event and continues without the cross-exam results (empty list).

### Stage 5 — ReACT Report Generation
**`ReACTReportAgent.generate_report(...)`** makes a single big LLM
call with `max_tokens=4500` and `timeout_s=240`. Prompt includes:
- Asset metadata
- Early + late thread excerpts (first third + last 6000 chars)
- Market context (regime + levels)
- Technical / volume / quant data feeds (capped)

Output:
```python
{
  "consensus_direction": "BULLISH",     # ← overwritten by _compute_consensus
  "confidence": 65,                     # ← overwritten by _compute_consensus
  "key_arguments": ["...", ...],
  "dissenting_views": ["...", ...],
  "price_targets": {"low": ..., "mid": ..., "high": ...},
  "risk_factors": ["...", ...],
  "recommendation": {
    "action": "BUY",
    "entry": 82000,
    "stop": 78000,
    "target": 92000,
    "position_size_pct": 2.5
  },
  "conviction_shifts": ["Marcus Wei flipped bear→neutral after round 12", ...]
}
```

**Ground-truth override** — LLMs tend to copy the prompt's example
values ("always BULLISH 72%"). After Stage 5,
`_compute_consensus(thread, entities)` runs **influence-weighted math**
on the actual thread sentiments and overwrites `consensus_direction` +
`confidence` with real values. See `dag_orchestrator.py::_compute_consensus`.

**Fallback** — if Stage 5 LLM fails or times out,
`_fallback_summary_from_thread()` extracts a usable summary from the
thread itself:
- `consensus_direction` + `confidence` from `_compute_consensus`
- `key_arguments` = top 5 bullish messages by sentiment × influence
- `dissenting_views` = top 3 bearish
- `price_targets` = median / spread of `price_prediction` values
- `recommendation` = BUY/SELL/HOLD anchored on current close

So even a completely failed Stage 5 produces real output based on the
actual debate, not a NEUTRAL stub.

## 5. Multi-chart (portfolio) mode

**Entry point**: `_swarm_intelligence_processor` in
`core/agents/processors.py`.

Context provides:
```python
{
  "dataset_id": "<focused window's dataset>",
  "dataset_ids": ["<id1>", "<id2>", ...],   # all canvas windows
  ...
}
```

Processing:
1. Normalise `dataset_ids`: **always promote `dataset_id` to index 0**
   so the focused chart is the primary asset regardless of fetch order
2. Load each via `store.get_dataframe(id)`, dropping any missing ones
   (recorded as a `warn`-level RunEvent so user knows)
3. Fall back to `store.list_datasets()[-1]` if NONE loaded
4. If `len(loaded) > 1` → portfolio mode:
   ```python
   portfolio_lines = ["## Portfolio context (other assets on the canvas):"]
   for dsid, pbars, psym in loaded[1:]:
       portfolio_lines.append(format_ohlc_summary(pbars, psym, "Raw"))
   report = report + "\n\n" + "\n".join(portfolio_lines)
   ```
   `report_text` is then passed to `orchestrator.run()` and embedded in
   the intel briefing prompt — agents see the portfolio and reference
   siblings naturally ("ETH is up 8% — strengthens rotation-away-from-BTC thesis").

5. Reply annotation:
   - `len(loaded) > 1` → header reads "portfolio debate on BTC with 2 sibling assets: ETH, SOL"
   - `len(loaded) == 1` but `len(dataset_ids) > 1` → ⚠️ callout above the consensus line: "Ran on BTC only. 1 other chart on the canvas was skipped..."
   - `len(loaded) == 1 == len(dataset_ids)` → no annotation, plain single-chart debate

Multi-chart mode is **one debate that considers N assets**, not N
separate debates. Each persona sees the portfolio and can vote across.
Consensus math is still per-primary-asset.

## 6. Response shape & frontend mapping

Backend orchestrator `run()` returns:
```python
{
  "asset_info": {...},
  "entities": [...],             # 50 persona dicts
  "thread": [...],               # all 450-ish messages
  "total_rounds": 30,
  "summary": {...},              # consensus + key_arguments + etc.
  "intel_briefing": {...},
  "cross_exam_results": [...],
  "market_context": {...},       # Stage 1 output
  "data_feeds": {...},           # 6 specialisation feeds
  "agent_research": {id: [findings]},
  "convergence_timeline": [{round, sentiment}, ...],
  "events": [                   # timeouts, errors, warnings
    {"timestamp": "...", "level": "warn|error|info", "stage": "...", "message": "..."}
  ]
}
```

The processor wraps this with top-level identity fields:
```python
debate_payload = {
  "debate_id": uuid.uuid4(),
  "symbol": symbol,
  "bars_analyzed": len(bars),
  **result,
  "events": [missing_warning + ...result.events]  # prepended if any
}
```

Tool-call: `simulation.set_debate` with this payload.

Frontend `toolRegistry["simulation.set_debate"]` maps snake_case →
camelCase into `SimulationDebate` shape (`apps/web/src/types/index.ts`)
and calls `setCurrentDebate(mapped)`.

## 7. UI surfaces

Four bottom-panel tabs activate when `currentDebate !== null`:

- **DAG Graph** (`DAGGraphTab.tsx`) — React Flow visualisation of the
  5 pipeline stages
- **Personalities** (`PersonalitiesTab.tsx`) — grid of 50 persona cards.
  Click a card → `AgentDetailPanel` with:
  - Full profile (role, stance, specialization, influence, tools)
  - All messages this agent posted, grouped by round, with tool chips
  - Cross-exam Q&A for this agent (if selected)
  - Research trail — each query, reasoning, and result
  - **Live interview chat box** — POST to `/interview` keeps the
    persona in character for follow-up questions
- **Debate Thread** (`DebateThreadTab.tsx`) — flat list of all messages
  with sentiment bars, tool chips, agreement references
- **Run Stats** (`RunStatsTab.tsx`) — consensus + briefing + market
  context + data feeds + cross-exams + convergence chart + agent
  research trail + events banner + PDF export (Summary / Full dropdown)

## 8. CLI interface

`vibe-trade simulate [options]`:

```bash
vibe-trade simulate --symbol BTC/USDT --interval 1d --bars 500
```

Runs the same `DebateOrchestrator` in the terminal. Fetches bars via
`core.data.fetcher` first, pipes through the 5 stages, and prints:
- Consensus panel (direction + confidence + recommendation)
- Key arguments + dissenting views
- Run Warnings panel (any events fired) — matches the web UI
  exactly so both surfaces display the same diagnostics

## 9. Known limitations

- **No streaming** — UI waits for the full 10-30 min pipeline before
  rendering anything. Planner shows a timer-based approximation of
  progress, not real round-by-round. Events surface after completion.
- **50 × 30 is the maximum preset**, not a must. For faster iteration,
  reduce `MAX_ROUNDS` / `SPEAKERS_PER_ROUND` / `TARGET_ENTITIES` in
  code. No runtime knob yet.
- **No persona caching** — each run regenerates 50 personas from
  scratch. Expensive. An incremental "re-run with same personas but
  new bars" would be a useful optimisation.
- **Global DuckDuckGo rate limiter** (`_MIN_SEARCH_INTERVAL = 0.5s`)
  serialises ALL web searches across the whole pipeline — with 50
  agents × 3-8 queries each, Stage 2.5 can take 10+ min just on
  sequential searches.
- **No cross-session memory** — agents don't remember prior debates.
  A persona named "Marcus Wei" is ephemeral per-run.
