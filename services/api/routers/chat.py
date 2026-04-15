"""
Chat router.

Provides a conversational interface to the trading agents.
Routes messages to the appropriate agent based on the active mode.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.agents.llm_client import chat_completion, is_available as llm_available
from core.agents.backtest_agent import BacktestAgent
from core.agents.vibe_trade_agent import vibe_trade

router = APIRouter(tags=["chat"])


class ChatRequest(BaseModel):
    """Chat message from the user."""
    message: str = Field(..., min_length=1)
    mode: str = Field(default="pattern", description="Active skill id: pattern, strategy, backtest, simulation")
    context: dict = Field(default_factory=dict, description="Additional context (dataset_id, script, etc.)")


class ChatResponse(BaseModel):
    """Chat response from the agent."""
    reply: str
    script: str | None = None
    script_type: str | None = None  # "pattern" or "indicator"
    data: dict | None = None
    tool_calls: list[dict] = Field(default_factory=list)


# Backtest agent retained as-is (not yet converted to a skill).
_backtest_agent = BacktestAgent()


CHAT_SYSTEM_PROMPT = """You are a helpful trading AI assistant. You help users:
- Detect patterns in OHLC price data
- Build trading strategies
- Configure and interpret backtests
- Understand market micro-structure

Be concise and practical. If the user describes a pattern or strategy idea,
explain what you would generate and ask for confirmation. If the user asks
a general trading question, answer directly.

Keep responses under 3-4 sentences unless more detail is needed."""


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    """
    Send a message to the trading AI agent.

    Routes to the appropriate agent based on the active mode.
    Returns a reply and optionally a generated script.
    """
    mode = req.mode
    message = req.message
    context = req.context

    try:
        if mode == "pattern":
            return await _handle_pattern(message, context)
        elif mode == "strategy":
            return await _handle_strategy(message, context)
        elif mode == "backtest":
            return await _handle_backtest(message, context)
        elif mode == "simulation":
            return _handle_simulation(message)
        # Any other mode: if it matches a registered skill, dispatch through
        # vibe_trade. This keeps the router from hard-coding every new skill.
        elif vibe_trade.get_skill(mode) is not None:
            response = await vibe_trade.dispatch(mode, message, context)
            return _skill_response_to_chat(response)
        else:
            # No specific skill active. First try the built-in planner —
            # if the message looks multi-step, vibe_trade will decompose it
            # and run the steps in order. If it doesn't look multi-step (or
            # the planner can't build a plan), we fall through to general
            # LLM chat.
            plan_response = await vibe_trade.try_plan_and_execute(message, context)
            if plan_response is not None:
                return _skill_response_to_chat(plan_response)
            return await _handle_general(message)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


PATTERN_ANALYSIS_PROMPT = """You are a trading pattern analyst. The user selected a region on their chart by drawing a single pattern box around it, and the frontend has extracted a mathematical fingerprint of that region.

Analyze the pattern data and explain:
1. What type of pattern this looks like (e.g., bull flag, double bottom, ascending triangle, head and shoulders, breakout, etc.)
2. The key characteristics: candle structure, trend direction, indicator behavior
3. What the pattern typically signals — is it bullish, bearish, or continuation?
4. How reliable this pattern typically is and any concerns or caveats

Be concise (4-6 sentences). End by asking: "Should I create a detection script for this pattern, or would you like to adjust anything?"

Do NOT generate code. Only analyze and explain."""


CONFIRM_KEYWORDS = [
    "yes", "proceed", "create", "generate", "go ahead", "make it",
    "do it", "create script", "generate script", "looks good",
    "perfect", "confirmed", "ok", "okay", "sure", "build",
]


async def _handle_pattern(message: str, context: dict) -> ChatResponse:
    """Handle pattern skill: generate JS pattern or indicator scripts."""
    current_script = context.get("pattern_script", "")

    # Check if this is a pattern fingerprint (contains SHAPE + sliding-window rules)
    is_fingerprint = "SHAPE:" in message and "Sliding window" in message

    # Check if user is confirming to proceed with script creation
    pending_fingerprint = context.get("pending_fingerprint", "")
    lower_msg = message.lower().strip()
    is_confirm = any(kw in lower_msg for kw in CONFIRM_KEYWORDS)

    # Priority 1: confirmation of pending fingerprint → dispatch to pattern skill
    if is_confirm and pending_fingerprint:
        response = await vibe_trade.dispatch("pattern", pending_fingerprint, context)
        return _skill_response_to_chat(response)

    if is_fingerprint:
        # First step: analyze the pattern, don't generate script yet
        if llm_available():
            analysis = chat_completion(
                system_prompt=PATTERN_ANALYSIS_PROMPT,
                user_message=message,
                temperature=0.3,
                max_tokens=500,
            )
        else:
            analysis = (
                "I can see a pattern selection with a distinct shape and candle structure. "
                "Should I create a detection script for this pattern?"
            )

        return ChatResponse(
            reply=analysis,
            script=None,
            script_type="pattern",
            data={"pending_fingerprint": message},
        )

    # If there's an existing script, treat the message as an edit request
    if current_script and current_script.strip():
        return await _handle_script_edit(message, current_script)

    # Regular pattern/indicator request — dispatch to the pattern skill
    response = await vibe_trade.dispatch("pattern", message, context)
    return _skill_response_to_chat(response)


def _skill_response_to_chat(response) -> ChatResponse:
    """Convert a SkillResponse dataclass into a ChatResponse, propagating tool_calls."""
    return ChatResponse(
        reply=response.reply,
        script=response.script,
        script_type=response.script_type,
        data=response.data or None,
        tool_calls=response.tool_calls or [],
    )


SCRIPT_EDIT_PROMPT = """You are a JavaScript trading script editor.

You have an existing pattern detection script. The user wants to modify it.
Apply their requested changes and return the COMPLETE modified script.

## Rules
- Return ONLY the complete modified JavaScript code
- Keep the same structure: const results = [], sliding window, return results
- Preserve working logic — only change what the user asks
- No markdown fences, no explanations — just the code

## Current script:
{script}

## User request:
{request}"""


async def _handle_script_edit(message: str, current_script: str) -> ChatResponse:
    """Edit an existing script based on user instructions."""
    if llm_available():
        # Generate modified script
        edited = chat_completion(
            system_prompt=SCRIPT_EDIT_PROMPT.format(
                script=current_script,
                request=message,
            ),
            user_message=message,
            temperature=0.3,
        )
        edited = edited.strip()
        if edited.startswith("```"):
            nl = edited.index("\n") if "\n" in edited else len(edited)
            edited = edited[nl + 1:]
            if edited.endswith("```"):
                edited = edited[:-3]
            edited = edited.strip()

        # Get explanation of changes
        explanation = chat_completion(
            system_prompt="You are a trading analyst. In 1-2 sentences, explain what changed in this script edit. Be concise.",
            user_message=f"User asked: {message}\n\nThe script was modified accordingly.",
            temperature=0.3,
            max_tokens=150,
        )

        return ChatResponse(
            reply=explanation,
            script=edited,
            script_type="pattern",
        )
    else:
        return ChatResponse(
            reply=f"I can't edit the script without an LLM connection. You can modify it directly in the code editor.",
            script=current_script,
            script_type="pattern",
        )


async def _handle_strategy(message: str, context: dict) -> ChatResponse:
    """Handle strategy skill: generate from structured config or analyze results."""
    strategy_config = context.get("strategy_config")
    analyze_request = context.get("analyze_results")

    # If analyzing results — dispatch in analyze mode
    if analyze_request and strategy_config:
        response = await vibe_trade.dispatch(
            "strategy",
            message,
            {"mode": "analyze", "strategy_config": strategy_config, "analyze_results": analyze_request},
        )
        return _skill_response_to_chat(response)

    # If config provided — dispatch in generate mode
    if strategy_config:
        response = await vibe_trade.dispatch(
            "strategy",
            message,
            {"mode": "generate", "strategy_config": strategy_config},
        )
        return _skill_response_to_chat(response)

    # Fallback: general strategy chat (no skill routing needed)
    if llm_available():
        reply = chat_completion(
            system_prompt=CHAT_SYSTEM_PROMPT,
            user_message=f"[Strategy skill] {message}",
        )
    else:
        reply = "Fill in the Strategy Builder form to generate and backtest a strategy."

    return ChatResponse(
        reply=reply,
        script=None,
        script_type="strategy",
        data={},
    )


async def _handle_backtest(message: str, context: dict) -> ChatResponse:
    """Handle backtest mode: configure and interpret backtests."""
    dataset_meta = context.get("dataset_meta", {"rows": 0})
    result = _backtest_agent.configure(
        strategy_description=message,
        dataset_meta=dataset_meta,
    )
    return ChatResponse(
        reply=result["explanation"],
        data={
            "config": result["config"],
            "suggestions": result["suggestions"],
        },
    )


def _handle_simulation(message: str) -> ChatResponse:
    """Handle simulation mode questions."""
    if llm_available():
        reply = chat_completion(
            system_prompt=CHAT_SYSTEM_PROMPT,
            user_message=f"[Simulation mode] {message}",
        )
    else:
        reply = (
            "Simulation mode replays historical data bar-by-bar, executing "
            "your strategy in real-time. Configure speed and watch the equity "
            "curve evolve. Upload a dataset and define a strategy first."
        )
    return ChatResponse(reply=reply)


async def _handle_general(message: str) -> ChatResponse:
    """Handle general chat using OpenAI if available."""
    if llm_available():
        reply = chat_completion(
            system_prompt=CHAT_SYSTEM_PROMPT,
            user_message=message,
        )
    else:
        reply = (
            "I can help you detect patterns, build strategies, and run backtests. "
            "Switch to a mode using the top bar and describe what you're looking for."
        )
    return ChatResponse(reply=reply)


@router.get("/chat/status")
async def chat_status() -> dict:
    """Check which LLM provider is configured and available."""
    from core.agents.llm_client import active_provider_info
    info = active_provider_info()
    return {
        "llm_available": llm_available(),
        "mode": info["provider"] if llm_available() else "mock",
        "provider": info["provider"],
        "model": info["model"],
    }


@router.get("/skills")
async def list_skills() -> list[dict]:
    """
    Return the full skill registry as JSON.

    The frontend calls this on mount to render the skill chip row and
    bottom-panel tabs entirely from server metadata. Dropping a new skill
    folder under `trading-platform/skills/` and restarting the backend will
    cause it to appear automatically — no frontend edits required.
    """
    return vibe_trade.registry.to_json()


@router.get("/tools")
async def list_tools() -> list[dict]:
    """
    Return the full tool catalog as JSON.

    Tools are product features that skills can invoke (drawing tools, chart
    overlays, bottom panel tabs, script editor control, notifications, etc.).
    The frontend uses this catalog to validate + render tool_calls. Source
    of truth: `skills/tools.py::TOOL_CATALOG`.
    """
    from skills.tools import catalog_to_json
    return catalog_to_json()


class FetchDataRequest(BaseModel):
    """Request shape for /fetch-data."""
    symbol: str = Field(..., min_length=1, description="Ticker or pair, e.g. AAPL, BTC/USDT, ETH-USD")
    source: str = Field(default="auto", description="'auto' | 'yfinance' | 'ccxt'")
    interval: str = Field(default="1d", description="1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1mo")
    limit: int = Field(default=1000, ge=1, le=50000, description="Approximate number of bars (max 50k — e.g. 30 days of 1m crypto data = 43,200)")
    exchange: str = Field(default="binance", description="ccxt exchange name (binance, coinbase, kraken, okx, ...)")


class PlanRequest(BaseModel):
    """Request shape for /plan."""
    message: str = Field(..., min_length=1)
    context: dict = Field(default_factory=dict)
    # If provided and non-empty, the planner will ONLY build plans that use
    # skills from this list. Honors the user's explicit skill selection.
    available_skills: list[str] = Field(default_factory=list)


@router.post("/plan")
async def make_plan(req: PlanRequest) -> dict:
    """
    Build a multi-step execution plan WITHOUT running it.

    The frontend uses this to orchestrate plan execution step-by-step in the
    browser, so each step's generated script can be ACTUALLY EXECUTED via the
    Web Worker pattern/strategy executors before the next step's LLM call.
    This unlocks closed-loop workflows like "fetch data → run pattern detector
    → see N matches → run backtest → see real PnL" in a single chat turn.

    The `available_skills` field restricts the planner to the user's selected
    subset — e.g. if the user has only Pattern + Strategy chips active, the
    planner cannot emit a Data Fetcher step even if the message asks for it.

    Returns:
      {
        "steps": [{"skill", "message", "rationale", "context"}, ...],
        "is_multi_step": bool   // false → frontend should fall through to plain chat
      }
    """
    from core.agents.planner import plan as build_plan
    from core.agents.vibe_trade_agent import looks_multi_step

    if not looks_multi_step(req.message):
        return {"steps": [], "is_multi_step": False}

    steps = build_plan(req.message, available_skills=req.available_skills or None)
    return {"steps": steps, "is_multi_step": True}


@router.post("/fetch-data")
async def fetch_market_data(req: FetchDataRequest) -> dict:
    """
    Fetch historical OHLCV bars from yfinance (stocks/ETFs) or ccxt (crypto).

    No API key required for either provider's public data. Auto-detects the
    correct provider from the symbol shape if `source == "auto"`:
      - "BTC/USDT", "ETH-USD", or bare crypto bases → ccxt
      - "AAPL", "^GSPC", "EURUSD=X" → yfinance

    Returns the bars + metadata in the platform's normalized OHLC shape so
    the frontend can register them as a Dataset and render them on the chart.
    """
    from core.data.fetcher import fetch
    try:
        result = fetch(
            symbol=req.symbol,
            source=req.source,
            interval=req.interval,
            limit=req.limit,
            exchange=req.exchange,
        )
        return result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch {req.symbol}: {exc}") from exc
