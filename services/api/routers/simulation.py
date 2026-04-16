"""
Simulation router.

Runs a bar-by-bar replay simulation using the core SimulationEngine,
and a multi-agent debate endpoint for the Simulation mode committee.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.engine.simulation_engine import SimulationEngine
from core.engine.dag_orchestrator import DebateOrchestrator
from services.api.models import SimulateRequest, SimulateResponse
from services.api.store import store

router = APIRouter(tags=["simulation"])


# ---------------------------------------------------------------------------
# Multi-Agent Debate models
# ---------------------------------------------------------------------------

class DebateRequest(BaseModel):
    dataset_id: str = Field(..., description="UUID of the uploaded dataset")
    bars_count: int = Field(default=100, ge=10, le=500)
    context: str = Field(default="", description="Research report text or user context to generate specialized agent personas")


# --- Response models for v2 social simulation ---

class EntityResponse(BaseModel):
    id: str
    name: str
    role: str
    background: str
    bias: str
    personality: str


class DiscussionMessageResponse(BaseModel):
    id: str
    round: int
    entity_id: str
    entity_name: str
    entity_role: str
    content: str
    sentiment: float
    price_prediction: Optional[float] = None
    agreed_with: List[str] = []
    disagreed_with: List[str] = []
    is_chart_support: bool = False


class SummaryResponse(BaseModel):
    consensus_direction: str
    confidence: float
    key_arguments: List[str]
    dissenting_views: List[str]
    price_targets: Dict[str, float]
    risk_factors: List[str]
    recommendation: Dict[str, Any]


class AssetInfoResponse(BaseModel):
    asset_class: str
    asset_name: str
    description: str
    price_drivers: List[str]


class DebateResponse(BaseModel):
    debate_id: str
    asset_info: AssetInfoResponse
    entities: List[EntityResponse]
    thread: List[DiscussionMessageResponse]
    total_rounds: int
    summary: SummaryResponse
    bars_analyzed: int
    symbol: str


# ---------------------------------------------------------------------------
# Debate endpoint (v2 — social simulation)
# ---------------------------------------------------------------------------

def _normalize_confidence(raw: float | int) -> float:
    """Normalize confidence to 0-100 scale. LLMs sometimes return 0.72 instead of 72."""
    val = float(raw)
    if val <= 1.0:
        # 0-1 scale → multiply to 0-100
        return round(val * 100, 1)
    return round(min(val, 100), 1)


def _sanitize_message(m: dict) -> dict:
    """Clean LLM-generated message fields so they pass Pydantic validation."""
    pp = m.get("price_prediction")
    if pp is not None:
        if isinstance(pp, str):
            # Handle ranges like "65000-70000" → take the midpoint
            pp = pp.replace(",", "").replace("$", "").strip()
            if "-" in pp and not pp.startswith("-"):
                parts = pp.split("-")
                try:
                    pp = (float(parts[0]) + float(parts[1])) / 2
                except (ValueError, IndexError):
                    pp = None
            else:
                try:
                    pp = float(pp)
                except ValueError:
                    pp = None
        elif not isinstance(pp, (int, float)):
            pp = None
    m = {**m, "price_prediction": pp}
    # Ensure list fields are actually lists
    for key in ("agreed_with", "disagreed_with"):
        v = m.get(key)
        if v is None:
            m[key] = []
        elif isinstance(v, str):
            m[key] = [v] if v else []
    return m


@router.post("/debate", response_model=DebateResponse)
async def run_debate(request: DebateRequest) -> DebateResponse:
    """Run the full social simulation: classify → generate entities → 5-round debate → summary."""
    df = store.get_dataframe(request.dataset_id)
    if df is None:
        raise HTTPException(status_code=404, detail=f"Dataset '{request.dataset_id}' not found.")

    tail = df.tail(request.bars_count)
    bars: List[Dict[str, Any]] = tail.to_dict("records")
    if not bars:
        raise HTTPException(status_code=422, detail="Dataset has no bars.")

    # Extract symbol from metadata
    raw_name = "Unknown"
    meta = store.get_metadata(request.dataset_id)
    if meta:
        if isinstance(meta, dict):
            raw_name = meta.get("symbol") or meta.get("filename", "Unknown")
        elif hasattr(meta, "symbol") and meta.symbol:
            raw_name = meta.symbol

    # Use the AssetClassifier (LLM) to decode the real asset name from the dataset name
    symbol = raw_name

    orchestrator = DebateOrchestrator()
    results = await orchestrator.run(bars, symbol, report_text=request.context or "")

    ai = results["asset_info"]
    return DebateResponse(
        debate_id=str(uuid.uuid4()),
        asset_info=AssetInfoResponse(
            asset_class=ai.get("asset_class", "unknown"),
            asset_name=ai.get("asset_name", symbol),
            description=ai.get("description", ""),
            price_drivers=ai.get("price_drivers", []),
        ),
        entities=[EntityResponse(**e) for e in results["entities"]],
        thread=[DiscussionMessageResponse(**_sanitize_message(m)) for m in results["thread"]],
        total_rounds=results["total_rounds"],
        summary=SummaryResponse(
            consensus_direction=results["summary"].get("consensus_direction", "NEUTRAL"),
            # Normalize confidence to 0-100 scale. The LLM may return 0.72
            # (0-1 scale) or 72 (0-100 scale) depending on the model.
            confidence=_normalize_confidence(results["summary"].get("confidence", 50)),
            key_arguments=results["summary"].get("key_arguments", []),
            dissenting_views=results["summary"].get("dissenting_views", []),
            price_targets=results["summary"].get("price_targets", {}),
            risk_factors=results["summary"].get("risk_factors", []),
            recommendation=results["summary"].get("recommendation", {}),
        ),
        bars_analyzed=len(bars),
        symbol=symbol,
    )


@router.post("/simulate", response_model=SimulateResponse)
async def simulate(request: SimulateRequest) -> SimulateResponse:
    """
    Run a bar-by-bar simulation of a strategy against a stored dataset.

    The strategy script must define a `strategy_fn` function with the
    signature: strategy_fn(bar_idx, bar, history_df, positions) -> list[dict].
    The speed parameter controls how many bars to advance per tick.
    """
    df = store.get_dataframe(request.dataset_id)
    if df is None:
        raise HTTPException(status_code=404, detail=f"Dataset '{request.dataset_id}' not found.")

    strategy = request.strategy

    try:
        strategy_fn = _compile_simulation_strategy(strategy.script)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Failed to compile simulation strategy: {exc}",
        )

    try:
        engine = SimulationEngine(
            df=df,
            initial_capital=strategy.initial_capital,
            bars_per_tick=request.speed,
        )
        result = engine.run(strategy_fn)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Simulation failed: {exc}",
        )

    # Convert ClosedTrade dataclass instances to dicts.
    trade_log: List[Dict[str, Any]] = []
    for trade in result.trade_log:
        trade_dict = asdict(trade)
        # Convert non-serializable time values to strings.
        if trade_dict.get("entry_time") is not None:
            trade_dict["entry_time"] = str(trade_dict["entry_time"])
        if trade_dict.get("exit_time") is not None:
            trade_dict["exit_time"] = str(trade_dict["exit_time"])
        trade_log.append(trade_dict)

    return SimulateResponse(
        total_pnl=result.total_pnl,
        total_trades=result.total_trades,
        bars_processed=result.bars_processed,
        equity_curve=result.equity_curve,
        trade_log=trade_log,
    )


def _compile_simulation_strategy(script: str):
    """
    Execute a strategy script and extract the strategy_fn function.

    The function must accept (bar_idx, bar, history_df, positions) and
    return a list of action dicts.

    Falls back to wrapping entry_condition/exit_condition if strategy_fn
    is not defined directly.
    """
    namespace: Dict[str, Any] = {}
    exec(script, namespace)  # noqa: S102

    # Prefer an explicitly defined strategy_fn.
    if "strategy_fn" in namespace and callable(namespace["strategy_fn"]):
        return namespace["strategy_fn"]

    # Fall back to wrapping entry_condition / exit_condition.
    entry_fn = namespace.get("entry_condition")
    exit_fn = namespace.get("exit_condition")

    if entry_fn is None or exit_fn is None:
        raise ValueError(
            "Strategy script must define either 'strategy_fn' or both "
            "'entry_condition' and 'exit_condition'."
        )

    def _wrapped_strategy(bar_idx, bar, history_df, positions):
        """Adapter that converts entry/exit condition functions into action dicts."""
        actions = []

        # Check exits on existing positions.
        for pos in positions:
            should_exit = exit_fn(bar_idx, bar, history_df, {}, pos)
            if should_exit:
                actions.append({"action": "close"})
                break  # Close one at a time (FIFO).

        # Check entry if no positions (simplified single-position logic).
        if not positions:
            signal = entry_fn(bar_idx, bar, history_df, {})
            if signal == "long":
                actions.append({"action": "buy", "size": 1.0})
            elif signal == "short":
                actions.append({"action": "sell", "size": 1.0})

        return actions

    return _wrapped_strategy
