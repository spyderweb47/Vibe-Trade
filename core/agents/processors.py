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
      mode == "analyze"  -> analyse pre-computed backtest metrics (legacy)
      mode == "generate" -> plan-first team flow (Risk + Portfolio + Writer + QA)
      opt-out            -> context.strategy_use_qa_team = False forces the
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
      Portfolio Manager optional) -> plan rendered in trace UI -> Risk and
      PM run first if included, feeding their analyses into the Writer's
      context -> Writer drafts the strategy script (uses
      STRATEGY_GENERATE_PROMPT) -> QA verifies via static analysis + LLM
      reasoning -> loop up to 3 iterations.

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
            # Plan first -> UI renders it before execution artefacts
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
    #   a) len(loaded) > 1 -> portfolio mode ran on N assets
    #   b) len(loaded) == 1 but len(dataset_ids) > 1 -> we were ASKED to
    #      include multiple but only 1 made it into the store. Say so
    #      loudly in the reply body so the user doesn't wonder why only
    #      one asset is mentioned.
    #   c) len(loaded) == 1 and len(dataset_ids) == 1 -> plain single-
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


# ─── Historic News skill processor ──────────────────────────────────────
#
# Research historic price-moving news events for the loaded asset and
# emit a structured event list the frontend renders as chart markers +
# a bottom-panel timeline. Uses the shared AgentSwarm service with a
# researcher + analyzer + QA team; optional Macro Researcher /
# Regulatory Researcher are added by the Team Planner when the asset
# class benefits from them.

# ─── Helpers for the historic_news skill ─────────────────────────────────


def _parse_news_intent(message: str, chart_symbol: str) -> Dict[str, Any]:
    """
    Parse the user's message into a structured intent.

    Examples:
      "fetch oil news on this chart"          -> topic="oil",  plot_symbol=chart_symbol, broadcast=False
      "plot AAPL news on the BTC chart"       -> topic="AAPL", plot_symbol="BTC",       broadcast=False
      "show macro news on all charts"         -> topic="macro", plot_symbol=None,        broadcast=True
      "find news for {chart_symbol}"          -> topic=chart_symbol, plot_symbol=chart_symbol, broadcast=False
      "" (empty)                              -> defaults: topic=chart_symbol, plot_symbol=chart_symbol

    Returns a dict with:
      topic (str)              — what to research news ABOUT
      plot_symbol (str|None)   — which chart's symbol to tag the events with
      broadcast (bool)         — if True, plot on every chart regardless of symbol
      categories (List[str])   — empty = all; else filter (e.g. ["earnings"])
    """
    low = (message or "").lower().strip()
    intent: Dict[str, Any] = {
        "topic": chart_symbol,
        "plot_symbol": chart_symbol,
        "broadcast": False,
        "categories": [],
    }

    # Words that LOOK like an asset ticker in a regex but really refer
    # to the current chart / all charts. When captured as plot_symbol,
    # we map them back to the right thing instead of using the literal.
    _SELF_REFS = {"this", "that", "the", "current", "active", "loaded", "my"}
    _ALL_REFS = {"all", "every", "any", "each", "both"}

    def _resolve_plot(captured: str) -> Optional[str]:
        c = captured.lower()
        if c in _SELF_REFS:
            return chart_symbol
        if c in _ALL_REFS:
            intent["broadcast"] = True
            return None
        return captured.upper()

    # Multi-chart intent — check FIRST so "on all charts" doesn't get
    # parsed as a per-chart target.
    if any(p in low for p in (
        "all charts", "every chart", "all open charts", "multiple charts",
        "across all", "on all", "broadcast", "every open chart",
    )):
        intent["broadcast"] = True
        intent["plot_symbol"] = None

    # Category filters — apply ALWAYS (additive on top of any topic
    # match below) so "earnings news for TSLA" sets both topic=TSLA
    # and categories=["earnings"].
    cat_keywords = {
        "earnings": ["earnings", "eps", "revenue report"],
        "regulatory": ["regulatory", "regulation", "sec ", "policy"],
        "macro": ["macro", "fed ", "fomc", "inflation", "cpi"],
        "product": ["product", "launch", "release"],
        "geopolitical": ["geopolitical", "war", "sanctions"],
    }
    for cat, kws in cat_keywords.items():
        if any(kw in low for kw in kws):
            intent["categories"].append(cat)

    # "X news on Y chart" — topic X, plot on Y
    import re as _re
    m = _re.search(
        r"(?:news|events)\s+(?:for|on|about)\s+([a-zA-Z][\w/\-=.]{0,12})\s+(?:on|to|in)\s+(?:the\s+)?([a-zA-Z][\w/\-=.]{0,12})\s+chart",
        low,
    )
    if m:
        intent["topic"] = m.group(1).upper()
        resolved = _resolve_plot(m.group(2))
        if resolved is not None or intent["broadcast"]:
            intent["plot_symbol"] = resolved
        return intent

    # "plot X news on Y" / "X news on Y" / "X news on Y chart"
    m = _re.search(
        r"(?:plot\s+)?([a-zA-Z][\w/\-=.]{0,12})\s+news\s+on\s+(?:the\s+)?([a-zA-Z][\w/\-=.]{0,12})",
        low,
    )
    if m:
        cand = m.group(1)
        if cand.lower() not in {*cat_keywords.keys(), "historic", "historical",
                                "the", "some", "any", "all", "more", "this"}:
            intent["topic"] = cand.upper()
        resolved = _resolve_plot(m.group(2))
        if resolved is not None or intent["broadcast"]:
            intent["plot_symbol"] = resolved
        return intent

    # "fetch X news" / "find X news" / "get news for X" / "X news"
    m = _re.search(
        r"(?:fetch|find|get|show|load|pull)\s+([a-zA-Z][\w/\-=.]{0,12})\s+news",
        low,
    )
    if m:
        cand = m.group(1)
        # Skip when the verb captured a category word like "earnings"
        # ("show earnings news") — we want topic=chart_symbol then.
        if cand.lower() not in {*cat_keywords.keys(), "historic", "historical",
                                "macro", "the", "some", "any", "all"}:
            intent["topic"] = cand.upper()
        return intent
    m = _re.search(r"news\s+(?:for|about|on)\s+([a-zA-Z][\w/\-=.]{0,12})", low)
    if m:
        cand = m.group(1)
        if cand.lower() not in _SELF_REFS:
            intent["topic"] = cand.upper()
        return intent

    return intent


def _build_news_query_set(
    topic: str,
    chart_lo_iso: str,
    chart_hi_iso: str,
    categories: List[str],
) -> List[str]:
    """
    Generate the search-query set for the real web_search calls.

    Without an LLM call: template-based covering broad event types,
    optionally filtered by user-requested categories. Returns 6-9
    queries — DDG is rate-limited so we keep it bounded.
    """
    range_clause = f"{chart_lo_iso}..{chart_hi_iso}" if chart_lo_iso and chart_hi_iso else "recent"
    base_queries = {
        "earnings":     [f"{topic} earnings report {range_clause}",
                         f"{topic} quarterly results revenue {range_clause}"],
        "regulatory":   [f"{topic} SEC regulation news {range_clause}",
                         f"{topic} regulatory ruling {range_clause}"],
        "macro":        [f"{topic} macroeconomic news fed rate {range_clause}",
                         f"{topic} inflation impact {range_clause}"],
        "product":      [f"{topic} product launch announcement {range_clause}",
                         f"{topic} new release feature {range_clause}"],
        "geopolitical": [f"{topic} geopolitical risk sanctions {range_clause}",
                         f"{topic} war supply chain disruption {range_clause}"],
        "sentiment":    [f"{topic} analyst rating upgrade downgrade {range_clause}",
                         f"{topic} institutional buying selling {range_clause}"],
    }

    if categories:
        # User asked for specific kinds of news — only those.
        out: List[str] = []
        for cat in categories:
            out.extend(base_queries.get(cat, []))
        return out[:9]

    # Default mix — one query per category, weighted toward earnings/macro
    mix: List[str] = []
    for cat in ("earnings", "regulatory", "macro", "product", "sentiment", "geopolitical"):
        mix.append(base_queries[cat][0])
    # Plus 2 broader catch-all queries so we don't miss the obvious headline
    mix.append(f"{topic} major news price moving event {range_clause}")
    mix.append(f"{topic} biggest news {range_clause}")
    return mix


def _run_real_research(
    queries: List[str],
    swarm,  # AgentSwarm — for event emission
    max_results_per_query: int = 6,
) -> str:
    """
    Actually invoke web_search for every query and assemble a findings
    document with REAL urls + snippets that the analyzer can extract
    structured events from.

    Without this step the agents hallucinate news (including fake URLs
    and dates) because Agent.speak() is just an LLM call — it never
    invokes the search_web tool no matter how many times we tell it
    to. This function bypasses that and feeds real search results to
    the downstream analyzer.
    """
    from core.agents.swarm_tools import web_search

    findings_blocks: List[str] = []
    for i, q in enumerate(queries, start=1):
        try:
            results = web_search(q, max_results=max_results_per_query)
        except Exception as exc:  # noqa: BLE001
            swarm._event(
                "warn", "historic_news",
                f"web_search failed for {q!r}: {type(exc).__name__}: {str(exc)[:120]}",
                "researcher",
            )
            continue
        if not results:
            swarm._event(
                "warn", "historic_news",
                f"web_search returned 0 results for {q!r}",
                "researcher",
            )
            continue

        block = [f"### Query {i}: {q}"]
        for r in results:
            title = (r.get("title") or "").strip()
            url = (r.get("url") or "").strip()
            snippet = (r.get("snippet") or "").strip()
            if not title and not snippet:
                continue
            block.append(f"- **{title}** ({url})\n  {snippet}")
        findings_blocks.append("\n".join(block))
        swarm._event(
            "info", "historic_news",
            f"query {i}/{len(queries)} returned {len(results)} results",
            "researcher",
        )
    return "\n\n".join(findings_blocks)


async def _historic_news_processor(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """
    Interactive historic-news research:
      1. Parse user intent — topic asset (defaults to chart's), target
         chart for plotting (defaults to chart's), broadcast flag,
         category filters
      2. Team Planner picks researcher roles
      3. Real web_search loop — actually invokes the tool for 6-9
         queries, returns real URLs/snippets (NOT hallucinated content)
      4. Analyzer + QA convert real findings into structured events
      5. Tool-call pushes events to the store with the right plot
         symbol (chart symbol, OR special "*" for broadcast mode)
      6. HistoricNewsTab + chart primitive render the markers
    """
    import json as _json
    from core.engine.agent_swarm import AgentSwarm
    from core.agents.base_agent import AgentSpec
    from core.agents.qa_agent import QASpec
    from core.agents.team_planner import TeamPlanner, RoleTemplate
    from services.api.store import store

    # Resolve asset from context (focused chart's dataset). Fallback
    # chain mirrors predict_analysis:
    #   1. context.dataset_id / context.activeDataset (plan executor
    #      wires these from the focused chart window)
    #   2. most recent dataset in the backend store (for direct skill
    #      invocations that bypass the plan executor, e.g. when the
    #      user selects Historic News from the skill picker and types
    #      a message without fetching new data)
    # The goal is: "plot on whatever chart is currently loaded". The
    # user shouldn't have to name the asset explicitly.
    dataset_id = context.get("dataset_id") or context.get("activeDataset")

    if not dataset_id:
        # No explicit id — take the last dataset in the store. This
        # matches the user's intent of "the chart I just loaded".
        try:
            all_ds = store.list_datasets()
            if all_ds:
                last = all_ds[-1]
                dataset_id = last if isinstance(last, str) else last.get("id")
        except Exception:  # noqa: BLE001
            pass

    symbol = "Unknown"
    date_range_hint = ""
    chart_lo_unix = 0          # earliest bar timestamp (unix seconds)
    chart_hi_unix = 0          # latest bar timestamp (unix seconds)
    chart_lo_iso = ""          # YYYY-MM-DD
    chart_hi_iso = ""          # YYYY-MM-DD
    if dataset_id:
        df = store.get_dataframe(dataset_id)
        if df is not None and len(df) > 0:
            meta = store.get_metadata(dataset_id)
            if meta:
                if isinstance(meta, dict):
                    symbol = meta.get("symbol") or meta.get("filename", symbol)
                elif hasattr(meta, "symbol") and meta.symbol:
                    symbol = meta.symbol
            try:
                chart_lo_unix = int(df.iloc[0]["time"])
                chart_hi_unix = int(df.iloc[-1]["time"])
                from datetime import datetime as _dt, timezone as _tz
                chart_lo_iso = _dt.fromtimestamp(chart_lo_unix, tz=_tz.utc).strftime("%Y-%m-%d")
                chart_hi_iso = _dt.fromtimestamp(chart_hi_unix, tz=_tz.utc).strftime("%Y-%m-%d")
                date_range_hint = f"{chart_lo_iso} to {chart_hi_iso}"
            except Exception:  # noqa: BLE001
                pass

    if symbol == "Unknown":
        return SkillResponse(
            reply=(
                "I need a dataset loaded on the chart before researching "
                "historic news. Ask me to fetch bars for a ticker first "
                "(e.g. 'fetch AAPL 1d for 2 years'), then try again."
            ),
            tool_calls=[
                {"tool": "notify.toast",
                 "value": {"level": "warning", "message": "Load a dataset first"}},
            ],
        )

    # ─── Parse user intent ────────────────────────────────────────────
    # Lets the user steer the swarm:
    #   "fetch oil news on this chart"             -> topic=OIL, plot=chart_symbol
    #   "plot AAPL news on the BTC chart"          -> topic=AAPL, plot=BTC
    #   "show macro news on all charts"            -> broadcast=True
    #   "earnings news for {chart_symbol}"         -> categories=["earnings"]
    intent = _parse_news_intent(message, chart_symbol=symbol)
    topic = intent["topic"]                       # what to RESEARCH
    plot_symbol = intent["plot_symbol"] or symbol # what symbol to TAG events with
    broadcast = bool(intent["broadcast"])
    if broadcast:
        # Special wildcard the frontend chart filter recognises as
        # "render on every chart regardless of symbol match".
        plot_symbol = "*"
    user_categories = intent.get("categories") or []

    # ─── Build a reusable date-constraint banner ──────────────────────
    # The previous prompts said "between {date_range_hint}" but the LLM
    # routinely ignored it and hallucinated events from training-data
    # years (2023, 2024) — the analyzer's events would then all get
    # filtered out by the chart-range guard. This banner is loud,
    # explicit, and reused in every prompt so the constraint is
    # impossible to miss.
    if chart_lo_unix > 0 and chart_hi_unix > 0:
        from datetime import datetime as _dt_b, timezone as _tz_b
        # Approximate target count: 1 event per ~10 days, clamped 12-30
        days_span = max(1, (chart_hi_unix - chart_lo_unix) // 86400)
        target_min = max(12, min(20, days_span // 14))
        target_max = max(target_min + 8, min(35, days_span // 7))
        date_constraint = (
            f"\n\n=== DATE CONSTRAINT (HARD RULE) ===\n"
            f"Every event MUST be dated between {chart_lo_iso} and {chart_hi_iso}.\n"
            f"Equivalent unix-second range: {chart_lo_unix} to {chart_hi_unix}.\n"
            f"Span: {days_span} days. Target {target_min}-{target_max} events.\n"
            f"\n"
            f"ANY event outside this range will be dropped from the output\n"
            f"and waste your research budget. Do NOT include events from\n"
            f"earlier or later periods even if they're famous — only events\n"
            f"that ACTUALLY happened in this window count.\n"
            f"\n"
            f"If you can't confirm an event's date is inside this window,\n"
            f"omit it. Quality timestamps over quantity guesses.\n"
            f"=== END DATE CONSTRAINT ===\n"
        )
    else:
        target_min, target_max = 15, 25
        date_constraint = (
            "\n\n=== DATE CONSTRAINT ===\n"
            "(Chart range unknown — focus on the most price-significant "
            "events for this asset across the last 1-2 years.)\n"
            "=== END DATE CONSTRAINT ===\n"
        )

    # ─── Phase 1: plan the team ──────────────────────────────────────
    planner = TeamPlanner()
    plan = planner.plan(
        skill_id="historic_news",
        user_message=f"Research historic news for {symbol}. {message}",
        templates=[
            RoleTemplate(
                role="researcher",
                description=(
                    "Queries the web for historic news events on the asset. "
                    "Uses search_web, fetch_news, fetch_url to pull article "
                    "snippets across the chart's date range. MANDATORY."
                ),
                persona_defaults={
                    "name": "News Researcher",
                    "background": "Financial-news librarian, 10 years pulling event archives for asset managers",
                    "style": "Systematic, covers multiple query angles, notes source reliability",
                },
                allowed_tools=["search_web", "fetch_news", "fetch_url"],
                mandatory=True,
                default_task=(
                    f"Find historic news events that moved {symbol}. "
                    f"Cover ALL major drivers: earnings, product launches, "
                    f"macro shocks, regulatory decisions, geopolitical events, "
                    f"analyst upgrades/downgrades, partnerships, lawsuits.\n\n"
                    f"Run AT LEAST 5-7 distinct search queries covering "
                    f"different periods within the date window and different "
                    f"event types. For each event found, capture the headline, "
                    f"the EXACT publish date, the source name, and a 2-3 "
                    f"sentence summary of what happened and how it affected "
                    f"the price.\n"
                    f"{date_constraint}"
                ),
            ),
            RoleTemplate(
                role="analyzer",
                description=(
                    "Parses the researcher's raw findings into a structured "
                    "JSON event list with timestamps, categories, direction "
                    "and impact ratings. MANDATORY."
                ),
                persona_defaults={
                    "name": "News Analyzer",
                    "background": "Quant, correlates news to price action",
                    "style": "Rigorous, assigns impact ratings based on price-reaction size",
                },
                allowed_tools=[],
                mandatory=True,
                default_task=(
                    "Convert the researcher's findings into a strict-JSON "
                    "event list. Each event MUST include timestamp (unix "
                    "seconds), headline, summary, source, category, impact, "
                    "direction."
                ),
            ),
            RoleTemplate(
                role="qa",
                description=(
                    "Reviews the analyzer's structured events. Drops "
                    "duplicates, flags timestamps outside the chart range, "
                    "rejects unsubstantiated claims without a source. "
                    "MANDATORY."
                ),
                persona_defaults={
                    "name": "News QA",
                    "background": "Editorial fact-checker",
                    "style": "Skeptical, demands credible sources + plausible timestamps",
                },
                allowed_tools=[],
                mandatory=True,
                default_task="Filter the event list for duplicates, invalid timestamps, and uncited claims",
            ),
            RoleTemplate(
                role="macro_researcher",
                description=(
                    "OPTIONAL. Add for commodities, currencies, indices — "
                    "assets where macro news dominates price action. "
                    "Covers Fed decisions, inflation prints, geopolitical events."
                ),
                persona_defaults={
                    "name": "Macro Researcher",
                    "background": "Macro strategist, follows central-bank and geopolitical news",
                    "style": "Top-down, connects asset moves to macro drivers",
                },
                allowed_tools=["search_web", "fetch_policy"],
                mandatory=False,
                default_task=(
                    f"Research macro events (Fed decisions, FOMC meetings, "
                    f"CPI prints, NFP reports, geopolitical shocks, central "
                    f"bank surprises) that moved {symbol}. Run 4-6 distinct "
                    f"searches covering different macro themes. Capture each "
                    f"event's exact date and source.\n"
                    f"{date_constraint}"
                ),
            ),
            RoleTemplate(
                role="regulatory_researcher",
                description=(
                    "OPTIONAL. Add for crypto, pharma, defense, or any asset "
                    "class with active policy considerations."
                ),
                persona_defaults={
                    "name": "Regulatory Researcher",
                    "background": "Policy analyst, tracks regulatory decisions + pending legislation",
                    "style": "Cites specific agencies, dockets, and bill numbers",
                },
                allowed_tools=["fetch_policy", "fetch_url", "search_web"],
                mandatory=False,
                default_task=(
                    f"Research regulatory decisions, agency actions, court "
                    f"rulings, and policy news affecting {symbol}. Cite "
                    f"specific agencies (SEC, FDA, EU, etc.), docket numbers, "
                    f"or bill numbers where possible. Run 4-6 distinct "
                    f"searches.\n"
                    f"{date_constraint}"
                ),
            ),
        ],
        default_execution_mode="sequential",  # researcher -> analyzer -> qa
    )

    plan_tool_calls = [
        {"tool": "swarm.team_plan.set", "value": plan.to_trace_payload()},
    ]

    # ─── Phase 2: execute researchers in parallel, then analyzer + qa ─
    swarm = AgentSwarm()
    specs = [
        AgentSpec(
            role=pa.role,
            persona=pa.persona,
            tools=pa.tools,
            temperature=0.3,
            max_tokens=2500,
        )
        for pa in plan.agents
    ]
    team = swarm.assemble(specs)

    # ─── Research phase — REAL web searches, not hallucinated ─────────
    # Previous version called agent.speak() for each researcher, which
    # is a single LLM call with no tool execution — the researchers'
    # "I have access to search_web" was informational only. Result:
    # 100% hallucinated articles, fake URLs, made-up dates.
    #
    # New flow:
    #   1. Build a query set from user intent + topic + date range +
    #      category filters. Template-based — no LLM call needed.
    #   2. ACTUALLY invoke web_search() for each query (with the
    #      existing rate limiter + retry + backend fallback).
    #   3. Aggregate real results (real URLs, real titles, real
    #      snippets) into a findings document.
    #   4. Analyzer extracts structured events FROM the real
    #      findings. URLs in the output are real because they came
    #      out of the search engine, not the LLM's training data.
    import asyncio
    queries = _build_news_query_set(topic, chart_lo_iso, chart_hi_iso, user_categories)
    swarm._event(
        "info", "historic_news",
        f"running {len(queries)} web searches for topic={topic!r}",
        "researcher",
    )
    real_findings = await asyncio.to_thread(
        _run_real_research, queries, swarm, 6,
    )

    if not real_findings.strip():
        return SkillResponse(
            reply=(
                f"**No web search results** for {topic} in {chart_lo_iso}..{chart_hi_iso}.\n\n"
                f"DuckDuckGo returned nothing for any of the {len(queries)} queries. "
                f"This usually means: (a) the search backend is rate-limiting us — "
                f"wait a minute and retry, (b) the topic+date combo is too narrow, "
                f"or (c) the network is blocked.\n\n"
                f"Tried queries:\n" + "\n".join(f"- {q}" for q in queries[:5])
            ),
            tool_calls=[
                {"tool": "notify.toast",
                 "value": {"level": "warning", "message": "No web search results"}},
            ],
            data={"events": [e for e in swarm.events()], "queries": queries},
        )

    # Build the analyzer's input. We include the real findings PLUS a
    # short context line so the analyzer knows what's expected.
    research_context = (
        f"Topic researched: {topic}\n"
        f"Plot symbol (chart asset): {symbol}\n"
        f"Chart date range: {date_range_hint or '(not provided)'}\n"
        f"User's original request: {message or '(default — historic news)'}\n"
    )
    analyzer_context = research_context + "\n\n## Real web search findings\n\n" + real_findings

    qa_result = await team.run_with_qa_loop(
        task=(
            f"Convert the researcher findings above into a strict-JSON "
            f"event list for {symbol}.\n"
            f"{date_constraint}\n"
            "**Output rules — read carefully:**\n"
            "1. Return ONLY raw JSON. NO markdown fences (```), NO preamble "
            "('Here is the JSON:'), NO postamble ('Hope this helps').\n"
            "2. The very first character of your response MUST be `{` and the "
            "very last character MUST be `}`.\n"
            "3. `timestamp` MUST be an integer in unix SECONDS within the "
            f"range above ({chart_lo_unix}-{chart_hi_unix}). NOT "
            f"milliseconds, NOT a date string.\n"
            "4. Drop any event where you can't determine a precise date.\n"
            "5. Drop any event without a credible named source.\n"
            f"6. Aim for {target_min}-{target_max} events spread evenly "
            f"across the date window. Cluster around earnings calendar "
            f"dates and known macro events.\n"
            "7. **NEVER invent URLs.** Use the EXACT url from the search "
            "result you're extracting from. If the result has no URL, set "
            'url to null — do NOT make one up like '
            '\"https://reuters.com/markets/...\". Hallucinated URLs are '
            "the #1 way this skill loses user trust.\n"
            "8. Use the EXACT headline from the search result. Don't "
            "rewrite or summarise it — copy it verbatim.\n\n"
            "**Required shape (copy this skeleton exactly):**\n"
            "{\n"
            '  "events": [\n'
            "    {\n"
            f'      "timestamp": {chart_lo_unix or 1704067200},\n'
            '      "headline": "Apple beats Q1 earnings estimates",\n'
            '      "summary": "Apple reported Q1 FY2024 EPS of $2.18 vs $2.10 expected, '
            'with iPhone revenue down 0.6% YoY but Services up 11.3%.",\n'
            '      "source": "Reuters",\n'
            '      "url": "https://example.com/article",\n'
            '      "category": "earnings",\n'
            '      "impact": "high",\n'
            '      "direction": "bullish",\n'
            '      "price_impact_pct": 2.4\n'
            "    }\n"
            "  ],\n"
            '  "summary": "One-paragraph overview of the news landscape across the chart range.",\n'
            '  "key_themes": ["AI strategy", "China demand", "Services growth"]\n'
            "}\n\n"
            "**Allowed values:**\n"
            '- category: "earnings" | "regulatory" | "macro" | "product" | '
            '"sentiment" | "geopolitical" | "technical"\n'
            '- impact: "high" | "medium" | "low"\n'
            '- direction: "bullish" | "bearish" | "neutral"\n\n'
            f"Asset: {symbol}. Chart range: {date_range_hint or '(unknown)'}."
        ),
        context=analyzer_context,
        producer_role="analyzer",
        verifier_role="qa",
        max_iterations=2,
        spec=QASpec(
            acceptance_criteria=(
                f"Each event MUST satisfy ALL of:\n"
                f"1. timestamp is an integer in the range "
                f"{chart_lo_unix}-{chart_hi_unix} (inclusive). REJECT any "
                f"event whose unix timestamp is outside this window.\n"
                f"2. credible named source (e.g. 'Reuters', 'Bloomberg', "
                f"'WSJ' — NOT 'multiple outlets' or 'various reports').\n"
                f"3. non-empty headline.\n"
                f"4. category is one of: earnings|regulatory|macro|product|"
                f"sentiment|geopolitical|technical.\n"
                f"5. no duplicates (same event with different timestamps "
                f"or wording).\n"
                f"6. event count >= {target_min}. If under {target_min}, "
                f"the producer needs to add more events from the research "
                f"findings.\n"
                f"Date window for reference: {chart_lo_iso} to {chart_hi_iso}."
            ),
        ),
    )

    # Parse the final artifact. Analyzer was instructed to return
    # strict JSON, but real LLM output frequently has preamble text,
    # markdown fences with various spacing, or both. Be liberal:
    #   1. Strip ```json / ``` fences if present
    #   2. If the result still doesn't parse, search for the first
    #      balanced { ... } block and try that
    raw_content = qa_result.final_artifact.content or ""
    cleaned = raw_content.strip()

    # Strip code fences (```json ... ```, ``` ... ```)
    if cleaned.startswith("```"):
        nl = cleaned.index("\n") if "\n" in cleaned else len(cleaned)
        cleaned = cleaned[nl + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()

    def _extract_json_object(text: str) -> str | None:
        """
        Scan for the first balanced {...} or [...] block. Tolerates
        preamble like 'Here is the JSON:\n\n{...}\n\nHope this helps.'
        Returns the substring or None if no balanced block found.
        """
        for opener, closer in (("{", "}"), ("[", "]")):
            start = text.find(opener)
            if start < 0:
                continue
            depth = 0
            in_str = False
            esc = False
            for i in range(start, len(text)):
                ch = text[i]
                if esc:
                    esc = False
                    continue
                if ch == "\\":
                    esc = True
                    continue
                if ch == '"':
                    in_str = not in_str
                    continue
                if in_str:
                    continue
                if ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        return text[start:i + 1]
            # unbalanced — fall through to next opener
        return None

    def _coerce_timestamp(v: Any) -> int:
        """Accept unix seconds (int/float/str-of-int) OR ISO date string."""
        if isinstance(v, (int, float)):
            n = int(v)
            # If the LLM gave us milliseconds, scale down
            if n > 10**12:
                n //= 1000
            return n
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return 0
            # Plain integer string
            if s.lstrip("-").isdigit():
                n = int(s)
                if n > 10**12:
                    n //= 1000
                return n
            # ISO date — try to parse
            try:
                from datetime import datetime as _dt
                # Accept "2024-01-15", "2024-01-15T10:30:00", "2024-01-15T10:30:00Z"
                s2 = s.replace("Z", "+00:00")
                dt = _dt.fromisoformat(s2) if "T" in s2 or "+" in s2 or len(s2) > 10 else _dt.strptime(s2, "%Y-%m-%d")
                return int(dt.timestamp())
            except (ValueError, ImportError):
                return 0
        return 0

    # Bounds for the "is this timestamp inside the chart range" filter.
    # Allow a 14-day buffer on either side so pre-market news and
    # slightly-after-close aftershocks still land on the chart.
    chart_min_ts = 0
    chart_max_ts = 10**12
    if dataset_id:
        df_bounds = store.get_dataframe(dataset_id)
        if df_bounds is not None and len(df_bounds) > 0:
            try:
                chart_min_ts = int(df_bounds.iloc[0]["time"]) - 14 * 86400
                chart_max_ts = int(df_bounds.iloc[-1]["time"]) + 14 * 86400
            except Exception:  # noqa: BLE001
                pass

    events: List[Dict[str, Any]] = []
    overview_summary = ""
    key_themes: List[str] = []
    parse_error: str | None = None
    parsed: Any = None
    raw_event_count = 0           # how many events the analyzer produced
    dropped_out_of_range = 0      # how many were filtered by chart range
    dropped_no_timestamp = 0      # how many had unparseable timestamps

    # First attempt: parse as-is (post fence-strip)
    try:
        parsed = _json.loads(cleaned)
    except (_json.JSONDecodeError, ValueError) as exc:
        parse_error = str(exc)
        # Second attempt: extract first balanced JSON block (tolerates
        # preamble/postamble text)
        block = _extract_json_object(cleaned)
        if block:
            try:
                parsed = _json.loads(block)
                parse_error = None  # second attempt succeeded
            except (_json.JSONDecodeError, ValueError) as exc2:
                parse_error = f"after-extract: {exc2}"

    # Some models return [..., ...] directly (the events array) instead
    # of {"events": [...]}. Wrap for uniform handling.
    if isinstance(parsed, list):
        parsed = {"events": parsed}

    if isinstance(parsed, dict):
        raw_events = parsed.get("events") or []
        # Some models nest one level deeper, e.g. {"data": {"events": [...]}}
        if not raw_events and isinstance(parsed.get("data"), dict):
            raw_events = parsed["data"].get("events") or []
        if isinstance(raw_events, list):
            raw_event_count = sum(1 for e in raw_events if isinstance(e, dict))
            for e in raw_events:
                if not isinstance(e, dict):
                    continue
                ts = _coerce_timestamp(e.get("timestamp") or e.get("date") or e.get("time"))
                if ts <= 0:
                    dropped_no_timestamp += 1
                    continue
                # Drop events whose timestamp is outside the chart
                # range — plotting them would be invisible anyway
                # and they're usually LLM hallucinations about
                # events the asset wasn't tradable for yet.
                if ts < chart_min_ts or ts > chart_max_ts:
                    dropped_out_of_range += 1
                    continue
                # price_impact_pct may arrive as int, float, str, or
                # be missing entirely — coerce defensively.
                pip_raw = e.get("price_impact_pct") if "price_impact_pct" in e else e.get("priceImpactPct")
                pip_val: float | None = None
                if isinstance(pip_raw, (int, float)):
                    pip_val = float(pip_raw)
                elif isinstance(pip_raw, str):
                    s = pip_raw.replace("%", "").strip()
                    try:
                        pip_val = float(s) if s else None
                    except ValueError:
                        pip_val = None

                events.append({
                    "id": f"ne_{ts}_{len(events)}",
                    "timestamp": ts,
                    "headline": str(e.get("headline") or e.get("title") or "").strip(),
                    "summary": str(e.get("summary") or e.get("description") or "").strip(),
                    "source": str(e.get("source") or "").strip(),
                    "url": str(e.get("url") or e.get("link") or "").strip() or None,
                    "category": str(e.get("category") or "sentiment").strip().lower() or "sentiment",
                    "impact": str(e.get("impact") or "medium").strip().lower() or "medium",
                    "direction": str(e.get("direction") or "neutral").strip().lower() or "neutral",
                    "price_impact_pct": pip_val,
                })
            if dropped_out_of_range:
                swarm._event(
                    "warn", "historic_news",
                    f"dropped {dropped_out_of_range} event(s) outside chart range "
                    f"({chart_min_ts}..{chart_max_ts})",
                    "analyzer",
                )
        overview_summary = str(parsed.get("summary") or "").strip()
        key_themes = [str(t) for t in (parsed.get("key_themes") or parsed.get("keyThemes") or []) if t]

    if not events:
        # Distinguish the four real failure modes so the user can act:
        #   A. JSON didn't parse at all                    -> re-run usually fixes
        #   B. JSON parsed but events list missing/empty   -> analyzer found nothing
        #   C. JSON parsed but every ts outside chart      -> load wider chart data
        #   D. JSON parsed but every ts unparseable        -> prompt issue
        preview = raw_content.strip()[:600] or "(empty)"
        from datetime import datetime as _dt2, timezone as _tz2
        try:
            chart_lo_str = _dt2.fromtimestamp(chart_min_ts, tz=_tz2.utc).strftime("%Y-%m-%d") if chart_min_ts > 0 else "(open)"
            chart_hi_str = _dt2.fromtimestamp(chart_max_ts, tz=_tz2.utc).strftime("%Y-%m-%d") if chart_max_ts < 10**12 else "(open)"
        except (OverflowError, ValueError):
            chart_lo_str, chart_hi_str = "?", "?"

        if parse_error:
            why = f"JSON parse failed: {parse_error}"
            user_hint = "The model returned prose where JSON was expected. Try re-running."
        elif parsed is None:
            why = "Analyzer returned no parseable content"
            user_hint = "Try re-running — the LLM may have produced an empty response."
        elif not isinstance(parsed, dict):
            why = f"Analyzer returned a {type(parsed).__name__}, expected an object"
            user_hint = "Try re-running."
        elif raw_event_count == 0:
            why = "Analyzer returned valid JSON but no events"
            user_hint = (
                "The researchers may not have surfaced anything material for this "
                "asset/period, or the analyzer judged everything as too weak to "
                "include. Try a different timeframe or be more specific in your "
                "request."
            )
        elif dropped_out_of_range == raw_event_count:
            why = (
                f"All {raw_event_count} event(s) had timestamps outside the chart "
                f"range ({chart_lo_str} -> {chart_hi_str}, +/-14d buffer)"
            )
            user_hint = (
                f"The analyzer found events but they're all outside your chart's "
                f"date range. Either the chart shows too narrow a window, or the "
                f"analyzer mis-dated the events. Try loading a wider date range "
                f"with `data_fetcher` (e.g. 'fetch {symbol} 1d for 5 years')."
            )
        elif dropped_no_timestamp == raw_event_count:
            why = f"All {raw_event_count} event(s) had unparseable timestamps"
            user_hint = "Try re-running — the LLM dated the events in an unrecognised format."
        else:
            why = (
                f"All {raw_event_count} event(s) were filtered out — "
                f"{dropped_out_of_range} outside chart range "
                f"({chart_lo_str} -> {chart_hi_str}), "
                f"{dropped_no_timestamp} with bad timestamps"
            )
            user_hint = "Mixed filtering issue — see counts above."

        swarm._event("error", "historic_news", f"{why}. Raw: {preview!r}", "analyzer")
        return SkillResponse(
            reply=(
                f"**Couldn't extract news events for {symbol}.**\n\n"
                f"_{why}._\n\n"
                f"{user_hint}\n\n"
                f"Analyzer's raw output (first 600 chars):\n\n"
                f"```\n{preview}\n```"
            ),
            tool_calls=[*plan_tool_calls,
                {"tool": "notify.toast",
                 "value": {"level": "warning", "message": "No structured events — see chat for details"}},
            ],
            data={
                "raw_findings": findings,
                "raw_event_count": raw_event_count,
                "dropped_out_of_range": dropped_out_of_range,
                "dropped_no_timestamp": dropped_no_timestamp,
                "chart_range": [chart_min_ts, chart_max_ts],
                "events": [e for e in swarm.events()],
            },
        )

    # Sort by timestamp descending (newest first) for the UI timeline
    events.sort(key=lambda e: e["timestamp"], reverse=True)

    # Build the reply
    by_category: Dict[str, int] = {}
    for e in events:
        by_category[e["category"]] = by_category.get(e["category"], 0) + 1
    category_breakdown = ", ".join(f"{k}:{v}" for k, v in by_category.items())
    # Build header that reflects user's intent — "X news on Y chart"
    # phrasing when they differ.
    if broadcast:
        header = (
            f"**Found {len(events)} {topic} news events** "
            f"({category_breakdown}) — plotted on **all open charts**."
        )
    elif topic.upper() != symbol.upper():
        header = (
            f"**Found {len(events)} {topic} news events** "
            f"({category_breakdown}) — plotted on the **{symbol}** chart."
        )
    else:
        header = (
            f"**Found {len(events)} historic news events** for **{symbol}** "
            f"({category_breakdown})."
        )
    reply_parts = [header]
    if overview_summary:
        reply_parts.extend(["", overview_summary])
    if key_themes:
        reply_parts.extend(["", "**Key themes:**"])
        for t in key_themes[:5]:
            reply_parts.append(f"- {t}")
    reply_parts.append("")
    reply_parts.append(
        "_Markers plotted on the chart — click an event in the Historic "
        "News tab to zoom the chart and read the full summary._"
    )

    toast_message = (
        f"Loaded {len(events)} {topic} news events"
        + (f" on all charts" if broadcast else f" for {symbol}")
    )

    return SkillResponse(
        reply="\n".join(reply_parts),
        data={
            "symbol": symbol,
            "topic": topic,
            "plot_symbol": plot_symbol,
            "broadcast": broadcast,
            "categories": user_categories,
            "events_count": len(events),
            "key_themes": key_themes,
            "summary": overview_summary,
            "queries": queries,
            "agent_events": [
                {"timestamp": ev.timestamp, "level": ev.level, "stage": ev.stage,
                 "message": ev.message, "agent_role": ev.agent_role}
                for ev in swarm.events()
            ],
        },
        tool_calls=[
            *plan_tool_calls,
            # plot_symbol is "*" in broadcast mode so the chart filter
            # renders markers on every open chart regardless of asset.
            {"tool": "news.events.set", "value": {"symbol": plot_symbol, "events": events}},
            {"tool": "bottom_panel.activate_tab", "value": "historic_news"},
            {"tool": "notify.toast",
             "value": {"level": "info", "message": toast_message}},
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
    "historic_news": _historic_news_processor,
    # Backward-compat alias — old skill id routes to the new processor
    "swarm_intelligence": _predict_analysis_processor,
}


def get_processor(skill_id: str) -> ProcessorFn | None:
    return PROCESSORS.get(skill_id)
