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

from typing import Any, Awaitable, Callable, Dict

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
    """Generate a pattern / indicator / pine-convert script from the message."""
    result = _pattern.generate(message)

    script = result.get("script")
    script_type = result.get("script_type", "pattern")
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
        # script_editor.load loads the JS into the editor. View-switching is
        # handled by RightSidebar based on first-time-vs-edit — the tool
        # executor intentionally does NOT force view="code".
        tool_calls.append({"tool": "script_editor.load", "value": script})
        tool_calls.append({"tool": "bottom_panel.activate_tab", "value": "pattern_analysis"})

    return SkillResponse(
        reply=explanation,
        script=script,
        script_type=script_type,
        data=data,
        tool_calls=tool_calls,
    )


# ─── Strategy skill processor ────────────────────────────────────────────

async def _strategy_processor(
    message: str,
    context: Dict[str, Any],
    tools: ToolContext,
) -> SkillResponse:
    """Generate a strategy script from config, or analyze backtest results."""
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

    rows = result["metadata"]["rows"]
    src = result["source"]
    iv = result["interval"]

    return SkillResponse(
        reply=(
            f"Loaded **{rows}** bars of **{result['symbol']}** ({iv}) from `{src}`. "
            f"The chart has switched to the new dataset — you can now run pattern "
            f"detection or strategy backtests on it."
        ),
        data={"dataset": result},
        tool_calls=[
            {"tool": "data.dataset.add", "value": result},
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
    """
    from core.engine.dag_orchestrator import DebateOrchestrator
    from services.api.store import store

    dataset_id = context.get("dataset_id") or context.get("activeDataset")
    report = context.get("report", "") or message

    # Load bars from the backend store (synced by the frontend on dataset load)
    bars = None
    symbol = "Unknown"
    if dataset_id:
        df = store.get_dataframe(dataset_id)
        if df is not None and len(df) > 0:
            bars = df.tail(500).to_dict("records")
            meta = store.get_metadata(dataset_id)
            if meta:
                if isinstance(meta, dict):
                    symbol = meta.get("symbol") or meta.get("filename", "Unknown")
                elif hasattr(meta, "symbol") and meta.symbol:
                    symbol = meta.symbol

    # If no dataset or no bars, also check all datasets in the store
    if not bars:
        all_ds = store.list_datasets()
        if all_ds:
            # Use the most recently added dataset
            last_id = all_ds[-1] if isinstance(all_ds[-1], str) else all_ds[-1].get("id", "")
            df = store.get_dataframe(last_id)
            if df is not None and len(df) > 0:
                dataset_id = last_id
                bars = df.tail(500).to_dict("records")
                meta = store.get_metadata(last_id)
                if meta:
                    if isinstance(meta, dict):
                        symbol = meta.get("symbol") or meta.get("filename", "Unknown")
                    elif hasattr(meta, "symbol") and meta.symbol:
                        symbol = meta.symbol

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
        return SkillResponse(
            reply=f"Swarm debate failed: {exc}",
            tool_calls=[
                {"tool": "notify.toast", "value": {"level": "error", "message": f"Debate error: {exc}"}},
            ],
        )

    # Build summary text for the chat reply
    summary = result.get("summary", {})
    direction = summary.get("consensus_direction", "NEUTRAL")
    raw_confidence = summary.get("confidence", 0)
    confidence = round(raw_confidence * 100, 1) if raw_confidence <= 1.0 else round(min(raw_confidence, 100), 1)
    entities = result.get("entities", [])
    thread = result.get("thread", [])
    total_rounds = result.get("total_rounds", 0)
    price_targets = summary.get("price_targets", {})

    reply_parts = [
        f"**Swarm debate complete** — {len(entities)} personas, {total_rounds} rounds, {len(thread)} messages.",
        f"",
        f"**Consensus: {direction}** with {confidence:.0f}% confidence.",
    ]
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
        data={"debate": result},
        tool_calls=[
            {"tool": "simulation.set_debate", "value": result},
            {"tool": "bottom_panel.activate_tab", "value": "dag_graph"},
            {"tool": "notify.toast", "value": {"level": "info", "message": f"Swarm: {direction} ({confidence:.0f}%)"}},
        ],
    )


# ─── Registry ────────────────────────────────────────────────────────────

PROCESSORS: Dict[str, ProcessorFn] = {
    "pattern": _pattern_processor,
    "strategy": _strategy_processor,
    "data_fetcher": _data_fetcher_processor,
    "swarm_intelligence": _swarm_intelligence_processor,
}


def get_processor(skill_id: str) -> ProcessorFn | None:
    return PROCESSORS.get(skill_id)
