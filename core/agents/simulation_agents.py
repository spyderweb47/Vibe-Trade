"""
Multi-agent debate system for Vibe Trade Simulation mode.

Four specialized agents form a committee that debates trade decisions:
  Bull Analyst → argues FOR
  Bear Analyst → argues AGAINST
  Risk Officer → evaluates risk/reward (sees both Bull + Bear)
  Portfolio Manager → synthesizes all, makes final BUY/SELL/HOLD call

Each agent receives pre-computed market data (not raw OHLC) and outputs
structured JSON via chat_completion_json.
"""

from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion_json, chat_completion, is_available as llm_available


# ---------------------------------------------------------------------------
# Market data formatter — pre-computes indicators server-side so the LLM
# doesn't waste tokens on raw OHLC numbers.
# ---------------------------------------------------------------------------

def format_ohlc_for_prompt(bars: List[Dict[str, Any]], symbol: str) -> str:
    """Convert recent OHLC bars into a compact market summary for LLM consumption."""
    if not bars:
        return "No market data available."

    n = len(bars)
    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    volumes = [b.get("volume", 0) for b in bars]

    current = closes[-1]
    prev = closes[-2] if n >= 2 else current

    # Simple Moving Averages
    def sma(data: list, period: int) -> Optional[float]:
        if len(data) < period:
            return None
        return sum(data[-period:]) / period

    sma20 = sma(closes, 20)
    sma50 = sma(closes, 50)

    # RSI 14
    def compute_rsi(data: list, period: int = 14) -> Optional[float]:
        if len(data) < period + 1:
            return None
        gains, losses = 0.0, 0.0
        for i in range(-period, 0):
            d = data[i] - data[i - 1]
            if d > 0:
                gains += d
            else:
                losses -= d
        avg_gain = gains / period
        avg_loss = losses / period
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100 - 100 / (1 + rs)

    rsi = compute_rsi(closes)

    # ATR 14
    def compute_atr(bars_list: list, period: int = 14) -> Optional[float]:
        if len(bars_list) < period + 1:
            return None
        trs = []
        for i in range(-period, 0):
            b = bars_list[i]
            bp = bars_list[i - 1]
            tr = max(
                b["high"] - b["low"],
                abs(b["high"] - bp["close"]),
                abs(b["low"] - bp["close"]),
            )
            trs.append(tr)
        return sum(trs) / len(trs)

    atr = compute_atr(bars)

    # Volume average
    avg_vol = sum(volumes[-20:]) / min(20, len(volumes)) if volumes else 0
    current_vol = volumes[-1] if volumes else 0

    # Price changes
    def pct_change(data: list, lookback: int) -> Optional[float]:
        if len(data) <= lookback or data[-lookback - 1] == 0:
            return None
        return ((data[-1] - data[-lookback - 1]) / data[-lookback - 1]) * 100

    chg_5 = pct_change(closes, 5)
    chg_10 = pct_change(closes, 10)
    chg_20 = pct_change(closes, 20)

    # High/Low range
    period_high = max(highs[-20:]) if n >= 20 else max(highs)
    period_low = min(lows[-20:]) if n >= 20 else min(lows)

    # Recent 5 bars as table
    recent = bars[-5:]
    table_lines = ["Date       | Open     | High     | Low      | Close    | Volume"]
    for b in recent:
        t = b.get("time", "")
        table_lines.append(
            f"{t:<10} | {b['open']:>8.2f} | {b['high']:>8.2f} | {b['low']:>8.2f} | {b['close']:>8.2f} | {b.get('volume', 0):>8.0f}"
        )

    # Trend detection
    higher_highs = sum(1 for i in range(-5, 0) if highs[i] > highs[i - 1]) if n > 5 else 0
    higher_lows = sum(1 for i in range(-5, 0) if lows[i] > lows[i - 1]) if n > 5 else 0

    lines = [
        f"## Market Data Summary — {symbol}",
        f"Bars analyzed: {n}",
        f"Current price: {current:.2f} ({'+' if current >= prev else ''}{((current - prev) / prev * 100):.2f}% from prior bar)",
        "",
        "### Key Levels",
        f"  20-bar high: {period_high:.2f}  |  20-bar low: {period_low:.2f}",
        f"  SMA(20): {f'{sma20:.2f}' if sma20 else 'N/A'}  |  SMA(50): {f'{sma50:.2f}' if sma50 else 'N/A'}",
        f"  Price vs SMA20: {'ABOVE' if sma20 and current > sma20 else 'BELOW' if sma20 else 'N/A'}",
        f"  Price vs SMA50: {'ABOVE' if sma50 and current > sma50 else 'BELOW' if sma50 else 'N/A'}",
        "",
        "### Indicators",
        f"  RSI(14): {f'{rsi:.1f}' if rsi else 'N/A'} {'(OVERSOLD)' if rsi and rsi < 30 else '(OVERBOUGHT)' if rsi and rsi > 70 else ''}",
        f"  ATR(14): {f'{atr:.2f}' if atr else 'N/A'} ({f'{(atr / current * 100):.2f}% of price' if atr else ''})",
        f"  Volume: {current_vol:.0f} (avg: {avg_vol:.0f}, {'ABOVE' if current_vol > avg_vol * 1.2 else 'BELOW'} average)",
        "",
        "### Momentum",
        f"  5-bar change: {f'{chg_5:+.2f}%' if chg_5 is not None else 'N/A'}",
        f"  10-bar change: {f'{chg_10:+.2f}%' if chg_10 is not None else 'N/A'}",
        f"  20-bar change: {f'{chg_20:+.2f}%' if chg_20 is not None else 'N/A'}",
        f"  Recent 5 bars: {higher_highs}/5 higher highs, {higher_lows}/5 higher lows",
        "",
        "### Recent Bars",
        "\n".join(table_lines),
    ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# System Prompts
# ---------------------------------------------------------------------------

BULL_SYSTEM_PROMPT = """You are the BULL ANALYST on a trading committee. Your job is to make the strongest possible case FOR entering a long position.

Analyze the market data and build your bullish argument. Look for:
- Price trading above key moving averages (SMA 20, SMA 50)
- RSI recovering from oversold or holding above 50
- Higher highs and higher lows forming
- Volume increasing on up-moves (accumulation)
- Support levels holding
- Bullish candlestick patterns (engulfing, hammer, morning star)
- Positive momentum (rising close-over-close)

Be specific — cite actual price levels and indicator values from the data.

Respond with ONLY valid JSON (no markdown fences):
{
  "argument": "Your 3-5 sentence bullish thesis",
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "sentiment": 0.7,
  "signals": ["Signal 1", "Signal 2"]
}

sentiment: 0.0 = neutral, 1.0 = extremely bullish. Base it on signal strength."""

BEAR_SYSTEM_PROMPT = """You are the BEAR ANALYST on a trading committee. Your job is to make the strongest possible case AGAINST entering a long position.

Analyze the market data and build your bearish argument. Look for:
- Price trading below key moving averages
- RSI overbought (>70) or showing divergence
- Lower highs and lower lows forming
- Volume declining on up-moves (distribution)
- Resistance levels overhead
- Bearish candlestick patterns (engulfing, shooting star, evening star)
- Negative momentum (falling close-over-close)
- Potential support breakdown

Be specific — cite actual price levels and indicator values from the data.

Respond with ONLY valid JSON (no markdown fences):
{
  "argument": "Your 3-5 sentence bearish thesis",
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "sentiment": -0.7,
  "signals": ["Signal 1", "Signal 2"]
}

sentiment: 0.0 = neutral, -1.0 = extremely bearish. Base it on signal strength."""

RISK_SYSTEM_PROMPT = """You are the RISK OFFICER on a trading committee. You have read both the Bull Analyst's and Bear Analyst's arguments.

Your job is NOT to pick a side. Instead, evaluate:
1. Risk/reward ratio — is the potential upside worth the downside risk?
2. Volatility regime — is ATR elevated, suggesting wider stops are needed?
3. Position sizing — given the volatility, what % of capital should be risked?
4. Maximum drawdown concern — how bad could it get?
5. Uncertainty level — how conflicting are the bull/bear signals?

Be quantitative where possible — suggest specific stop and target levels.

Respond with ONLY valid JSON (no markdown fences):
{
  "argument": "Your 3-5 sentence risk assessment",
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "sentiment": 0.0,
  "signals": ["Risk factor 1", "Risk factor 2"],
  "risk_reward_ratio": 2.5,
  "suggested_position_size_pct": 2.0,
  "max_risk_pct": 1.5
}

sentiment: -0.5 = high risk / unfavorable, +0.5 = low risk / favorable."""

PM_SYSTEM_PROMPT = """You are the PORTFOLIO MANAGER. You have read arguments from:
- The Bull Analyst (bullish case)
- The Bear Analyst (bearish case)
- The Risk Officer (risk assessment)

Make a DECISIVE call: BUY, SELL, or HOLD. Do not hedge or equivocate.
Weigh the evidence, pick the stronger argument, and commit.

Your decision must include:
- A clear BUY / SELL / HOLD verdict
- A confidence score (0.0 to 1.0) — how sure you are
- Specific price levels: entry, stop-loss, and target
- Suggested position size (% of capital)

Respond with ONLY valid JSON (no markdown fences):
{
  "decision": "BUY",
  "confidence": 0.72,
  "reasoning": "2-3 sentence synthesis explaining your decision",
  "suggested_entry": 100.50,
  "suggested_stop": 98.00,
  "suggested_target": 105.00,
  "position_size_pct": 2.0
}"""


# ---------------------------------------------------------------------------
# Agent Classes
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Architect Agent — dynamically generates agent personas from a report
# ---------------------------------------------------------------------------

ARCHITECT_PROMPT = """You are a simulation architect. Given a research report and/or asset information,
create 4-6 specialized analyst personas that would be relevant to debating the next price action of this asset.

Each persona should have a unique perspective based on their specialty — different from the others.
For example, for a crypto asset you might create: On-chain Analyst, Macro Strategist, DeFi Protocol Specialist, Whale Tracker, Regulatory Analyst.
For a stock: Fundamental Analyst, Technical Analyst, Industry Specialist, Macro Economist, Sentiment Analyst.

Consider the report content to create RELEVANT personas. If the report mentions specific topics (e.g., earnings, Fed policy, protocol upgrades), create analysts that specialize in those areas.

Respond with ONLY valid JSON (no markdown fences):
{
  "agents": [
    {
      "role": "on_chain_analyst",
      "label": "On-Chain Analyst",
      "focus": "Analyze on-chain metrics: active addresses, whale movements, exchange flows, TVL changes",
      "bias": "neutral"
    },
    {
      "role": "macro_strategist",
      "label": "Macro Strategist",
      "focus": "Evaluate macroeconomic factors: interest rates, dollar strength, liquidity conditions, correlation with risk assets",
      "bias": "neutral"
    }
  ]
}

bias can be: "bullish", "bearish", or "neutral" — set based on the persona's natural leaning given their specialty.
Create exactly 4-6 agents. Make role names snake_case and unique."""


class ArchitectAgent:
    """Generates dynamic agent personas from report text and asset context."""

    def generate_personas(self, symbol: str, report_text: str = "", market_summary: str = "") -> list:
        user_msg = f"Asset: {symbol}\n"
        if report_text:
            # Truncate report to fit context
            user_msg += f"\n## Research Report (excerpt)\n{report_text[:3000]}\n"
        if market_summary:
            user_msg += f"\n## Market Data\n{market_summary[:1000]}\n"
        user_msg += "\nCreate 4-6 specialized analyst personas for debating the next price action of this asset."

        if not llm_available():
            return self._mock_personas(symbol)

        result = chat_completion_json(
            system_prompt=ARCHITECT_PROMPT,
            user_message=user_msg,
            temperature=0.5,
            max_tokens=1500,
        )

        agents = result.get("agents", [])
        if not agents or not isinstance(agents, list):
            return self._mock_personas(symbol)
        return agents

    def _mock_personas(self, symbol: str) -> list:
        return [
            {"role": "technical_analyst", "label": "Technical Analyst", "focus": "Chart patterns, indicators, support/resistance levels, trend analysis", "bias": "neutral"},
            {"role": "fundamental_analyst", "label": "Fundamental Analyst", "focus": "Valuation metrics, earnings, revenue growth, competitive position", "bias": "neutral"},
            {"role": "sentiment_analyst", "label": "Sentiment Analyst", "focus": "Market sentiment, fear/greed, social media trends, positioning data", "bias": "neutral"},
            {"role": "risk_manager", "label": "Risk Manager", "focus": "Volatility assessment, correlation risks, position sizing, tail risk scenarios", "bias": "neutral"},
        ]


# ---------------------------------------------------------------------------
# Dynamic Debate Agent — a single class that takes a persona config
# ---------------------------------------------------------------------------

DYNAMIC_AGENT_PROMPT = """You are {label}, a specialized analyst on a trading committee.

Your focus area: {focus}

Analyze the market data (and research report if provided) from your unique perspective.
{bias_instruction}

Respond with ONLY valid JSON (no markdown fences):
{{
  "argument": "Your 3-5 sentence analysis from your specialized perspective",
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "sentiment": 0.5,
  "signals": ["Signal 1", "Signal 2"]
}}

sentiment: -1.0 = very bearish, 0.0 = neutral, +1.0 = very bullish. Base it on what you see in the data from your perspective."""


class DynamicDebateAgent:
    """A debate agent instantiated from a persona config."""

    def __init__(self, persona: dict):
        self.role = persona.get("role", "analyst")
        self.label = persona.get("label", "Analyst")
        self.focus = persona.get("focus", "General market analysis")
        self.bias = persona.get("bias", "neutral")

        bias_instruction = ""
        if self.bias == "bullish":
            bias_instruction = "You have a naturally bullish leaning — look for reasons the price will go UP. But be honest about risks."
        elif self.bias == "bearish":
            bias_instruction = "You have a naturally bearish leaning — look for reasons the price will go DOWN. But acknowledge bullish signals."

        self.system_prompt = DYNAMIC_AGENT_PROMPT.format(
            label=self.label,
            focus=self.focus,
            bias_instruction=bias_instruction,
        )

    def analyze(self, market_data: str, report_text: str = "") -> dict:
        user_msg = market_data
        if report_text:
            user_msg += f"\n\n## Research Report (excerpt)\n{report_text[:2000]}"

        if not llm_available():
            return {
                "argument": f"[Mock] {self.label} analysis requires an OpenAI API key.",
                "key_points": [f"Focus: {self.focus}"],
                "sentiment": 0.0,
                "signals": [],
            }

        result = chat_completion_json(
            system_prompt=self.system_prompt,
            user_message=user_msg,
            temperature=0.4,
            max_tokens=1200,
        )

        result.setdefault("argument", f"{self.label}: No analysis available.")
        result.setdefault("key_points", [])
        result.setdefault("sentiment", 0.0)
        result.setdefault("signals", [])
        return result


class BaseDebateAgent:
    role: str = ""
    label: str = ""
    system_prompt: str = ""

    def analyze(
        self,
        market_data: str,
        prior_arguments: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        user_msg = market_data
        if prior_arguments:
            parts = ["\n\n## Prior Arguments from Committee Members\n"]
            for role_name, arg in prior_arguments.items():
                parts.append(f"### {role_name.upper()} ANALYST\n{arg}\n")
            user_msg = market_data + "\n".join(parts)

        if not llm_available():
            return self._mock()

        result = chat_completion_json(
            system_prompt=self.system_prompt,
            user_message=user_msg,
            temperature=0.4,
            max_tokens=1500,
        )

        # Ensure required fields
        result.setdefault("argument", "No analysis available.")
        result.setdefault("key_points", [])
        result.setdefault("sentiment", 0.0)
        result.setdefault("signals", [])
        return result

    def _mock(self) -> Dict[str, Any]:
        return {
            "argument": f"[Mock] The {self.label} agent requires an OpenAI API key to analyze market data.",
            "key_points": ["LLM unavailable — using mock response"],
            "sentiment": 0.0,
            "signals": [],
        }


class BullAnalyst(BaseDebateAgent):
    role = "bull"
    label = "Bull Analyst"
    system_prompt = BULL_SYSTEM_PROMPT

    def _mock(self) -> Dict[str, Any]:
        return {
            "argument": "Price is showing signs of support near recent lows with RSI recovering from oversold territory. The SMA(20) is trending upward, suggesting near-term momentum is building.",
            "key_points": ["RSI recovering from oversold", "SMA(20) support holding", "Volume increasing on up-bars"],
            "sentiment": 0.65,
            "signals": ["RSI oversold bounce", "SMA support", "Volume confirmation"],
        }


class BearAnalyst(BaseDebateAgent):
    role = "bear"
    label = "Bear Analyst"
    system_prompt = BEAR_SYSTEM_PROMPT

    def _mock(self) -> Dict[str, Any]:
        return {
            "argument": "Price is approaching resistance at the 20-bar high with declining momentum. Volume has been decreasing on rallies, suggesting distribution. The risk of a pullback from current levels is elevated.",
            "key_points": ["Approaching resistance", "Volume declining on rallies", "Momentum weakening"],
            "sentiment": -0.55,
            "signals": ["Resistance overhead", "Bearish divergence", "Distribution volume"],
        }


class RiskOfficer(BaseDebateAgent):
    role = "risk"
    label = "Risk Officer"
    system_prompt = RISK_SYSTEM_PROMPT

    def _mock(self) -> Dict[str, Any]:
        return {
            "argument": "Current volatility (ATR) suggests a 2% stop-loss distance is appropriate. The risk/reward is acceptable at approximately 2:1 if entry is near current levels with a target at the 20-bar high. Position size should be conservative given mixed signals.",
            "key_points": ["R:R ratio ~2:1", "Volatility moderate", "Suggest 2% position size"],
            "sentiment": 0.1,
            "signals": ["Moderate ATR", "Mixed signals warrant caution"],
            "risk_reward_ratio": 2.0,
            "suggested_position_size_pct": 2.0,
            "max_risk_pct": 1.5,
        }


class PortfolioManager(BaseDebateAgent):
    role = "pm"
    label = "Portfolio Manager"
    system_prompt = PM_SYSTEM_PROMPT

    def _mock(self) -> Dict[str, Any]:
        return {
            "decision": "HOLD",
            "confidence": 0.45,
            "reasoning": "The bull and bear cases are roughly balanced. While near-term momentum is slightly positive, overhead resistance and declining volume suggest waiting for a clearer signal before committing capital.",
            "suggested_entry": None,
            "suggested_stop": None,
            "suggested_target": None,
            "position_size_pct": 0.0,
        }
