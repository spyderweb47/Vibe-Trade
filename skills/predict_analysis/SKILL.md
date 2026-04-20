---
id: predict_analysis
aliases:
  - swarm_intelligence
name: Predict Analysis
tagline: Multi-persona debate
description: >
  Runs a team of 50 LLM personas through a 30-round structured debate to
  predict market direction. Uses the Canvas Agent Swarm Service — the
  same shared infrastructure other skills use for smaller agent teams.
  Output is an influence-weighted consensus direction + trade recommendation
  with a transparent record of every argument, research query, and
  cross-examination.
version: 2.0.0
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
  placeholder: "Predict direction via multi-persona debate..."
  supports_fingerprint: false
---

# Predict Analysis Skill

> **Previously known as `swarm_intelligence`.** The skill id
> `swarm_intelligence` is retained as an alias for backward
> compatibility. See `docs/PREDICT_ANALYSIS.md` for the full technical
> walkthrough.

## The team

This skill uses the largest team of any skill — 50 agents in total —
orchestrated via the shared **Agent Swarm Service**
(`core/engine/agent_swarm.py`).

| Role(s) | Count | What they do |
|---|---|---|
| Asset classifier | 1 | Identifies the asset + its price drivers |
| Context analyser | 1 | Extracts regime + key levels from bars |
| Intelligence gatherer | 1 | Web-searches news / analysis / regulation / indicators |
| Personas (bull/bear/neutral/observer) | 50 | Debate the asset for 30 rounds |
| Cross-examiner | 1 | Probes divergent personas with targeted questions |
| Reporter | 1 | Synthesises final research note |

All coordination — parallelism, timeouts, retries, event recording —
is handled by the Agent Swarm Service, not this skill.

## Pipeline (5 stages, ~10-30 minutes total)

1. **Context Analysis** — classify asset + extract market context + build 6 specialisation data feeds
2. **Intelligence Gathering** — 4 web searches → synthesise bull/bear briefing
3. **Persona Generation** — 50 personas with distinct backgrounds, biases, influence weights, specialisations, tool access
4. **Iterative Research** — each persona plans its own research queries (min 3, max 8) using their assigned tools
5. **Multi-Round Debate** — 30 rounds × 15 speakers with per-agent memory + selective thread routing
6. **Cross-Examination** — press the 6-8 most divergent personas with targeted questions
7. **ReACT Report** — synthesise + apply influence-weighted consensus math

## Multi-chart (portfolio) mode

When the Canvas has multiple chart windows, the focused chart is the
primary asset (drives the full pipeline); siblings are summarised into
the intel briefing as portfolio context. Personas reference them
naturally in their arguments.

See `docs/PREDICT_ANALYSIS.md` § 5 for the processor-level normalisation
(focused → index 0, missing-dataset warnings, etc.).

## Tool calls emitted

| Tool | When | Purpose |
|---|---|---|
| `simulation.set_debate` | On completion | Push full debate payload to the store |
| `bottom_panel.activate_tab` | On completion | Switch to DAG Graph tab |
| `notify.toast` | On completion | Toast with consensus summary |

## Output tabs

| Tab | Shows |
|---|---|
| **DAG Graph** | React Flow pipeline visualisation |
| **Personalities** | 50 persona cards; click → full profile + research trail + live /interview chat |
| **Debate Thread** | Flat list of all messages with sentiment bars + tool chips + agreement references |
| **Run Stats** | Consensus + briefing + market context + data feeds + cross-exams + convergence chart + PDF export + Run Warnings banner |

## Input

- Natural language: "run a swarm debate on BTC", "predict direction for CL=F", "what does the committee think about AAPL?"
- Requires at least one dataset loaded on the Canvas.
- Optional: message text is passed through as additional context into every persona's prompt.

## Known limitations

See `docs/PREDICT_ANALYSIS.md` § 13. Summary: no streaming (user waits
for full 10-30 min run), no persona caching (every run regenerates),
global DDG rate limiter serialises web searches, no cross-session memory.
