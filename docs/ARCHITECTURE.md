# Vibe Trade — Architecture

> **Baseline**: this doc describes the architecture **after the
> Canvas-as-Platform refactor**. Previous versions are archived in
> `docs/back/` with `_v0.4.2` or `_pre-v0.4` suffixes.
>
> **Subsystem docs**:
> - [`AGENT_SWARM.md`](./AGENT_SWARM.md) — the shared agent-orchestration service (a Canvas-level capability)
> - [`SKILLS.md`](./SKILLS.md) — skills that extend the Canvas via this service
> - [`PREDICT_ANALYSIS.md`](./PREDICT_ANALYSIS.md) — the multi-persona debate skill (renamed from `swarm_intelligence`)
> - [`CANVAS.md`](./CANVAS.md) — multi-chart workspace details

## 1. One-line pitch

The Canvas is an AI-native trading workspace. Skills extend it. Every
skill has access to a shared **Agent Swarm Service** that can spawn,
orchestrate, and verify LLM agents with research tools — so a skill
isn't just "a prompt template", it's a whole team of specialised
agents cooperating (including a QA agent that verifies the output in
a closed loop).

## 2. The 3 layers — revised

```
╔══════════════════════════════════════════════════════════╗
║                      LAYER 1: CANVAS                     ║
║                                                          ║
║   Multi-chart workspace. Chart windows, drawings, bottom ║
║   panel. The stage where everything the user sees lives. ║
║                                                          ║
║   DEFAULT CAPABILITIES (embedded in the Canvas):         ║
║     • Planner (routes typed intent to skills)            ║
║     • Agent Swarm Service (spawn agents, orchestrate,    ║
║       run QA loops)                                      ║
║     • Swarm Tools (search_web, fetch_url, run_indicator, ║
║       compute_levels, ...) — a shared tool registry      ║
║       any agent can use                                  ║
╠══════════════════════════════════════════════════════════╣
║                      LAYER 2: TOOLING                    ║
║                                                          ║
║   Two tool vocabularies:                                 ║
║                                                          ║
║   UI Tools          │  Swarm Tools                       ║
║   (Frontend verbs)  │  (Agent-callable tools)            ║
║   ─────────────────│──────────────────────────────       ║
║   data.dataset.add  │  search_web                        ║
║   script_editor.    │  fetch_url                         ║
║     load            │  fetch_pdf                         ║
║   chart.set_        │  fetch_news                        ║
║     timeframe       │  fetch_policy                      ║
║   chart.focus_range │  run_indicator                     ║
║   bottom_panel.     │  compute_levels                    ║
║     activate_tab    │  (+ future: write_script,          ║
║   notify.toast      │     verify_script, ...)            ║
║   simulation.set_   │                                    ║
║     debate          │                                    ║
║                                                          ║
║   UI tools mutate the Canvas. Swarm tools give agents    ║
║   powers. Both are registries the layers below fill in.  ║
╠══════════════════════════════════════════════════════════╣
║                      LAYER 3: SKILLS                     ║
║                                                          ║
║   Extensions that the Planner can dispatch. Each skill   ║
║   is a **team-builder**: it declares what agents it      ║
║   needs and what they should do. The Canvas's Agent      ║
║   Swarm Service does the heavy lifting — skills just     ║
║   describe the team.                                     ║
║                                                          ║
║   Current skills:                                        ║
║     • data_fetcher      — no agents; just pulls bars     ║
║     • pattern           — Research + Writer + QA agents  ║
║     • strategy          — Risk + Portfolio + Writer + QA ║
║     • predict_analysis  — 50 personas debating (what     ║
║                           used to be `swarm_intelligence`)║
║                                                          ║
║   New skills are added by describing the team, not by    ║
║   reimplementing orchestration.                          ║
╚══════════════════════════════════════════════════════════╝
```

Key shift: **agent orchestration is no longer a skill-private
concern**. It's a Canvas capability that every skill can leverage.
Strategy generation becomes a team effort. Pattern detection becomes a
team effort. The debate engine (`predict_analysis`) is simply the
skill that uses the biggest team.

## 3. The reference flow — "build me a strategy"

```
User: "Build a mean-reversion strategy on ETH with TP 3% / SL 1.5%"
      │
      ▼
Planner      ──decompose──▶  [data_fetcher, strategy]
      │
      ▼
data_fetcher ──backend─────▶  saves ETH bars to store, spawns window
      │
      ▼
strategy skill invoked — under the hood it asks the Canvas's
Agent Swarm Service to assemble a team:

   ┌────────────────────────────────────────────────────────┐
   │   AgentSwarm.assemble([                                │
   │     ("risk_manager",   persona=..., tools=[...]),      │
   │     ("portfolio_mgr",  persona=..., tools=[...]),      │
   │     ("script_writer",  persona=..., tools=[...]),      │
   │     ("qa_verifier",    persona=..., tools=[...])       │
   │   ])                                                   │
   └────────────────────────────────────────────────────────┘
                             │
                             ▼
   Team runs cooperatively:
     1. risk_manager analyses ETH regime + recommends position sizing
     2. portfolio_mgr checks how this strategy sits in user's context
     3. script_writer drafts the JS strategy (informed by 1 & 2)
     4. qa_verifier RUNS the draft in a sandbox against the actual
        bars, checks the trades match the user's intent, returns
        {pass: bool, issues: [...]}
     5. If qa fails, script_writer iterates (bounded loop, max 3 tries)
     6. Final artifact returned when qa passes (or max iterations hit)
                             │
                             ▼
   strategy skill emits tool_call: script_editor.load + backtest run
                             │
                             ▼
                        UI updates
```

This pattern generalises. Pattern skill uses the same `AgentSwarm`
with a smaller team (research + writer + qa). Predict Analysis uses it
with 50 personas and a debate-specific orchestration mode.

## 4. Request flow (end-to-end)

```
User chat message
      │
      ▼
RightSidebar.handleSubmit
      │
      ▼
POST /plan ─▶ planner.plan() — LLM + keyword fallback
      │
      ▼
planExecutor runs each step:
  POST /chat  { message, mode=skill_id, context={dataset_id, dataset_ids, ...} }
      │
      ▼
services/api/routers/chat.py → get_processor(skill_id)
      │
      ▼
core/agents/processors.py::<skill>_processor()
   ├─ For skills that need agents:
   │    swarm = AgentSwarm()                  ← from core/engine/agent_swarm.py
   │    team = swarm.assemble([...spec...])
   │    artifact = await team.run(task_description, context)
   │
   └─ Returns SkillResponse with tool_calls
      │
      ▼
Frontend toolRegistry executes tool_calls → UI mutations
```

The AgentSwarm service is the single place in the codebase that knows
about parallelism, timeouts, retries, per-agent context building,
research loops, and QA loops. Skills describe WHAT team they need;
the service does HOW.

## 5. Tech stack

### Backend (Python 3.12+)
- **FastAPI** — HTTP API (`services/api`)
- **pandas / numpy** — OHLC data wrangling
- **yfinance + ccxt** — market data providers (`core/data/fetcher.py`)
- **openai / anthropic SDKs** — LLM calls, provider-agnostic via `core/agents/llm_client.py`
- **ddgs** (DuckDuckGo) — web research
- **BeautifulSoup + pypdf2** — HTML/PDF scraping

### Frontend (Next.js 16 App Router)
- **React 19** + **TypeScript**
- **Zustand** — state
- **lightweight-charts v5** — candlestick rendering + custom Primitives
- **react-rnd** — drag/resize chart windows
- **React Flow** — pipeline visualisation
- **Tailwind v4** — styling
- **jsPDF** — native text-based PDF export

### CLI
- **Typer** + **Rich**
- `vibe-trade serve` bundles built Next.js export

## 6. Directory map

```
trading-platform/
├── core/
│   ├── agents/
│   │   ├── base_agent.py          NEW — shared Agent base class
│   │   ├── qa_agent.py            NEW — QA-loop pattern (verify+iterate)
│   │   ├── llm_client.py
│   │   ├── planner.py             knows about all registered skills
│   │   ├── processors.py          per-skill entry points
│   │   ├── simulation_agents.py   personas, researcher, examiner (used by predict_analysis)
│   │   ├── swarm_tools.py         shared tool registry (search_web, fetch_url, ...)
│   │   ├── pattern_agent.py       script generation logic
│   │   └── strategy_agent.py      script generation logic
│   │
│   ├── engine/
│   │   ├── agent_swarm.py         NEW — the AgentSwarm service
│   │   │                               This is the Canvas-level capability
│   │   ├── dag_orchestrator.py    predict_analysis's 5-stage pipeline;
│   │   │                           now uses AgentSwarm for parallelism
│   │   └── simulation_engine.py   bar-by-bar replay simulator
│   │
│   ├── data/fetcher.py
│   ├── indicators/
│   └── skill_registry.py
│
├── services/api/
│   ├── main.py
│   ├── store.py
│   └── routers/
│       ├── chat.py, simulation.py, upload.py, patterns.py,
│       ├── strategies.py, backtest.py, analysis.py, indicators.py
│
├── skills/
│   ├── data_fetcher/         (unchanged)
│   ├── pattern/              SKILL.md describes the team it uses
│   ├── strategy/             SKILL.md describes the team it uses
│   ├── predict_analysis/     RENAMED from swarm_intelligence
│   └── _template/
│
├── apps/web/                 (frontend — unchanged layout;
│                              Canvas already documented separately)
│
├── vibe_trade/               (CLI)
│
├── docs/
│   ├── ARCHITECTURE.md       (you are here)
│   ├── AGENT_SWARM.md        NEW
│   ├── SKILLS.md
│   ├── CANVAS.md
│   ├── PREDICT_ANALYSIS.md   (renamed from SWARM_PIPELINE.md)
│   └── back/
│
└── pyproject.toml
```

## 7. What changed vs v0.4.2

| Concern | v0.4.2 | Now |
|---|---|---|
| Agent orchestration | Trapped inside `swarm_intelligence` skill | Extracted to `core/engine/agent_swarm.py` — a Canvas capability |
| Agent tools | Locked to swarm's use case | Shared `swarm_tools.py` registry any agent can call |
| Pattern skill | Single LLM call producing a script | Team: Research + Writer + QA agents (QA loop verifies script) |
| Strategy skill | Single LLM call + LLM config | Team: Risk + Portfolio + Writer + QA agents (QA loop tests backtest) |
| Multi-persona debate | Was the skill "swarm_intelligence" | Now the skill "predict_analysis" (debate engine is one specific use of AgentSwarm) |
| QA verification | Only in predict_analysis's cross-exam stage | Standardised pattern (`qa_agent.py`) — any skill can request a QA loop |

The fundamental change: **"agentic" is no longer a feature of one
skill; it's a capability of the Canvas** that every skill opts into.

## 8. Frontend state model

Unchanged from v0.4.2 — same zustand store, same conversation
persistence, same multi-chart canvas state. Only the skill name
`swarm_intelligence` → `predict_analysis` where it appears in:
- `apps/web/src/lib/planExecutor.ts::SKILL_SUB_PLANS`
- Result-summary formatter
- Any hardcoded skill-id lookups

See [`CANVAS.md`](./CANVAS.md) for canvas details and
[`SKILLS.md`](./SKILLS.md) for the skill system.

## 9. HTTP API

Unchanged. The skill rename is internal; the `/chat` and `/plan`
endpoints take whatever `mode` / `skill` string the processor
registry has. Backward-compat: the old `swarm_intelligence` id still
routes to the new `predict_analysis` processor (documented shim in
`processors.py`).

## 10. Reliability (unchanged baseline)

4-layer timeouts + `RunEvent` logging + fallback summaries — all
still enforced by the AgentSwarm service now that it owns the
orchestration. Any skill that uses the service inherits the same
reliability guarantees (per-agent timeouts, retry policy, event
recording).

See [`AGENT_SWARM.md`](./AGENT_SWARM.md) § Reliability for details.

## 11. Migration guide for skill authors

Before (v0.4.2):
```python
async def _my_skill_processor(message, context, tools):
    # Build prompt, call chat_completion, parse response
    prompt = build_prompt(...)
    result = chat_completion(prompt, ...)
    return SkillResponse(reply=result.text, tool_calls=[...])
```

After:
```python
async def _my_skill_processor(message, context, tools):
    swarm = AgentSwarm()
    team = swarm.assemble([
        AgentSpec(role="analyst", persona={...}, tools=["search_web"]),
        AgentSpec(role="writer", persona={...}, tools=[]),
        AgentSpec(role="qa", persona={...}, tools=["run_indicator"]),
    ])
    artifact = await team.run_with_qa_loop(
        task=message,
        context=context,
        max_iterations=3,
    )
    return SkillResponse(reply=artifact.summary, tool_calls=artifact.tool_calls)
```

The skill author focuses on describing the team; the service provides
parallelism, timeouts, retries, QA loops, and event recording.

See [`AGENT_SWARM.md`](./AGENT_SWARM.md) for the full API.
