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
    # dataset_id, deduplicate preserving order.
    dataset_ids: List[str] = []
    if isinstance(dataset_ids_ctx, list):
        dataset_ids = [str(i) for i in dataset_ids_ctx if isinstance(i, str) and i]
    if dataset_id and dataset_id not in dataset_ids:
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

    # Multi-chart reply annotation — tell the user the debate considered
    # all assets on their canvas, not just the primary ticker.
    portfolio_note = ""
    if len(loaded) > 1:
        others = ", ".join(s for (_, _, s) in loaded[1:])
        portfolio_note = (
            f" (portfolio debate on {symbol} with {len(loaded) - 1} "
            f"sibling asset{'s' if len(loaded) - 1 != 1 else ''}: {others})"
        )

    reply_parts = [
        f"**Swarm debate complete** — {len(entities)} personas, {total_rounds} rounds, {len(thread)} messages{portfolio_note}.",
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
        data={"debate": debate_payload},
        tool_calls=[
            {"tool": "simulation.set_debate", "value": debate_payload},
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
