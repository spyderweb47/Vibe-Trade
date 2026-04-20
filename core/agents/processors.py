"""
Skill processors — Python logic that runs when a skill is dispatched.

A **processor** is an async function `(message, context, tools) -> SkillResponse`
that is invoked by `VibeTrade.dispatch(skill_id, ...)` when the user sends a
chat message routed to `skill_id`.

Processors live here — NOT inside the skill's folder — so that:
  - `skills/*/SKILL.md` files stay pure documentation
  - Python code stays in one place, easy to review + test
  - Adding a new skill = add SKILL.md + add one entry here

To wire a new skill:
  1. Drop `skills/<id>/SKILL.md` with the skill's metadata + instructions
  2. Write an `async def _<id>_processor(message, context, tools)` below
  3. Register it in the `PROCESSORS` dict at the bottom

If a skill has no processor registered, `VibeTrade.dispatch` raises — so
either register one or use the planned LLM-fallback path (not yet shipped).
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, List

from core.agents.pattern_agent import PatternAgent
from core.agents.strategy_agent import StrategyAgent
from core.data.fetcher import fetch as fetch_market_data, parse_query
from core.skill_types import SkillResponse, ToolContext


# Underlying agents — instantiated once, reused across dispatches.
_pattern = PatternAgent()
_strategy = StrategyAgent()


# ─── Pattern skill processor ─────────────────────────────────────────────

async def _pattern_processor(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Generate a pattern / indicator / pine-convert script.

    Path A (team + QA loop) — used for standard pattern requests:
      Writer agent drafts a JS pattern-detection script using the
      existing battle-tested PATTERN_SYSTEM_PROMPT, then a QA agent
      statically analyses it for common LLM mistakes (forbidden APIs,
      missing return, hardcoded confidence, over-strict thresholds).
      If the QA verdict is "fail", the writer reflects and iterates,
      up to 3 times.

    Legacy path — used for `indicator` and `pine_convert` requests:
      Single LLM call via PatternAgent.generate(). No QA loop — the
      indicator-generation prompt is stable enough that the extra
      verification round doesn't improve quality and would delay the
      response unnecessarily.

    Opt-out: set `context.pattern_use_qa_team = False` to force the
    legacy single-call path for a specific request.
    """
    # Decide path
    script_type = _pattern._detect_type(message)
    use_team = context.get("pattern_use_qa_team", True) and script_type == "pattern"

    if not use_team:
        return await _pattern_processor_legacy(message, script_type, context, tools)

    return await _pattern_processor_with_team(message, context, tools)


async def _pattern_processor_legacy(
    message: str,
    script_type: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """Original single-call path — kept for indicator/pine_convert and
    explicit opt-out via `context.pattern_use_qa_team = False`."""
    result = _pattern.generate(message)

    script = result.get("script")
    script_type = result.get("script_type", script_type)
    explanation = result.get("explanation", "")

    data: Dict[str, Any] = {
        "parameters": result.get("parameters", {}),
        "indicators_used": result.get("indicators_used", []),
    }
    if script_type == "indicator":
        data["default_params"] = result.get("default_params", {})
        data["indicator_name"] = result.get("indicator_name", "Custom")

    tool_calls = []
    if script:
        tool_calls.append({"tool": "script_editor.load", "value": script})
        tool_calls.append({"tool": "bottom_panel.activate_tab", "value": "pattern_analysis"})

    return SkillResponse(
        reply=explanation,
        script=script,
        script_type=script_type,
        data=data,
        tool_calls=tool_calls,
    )


async def _pattern_processor_with_team(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Plan-first team-based pattern generation:

      1. TeamPlanner decides which agents to spawn (Writer + QA are
         mandatory; Researcher is added if the user's request needs
         domain research).
      2. Plan is emitted as a `swarm.team_plan.set` tool_call so the
         frontend trace UI can render it BEFORE execution starts.
      3. AgentSwarm assembles the team from the plan.
      4. Team runs via Team.run_with_qa_loop with the producer/verifier
         roles the planner picked.

    This is the first skill to use the plan-first flow — the pattern
    for every other skill to follow.
    """
    # Late imports so agent_swarm stays a leaf dependency
    from core.engine.agent_swarm import AgentSwarm
    from core.agents.base_agent import AgentSpec
    from core.agents.qa_agent import QASpec
    from core.agents.team_planner import TeamPlanner, RoleTemplate
    from core.agents.pattern_agent import (
        PATTERN_SYSTEM_PROMPT,
        PATTERN_QA_CRITERIA,
        static_analyse_pattern_script,
        _strip_code_fences,
    )

    # ─── Phase 1: plan the team ──────────────────────────────────────
    planner = TeamPlanner()
    plan = planner.plan(
        skill_id="pattern",
        user_message=message,
        templates=[
            RoleTemplate(
                role="writer",
                description=(
                    "Drafts the JavaScript pattern-detection script using the "
                    "standard Vibe Trade pattern API (results array, for loop, "
                    "return results). MANDATORY."
                ),
                persona_defaults={
                    "name": "Pattern Writer",
                    "background": "Quant pattern-detection engineer, 10 years writing"
                                  " JS scripts for chart anomaly detection",
                    "style": "Precise, concise, follows forgiving-threshold conventions",
                },
                allowed_tools=[],
                mandatory=True,
                default_task="Draft a JavaScript pattern-detection script for the user's request",
            ),
            RoleTemplate(
                role="qa",
                description=(
                    "Reviews the writer's script for correctness, adherence to "
                    "the sandbox API, forgiving thresholds, and no hardcoded "
                    "confidence=1.0. Blocks promotion until acceptance criteria "
                    "are met. MANDATORY."
                ),
                persona_defaults={
                    "name": "Script QA Reviewer",
                    "background": "Senior code reviewer, skeptical about edge cases"
                                  " and silent-failure conditions",
                    "style": "Adversarial — tries to catch bugs the writer would miss",
                },
                allowed_tools=[],
                mandatory=True,
                default_task="Verify the writer's script meets the pattern-skill acceptance criteria",
            ),
            RoleTemplate(
                role="researcher",
                description=(
                    "OPTIONAL. Add this when the user's pattern request is unusual "
                    "(academic patterns, rare harmonics, niche wyckoff phases) "
                    "and would benefit from looking up the pattern's definition or "
                    "visual signature. Has `search_web` and `fetch_url` to pull "
                    "from trading literature. Skip for classic well-known patterns."
                ),
                persona_defaults={
                    "name": "Pattern Researcher",
                    "background": "Technical-analysis historian, references pattern studies",
                    "style": "Rigorous, cites sources, explains mathematical signatures",
                },
                allowed_tools=["search_web", "fetch_url"],
                mandatory=False,
                default_task="Research the pattern's definition and mathematical signature",
            ),
        ],
        default_execution_mode="qa_loop",
    )

    # ─── Phase 2: emit plan as a trace tool_call ─────────────────────
    # The frontend tool 'swarm.team_plan.set' (to be wired in the
    # toolRegistry) renders this as a dedicated trace sub-message so the
    # user sees the team BEFORE the run starts. Having it as a tool_call
    # means it flows through the same channel as other UI updates.
    plan_tool_calls = [
        {"tool": "swarm.team_plan.set", "value": plan.to_trace_payload()},
    ]

    # ─── Phase 3: assemble + execute ─────────────────────────────────
    swarm = AgentSwarm()
    specs = []
    for pa in plan.agents:
        # Writer gets the PATTERN_SYSTEM_PROMPT override so it uses our
        # battle-tested prompt. Other roles use the base_agent default
        # (persona-derived) prompt.
        system_prompt = PATTERN_SYSTEM_PROMPT if pa.role == "writer" else None
        specs.append(AgentSpec(
            role=pa.role,
            persona=pa.persona,
            system_prompt=system_prompt,
            tools=pa.tools,
            temperature=0.3 if pa.role == "writer" else 0.2,
            max_tokens=1800 if pa.role == "writer" else 1200,
        ))
    team = swarm.assemble(specs)

    # Pre-execution: let the researcher run first if it was included so
    # the writer gets its findings as additional context.
    #
    # NOTE: we deliberately DON'T call team.run_parallel here — that
    # would fire EVERY agent in the team (writer + qa + researcher) on
    # the researcher's task, wasting 2 unnecessary LLM calls. Instead
    # we invoke just the researcher's speak() directly via a bounded
    # asyncio.wait_for.
    writer_context = ""
    researcher_agent = team.agents.get("researcher")
    if researcher_agent is not None:
        researcher_task = next(
            (a.task for a in plan.agents if a.role == "researcher"),
            "Research this pattern",
        )
        import asyncio
        try:
            r_resp = await asyncio.wait_for(
                asyncio.to_thread(
                    researcher_agent.speak,
                    f"User request: {message}",
                    researcher_task,
                ),
                timeout=90.0,
            )
            if r_resp.content and not r_resp.error:
                writer_context = f"## Prior research\n{r_resp.content}\n\n"
        except asyncio.TimeoutError:
            swarm._event(
                "warn", "pattern_pre_exec",
                "researcher timed out — writer will proceed without its input",
                "researcher",
            )

    # QA loop driven by the plan's chosen producer/verifier
    producer = plan.qa_producer or "writer"
    verifier = plan.qa_verifier or "qa"

    qa_result = await team.run_with_qa_loop(
        task=message,
        context=writer_context,
        producer_role=producer,
        verifier_role=verifier,
        max_iterations=plan.qa_max_iterations,
        spec=QASpec(
            acceptance_criteria=PATTERN_QA_CRITERIA,
            test_fn=static_analyse_pattern_script,
            test_data=None,
        ),
    )

    script = _strip_code_fences(qa_result.final_artifact.content or "")

    # If the writer actually errored out (LLM unavailable, etc.), fall
    # back to the legacy path so the user still gets SOMETHING.
    if not script or qa_result.final_reason in ("producer_failed", "producer_reflect_failed"):
        print(
            f"[pattern.team] writer failed ({qa_result.final_reason}) — "
            f"falling back to legacy path",
            flush=True,
        )
        return await _pattern_processor_legacy(message, "pattern", context, tools)

    # Build an explanation — one more small LLM call so the chat reply
    # reads as the final finished artefact, not a QA dump.
    try:
        from core.agents.llm_client import chat_completion
        explanation = chat_completion(
            system_prompt=(
                "You are a trading analyst. Explain the following JavaScript "
                "pattern-detection script in 2-3 sentences. What does it "
                "compute and how?"
            ),
            user_message=script,
            temperature=0.3,
            max_tokens=300,
        ).strip()
    except Exception:  # noqa: BLE001
        explanation = "Pattern detection script generated and QA'd."

    data: Dict[str, Any] = {
        "parameters": _pattern._extract_parameters(script),
        "indicators_used": _pattern._extract_indicators(script),
        # Surface the QA trail so the UI / CLI can show "verified in 2 iterations"
        "qa_passed": qa_result.passed,
        "qa_iterations": qa_result.iterations,
        "qa_final_reason": qa_result.final_reason,
        "events": [
            {"timestamp": e.timestamp, "level": e.level, "stage": e.stage,
             "message": e.message, "agent_role": e.agent_role}
            for e in swarm.events()
        ],
    }

    # QA status note in the reply so the user knows what happened behind
    # the scenes without having to open a diagnostics tab.
    qa_note = (
        f"\n\n_✓ QA-verified in {qa_result.iterations} iteration(s)._"
        if qa_result.passed
        else (
            f"\n\n_⚠ QA review ran but didn't fully pass after "
            f"{qa_result.iterations} iteration(s) — using best attempt. "
            f"Reason: {qa_result.final_reason}._"
        )
    )

    return SkillResponse(
        reply=explanation + qa_note,
        script=script,
        script_type="pattern",
        data=data,
        tool_calls=[
            # Plan-first: team plan goes out first so the UI renders
            # it above the execution artefacts (script, panel switch).
            *plan_tool_calls,
            {"tool": "script_editor.load", "value": script},
            {"tool": "bottom_panel.activate_tab", "value": "pattern_analysis"},
        ],
    )


# ─── Strategy skill processor ────────────────────────────────────────────

async def _strategy_processor(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Dispatcher for strategy requests:
      mode == "analyze"  → analyse pre-computed backtest metrics (legacy)
      mode == "generate" → plan-first team flow (Risk + Portfolio + Writer + QA)
      opt-out            → context.strategy_use_qa_team = False forces the
                           original single-call path even for generate mode
    """
    mode = context.get("mode", "generate")

    if mode == "analyze":
        return await _strategy_processor_legacy(message, context, tools)

    use_team = context.get("strategy_use_qa_team", True)
    if not use_team:
        return await _strategy_processor_legacy(message, context, tools)

    return await _strategy_processor_with_team(message, context, tools)


async def _strategy_processor_legacy(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """Original single-call path. Kept for analyze mode and explicit opt-out."""
    mode = context.get("mode", "generate")
    strategy_config = context.get("strategy_config") or {}

    if mode == "analyze":
        metrics = context.get("analyze_results") or {}
        result = _strategy.analyze_results(strategy_config, metrics)
        return SkillResponse(
            reply=result.get("analysis", ""),
            script=None,
            script_type="strategy",
            data={"suggestions": result.get("suggestions", [])},
            tool_calls=[],
        )

    # Default: generate-from-config mode
    result = _strategy.generate_from_config(strategy_config)
    script = result.get("script")
    tool_calls = []
    if script:
        tool_calls.append({"tool": "script_editor.load", "value": script})
        tool_calls.append({"tool": "bottom_panel.activate_tab", "value": "portfolio"})

    return SkillResponse(
        reply=result.get("explanation", "Strategy generated."),
        script=script,
        script_type="strategy",
        data={"config": strategy_config},
        tool_calls=tool_calls,
    )


async def _strategy_processor_with_team(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Plan-first team-based strategy generation:
      TeamPlanner picks the team (Writer + QA mandatory; Risk Manager and
      Portfolio Manager optional) → plan rendered in trace UI → Risk and
      PM run first if included, feeding their analyses into the Writer's
      context → Writer drafts the strategy script (uses
      STRATEGY_GENERATE_PROMPT) → QA verifies via static analysis + LLM
      reasoning → loop up to 3 iterations.

    On LLM/fixer failure, gracefully falls back to the legacy single-call
    path so the user always gets a script.
    """
    # Late imports — keep agent_swarm a leaf dependency of processors
    import json as _json
    from core.engine.agent_swarm import AgentSwarm
    from core.agents.base_agent import AgentSpec
    from core.agents.qa_agent import QASpec
    from core.agents.team_planner import TeamPlanner, RoleTemplate
    from core.agents.strategy_agent import (
        STRATEGY_GENERATE_PROMPT,
        STRATEGY_QA_CRITERIA,
        static_analyse_strategy_script,
    )

    strategy_config = context.get("strategy_config") or {}

    # The writer's prompt needs the structured config rendered into
    # STRATEGY_GENERATE_PROMPT's placeholders. We do this once up-front
    # so the writer's system_prompt is fully baked — matches how the
    # pattern writer uses PATTERN_SYSTEM_PROMPT directly.
    tp = strategy_config.get("takeProfit", {}) or {}
    sl = strategy_config.get("stopLoss", {}) or {}
    writer_system_prompt = STRATEGY_GENERATE_PROMPT.format(
        entry_condition=strategy_config.get("entryCondition", ""),
        exit_condition=strategy_config.get("exitCondition", ""),
        tp_type=tp.get("type", "percentage"),
        tp_value=tp.get("value", 5),
        sl_type=sl.get("type", "percentage"),
        sl_value=sl.get("value", 2),
        max_drawdown=strategy_config.get("maxDrawdown", 20),
        seed_amount=strategy_config.get("seedAmount", 10000),
        special=strategy_config.get("specialInstructions", "None"),
    )

    # ─── Phase 1: plan the team ──────────────────────────────────────
    planner = TeamPlanner()
    plan = planner.plan(
        skill_id="strategy",
        user_message=message or _json.dumps(strategy_config),
        templates=[
            RoleTemplate(
                role="writer",
                description=(
                    "Drafts the JavaScript strategy/backtest script using "
                    "the Vibe Trade strategy API (trades[] + equity[] + "
                    "return). MANDATORY."
                ),
                persona_defaults={
                    "name": "Strategy Writer",
                    "background": "Quant developer, specialises in concise backtest scripts",
                    "style": "Precise, defines all indicators inline, bounds-checks every array access",
                },
                allowed_tools=[],
                mandatory=True,
                default_task=(
                    "Draft a JavaScript backtest script that implements the "
                    "user's strategy config with proper equity tracking and "
                    "bounds-checked indicator helpers"
                ),
            ),
            RoleTemplate(
                role="qa",
                description=(
                    "Reviews the writer's script for sandbox compliance, "
                    "equity-updated-every-bar, config respected, trade "
                    "shape, and achievable entry conditions. Blocks "
                    "promotion until acceptance criteria are met. MANDATORY."
                ),
                persona_defaults={
                    "name": "Backtest QA Reviewer",
                    "background": "Senior quant, tears backtests apart looking for silent bugs",
                    "style": "Adversarial — flags scripts that will produce 0 trades on real data",
                },
                allowed_tools=[],
                mandatory=True,
                default_task="Verify the strategy script meets the acceptance criteria",
            ),
            RoleTemplate(
                role="risk_manager",
                description=(
                    "OPTIONAL. Add when the user's request has non-trivial "
                    "risk parameters (leverage, aggressive DD limits, short "
                    "selling) or asks for a risk-aware strategy. Analyses "
                    "the config's TP/SL/DD ratios for soundness and suggests "
                    "adjustments if the risk-reward is poor."
                ),
                persona_defaults={
                    "name": "Risk Manager",
                    "background": "Prop-trading risk desk, 10+ years, obsessed with drawdown",
                    "style": "Conservative, cites R-multiples and expected value",
                },
                allowed_tools=["run_indicator", "compute_levels"],
                mandatory=False,
                default_task=(
                    "Analyse the strategy config's risk profile (TP/SL ratio, "
                    "max drawdown, implied win-rate needed for profitability) "
                    "and recommend adjustments if the risk is mis-calibrated"
                ),
            ),
            RoleTemplate(
                role="portfolio_mgr",
                description=(
                    "OPTIONAL. Add when the user's request references market "
                    "conditions, regime, or asset-specific context ('work on "
                    "crypto bear markets', 'only in trending regimes'). "
                    "Considers whether the strategy makes sense for the "
                    "asset class and current environment."
                ),
                persona_defaults={
                    "name": "Portfolio Manager",
                    "background": "Multi-asset PM, considers correlation + regime",
                    "style": "Top-down, connects asset behaviour to strategy choice",
                },
                allowed_tools=["search_web"],
                mandatory=False,
                default_task=(
                    "Consider whether the proposed strategy suits the current "
                    "asset / regime, and flag mis-matches"
                ),
            ),
        ],
        default_execution_mode="qa_loop",
    )

    # ─── Phase 2: emit plan as trace tool_call ───────────────────────
    plan_tool_calls = [
        {"tool": "swarm.team_plan.set", "value": plan.to_trace_payload()},
    ]

    # ─── Phase 3: assemble + execute ─────────────────────────────────
    swarm = AgentSwarm()
    specs = []
    for pa in plan.agents:
        system_prompt = writer_system_prompt if pa.role == "writer" else None
        specs.append(AgentSpec(
            role=pa.role,
            persona=pa.persona,
            system_prompt=system_prompt,
            tools=pa.tools,
            temperature=0.3 if pa.role == "writer" else 0.2,
            max_tokens=2500 if pa.role == "writer" else 1200,
        ))
    team = swarm.assemble(specs)

    # Pre-execution: risk + portfolio managers run first if planned,
    # feed their analyses into the writer's context. Run in parallel
    # since they're independent.
    pre_agents = [a.role for a in plan.agents if a.role in ("risk_manager", "portfolio_mgr")]
    pre_agent_tasks: Dict[str, str] = {
        a.role: a.task for a in plan.agents if a.role in pre_agents
    }
    writer_context_parts: List[str] = []
    if pre_agents:
        # Create a small sub-team just for the pre-run so run_parallel
        # only runs these agents (not the writer/qa that come later).
        sub_specs = [s for s in specs if s.role in pre_agents]
        sub_team = swarm.assemble(sub_specs)
        # run_parallel uses the same task for all — but we want each
        # agent's own task. Run them individually and gather.
        pre_results: Dict[str, Any] = {}
        for role in pre_agents:
            agent = sub_team.agents.get(role)
            if agent is None:
                continue
            import asyncio
            try:
                resp = await asyncio.wait_for(
                    asyncio.to_thread(
                        agent.speak,
                        f"User request: {message}\n\nConfig: {_json.dumps(strategy_config)}",
                        pre_agent_tasks.get(role, "Analyse this strategy"),
                    ),
                    timeout=120.0,
                )
                pre_results[role] = resp
            except asyncio.TimeoutError:
                swarm._event(
                    "warn", "strategy_pre_exec",
                    f"{role} timed out — writer will proceed without its input",
                    role,
                )
        for role, resp in pre_results.items():
            if resp.content:
                label = {
                    "risk_manager": "Risk analysis",
                    "portfolio_mgr": "Portfolio context",
                }.get(role, role)
                writer_context_parts.append(f"## {label}\n{resp.content}")

    writer_context = (
        "\n\n".join(writer_context_parts)
        + (f"\n\n## Config\n{_json.dumps(strategy_config, indent=2)}" if writer_context_parts
           else f"## Config\n{_json.dumps(strategy_config, indent=2)}")
    )

    producer = plan.qa_producer or "writer"
    verifier = plan.qa_verifier or "qa"

    qa_result = await team.run_with_qa_loop(
        task="Generate the strategy script now. Include all indicator functions inline.",
        context=writer_context,
        producer_role=producer,
        verifier_role=verifier,
        max_iterations=plan.qa_max_iterations,
        spec=QASpec(
            acceptance_criteria=STRATEGY_QA_CRITERIA,
            test_fn=static_analyse_strategy_script,
            test_data=None,
        ),
    )

    # Strip code fences from writer output
    script = (qa_result.final_artifact.content or "").strip()
    if script.startswith("```"):
        nl = script.index("\n") if "\n" in script else len(script)
        script = script[nl + 1:]
        if script.endswith("```"):
            script = script[:-3]
        script = script.strip()

    # Graceful fallback: if the writer totally failed, fall through to
    # the legacy single-call path so the user still gets SOMETHING.
    if not script or qa_result.final_reason in ("producer_failed", "producer_reflect_failed"):
        print(
            f"[strategy.team] writer failed ({qa_result.final_reason}) — "
            f"falling back to legacy path",
            flush=True,
        )
        return await _strategy_processor_legacy(message, context, tools)

    qa_note = (
        f"\n\n_✓ QA-verified in {qa_result.iterations} iteration(s)._"
        if qa_result.passed
        else (
            f"\n\n_⚠ QA review didn't fully pass after "
            f"{qa_result.iterations} iteration(s) — using best attempt. "
            f"Reason: {qa_result.final_reason}._"
        )
    )

    data: Dict[str, Any] = {
        "config": strategy_config,
        "qa_passed": qa_result.passed,
        "qa_iterations": qa_result.iterations,
        "qa_final_reason": qa_result.final_reason,
        "events": [
            {"timestamp": e.timestamp, "level": e.level, "stage": e.stage,
             "message": e.message, "agent_role": e.agent_role}
            for e in swarm.events()
        ],
    }

    reply = (
        "Strategy script generated from your configuration via a "
        f"{len(plan.agents)}-agent team."
        + qa_note
    )

    return SkillResponse(
        reply=reply,
        script=script,
        script_type="strategy",
        data=data,
        tool_calls=[
            # Plan first → UI renders it before execution artefacts
            *plan_tool_calls,
            {"tool": "script_editor.load", "value": script},
            {"tool": "bottom_panel.activate_tab", "value": "portfolio"},
        ],
    )


ProcessorFn = Callable[[str, Dict[str, Any], ToolContext], Awaitable[SkillResponse]]


# ─── Data Fetcher skill processor ────────────────────────────────────────


async def _data_fetcher_processor(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Pull historical OHLC bars from yfinance / ccxt and return tool_calls
    that load them onto the chart.

    Uses the regex-based query parser in `core.data.fetcher` to extract the
    symbol / interval / limit from the user's natural-language request.
    """
    parsed = parse_query(message)
    symbol = parsed.get("symbol")
    if not symbol:
        return SkillResponse(
            reply=(
                "I couldn't find a ticker or pair in your message. Try "
                "something like 'Fetch BTC/USDT 1h' or 'Get AAPL daily 2 years'."
            ),
            tool_calls=[],
        )

    interval = parsed.get("interval", "1d")
    limit = int(parsed.get("limit", 1000))
    source = parsed.get("source", "auto")

    try:
        result = fetch_market_data(
            symbol=symbol,
            source=source,
            interval=interval,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        return SkillResponse(
            reply=f"Failed to fetch {symbol}: {exc}",
            tool_calls=[
                {"tool": "notify.toast", "value": {"level": "error", "message": f"Fetch failed: {exc}"}},
            ],
        )

    # Persist the fetched bars into the backend's in-memory store
    # IMMEDIATELY, using a backend-generated dataset_id that's embedded
    # in the response. This eliminates the race where a subsequent
    # skill call (e.g. swarm_intelligence) hits `/chat` before the
    # frontend has finished posting the dataset via /datasets/sync, and
    # the backend processor can't find the data so it bails with
    # "I need market data loaded on the chart".
    #
    # The frontend's data.dataset.add executor now uses the id from
    # the payload (falling back to generating one only when absent)
    # so both sides agree on the dataset id.
    import uuid as _uuid
    import pandas as _pd
    from services.api.store import store

    dataset_id = str(_uuid.uuid4())
    try:
        df = _pd.DataFrame(result["bars"])
        store.save_dataset(dataset_id, df, {
            "symbol": result.get("symbol"),
            "source": result.get("source"),
            "interval": result.get("interval"),
            **(result.get("metadata") or {}),
        })
    except Exception as exc:  # noqa: BLE001
        # Non-fatal — frontend will still try to sync via the legacy
        # path; log so we can debug if it recurs.
        print(f"[data_fetcher] warning: failed to save bars to backend store: {exc}", flush=True)

    # Echo the id back in the result so the frontend's data.dataset.add
    # executor can use it instead of generating its own.
    result_with_id = {**result, "dataset_id": dataset_id}

    rows = result["metadata"]["rows"]
    src = result["source"]
    iv = result["interval"]

    return SkillResponse(
        reply=(
            f"Loaded **{rows}** bars of **{result['symbol']}** ({iv}) from `{src}`. "
            f"The chart has switched to the new dataset — you can now run pattern "
            f"detection or strategy backtests on it."
        ),
        data={"dataset": result_with_id},
        tool_calls=[
            {"tool": "data.dataset.add", "value": result_with_id},
            {"tool": "chart.set_timeframe", "value": iv},
            {
                "tool": "notify.toast",
                "value": {"level": "info", "message": f"Loaded {rows} bars of {result['symbol']}"},
            },
        ],
    )


# ─── Swarm Intelligence skill processor ─────────────────────────────────


async def _swarm_intelligence_processor(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Run a multi-agent debate on the active dataset.

    Delegates to the existing debate pipeline via DebateOrchestrator.
    Loads bars from the backend's in-memory store (same as the /debate
    endpoint) — the frontend only needs to pass the dataset_id.

    Multi-chart mode: if `dataset_ids` is provided (list of >1), the
    primary asset (first id) drives the technical analysis while the
    other assets are included as portfolio context in `report_text`
    so the debate considers them as comparables / alternatives /
    hedges. Single-chart mode is unchanged.
    """
    from core.engine.dag_orchestrator import DebateOrchestrator
    from services.api.store import store

    dataset_id = context.get("dataset_id") or context.get("activeDataset")
    dataset_ids_ctx = context.get("dataset_ids")
    report = context.get("report", "") or message

    # Normalize dataset_ids: accept list, fall back to the single
    # dataset_id. ALWAYS put the focused dataset (dataset_id /
    # activeDataset) at index 0 — it's the "primary" asset whose
    # technicals drive Stage 1 / Stage 3. Without this the processor
    # was running the full pipeline on whichever chart happened to be
    # fetched first instead of whichever chart the user had selected,
    # which made the output feel like it ignored the other chart.
    dataset_ids: List[str] = []
    if isinstance(dataset_ids_ctx, list):
        dataset_ids = [str(i) for i in dataset_ids_ctx if isinstance(i, str) and i]
    if dataset_id:
        # Remove any existing occurrence and prepend — so the focused
        # chart is always the primary regardless of fetch order.
        dataset_ids = [i for i in dataset_ids if i != dataset_id]
        dataset_ids.insert(0, dataset_id)

    # Helper: load (bars, symbol) for one dataset id. Returns (None, fallback)
    # when the id isn't in the store.
    def _load_dataset(dsid: str) -> tuple:
        df = store.get_dataframe(dsid)
        if df is None or len(df) == 0:
            return None, "Unknown"
        bars_ = df.tail(500).to_dict("records")
        sym_ = "Unknown"
        meta = store.get_metadata(dsid)
        if meta:
            if isinstance(meta, dict):
                sym_ = meta.get("symbol") or meta.get("filename", "Unknown")
            elif hasattr(meta, "symbol") and meta.symbol:
                sym_ = meta.symbol
        return bars_, sym_

    # Load each dataset. Skip any that aren't actually in the store,
    # and remember which ones were missing so we can tell the user
    # clearly rather than silently falling back.
    loaded: List[tuple] = []  # [(dataset_id, bars, symbol), ...]
    missing: List[str] = []
    for dsid in dataset_ids:
        b, s = _load_dataset(dsid)
        if b:
            loaded.append((dsid, b, s))
        else:
            missing.append(dsid)

    # Fall back to "most recent dataset in store" when nothing we were
    # asked to load actually exists (e.g. user cleared state).
    if not loaded:
        all_ds = store.list_datasets()
        if all_ds:
            last_id = all_ds[-1] if isinstance(all_ds[-1], str) else all_ds[-1].get("id", "")
            b, s = _load_dataset(last_id)
            if b:
                loaded.append((last_id, b, s))

    # If we were asked to include multiple datasets and SOME of them
    # weren't in the backend store, keep going with what we have but
    # let the user know exactly what happened — they'll otherwise see
    # "portfolio debate on BTC with 1 sibling" and wonder why SOL
    # didn't get included. The event surfaces in the UI's Run Warnings
    # banner + the CLI Run Warnings panel.
    missing_warning: str | None = None
    if missing and loaded:
        missing_warning = (
            f"{len(missing)} requested dataset(s) weren't available in the "
            f"backend store — likely a sync race; those assets were excluded "
            f"from the portfolio debate."
        )

    # Primary asset drives the main technical analysis.
    if loaded:
        dataset_id, bars, symbol = loaded[0]
    else:
        bars = None
        symbol = "Unknown"

    # If we have multiple datasets, build a portfolio context summary
    # that gets injected into the orchestrator's report_text. The
    # debate then considers the primary asset with awareness of the
    # portfolio siblings (e.g. "ETH is up 8% over the same window,
    # strengthens the rotation-away-from-BTC thesis").
    if len(loaded) > 1:
        from core.agents.simulation_agents import format_ohlc_summary
        portfolio_lines = [
            "## Portfolio context (other assets on the canvas):",
        ]
        for dsid, pbars, psym in loaded[1:]:
            try:
                portfolio_lines.append(format_ohlc_summary(pbars, psym, "Raw"))
            except Exception:  # noqa: BLE001
                portfolio_lines.append(f"- {psym}: {len(pbars)} bars available")
        portfolio_block = "\n".join(portfolio_lines)
        report = (report + "\n\n" + portfolio_block).strip() if report else portfolio_block

    if not bars:
        return SkillResponse(
            reply=(
                "I need market data loaded on the chart before running a swarm debate. "
                "Use the Data Fetcher skill to load a dataset first, then try again."
            ),
            tool_calls=[
                {"tool": "notify.toast", "value": {"level": "warning", "message": "Load a dataset first"}},
            ],
        )

    try:
        orchestrator = DebateOrchestrator()
        result = await orchestrator.run(
            bars=bars,
            symbol=symbol,
            report_text=report,
        )
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        # Surface accumulated events so the UI can show what happened up to
        # the crash even on total-failure paths.
        partial_events = list(orchestrator.run_events) if 'orchestrator' in locals() else []
        return SkillResponse(
            reply=f"Swarm debate failed: {exc}",
            tool_calls=[
                {"tool": "notify.toast", "value": {"level": "error", "message": f"Debate error: {exc}"}},
            ],
            data={"error": str(exc), "events": partial_events},
        )

    # Wrap the orchestrator's raw dict with the top-level identity fields
    # the frontend toolRegistry's `simulation.set_debate` expects. Without
    # these, the UI falls back to a timestamp-based id and an empty symbol
    # string — which in turn breaks the RunStatsTab header, the PDF export
    # filename, and the snapshotting that preserves the debate across
    # conversation switches. This matches the shape the /debate endpoint
    # produces via its Pydantic DebateResponse projection.
    import uuid as _uuid
    # Prepend the missing-dataset warning (if any) to the run events so
    # the UI's Run Warnings banner lists it alongside any events the
    # orchestrator itself recorded.
    existing_events = list(result.get("events") or [])
    if missing_warning:
        import time as _time
        existing_events.insert(0, {
            "timestamp": _time.strftime("%Y-%m-%dT%H:%M:%S"),
            "level": "warn",
            "stage": "setup",
            "message": missing_warning,
        })
    debate_payload = {
        "debate_id": str(_uuid.uuid4()),
        "symbol": symbol,
        "bars_analyzed": len(bars),
        **result,
        "events": existing_events,
    }

    # Build summary text for the chat reply
    summary = result.get("summary", {})
    direction = summary.get("consensus_direction", "NEUTRAL")
    raw_confidence = summary.get("confidence", 0)
    confidence = round(raw_confidence * 100, 1) if raw_confidence <= 1.0 else round(min(raw_confidence, 100), 1)
    entities = result.get("entities", [])
    thread = result.get("thread", [])
    total_rounds = result.get("total_rounds", 0)
    price_targets = summary.get("price_targets", {})

    # Multi-chart reply annotation. Three cases:
    #   a) len(loaded) > 1 → portfolio mode ran on N assets
    #   b) len(loaded) == 1 but len(dataset_ids) > 1 → we were ASKED to
    #      include multiple but only 1 made it into the store. Say so
    #      loudly in the reply body so the user doesn't wonder why only
    #      one asset is mentioned.
    #   c) len(loaded) == 1 and len(dataset_ids) == 1 → plain single-
    #      chart debate, no annotation.
    portfolio_note = ""
    if len(loaded) > 1:
        others = ", ".join(s for (_, _, s) in loaded[1:])
        portfolio_note = (
            f" (portfolio debate on {symbol} with {len(loaded) - 1} "
            f"sibling asset{'s' if len(loaded) - 1 != 1 else ''}: {others})"
        )

    # Header line (first in reply_parts)
    reply_header = (
        f"**Swarm debate complete** — {len(entities)} personas, "
        f"{total_rounds} rounds, {len(thread)} messages{portfolio_note}."
    )

    reply_parts = [reply_header, ""]

    # Case (b): requested multi-chart but only primary loaded — print a
    # prominent note at the TOP of the reply body so it's unmissable.
    if len(loaded) == 1 and len(dataset_ids) > 1:
        missed_count = len(dataset_ids) - 1
        reply_parts.append(
            f"> ⚠️ Ran on **{symbol}** only. {missed_count} other chart"
            f"{'s' if missed_count != 1 else ''} on the canvas were skipped "
            f"because they weren't available in the backend store yet "
            f"(likely a sync race). Re-run and they should be included; if "
            f"it persists, check the Run Warnings tab."
        )
        reply_parts.append("")

    reply_parts.append(f"**Consensus: {direction}** with {confidence:.0f}% confidence.")
    if price_targets:
        low = price_targets.get("low", "?")
        mid = price_targets.get("mid", "?")
        high = price_targets.get("high", "?")
        reply_parts.append(f"Price targets: low {low}, mid {mid}, high {high}.")

    key_args = summary.get("key_arguments", [])
    if key_args:
        reply_parts.append("")
        reply_parts.append("**Key arguments:**")
        for arg in key_args[:3]:
            reply_parts.append(f"- {arg}")

    return SkillResponse(
        reply="\n".join(reply_parts),
        data={"debate": debate_payload},
        tool_calls=[
            {"tool": "simulation.set_debate", "value": debate_payload},
            {"tool": "bottom_panel.activate_tab", "value": "dag_graph"},
            {"tool": "notify.toast", "value": {"level": "info", "message": f"Swarm: {direction} ({confidence:.0f}%)"}},
        ],
    )


# ─── Registry ────────────────────────────────────────────────────────────
#
# The predict_analysis skill is the renamed swarm_intelligence — it's
# one skill among others that uses the shared Agent Swarm Service (with
# the largest team). The old id is kept as an alias so saved plans,
# frontend code, and existing conversations keep routing.

# Primary (new) name
_predict_analysis_processor = _swarm_intelligence_processor

PROCESSORS: Dict[str, ProcessorFn] = {
    "pattern": _pattern_processor,
    "strategy": _strategy_processor,
    "data_fetcher": _data_fetcher_processor,
    "predict_analysis": _predict_analysis_processor,
    # Backward-compat alias — old skill id routes to the new processor
    "swarm_intelligence": _predict_analysis_processor,
}


def get_processor(skill_id: str) -> ProcessorFn | None:
    return PROCESSORS.get(skill_id)
