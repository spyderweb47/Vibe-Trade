# Predict Analysis skill — multi-persona trading debate

> **Status**: this is the renamed `swarm_intelligence` skill. The core
> pipeline is unchanged (5 stages, 50 personas, 30 rounds,
> cross-exam, ReACT report). The rename reflects the new architecture
> where **agent orchestration is a Canvas capability**, not a
> skill-specific invention. Predict Analysis is one skill that uses
> the shared AgentSwarm service — just with the largest team.

> **Companion docs**:
> - [`AGENT_SWARM.md`](./AGENT_SWARM.md) — the underlying service
> - [`SKILLS.md`](./SKILLS.md) — how skills plug into the Canvas
> - [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the 3-layer model

## 1. What it does

Runs a committee of 50 LLM personas (technical analysts, macro
traders, quants, regulators, sentiment watchers) debating an asset
across 30 rounds, with per-agent memory, selective message routing,
and a ReACT-style final report. Output is an **influence-weighted
consensus** direction + trade recommendation + full transparent
record of every argument.

Inspired by MiroFish: diverse adversarial panels outperform single
models because dissent is preserved.

## 2. Where to find it

```
skills/predict_analysis/
├── SKILL.md           — human description
└── skill.yaml         — registered metadata

core/engine/dag_orchestrator.py
└── DebateOrchestrator ← the 5-stage pipeline (entry point)

core/agents/simulation_agents.py
├── AssetClassifier
├── ContextAnalyzer
├── DataFeedBuilder
├── IntelligenceGatherer
├── IterativeResearcher
├── EntityGenerator
├── DiscussionAgent
├── CrossExaminer
├── ReACTReportAgent
└── InterviewAgent      ← post-debate live chat

core/agents/processors.py
└── _predict_analysis_processor  ← skill entry; builds portfolio
                                    context, calls orchestrator

core/engine/agent_swarm.py  ← predict_analysis uses this for
                              parallelism primitives (internally
                              a shim during migration)
```

## 3. The 5 stages (unchanged)

```
Stage 1:  Context Analysis            [2 LLM + 1 synth feeds]
Stage 1.5: Intelligence Gathering     [4 web + 1 synth]
Stage 2:  Persona Generation          [5 batches of 10 parallel]
Stage 2.5: Iterative Research         [up to 320 web + LLM calls]
Stage 3:  Multi-Round Debate          [30 rounds × 15 speakers]
Stage 4:  Cross-Examination           [6-8 divergent agents pressed]
Stage 5:  ReACT Report Generation     [1 big synth + math override]
```

See `docs/back/SWARM_PIPELINE_v0.4.2.md` for the pre-refactor stage
detail — every argument there still holds. What changed is the
plumbing, not the semantics.

## 4. Configuration constants

All in `DebateOrchestrator` (`core/engine/dag_orchestrator.py`):

```python
MAX_ROUNDS = 30
SPEAKERS_PER_ROUND = 15               # → up to 30 × 15 = 450 messages
```

`EntityGenerator.TARGET_ENTITIES = 50`
`IterativeResearcher.MIN_ITERATIONS = 3, MAX_ITERATIONS = 8`

## 5. Multi-chart (portfolio) mode

Entry point: `_predict_analysis_processor` in `processors.py`.

- `context.dataset_id` — focused window's dataset (primary asset)
- `context.dataset_ids` — all canvas window datasets

Processing:
1. Promote focused dataset to index 0 of `dataset_ids`
2. Load each from `services.api.store`, skipping missing (recorded as warn events)
3. If `len(loaded) > 1`, build portfolio context block and append to `report_text`
4. Call `DebateOrchestrator.run(bars, symbol, report_text)` with the primary asset

The orchestrator stays single-asset; portfolio context is text-only.
Personas see the sibling summaries in their intel briefing and
reference them naturally.

## 6. How it uses AgentSwarm (the new foundation)

Internally, the 5 stages now map onto the service:

| Stage | AgentSwarm call |
|---|---|
| 1 — Context | `swarm.spawn(role="classifier").speak()` + `swarm.spawn(role="context_analyzer").speak()` in parallel |
| 1.5 — Intel | `swarm.spawn(role="intel").speak()` with `search_web` tool calls |
| 2 — Personas | `team = swarm.assemble([...5 generator batches...])` + `team.run_parallel()` |
| 2.5 — Research | each persona-agent runs `Agent.research_loop(MIN_ITERATIONS, MAX_ITERATIONS)` |
| 3 — Debate | `team = swarm.assemble([...50 agents...])` + `team.discussion(rounds=30, speakers_per_round=15)` |
| 4 — Cross-exam | `swarm.spawn(role="cross_examiner")` + per-agent `speak()` against divergent agents |
| 5 — Report | `swarm.spawn(role="reporter").speak()` + `_compute_consensus` override |

The existing code (`DebateOrchestrator.run()`) is preserved behind a
shim that presents the old synchronous interface but delegates to the
service internally. Migration is progressive: each stage is refactored
one at a time, behavior-preserving.

## 7. Cross-exam as QA

Stage 4's cross-examination is effectively a **specialised QA loop**:
the divergent agents are "producers" and the cross-examiner is a
"verifier" asking targeted challenge questions. In the new architecture
this maps cleanly onto:

```python
for divergent_agent in most_divergent(thread, entities, n=8):
    qa_result = await team.run_with_qa_loop(
        task=divergent_agent.thesis,
        context=consensus_summary,
        producer_role=divergent_agent.role,
        verifier_role="cross_examiner",
        max_iterations=1,      # one probing question, not a rework loop
        spec=QASpec(acceptance_criteria="Agent must defend thesis with specific evidence"),
    )
```

So Predict Analysis isn't a weird outlier — it's the canonical
"multi-agent + QA" pattern at scale.

## 8. Response shape

Orchestrator returns (unchanged from v0.4.2):

```python
{
  "debate_id": str,
  "symbol": str,
  "bars_analyzed": int,
  "asset_info": {asset_class, asset_name, description, price_drivers},
  "entities": [...50 personas...],
  "thread": [...~450 DiscussionMessage...],
  "total_rounds": int,
  "summary": {
    "consensus_direction": "BULLISH|BEARISH|NEUTRAL",  # math-override
    "confidence": 0-100,                                # math-override
    "key_arguments": [...],
    "dissenting_views": [...],
    "price_targets": {low, mid, high},
    "risk_factors": [...],
    "recommendation": {action, entry, stop, target, position_size_pct},
    "conviction_shifts": [...]
  },
  "intel_briefing": {executive_summary, bull_case, bear_case,
                     key_events, sentiment_reading, data_points, raw_findings},
  "cross_exam_results": [...],
  "market_context": {...},
  "data_feeds": {general, technical, volume, quant, macro, structure},
  "agent_research": {entity_id: [findings]},
  "convergence_timeline": [{round, sentiment}, ...],
  "events": [...RunEvents...]
}
```

Emitted as tool call `simulation.set_debate` with this entire payload.
Frontend `toolRegistry.simulation.set_debate` maps snake_case →
camelCase into `SimulationDebate` and stores via `setCurrentDebate`.

## 9. UI surfaces

Four bottom-panel tabs activate when `currentDebate !== null`:

- **DAG Graph** — React Flow pipeline visualisation (`DAGGraphTab.tsx`)
- **Personalities** — 50 persona cards (`PersonalitiesTab.tsx`); click →
  `AgentDetailPanel` with full profile, messages, research trail, and
  live `/interview` chat
- **Debate Thread** — flat list of all messages with sentiment bars
  and tool chips (`DebateThreadTab.tsx`)
- **Run Stats** — consensus + briefing + market context + data feeds
  + cross-exams + convergence chart + agent research trail + events
  banner + PDF export Summary/Full dropdown (`RunStatsTab.tsx`)

## 10. CLI

`vibe-trade simulate [options]`:
```bash
vibe-trade simulate --symbol BTC/USDT --interval 1d --bars 500
```

Runs the same orchestrator in-terminal. Prints the consensus panel,
key arguments, dissenting views, and Run Warnings panel (matches the
web UI's Events banner).

## 11. Why rename from `swarm_intelligence`?

`swarm_intelligence` conflated two things:
1. The general capability of "spawn and orchestrate a swarm of agents"
2. The specific application of that to multi-persona market debate

The rename separates them:
- **AgentSwarm** = the capability (now a Canvas-level service)
- **Predict Analysis** = the specific application (the debate skill)

Other skills now use the same capability differently (pattern skill
hires a 3-agent team, strategy hires 4). None of them "are" swarm
intelligence anymore — they all _use_ swarm intelligence.

## 12. Backward compatibility

- Skill id `swarm_intelligence` is aliased to `predict_analysis` in
  `PROCESSORS` registry. Old conversations / saved plans keep routing.
- `simulation.set_debate` tool name is retained (would need frontend
  changes to rename; low value).
- Frontend `SKILL_SUB_PLANS["swarm_intelligence"]` key kept as an
  alias alongside the new key.
- `DebateOrchestrator.run()` public interface unchanged — its internals
  delegate to AgentSwarm progressively.

## 13. What's still intentionally NOT done

Same list as v0.4.2:
- **No streaming** — UI waits for full 10-30 min pipeline
- **No persona cache** — every run regenerates personas from scratch
- **Global DuckDuckGo rate limiter** serialises all web searches
- **No cross-run memory** — agents don't remember prior debates
