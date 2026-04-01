"""
Chat router.

Provides a conversational interface to the trading agents.
Routes messages to the appropriate agent based on the active mode.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.agents.llm_client import chat_completion, is_available as llm_available
from core.agents.pattern_agent import PatternAgent
from core.agents.strategy_agent import StrategyAgent
from core.agents.backtest_agent import BacktestAgent

router = APIRouter(tags=["chat"])


class ChatRequest(BaseModel):
    """Chat message from the user."""
    message: str = Field(..., min_length=1)
    mode: str = Field(default="pattern", description="Active mode: pattern, strategy, backtest, simulation")
    context: dict = Field(default_factory=dict, description="Additional context (dataset_id, script, etc.)")


class ChatResponse(BaseModel):
    """Chat response from the agent."""
    reply: str
    script: str | None = None
    script_type: str | None = None  # "pattern" or "indicator"
    data: dict | None = None


# Agent instances (reused across requests).
_pattern_agent = PatternAgent()
_strategy_agent = StrategyAgent()
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
        else:
            return await _handle_general(message)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


async def _handle_pattern(message: str, context: dict) -> ChatResponse:
    """Handle pattern mode: generate JS pattern or indicator scripts."""
    current_script = context.get("pattern_script", "")

    # If there's an existing script, treat the message as an edit request
    if current_script and current_script.strip():
        return await _handle_script_edit(message, current_script)

    result = _pattern_agent.generate(message)
    data: dict = {
        "parameters": result["parameters"],
        "indicators_used": result.get("indicators_used", []),
    }
    if result.get("script_type") == "indicator":
        data["default_params"] = result.get("default_params", {})
        data["indicator_name"] = result.get("indicator_name", "Custom")
    return ChatResponse(
        reply=result["explanation"],
        script=result["script"],
        script_type=result.get("script_type", "pattern"),
        data=data,
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
    """Handle strategy mode: generate trading strategies."""
    pattern_info = context.get("pattern_script", context.get("pattern_info", ""))
    result = _strategy_agent.generate(
        pattern_info=pattern_info or message,
        user_intent=message,
    )
    return ChatResponse(
        reply=result["explanation"],
        script=result["script"],
        data={
            "parameters": result["parameters"],
            "entry_rules": result["entry_rules"],
            "exit_rules": result["exit_rules"],
        },
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
    """Check if OpenAI API is configured."""
    return {
        "llm_available": llm_available(),
        "mode": "openai" if llm_available() else "mock",
    }
