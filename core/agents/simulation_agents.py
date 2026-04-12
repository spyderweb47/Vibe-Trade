"""
Social Simulation Engine for Vibe Trade.

6-stage pipeline:
  1. AssetClassifier — determines asset type + key price drivers
  2. ChartSupportAgent — resamples OHLC data, pre-computes indicators
  3. EntityGenerator — creates 20-30 diverse personas from report + asset context
  4. DiscussionAgent — each entity participates in a shared-thread debate
  5. ChartSupportAgent (mid-debate) — injects data when entities request it
  6. SummaryAgent — produces final report from full discussion thread
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion, chat_completion_json, is_available as llm_available


# ---------------------------------------------------------------------------
# Stage 1: Asset Classifier
# ---------------------------------------------------------------------------

ASSET_CLASSIFIER_PROMPT = """You are an asset classification expert. Given market data metadata, determine:
1. The asset class (crypto, stock, forex, commodity, index, etf)
2. A brief description of the specific asset
3. Key factors that drive this asset's price (5-8 factors)

Respond with ONLY valid JSON (no markdown fences):
{
  "asset_class": "crypto",
  "asset_name": "Bitcoin (BTC)",
  "description": "Layer 1 proof-of-work blockchain, digital store of value",
  "price_drivers": ["Federal Reserve interest rates", "Institutional adoption", "Halving cycles", "On-chain metrics", "Regulatory environment", "Dollar strength (DXY)", "Risk appetite in traditional markets"]
}"""


class AssetClassifier:
    def classify(self, symbol: str, price_range: tuple, bar_count: int) -> dict:
        user_msg = f"Symbol: {symbol}\nPrice range: ${price_range[0]:.2f} - ${price_range[1]:.2f}\nBars: {bar_count}"
        if not llm_available():
            return self._mock(symbol, price_range)
        result = chat_completion_json(
            system_prompt=ASSET_CLASSIFIER_PROMPT,
            user_message=user_msg,
            temperature=0.3,
            max_tokens=500,
        )
        result.setdefault("asset_class", "unknown")
        result.setdefault("asset_name", symbol)
        result.setdefault("description", "")
        result.setdefault("price_drivers", [])
        return result

    def _mock(self, symbol: str, price_range: tuple) -> dict:
        sym = symbol.upper()
        if any(k in sym for k in ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB", "ADA"]):
            return {"asset_class": "crypto", "asset_name": sym, "description": f"{sym} cryptocurrency",
                    "price_drivers": ["Fed policy", "Institutional flows", "On-chain metrics", "Regulation", "DXY", "Risk appetite"]}
        if price_range[1] > 10000:
            return {"asset_class": "index", "asset_name": sym, "description": f"{sym} market index",
                    "price_drivers": ["Earnings season", "GDP growth", "Interest rates", "Geopolitics", "Sector rotation"]}
        return {"asset_class": "stock", "asset_name": sym, "description": f"{sym} equity",
                "price_drivers": ["Earnings", "Revenue growth", "Industry trends", "Macro environment", "Analyst ratings"]}


# ---------------------------------------------------------------------------
# Stage 2: Chart Support Agent (data prep + mid-debate injection)
# ---------------------------------------------------------------------------

class ChartSupportAgent:
    """Handles smart data resampling and formatting for LLM consumption."""

    def prepare_multi_timeframe(self, bars: list, symbol: str) -> dict:
        """Prepare market summaries at multiple timeframes."""
        summaries = {}

        # Always create a daily summary from the raw data
        summaries["raw"] = format_ohlc_summary(bars[-200:] if len(bars) > 200 else bars, symbol, "Raw")

        # If we have enough bars, create resampled views
        if len(bars) > 100:
            daily = self._resample_to_daily(bars)
            if daily:
                summaries["daily"] = format_ohlc_summary(daily[-365:], symbol, "Daily")

        if len(bars) > 500:
            weekly = self._resample_to_weekly(bars)
            if weekly:
                summaries["weekly"] = format_ohlc_summary(weekly[-52:], symbol, "Weekly")

        return summaries

    def handle_data_request(self, request_text: str, bars: list, symbol: str) -> Optional[str]:
        """Check if an entity is requesting specific data and provide it."""
        lower = request_text.lower()
        patterns = [
            (r"(4h|4.hour|four.hour)", 14400),
            (r"(1h|hourly|one.hour)", 3600),
            (r"(daily|1d|day)", 86400),
            (r"(weekly|1w|week)", 604800),
            (r"(monthly|1m|month)", 2592000),
        ]
        for pattern, seconds in patterns:
            if re.search(pattern, lower) and any(kw in lower for kw in ["show", "what does", "need", "look at", "check", "data"]):
                resampled = self._resample(bars, seconds)
                if resampled:
                    tf_label = {3600: "1H", 14400: "4H", 86400: "Daily", 604800: "Weekly", 2592000: "Monthly"}.get(seconds, "Custom")
                    return format_ohlc_summary(resampled[-50:], symbol, tf_label)
        return None

    def _resample(self, bars: list, bucket_seconds: int) -> list:
        if not bars:
            return []
        result = []
        bucket_start = None
        current = None
        for b in bars:
            t = b.get("time", 0)
            # Handle pandas Timestamp, string, or numeric time values
            if hasattr(t, "timestamp"):
                t = int(t.timestamp())
            elif isinstance(t, str):
                t = int(float(t))
            else:
                t = int(t)
            bucket = (t // bucket_seconds) * bucket_seconds
            if bucket != bucket_start:
                if current:
                    result.append(current)
                bucket_start = bucket
                current = {"time": bucket, "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b.get("volume", 0)}
            else:
                current["high"] = max(current["high"], b["high"])
                current["low"] = min(current["low"], b["low"])
                current["close"] = b["close"]
                current["volume"] = current.get("volume", 0) + b.get("volume", 0)
        if current:
            result.append(current)
        return result

    def _resample_to_daily(self, bars: list) -> list:
        return self._resample(bars, 86400)

    def _resample_to_weekly(self, bars: list) -> list:
        return self._resample(bars, 604800)


# ---------------------------------------------------------------------------
# Stage 3: Entity Generator
# ---------------------------------------------------------------------------

ENTITY_GENERATOR_PROMPT = """You are a simulation architect. Given an asset and its context, generate 20-25 diverse personas who would have strong opinions about this asset's price.

CRITICAL: Create REALISTIC, DIVERSE personas with NAMES, not generic roles. Include:
- Professional traders (hedge fund, prop desk, quant)
- Retail investors (different risk profiles)
- Industry insiders (if applicable — miners for crypto, employees for stocks)
- Analysts (technical, fundamental, macro)
- Contrarians and skeptics
- Media/journalists who cover this asset
- Regulatory/policy observers
- Community members (crypto twitter, Reddit, forums)

Each persona must feel like a REAL person with a distinct voice, not a generic label.

Respond with ONLY valid JSON (no markdown fences):
{{
  "entities": [
    {{
      "id": "marcus_wei",
      "name": "Marcus Wei",
      "role": "Macro Hedge Fund PM",
      "background": "15 years managing a $2B global macro fund. CFA, MIT Sloan grad. Trades based on central bank policy and cross-asset correlations.",
      "bias": "cautious_bullish",
      "personality": "data-driven, measured, prefers risk-adjusted returns over moonshots"
    }},
    ...
  ]
}}

bias options: strongly_bullish, bullish, cautious_bullish, neutral, cautious_bearish, bearish, strongly_bearish, contrarian
personality: 1-2 sentence description of how they argue (aggressive? measured? memetic? academic?)

Generate exactly 20-25 entities. Make them DIVERSE — different ages, backgrounds, risk appetites, analysis styles."""


class EntityGenerator:
    def generate(self, asset_info: dict, market_summary: str, report_text: str = "") -> list:
        user_msg = f"Asset: {asset_info.get('asset_name', 'Unknown')} ({asset_info.get('asset_class', 'unknown')})\n"
        user_msg += f"Description: {asset_info.get('description', '')}\n"
        user_msg += f"Key price drivers: {', '.join(asset_info.get('price_drivers', []))}\n"
        user_msg += f"\nMarket summary:\n{market_summary[:800]}\n"
        if report_text:
            user_msg += f"\nResearch report excerpt:\n{report_text[:2000]}\n"

        if not llm_available():
            return self._mock(asset_info)

        result = chat_completion_json(
            system_prompt=ENTITY_GENERATOR_PROMPT,
            user_message=user_msg,
            temperature=0.7,
            max_tokens=4000,
        )
        entities = result.get("entities", [])
        if not entities or len(entities) < 5:
            return self._mock(asset_info)
        return entities[:25]  # cap at 25

    def _mock(self, asset_info: dict) -> list:
        ac = asset_info.get("asset_class", "stock")
        if ac == "crypto":
            return [
                {"id": "hedge_fund_pm", "name": "Marcus Wei", "role": "Macro Hedge Fund PM", "background": "15 years managing $2B fund", "bias": "cautious_bullish", "personality": "data-driven, measured"},
                {"id": "crypto_whale", "name": "0xDegen", "role": "Crypto Whale", "background": "Early BTC adopter, $50M portfolio", "bias": "bullish", "personality": "aggressive, meme-driven"},
                {"id": "quant_trader", "name": "Dr. Ananya Patel", "role": "Quantitative Trader", "background": "PhD in financial mathematics, algo trading desk", "bias": "neutral", "personality": "purely statistical, dismisses narratives"},
                {"id": "retail_bull", "name": "Jake Miller", "role": "Retail Investor", "background": "Software engineer, DCA since 2020", "bias": "bullish", "personality": "conviction-based, long-term holder"},
                {"id": "macro_bear", "name": "Dr. Elena Volkov", "role": "Macro Economist", "background": "Former Fed economist, now at think tank", "bias": "bearish", "personality": "academic, cites monetary policy data"},
                {"id": "onchain_analyst", "name": "Glassnode_Guru", "role": "On-Chain Analyst", "background": "Runs popular analytics dashboard", "bias": "neutral", "personality": "lets data speak, shows charts and metrics"},
                {"id": "miner", "name": "Zhang Wei", "role": "Mining Farm Operator", "background": "Runs 500PH/s operation in Texas", "bias": "bullish", "personality": "practical, cost-focused, knows hashrate dynamics"},
                {"id": "skeptic", "name": "Peter Schiff Jr.", "role": "Gold Bug / Crypto Skeptic", "background": "Traditional finance, gold advocate", "bias": "strongly_bearish", "personality": "dismissive of crypto, cites fundamentals"},
                {"id": "defi_dev", "name": "Vitalik_Fan_42", "role": "DeFi Developer", "background": "Builds on Layer 2, understands protocol economics", "bias": "cautious_bullish", "personality": "technical, ecosystem-focused"},
                {"id": "journalist", "name": "Sarah Chen", "role": "Crypto Journalist", "background": "Covers crypto for major financial outlet", "bias": "neutral", "personality": "balanced, asks probing questions"},
            ]
        return [
            {"id": "fund_manager", "name": "Robert Hayes", "role": "Fund Manager", "background": "20 years in equities", "bias": "cautious_bullish", "personality": "value-oriented, Warren Buffett disciple"},
            {"id": "day_trader", "name": "Mike Chen", "role": "Day Trader", "background": "Full-time trader, 8 years experience", "bias": "neutral", "personality": "price-action focused, ignores fundamentals"},
            {"id": "analyst", "name": "Dr. Sarah Kim", "role": "Equity Analyst", "background": "Covers sector for top investment bank", "bias": "neutral", "personality": "rigorous, DCF-driven"},
            {"id": "retail", "name": "Tom Reddit", "role": "Retail Investor", "background": "Invests savings, follows WallStreetBets", "bias": "bullish", "personality": "momentum-chasing, FOMO-driven"},
            {"id": "bear", "name": "Dr. Michael Burry II", "role": "Short Seller", "background": "Contrarian fund manager", "bias": "strongly_bearish", "personality": "looks for overvaluation, cites macro risks"},
            {"id": "insider", "name": "Anonymous Employee", "role": "Industry Insider", "background": "Works at a competitor firm", "bias": "cautious_bearish", "personality": "knows industry dynamics, conservative"},
            {"id": "macro", "name": "Janet Macro", "role": "Macro Strategist", "background": "Global macro desk at major bank", "bias": "neutral", "personality": "top-down, rates-focused"},
            {"id": "tech_analyst", "name": "ChartMaster_5000", "role": "Technical Analyst", "background": "CMT certified, 15 years of charting", "bias": "neutral", "personality": "pure technical, Fibonacci devotee"},
        ]


# ---------------------------------------------------------------------------
# Stage 4: Discussion Agent (one instance per entity per round)
# ---------------------------------------------------------------------------

DISCUSSION_PROMPT = """You are {name}, a {role}.
Background: {background}
Your natural bias: {bias}
Your personality: {personality}

You are in a live discussion panel about the next price move of {asset_name} ({asset_class}).

{market_context}

{thread_context}

NOW IT'S YOUR TURN TO SPEAK. Respond naturally as {name} would — in character, with your specific expertise and bias. Keep it conversational (2-4 sentences).

If you want to reference specific chart data you don't have, say "I'd like to see the [timeframe] data" and the Chart Support agent will provide it.

You can agree or disagree with other panelists by name. Give a specific price prediction if you feel confident.

Respond with ONLY valid JSON (no markdown fences):
{{
  "content": "Your conversational response as {name}",
  "sentiment": 0.5,
  "price_prediction": null,
  "agreed_with": [],
  "disagreed_with": [],
  "data_request": null
}}

sentiment: -1.0 = very bearish to +1.0 = very bullish
price_prediction: a specific number or null if not confident enough
agreed_with / disagreed_with: list of other panelists' names you reference
data_request: null, or a string like "4H chart for last 2 weeks" if you need data"""


class DiscussionAgent:
    """Represents one entity speaking in one round of discussion."""

    def __init__(self, entity: dict, asset_info: dict):
        self.entity = entity
        self.asset_info = asset_info

    def speak(self, market_summary: str, thread_so_far: str, report_excerpt: str = "") -> dict:
        market_context = f"## Market Data\n{market_summary[:1500]}"
        if report_excerpt:
            market_context += f"\n\n## Research Report Excerpt\n{report_excerpt[:800]}"

        thread_context = ""
        if thread_so_far:
            thread_context = f"## Discussion So Far\n{thread_so_far}"

        prompt = DISCUSSION_PROMPT.format(
            name=self.entity["name"],
            role=self.entity["role"],
            background=self.entity.get("background", ""),
            bias=self.entity.get("bias", "neutral"),
            personality=self.entity.get("personality", ""),
            asset_name=self.asset_info.get("asset_name", "the asset"),
            asset_class=self.asset_info.get("asset_class", "unknown"),
            market_context=market_context,
            thread_context=thread_context,
        )

        if not llm_available():
            return {
                "content": f"[Mock] {self.entity['name']} ({self.entity['role']}): Analysis requires an OpenAI API key.",
                "sentiment": 0.0,
                "price_prediction": None,
                "agreed_with": [],
                "disagreed_with": [],
                "data_request": None,
            }

        result = chat_completion_json(
            system_prompt=prompt,
            user_message="Your turn. Speak now.",
            temperature=0.6,
            max_tokens=400,
        )
        result.setdefault("content", f"{self.entity['name']}: No comment.")
        result.setdefault("sentiment", 0.0)
        result.setdefault("price_prediction", None)
        result.setdefault("agreed_with", [])
        result.setdefault("disagreed_with", [])
        result.setdefault("data_request", None)
        return result


# ---------------------------------------------------------------------------
# Stage 6: Summary Agent
# ---------------------------------------------------------------------------

SUMMARY_PROMPT = """You are a senior analyst synthesizing a multi-agent discussion panel about {asset_name} ({asset_class}).

Read the FULL discussion thread below and produce a structured summary report.

{thread}

Respond with ONLY valid JSON (no markdown fences):
{{
  "consensus_direction": "BULLISH",
  "confidence": 0.72,
  "key_arguments": ["Argument 1", "Argument 2", "Argument 3", "Argument 4", "Argument 5"],
  "dissenting_views": ["Contrarian view 1", "Contrarian view 2"],
  "price_targets": {{ "low": 58000, "mid": 65000, "high": 75000 }},
  "risk_factors": ["Risk 1", "Risk 2", "Risk 3"],
  "recommendation": {{
    "action": "BUY",
    "entry": 62000,
    "stop": 58000,
    "target": 72000,
    "position_size_pct": 2.0
  }}
}}

consensus_direction: BULLISH / BEARISH / NEUTRAL
confidence: 0.0 to 1.0 based on how aligned the panelists were"""


class SummaryAgent:
    def summarize(self, thread_text: str, asset_info: dict) -> dict:
        prompt = SUMMARY_PROMPT.format(
            asset_name=asset_info.get("asset_name", "Unknown"),
            asset_class=asset_info.get("asset_class", "unknown"),
            thread=thread_text[-6000:],  # last 6000 chars to fit context
        )

        if not llm_available():
            return {
                "consensus_direction": "NEUTRAL",
                "confidence": 0.5,
                "key_arguments": ["Mock: LLM unavailable for summary"],
                "dissenting_views": [],
                "price_targets": {"low": 0, "mid": 0, "high": 0},
                "risk_factors": ["LLM not configured"],
                "recommendation": {"action": "HOLD", "entry": None, "stop": None, "target": None, "position_size_pct": 0},
            }

        result = chat_completion_json(
            system_prompt=prompt,
            user_message="Produce the summary report now.",
            temperature=0.3,
            max_tokens=2000,
        )
        result.setdefault("consensus_direction", "NEUTRAL")
        result.setdefault("confidence", 0.5)
        result.setdefault("key_arguments", [])
        result.setdefault("dissenting_views", [])
        result.setdefault("price_targets", {"low": 0, "mid": 0, "high": 0})
        result.setdefault("risk_factors", [])
        result.setdefault("recommendation", {"action": "HOLD"})
        return result


# ---------------------------------------------------------------------------
# Utility: format OHLC for prompt (reused from existing code, simplified)
# ---------------------------------------------------------------------------

def format_ohlc_summary(bars: list, symbol: str, timeframe_label: str = "Raw") -> str:
    if not bars:
        return "No data."
    n = len(bars)
    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    volumes = [b.get("volume", 0) for b in bars]

    current = closes[-1]
    prev = closes[-2] if n >= 2 else current

    def sma(data, period):
        return sum(data[-period:]) / period if len(data) >= period else None

    def rsi(data, period=14):
        if len(data) < period + 1:
            return None
        gains, losses = 0, 0
        for i in range(-period, 0):
            d = data[i] - data[i - 1]
            if d > 0: gains += d
            else: losses -= d
        rs = gains / (losses or 1e-10)
        return 100 - 100 / (1 + rs)

    sma20 = sma(closes, 20)
    sma50 = sma(closes, 50)
    sma200 = sma(closes, 200)
    rsi14 = rsi(closes)

    period_high = max(highs[-50:]) if n >= 50 else max(highs)
    period_low = min(lows[-50:]) if n >= 50 else min(lows)

    def pct(data, lookback):
        if len(data) <= lookback or data[-lookback - 1] == 0:
            return None
        return ((data[-1] - data[-lookback - 1]) / data[-lookback - 1]) * 100

    lines = [
        f"## {symbol} — {timeframe_label} ({n} bars)",
        f"Price: {current:.2f} ({'+' if current >= prev else ''}{((current - prev) / prev * 100):.2f}%)",
        f"Range: {period_low:.2f} — {period_high:.2f}",
        f"SMA(20)={f'{sma20:.2f}' if sma20 else 'N/A'} SMA(50)={f'{sma50:.2f}' if sma50 else 'N/A'} SMA(200)={f'{sma200:.2f}' if sma200 else 'N/A'}",
        f"RSI(14)={f'{rsi14:.1f}' if rsi14 else 'N/A'}",
        f"5-bar: {f'{pct(closes,5):+.1f}%' if pct(closes,5) else 'N/A'} | 20-bar: {f'{pct(closes,20):+.1f}%' if pct(closes,20) else 'N/A'}",
    ]
    return "\n".join(lines)
