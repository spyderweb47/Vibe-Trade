# Skills — how they plug into the Canvas

> **Companion docs**:
> - [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the 3-layer model
> - [`AGENT_SWARM.md`](./AGENT_SWARM.md) for the shared agent service
> - [`PREDICT_ANALYSIS.md`](./PREDICT_ANALYSIS.md) for the multi-persona debate skill

## 1. What a skill is, precisely

A **skill** is a backend-registered capability that the Planner can
dispatch. Each skill:
1. Is declared in `skills/<id>/skill.yaml` + documented in `skills/<id>/SKILL.md`
2. Has a Python processor in `core/agents/processors.py`
3. Receives `(message, context, tools)` and returns a `SkillResponse`
4. Can emit `tool_calls` that mutate the Canvas
5. **Optionally** uses the Agent Swarm Service to spawn its team of LLM agents

A skill is a composition — it's the thin wrapper that says *"for
capability X, the team I need is [A, B, C]"* and delegates everything
else to the Canvas-level orchestration.

## 2. Registered skills

| id | Purpose | Agent team | QA loop |
|---|---|---|---|
| `data_fetcher` | Pull bars from yfinance/ccxt | None (no LLM) | N/A |
| `pattern` | Generate pattern-detection script | Researcher + Writer + QA | Yes (script runs → verifies matches) |
| `strategy` | Generate strategy script + backtest | Risk + Portfolio + Writer + QA | Yes (script runs → verifies trade quality) |
| `predict_analysis` | Multi-persona trading debate | 50 personas + CrossExaminer + Reporter | Partial (cross-exam as adversarial QA) |

`predict_analysis` is the renamed `swarm_intelligence` — it's now one
skill among others that uses the shared AgentSwarm service (just with
the biggest team).

## 3. The Planner

Every chat request goes through `POST /plan` first. The planner
returns an ordered list of skill invocations.

### Flow
```
Message → planner.plan(message, available_skills=full_registry)
         ├─ LLM call (temperature 0.2, max 900 tokens)
         │    Returns {"steps": [...]} or empty
         └─ Keyword fallback if LLM returns empty
             Scans message for trigger phrases:
               • "fetch" / "load" / "download"    → data_fetcher
               • "swarm" / "debate" / "predict"   → predict_analysis
               • "detect pattern" / "engulfing"   → pattern
               • "backtest" / "strategy"          → strategy
         │
         └─ Returns validated [{skill, message, rationale, context}]
```

### Prompt rules (`core/agents/planner.py::PLAN_SYSTEM_PROMPT`)
- Use ONLY skill ids from the registered list
- Each step's `message` is self-contained (downstream skill won't see original user message)
- `strategy` skill MUST include `context.strategy_config`
- Return `{"steps": []}` for out-of-scope requests

### Design choice: no chip restriction
The frontend passes `available_skills = undefined` — planner always
sees the full registry. Chip selection (active skill tabs) is UI
organisation only, not a plan restriction. Typed intent always wins.

## 4. SkillResponse shape

```python
@dataclass
class SkillResponse:
    reply: str                               # shown in chat
    data: Dict[str, Any] = None              # carried forward to next step
    script: str = None                       # auto-run if pattern/strategy
    script_type: str = "pattern"             # pattern | strategy | indicator
    tool_calls: List[Dict[str, Any]] = []    # [{tool, value}, ...]
```

`tool_calls` are the only way a skill affects the frontend. Each is
routed through the tool registry in `apps/web/src/lib/toolRegistry.ts`.

## 5. Skill processors — the two shapes

### Shape A: simple (no agents)
For skills that are just a backend operation + UI update. Example:
`data_fetcher`.

```python
async def _data_fetcher_processor(message, context, tools):
    parsed = parse_query(message)
    result = fetch_market_data(parsed["symbol"], parsed["interval"], parsed["limit"])
    # Save to backend store so next skill can use it
    dataset_id = uuid.uuid4()
    store.save_dataset(dataset_id, pd.DataFrame(result["bars"]), metadata)
    return SkillResponse(
        reply=f"Loaded {result['metadata']['rows']} bars of {result['symbol']}",
        tool_calls=[{"tool": "data.dataset.add", "value": {**result, "dataset_id": dataset_id}}],
    )
```

### Shape B: team-based (uses AgentSwarm)
For skills that benefit from multi-agent reasoning. Example: `pattern`.

```python
async def _pattern_processor(message, context, tools):
    swarm = AgentSwarm()
    team = swarm.assemble([
        AgentSpec(role="researcher", persona={...}, tools=["search_web"]),
        AgentSpec(role="writer", persona={...}, tools=[]),
        AgentSpec(role="qa", persona={...}, tools=["run_indicator"]),
    ])

    # Phase 1: research what the pattern means
    research = await team.agents["researcher"].speak(
        context=f"Pattern request: {message}",
        task="Research the mathematical/visual signature of this pattern",
    )

    # Phase 2: write + verify in a loop
    result = await team.run_with_qa_loop(
        task=message,
        context=research.content,
        producer_role="writer",
        verifier_role="qa",
        max_iterations=3,
        spec=QASpec(
            acceptance_criteria=f"Script detects at least 5 {message} instances...",
            test_fn=run_pattern_script,
            test_data=context.get("bars"),
        ),
    )

    return SkillResponse(
        reply=f"{result.final_artifact.content}\n_{result.iterations} QA iterations_",
        script=result.final_artifact.structured["script"],
        script_type="pattern",
        tool_calls=[{"tool": "script_editor.load", "value": ...}],
        data={"events": swarm.events()},
    )
```

All the parallelism, timeouts, retries, event recording are done by
`AgentSwarm` — the skill just declares the team.

## 6. Tool registry (unchanged from v0.4.2)

Tools are **UI mutations** a skill can request. Each has a handler in
`apps/web/src/lib/toolRegistry.ts`.

| Tool | Payload | Effect |
|---|---|---|
| `data.dataset.add` | `{dataset_id, bars, metadata, ...}` | `addDataset` + mark synced |
| `script_editor.load` | script string | Loads into code editor |
| `chart.set_timeframe` | `"1h" \| "1d" \| null` | Resample focused chart |
| `chart.focus_range` | `{startTime, endTime}` | Zoom focused chart |
| `chart.drawing.activate` | drawing tool name | Switch drawing toolbar |
| `bottom_panel.activate_tab` | tab id | Open specific bottom tab |
| `bottom_panel.close` | — | Collapse bottom panel |
| `simulation.set_debate` | full debate dict | Map to SimulationDebate + store |
| `simulation.run_debate` | — | Trigger direct-REST debate fallback |
| `simulation.reset` | — | Clear currentDebate |
| `notify.toast` | `{level, message}` | Transient toast |

### Tool vs Swarm Tool
Don't confuse:
- **UI tools** (above) — frontend verbs, used by skills via `tool_calls`
- **Swarm tools** (`search_web`, `run_indicator`, ...) — agent
  capabilities, used by AgentSwarm agents via `Agent.use_tool(...)`

See [`AGENT_SWARM.md`](./AGENT_SWARM.md) § 8 for the swarm-tool catalog.

## 7. Allowed-tools validation
Each skill's `skill.yaml` lists the UI tools it's allowed to emit:

```yaml
id: pattern
tools:
  - script_editor.load
  - bottom_panel.activate_tab
  - notify.toast
```

The frontend's `runToolCalls(tool_calls, skillId, allowedTools)` drops
any `tool_call` outside the allowed list. Prevents misbehaving skills
from opening random panels.

## 8. Adding a new skill

1. **Create folder**: `skills/<my_skill>/`
2. **`skill.yaml`**:
   ```yaml
   id: my_skill
   name: "My New Skill"
   description: "What it does"
   version: "0.1.0"
   tools:
     - script_editor.load
     - notify.toast
   ```
3. **`SKILL.md`** — human description shown in the Skills modal
4. **Describe the agent team** (if needed) as AgentSpecs
5. **Add processor** to `core/agents/processors.py`:
   ```python
   async def _my_skill_processor(message, context, tools):
       swarm = AgentSwarm()
       team = swarm.assemble([...])
       result = await team.run_with_qa_loop(...)
       return SkillResponse(reply=..., tool_calls=[...])

   PROCESSORS["my_skill"] = _my_skill_processor
   ```
6. **(Optional) Add keyword fallback rule** in `_FALLBACK_RULES`
7. **(Optional) Add sub-plan** in `SKILL_SUB_PLANS` for trace progress
8. **Restart backend** — skill auto-discovered via `core/skill_registry.py`

## 9. Plain-chat fallback

When the planner returns `{"steps": []}` (trivial messages like "hi"),
the frontend falls through to plain `/chat` call. `get_processor(mode)`
returns `None` for unknown modes → `_plain_chat(message)` runs —
single LLM call, no tool_calls.

## 10. Backward compatibility shim

The `swarm_intelligence` skill id is now an **alias** for
`predict_analysis`. The processor registry maps both:
```python
PROCESSORS["predict_analysis"] = _predict_analysis_processor
PROCESSORS["swarm_intelligence"] = _predict_analysis_processor   # alias
```
So existing frontend code / saved conversations that reference
`swarm_intelligence` keep working. The Planner's keyword fallback and
default emissions use the new name.

## 11. Skill vs AgentSwarm — where does logic go?

Rule of thumb:

| Logic | Lives in |
|---|---|
| Parsing user intent to task | Skill processor |
| Choosing what agents to hire | Skill processor (via AgentSpec list) |
| Running agents in parallel | AgentSwarm |
| Per-agent prompt building | AgentSwarm / base_agent |
| LLM retry + timeout policy | AgentSwarm / llm_client |
| QA loop mechanics | AgentSwarm (`team.run_with_qa_loop`) |
| Consensus math on agent outputs | Skill processor (if skill-specific) OR AgentSwarm helper (if generic) |
| Assembling `SkillResponse.tool_calls` | Skill processor |
| Event recording | AgentSwarm (skill reads via `swarm.events()`) |

If you're writing the same orchestration code in two skills, it
belongs in AgentSwarm. If it's truly skill-specific (e.g. "which
bottom panel tab to open"), it stays in the processor.
