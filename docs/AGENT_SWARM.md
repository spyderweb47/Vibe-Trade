# Agent Swarm Service — the Canvas's shared orchestration layer

> **Status**: service is live (`core/engine/agent_swarm.py`).
> - ✅ Pattern skill migrated to Writer + QA team (`_pattern_processor_with_team`)
> - ⏳ Strategy skill migration planned (Risk + Portfolio + Writer + QA)
> - ⏳ `predict_analysis` progressive migration planned (Stage 3 → `Team.discussion()`, etc.)

## 1. What it is

A reusable backend service that lets any skill:
- **Spawn** one or more LLM agents with a persona + tool access
- **Run** them in parallel (with timeouts) or sequentially
- **Orchestrate** them cooperatively (each agent's output feeds the next)
- **Verify** artifacts in a closed QA loop (producer → verifier → fix → retry)
- **Record** every call, retry, and failure as a `RunEvent` that
  surfaces in the UI

It's the generalisation of what `DebateOrchestrator` did for the old
`swarm_intelligence` skill — but now available to `pattern`,
`strategy`, and any future skill.

## 2. File layout

```
core/engine/
└── agent_swarm.py       ← the service (new)

core/agents/
├── base_agent.py        ← abstract Agent with speak/use_tool/reflect
├── qa_agent.py          ← QA-loop pattern (verify + feedback)
├── llm_client.py        ← still used for raw LLM calls
├── swarm_tools.py       ← shared tool registry (search_web, etc.)
└── simulation_agents.py ← specialised agents that inherit base_agent
```

## 3. Core concepts

### 3.1 `AgentSpec`

Declarative description of an agent you want on your team:

```python
@dataclass
class AgentSpec:
    role: str                           # "risk_manager", "script_writer", "qa"
    persona: Dict[str, Any]             # {name, background, style, influence}
    tools: List[str]                    # tool ids this agent can call
    system_prompt: Optional[str] = None # override default for this role
    temperature: float = 0.3
    max_tokens: int = 1500
    timeout_s: Optional[float] = None   # per-call override
```

### 3.2 `Agent` (the runtime object)

Produced by `swarm.spawn(spec)`. Has:

```python
class Agent:
    spec: AgentSpec
    memory: List[str]                   # this agent's own prior outputs

    async def speak(self, context: str, task: str) -> AgentResponse:
        """One LLM call with this agent's persona + context."""

    async def use_tool(self, tool_id: str, args: dict) -> str:
        """Call one of the tools this agent is allowed to use."""

    async def reflect(self, prior_output: str, feedback: str) -> AgentResponse:
        """Revise prior output given feedback (used in QA loops)."""
```

### 3.3 `AgentResponse`

```python
@dataclass
class AgentResponse:
    content: str                       # natural language output
    confidence: float                  # 0-1, self-reported
    tool_calls_made: Dict[str, str]    # {tool_id: short_result}
    structured: Optional[Dict]         # parsed JSON if the prompt asks for it
    error: Optional[str] = None        # if the call ultimately failed
```

### 3.4 `Team`

The result of `swarm.assemble([specs])`. Exposes the orchestration primitives:

```python
class Team:
    agents: Dict[str, Agent]            # role -> agent

    async def run_parallel(
        self,
        task: str,
        context: str,
        timeout_s: float = 180,
    ) -> Dict[str, AgentResponse]:
        """All agents work on the same task concurrently."""

    async def run_sequential(
        self,
        task: str,
        context: str,
        order: List[str],
    ) -> Dict[str, AgentResponse]:
        """Each agent gets prior agents' outputs as additional context."""

    async def discussion(
        self,
        rounds: int,
        speakers_per_round: int,
        convergence_threshold: float = 0.05,
    ) -> DiscussionResult:
        """The Stage-3-style debate primitive: rotating speakers over N
        rounds with per-agent memory and selective thread filtering."""

    async def run_with_qa_loop(
        self,
        task: str,
        context: str,
        producer_role: str,
        verifier_role: str,
        max_iterations: int = 3,
        spec: Optional[QASpec] = None,
    ) -> QAResult:
        """Producer generates → verifier checks → producer iterates on
        feedback. Stops when verifier says pass or max_iterations hit."""
```

### 3.5 `QASpec`

Describes what "passing" means to the verifier agent:

```python
@dataclass
class QASpec:
    """What the QA agent should check."""
    acceptance_criteria: str            # natural language
    test_fn: Optional[Callable] = None  # optional programmatic check
    test_data: Optional[Any] = None     # data to run the test against
```

For a pattern skill, `test_fn` might be "run this script and return the
list of matches on the current chart"; the verifier compares that
against `acceptance_criteria` ("should find 5-20 engulfing patterns").

## 4. The service API

`core/engine/agent_swarm.py` exposes:

```python
class AgentSwarm:
    """Entry point for skills that want to use agents."""

    def __init__(self, *, tools_registry: ToolsRegistry = None):
        self._tools = tools_registry or default_tools_registry()
        self.run_events: List[RunEvent] = []

    def spawn(self, spec: AgentSpec) -> Agent:
        """Create a single agent."""

    def assemble(self, specs: List[AgentSpec]) -> Team:
        """Create a team. Convenience wrapper around spawn x N."""

    def events(self) -> List[RunEvent]:
        """All recorded events so far. Surfaces to UI."""

    # Class-level reliability config (overridable per-call)
    DEFAULT_TIMEOUT_S = 180
    DEFAULT_MAX_RETRIES = 2
```

## 5. Writing a skill that uses the service

### Minimal: pattern skill (Research + Writer + QA)

```python
async def _pattern_processor(message, context, tools):
    swarm = AgentSwarm()

    team = swarm.assemble([
        AgentSpec(
            role="researcher",
            persona={
                "name": "Dr. Elena Vasquez",
                "background": "15 years technical analysis, pattern recognition specialist",
                "style": "rigorous, cites empirical pattern studies",
            },
            tools=["search_web", "fetch_url"],
        ),
        AgentSpec(
            role="writer",
            persona={
                "name": "Marcus Chen",
                "background": "quant developer, specialises in correlation-based pattern scripts",
                "style": "pragmatic, writes tight, well-commented JS",
            },
            tools=[],  # writer only synthesises; doesn't research
        ),
        AgentSpec(
            role="qa",
            persona={
                "name": "Dr. Sarah Kim",
                "background": "backtesting and script validation, skeptical",
                "style": "adversarial, tries to break the script",
            },
            tools=["run_indicator"],
        ),
    ])

    # First researcher investigates the pattern in depth
    research = await team.agents["researcher"].speak(
        context=f"User wants to detect: {message}",
        task=(
            "Research this pattern. What does it mean mathematically? "
            "What are known variations? What are common false-positive traps?"
        ),
    )

    # Then writer + qa loop: writer drafts, qa runs it, iterate up to 3x
    qa_result = await team.run_with_qa_loop(
        task=message,
        context=research.content,
        producer_role="writer",
        verifier_role="qa",
        max_iterations=3,
        spec=QASpec(
            acceptance_criteria=(
                f"Script must find 5-30 {message} patterns in the loaded "
                "data with confidence > 0.6 and no zero-duration matches."
            ),
            test_fn=run_pattern_script_and_count_matches,
            test_data=context.get("bars"),
        ),
    )

    # Record all agent activity on the run
    events = swarm.events()

    return SkillResponse(
        reply=f"{qa_result.final_artifact.content}\n\n_{len(events)} agent calls, {qa_result.iterations} QA iterations_",
        script=qa_result.final_artifact.structured["script"],
        script_type="pattern",
        tool_calls=[
            {"tool": "script_editor.load", "value": qa_result.final_artifact.structured["script"]},
            {"tool": "bottom_panel.activate_tab", "value": "pattern_analysis"},
        ],
        data={"agent_events": [asdict(e) for e in events]},
    )
```

### Strategy skill (bigger team)

```python
team = swarm.assemble([
    AgentSpec(role="risk_manager",   ..., tools=["run_indicator", "compute_levels"]),
    AgentSpec(role="portfolio_mgr",  ..., tools=["search_web"]),
    AgentSpec(role="script_writer",  ...),
    AgentSpec(role="qa_backtester",  ..., tools=["run_indicator"]),
])

# Risk + portfolio analyse in parallel
analysis = await team.run_parallel(
    task="Analyse conditions for mean-reversion on ETH, TP 3% SL 1.5%",
    context=market_summary,
)

# Writer synthesises both analyses into a script
draft_ctx = (
    f"Risk analysis: {analysis['risk_manager'].content}\n\n"
    f"Portfolio context: {analysis['portfolio_mgr'].content}"
)

# Writer + QA loop
qa = await team.run_with_qa_loop(
    task=message,
    context=draft_ctx,
    producer_role="script_writer",
    verifier_role="qa_backtester",
    max_iterations=3,
    spec=QASpec(
        acceptance_criteria=(
            "Strategy must produce at least 10 trades with win_rate > 40% "
            "and max_drawdown < 15% on the provided bars."
        ),
        test_fn=run_strategy_backtest,
        test_data={"bars": context["bars"], "config": context["strategy_config"]},
    ),
)
```

## 6. How `predict_analysis` uses it

The 5-stage debate pipeline still exists
(`core/engine/dag_orchestrator.py`), but internally it now calls
`AgentSwarm` for the parallelism primitives:

- **Stage 2** (persona generation) = `swarm.spawn()` 50 times
- **Stage 2.5** (iterative research) = each agent calls `Agent.use_tool("search_web", ...)` in a loop, with the swarm's rate limiter
- **Stage 3** (debate) = `team.discussion(rounds=30, speakers_per_round=15)`
- **Stage 4** (cross-exam) = `swarm.assemble([examiner])` + `Agent.speak` per divergent agent
- **Stage 5** (report) = single agent `speak()` + `_compute_consensus` math override

See [`PREDICT_ANALYSIS.md`](./PREDICT_ANALYSIS.md) for the
skill-specific flow.

## 7. Reliability (inherited by every skill)

The service handles, on behalf of every skill that uses it:

| Failure | Handled by | Result |
|---|---|---|
| Individual LLM call stalls | `llm_client.chat_completion` retry loop (2 retries, exp backoff) | Call eventually succeeds or raises |
| Individual agent times out | `Agent.speak` wrapped in `asyncio.wait_for(timeout_s=180)` | Agent marked as no-show, others continue |
| Whole team exceeds budget | `Team.run_parallel(timeout_s=...)` outer wait_for | Partial results returned, event logged |
| QA loop never converges | `max_iterations` cap | Final artifact returned with `qa.passed=False` + issues list |
| Tool call fails | `Agent.use_tool` try/except | `AgentResponse.tool_calls_made[tool_id] = "Error: ..."` |

Every failure produces a `RunEvent`:
```python
{"timestamp": "...", "level": "warn|error", "stage": "...",
 "agent_role": "...", "message": "..."}
```

The skill processor passes `swarm.events()` to its `SkillResponse`, and
they surface in the UI's Run Warnings banner / CLI Run Warnings panel.

## 8. Tools the agents can use

From `core/agents/swarm_tools.py`:

| Tool id | What it does | Rate limited? |
|---|---|---|
| `search_web` | DuckDuckGo search with multi-backend retry | Yes (global 0.5s interval) |
| `fetch_url` | Fetch + BeautifulSoup-extract text from a URL | No |
| `fetch_pdf` | Fetch + pypdf2-extract text from a PDF | No |
| `fetch_news` | `search_web` specialised for news queries | Yes |
| `fetch_policy` | `search_web` specialised for regulatory queries | Yes |
| `run_indicator` | Run a built-in indicator script against given bars | No |
| `compute_levels` | Extract support/resistance from bars | No |

Future (planned):
- `write_script(spec)` — drafts a JS pattern/strategy script
- `verify_script(script, bars, expected)` — runs a script, reports results
- `fetch_news_stream` — SSE-style live news feed
- `run_backtest(strategy, bars, config)` — server-side backtest

Each tool is just a `(args: dict) -> str` callable registered in a
global `TOOLS` dict in `swarm_tools.py`. Adding a new tool = define
the function + register.

## 9. Role → tool routing

`ROLE_TOOL_MAP` in `swarm_tools.py`:

```python
ROLE_TOOL_MAP: Dict[str, List[str]] = {
    # Research / analysis roles
    "technical":     ["run_indicator", "compute_levels"],
    "macro":         ["search_web", "fetch_news", "fetch_policy"],
    "quant":         ["run_indicator", "search_web"],
    "fundamental":   ["fetch_url", "fetch_pdf", "search_web"],
    "sentiment":     ["search_web", "fetch_news"],
    "geopolitical":  ["search_web", "fetch_news", "fetch_policy"],

    # Production roles (NEW)
    "script_writer": [],                        # synthesises only
    "risk_manager":  ["run_indicator", "compute_levels"],
    "portfolio_mgr": ["search_web"],
    "qa":            ["run_indicator", "compute_levels"],  # verifies
    "researcher":    ["search_web", "fetch_url", "fetch_pdf"],
}
```

An `AgentSpec` can override by passing `tools=[...]` explicitly.
Otherwise, `spawn()` looks up `ROLE_TOOL_MAP[spec.role]`.

## 10. Progress events vs RunEvents

Two different concerns:

- **Progress events** (what the user sees as the skill ticks through):
  emitted via `swarm.emit_progress("Running risk_manager...")` — the
  plan executor's sub-plan ticker picks these up.
- **Run events** (errors/warnings/timeouts): emitted via
  `swarm.events.append(RunEvent(...))` — surface after the run in Run
  Warnings.

Progress events are ephemeral and timing-driven; RunEvents are
permanent and persisted with the skill result.

## 11. Open design questions (decide before expanding integration)

1. **Agent memory across skill invocations** — should a `risk_manager`
   spawned by strategy skill today remember its outputs from last
   week? Current design: no, agents are ephemeral per-skill-call.
   A future "skill session memory" would enable continuity.

2. **Shared tool results cache** — if two agents in the same team
   search the same query, we run the web search twice. A per-team tool
   cache would save cost. Not critical yet.

3. **User-visible persona selection** — should the user be able to
   pick which risk_manager persona the strategy skill uses?
   Current design: persona is spec-defined by the skill author (hard-coded).

4. **Streaming intermediate agent outputs** — right now the skill
   waits for all agents to finish before returning. For long runs
   (50-agent debates), streaming "researcher said X" events to the UI
   would be a big UX win but requires SSE or WebSocket plumbing.

5. **QA loop failure policy** — when max_iterations hits with QA still
   failing, do we: (a) return the last artifact with a warning,
   (b) return a "couldn't verify" error, (c) fall back to a simpler
   prompt? Current plan: option (a).

See the Migration Guide in `ARCHITECTURE.md` § 11 for how to write a
skill against this API.
