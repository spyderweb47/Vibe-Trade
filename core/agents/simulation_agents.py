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

ASSET_CLASSIFIER_PROMPT = """You are an asset classification expert. You receive a dataset name (which could be a filename, ticker, or description) along with price data. Your job is to:

1. DECODE the real asset from the dataset name. Examples:
   - "BITCOIN-HOURLY-OHLCV.csv" → Bitcoin (BTC)
   - "AAPL_daily_2024.csv" → Apple Inc. (AAPL)
   - "EURUSD-1H.csv" → EUR/USD forex pair
   - "GOLD-FUTURES-2025.csv" → Gold (XAU)
   - "NIFTY50-5min.csv" → NIFTY 50 Index
   - "SOL-USDT-binance.csv" → Solana (SOL)
   - "TSLA" → Tesla Inc. (TSLA)
   Use the price range to validate (BTC trades at $20K-$100K, AAPL at $100-$250, etc.)

2. Determine the asset class (crypto, stock, forex, commodity, index, etf)

3. Write a brief description of the specific asset

4. List 5-8 key factors that drive this asset's price

Respond with ONLY valid JSON (no markdown fences):
{
  "asset_class": "crypto",
  "asset_name": "Bitcoin (BTC)",
  "description": "Layer 1 proof-of-work blockchain, the original cryptocurrency and digital store of value. Market cap ~$1.3T.",
  "price_drivers": ["Federal Reserve interest rates", "Institutional adoption (ETFs)", "Bitcoin halving cycles", "On-chain metrics (whale movements, exchange flows)", "Regulatory environment", "Dollar strength (DXY)", "Global risk appetite", "Mining economics (hashrate, energy costs)"]
}"""


class AssetClassifier:
    def classify(self, dataset_name: str, price_range: tuple, bar_count: int) -> dict:
        user_msg = f"Dataset name: {dataset_name}\nPrice range: ${price_range[0]:.2f} - ${price_range[1]:.2f}\nBars: {bar_count}\n\nDecode the real asset name from this dataset and classify it."
        if not llm_available():
            return self._mock(symbol, price_range)
        result = chat_completion_json(
            system_prompt=ASSET_CLASSIFIER_PROMPT,
            user_message=user_msg,
            temperature=0.3,
            max_tokens=500,
        )
        result.setdefault("asset_class", "unknown")
        result.setdefault("asset_name", dataset_name)
        result.setdefault("description", "")
        result.setdefault("price_drivers", [])
        return result

    def _mock(self, dataset_name: str, price_range: tuple) -> dict:
        name = dataset_name.upper()
        if any(k in name for k in ["BITCOIN", "BTC", "ETH", "ETHER", "SOL", "SOLANA", "DOGE", "XRP", "BNB", "ADA", "CRYPTO"]):
            asset = "Bitcoin (BTC)" if "BTC" in name or "BITCOIN" in name else name.split("-")[0].split("_")[0]
            return {"asset_class": "crypto", "asset_name": asset, "description": f"{asset} cryptocurrency",
                    "price_drivers": ["Fed policy", "Institutional flows", "On-chain metrics", "Regulation", "DXY", "Risk appetite", "Halving cycle", "Mining economics"]}
        if any(k in name for k in ["EUR", "USD", "GBP", "JPY", "FOREX", "FX"]):
            return {"asset_class": "forex", "asset_name": name.split(".")[0].split("-")[0], "description": "Forex pair",
                    "price_drivers": ["Interest rate differentials", "Central bank policy", "Trade balance", "Geopolitics", "Risk sentiment"]}
        if price_range[1] > 10000:
            return {"asset_class": "index", "asset_name": name.split(".")[0].split("-")[0], "description": "Market index",
                    "price_drivers": ["Earnings season", "GDP growth", "Interest rates", "Geopolitics", "Sector rotation"]}
        return {"asset_class": "stock", "asset_name": name.split(".")[0].split("-")[0], "description": "Equity",
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

ENTITY_GENERATOR_PROMPT = """You are a simulation architect. Given an asset and its context, generate 10-12 deeply developed personas who would have STRONG and DISTINCT opinions about this asset's next price move.

CRITICAL RULES:
- Each persona must feel like a REAL, fully fleshed-out person — not a generic label
- Give them a NAME, an AGE, a SPECIFIC background with years of experience, notable wins/losses
- Their personality should dictate HOW they argue: do they use data? emotions? memes? academic papers? gut feeling?
- Include their SPEAKING STYLE: formal? casual? aggressive? sarcastic? measured?
- Their bias should feel EARNED from their background — a burned short seller is bearish for a reason
- Make at least 2-3 strongly opinionated (one strongly bullish, one strongly bearish, one contrarian)
- Include at least one "wild card" persona who brings unexpected perspectives

Persona categories — cover ALL of these (2-3 personas per category).
CRITICAL: Adapt EVERY persona to the SPECIFIC asset being discussed.
For oil: include OPEC delegates, energy traders, refinery operators, geopolitical analysts focused on the Middle East.
For stocks: include sell-side equity analysts, company employees, supply chain experts for that sector.
For gold: include central bankers, precious metals dealers, mining executives, inflation hawks.
For forex: include central bank watchers, carry trade specialists, import/export businesses.
For crypto: include on-chain analysts, miners, DeFi builders.
Do NOT give crypto roles (miners, on-chain analysts, DeFi) to non-crypto assets.

PROFESSIONAL:
- Hedge fund PM / CIO (macro, long-short, multi-strat)
- Prop desk trader (momentum, flow-based)
- Family office advisor (wealth preservation, conservative)
- Venture capitalist / growth investor (if relevant to the asset class)

QUANTITATIVE:
- Quant researcher (ML models, backtesting, statistical signals)
- Algorithmic / systematic trader (execution-focused)

RETAIL:
- Conviction holder (DCA, long-term, high conviction)
- Active retail trader (swing trading, options)
- High-risk speculator (leveraged, social-media-driven)

DOMAIN EXPERTS (adapt to the specific asset):
- Industry insider (someone who works directly in this asset's industry)
- Supply/demand specialist (understands the physical market or supply chain)
- Regulatory/legal analyst (government policy, compliance, sanctions)
- Sector specialist (deep domain knowledge of THIS specific market)

ANALYSIS STYLES:
- Pure technical analyst (charts, Fibonacci, Elliott Wave, indicators)
- Fundamental analyst (DCF for stocks, cost curves for commodities, balance of payments for FX)
- Macro economist (rates, GDP, central bank policy, dollar, cross-asset)
- Geopolitical analyst (wars, sanctions, trade policy, elections, OPEC for oil)

CONTRARIANS & WILD CARDS:
- Permanent bear / skeptic (always argues against consensus)
- Contrarian (takes the opposite side of whatever is popular)
- Wild card outsider (unexpected perspective — historian, philosopher, psychologist)

MEDIA & COMMUNITY:
- Financial journalist (investigative, asks hard questions)
- Industry commentator / influencer (shapes sentiment in this market)
- Academic researcher (publishes papers, long-term structural view)

Respond with ONLY valid JSON (no markdown fences). The JSON format is:
{{
  "entities": [
    {{
      "id": "lowercase_snake_case_id",
      "name": "Full Name",
      "role": "Professional Title",
      "background": "Age, career history, notable calls, losses, credentials. 2-3 sentences of rich backstory.",
      "bias": "one of the bias options below",
      "personality": "Speaking style, catchphrases, quirks. What makes this person instantly recognizable in a debate."
    }},
    ...more entities...
  ]
}}

IMPORTANT: Do NOT reuse example names. Invent completely original characters every time.

bias options: strongly_bullish, bullish, cautious_bullish, neutral, cautious_bearish, bearish, strongly_bearish, contrarian

Generate exactly 30-35 entities. Cover EVERY relevant category for this specific asset — you need depth and diversity. Each one must feel like a real person you could have a conversation with — deep backstory, specific speaking style, earned bias."""


class EntityGenerator:
    TARGET_ENTITIES = 30
    BATCH_SIZE = 10  # LLMs reliably produce 10-12 entities per call

    def generate(self, asset_info: dict, market_summary: str, report_text: str = "") -> list:
        base_context = f"Asset: {asset_info.get('asset_name', 'Unknown')} ({asset_info.get('asset_class', 'unknown')})\n"
        base_context += f"Description: {asset_info.get('description', '')}\n"
        base_context += f"Key price drivers: {', '.join(asset_info.get('price_drivers', []))}\n"
        base_context += f"\nMarket summary:\n{market_summary[:800]}\n"
        if report_text:
            base_context += f"\nResearch report excerpt:\n{report_text[:2000]}\n"

        if not llm_available():
            return self._mock(asset_info)

        all_entities: list = []
        used_names: list[str] = []

        # Generate in batches to avoid LLM output truncation.
        # Each batch asks for 10-12 new personas, explicitly excluding
        # names already generated so there are no duplicates.
        batches_needed = (self.TARGET_ENTITIES + self.BATCH_SIZE - 1) // self.BATCH_SIZE
        for batch_idx in range(batches_needed):
            remaining = self.TARGET_ENTITIES - len(all_entities)
            if remaining <= 0:
                break

            count = min(self.BATCH_SIZE + 2, remaining + 2)  # ask for a few extra
            user_msg = base_context

            if used_names:
                user_msg += f"\n\nYou have ALREADY created these personas (do NOT repeat any of them):\n"
                user_msg += ", ".join(used_names) + "\n"
                user_msg += f"\nGenerate {count} MORE completely different personas. Different names, roles, backgrounds, and biases.\n"
            else:
                user_msg += f"\nGenerate exactly {count} entities.\n"

            # Try up to 2 times per batch in case the LLM returns truncated JSON
            batch: list = []
            for attempt in range(2):
                result = chat_completion_json(
                    system_prompt=ENTITY_GENERATOR_PROMPT,
                    user_message=user_msg,
                    temperature=0.75 + (batch_idx * 0.05) + (attempt * 0.05),
                    max_tokens=8000,
                )
                batch = result.get("entities", [])
                if batch and len(batch) >= 3:
                    break
                print(f"[entity_gen] batch {batch_idx + 1} attempt {attempt + 1}: got {len(batch)} entities, retrying...")
            if not batch:
                continue

            # Deduplicate against already-generated entities
            for entity in batch:
                name = entity.get("name", "")
                if name and name not in used_names:
                    all_entities.append(entity)
                    used_names.append(name)

            print(f"[entity_gen] batch {batch_idx + 1}: got {len(batch)} entities, total now {len(all_entities)}")

        if len(all_entities) < 5:
            return self._mock(asset_info)
        return all_entities[:self.TARGET_ENTITIES]

    def _mock(self, asset_info: dict) -> list:
        """Generic mock personas that work for ANY asset class."""
        asset = asset_info.get("asset_name", "this asset")
        ac = asset_info.get("asset_class", "unknown")
        return [
            {"id": "hedge_fund_pm", "name": "Victoria Ashworth", "role": "Macro Hedge Fund PM", "background": f"Age 48. 20 years managing a $3B global macro fund. CFA, Wharton MBA. Trades {asset} based on cross-asset correlations and central bank divergences.", "bias": "cautious_bullish", "personality": "Measured, precise. Says 'the data suggests' not 'I think'. Cites specific numbers. Dismantles sloppy reasoning."},
            {"id": "quant_researcher", "name": "Dr. Raj Malhotra", "role": "Quantitative Researcher", "background": f"Age 35. PhD in applied math from MIT. Built ML models for {ac} markets. Only trusts backtested signals. Refuses social media.", "bias": "neutral", "personality": "Clinical. 'Show me the Sharpe ratio.' Uses precise decimal places. Dismisses narratives."},
            {"id": "tech_analyst", "name": "ChartMaster_5K", "role": "Technical Analyst", "background": f"Age 42. CMT certified, 15 years of charting {ac} markets. Called major tops and bottoms. Runs a paid Discord.", "bias": "neutral", "personality": "Pure technical. If it's not on the chart, it doesn't exist. Says 'this level needs to hold.'"},
            {"id": "macro_economist", "name": "Dr. Elena Petrov", "role": "Macro Economist", "background": f"Age 52. Former central bank economist. Published 30+ papers on monetary policy. Views {asset} through the lens of rates, GDP, and dollar.", "bias": "bearish", "personality": "Academic, methodical. Cites papers and central bank minutes. Speaks in paragraphs."},
            {"id": "retail_trader", "name": "Jake Morrison", "role": "Active Retail Trader", "background": f"Age 31. Full-time swing trader for 5 years. Blew up first account, rebuilt. Trades {asset} on price action and momentum.", "bias": "bullish", "personality": "Blunt. 'The chart doesn't lie.' Quick to reverse position."},
            {"id": "short_seller", "name": "Dr. Michael Cross", "role": "Short Seller / Contrarian", "background": f"Age 49. Runs a short-focused fund. Made $200M in 2008. Sees overvaluation everywhere in {ac} markets.", "bias": "strongly_bearish", "personality": "Intense. Backs claims with forensic analysis. Says 'this is a zero' confidently."},
            {"id": "industry_insider", "name": "DeepIndustry", "role": f"{ac.title()} Industry Insider", "background": f"Age 39. Works directly in the {ac} industry. Knows supply/demand dynamics from the inside.", "bias": "cautious_bearish", "personality": "Cryptic. Says 'people would be surprised by the real numbers.' Drops hints."},
            {"id": "journalist", "name": "Sarah Chen", "role": "Financial Journalist", "background": f"Age 36. Senior {ac} correspondent at Bloomberg. Investigative background. Has sources everywhere.", "bias": "neutral", "personality": "Asks probing questions. Challenges bulls AND bears. 'But have you considered...'"},
            {"id": "geopolitical", "name": "Col. James Harris (Ret.)", "role": "Geopolitical Analyst", "background": f"Age 56. Former intelligence analyst, now geopolitical risk consultant. Views {asset} through the lens of wars, sanctions, and elections.", "bias": "cautious_bearish", "personality": "Sees risk everywhere. Speaks in scenarios. 'If X happens, then Y.'"},
            {"id": "contrarian", "name": "Nina Volkov", "role": "Contrarian Investor", "background": f"Age 44. Made her fortune buying when others panicked. Contrarian on {asset} by instinct. 'When everyone agrees, everyone is wrong.'", "bias": "contrarian", "personality": "Takes the opposite side. Calm when others panic. 'This is exactly when you buy.'"},
        ]


# ---------------------------------------------------------------------------
# Stage 4: Discussion Agent (one instance per entity per round)
# ---------------------------------------------------------------------------

DISCUSSION_PROMPT = """You are {name}, a {role}.
Background: {background}
Your natural bias: {bias}
Your personality: {personality}

You are on a live trading forum discussing the next price move of {asset_name} ({asset_class}).
This is round {round_num} of the discussion.

{market_context}

{thread_context}

YOUR TURN TO RESPOND. You MUST:
1. DIRECTLY RESPOND to 1-2 specific messages from other participants — quote them by name, say why you agree or disagree
2. Add YOUR unique perspective based on your expertise that others haven't mentioned
3. Stay FULLY in character as {name} — use your speaking style, your specific knowledge, your natural bias
4. If your opinion has SHIFTED based on what others said, explain why
5. If you feel confident, give a SPECIFIC price prediction with your timeframe

Your response should be SUBSTANTIAL — like a real analyst note (6-10 sentences). Cover:
- Your core thesis with SPECIFIC price levels, indicators, or data points backing it
- WHY you agree/disagree with others — not just "I agree with X" but "X's point about Y is valid because Z"
- Risk assessment: what could invalidate your thesis?
- A concrete trade setup if you have one: entry, stop, target, timeframe
Don't be generic or surface-level. Each response should add NEW information the thread hasn't covered yet.
If you need specific chart data (e.g., "what does the 4H look like?"), ask for it.

Respond with ONLY valid JSON (no markdown fences):
{{
  "content": "Your forum post responding to the discussion",
  "sentiment": 0.5,
  "price_prediction": null,
  "agreed_with": [],
  "disagreed_with": [],
  "data_request": null
}}

sentiment: -1.0 = very bearish to +1.0 = very bullish
price_prediction: specific number or null
agreed_with / disagreed_with: names of people you explicitly referenced
data_request: null, or "4H chart" / "weekly data" etc."""


class DiscussionAgent:
    """Represents one entity speaking in one round of discussion."""

    def __init__(self, entity: dict, asset_info: dict):
        self.entity = entity
        self.asset_info = asset_info

    def speak(self, market_summary: str, thread_so_far: str, report_excerpt: str = "", round_num: int = 1) -> dict:
        market_context = f"## Market Data\n{market_summary[:1500]}"
        if report_excerpt:
            market_context += f"\n\n## Research Report Excerpt\n{report_excerpt[:800]}"

        thread_context = ""
        if thread_so_far:
            recent_thread = thread_so_far[-5000:] if len(thread_so_far) > 5000 else thread_so_far
            thread_context = f"## Recent Discussion\n{recent_thread}"

        # Entity dicts from the LLM may use varying key names — be defensive
        e = self.entity
        name = e.get("name") or e.get("label") or e.get("id", "Analyst")
        role = e.get("role") or e.get("label") or "Analyst"

        prompt = DISCUSSION_PROMPT.format(
            name=name,
            role=role,
            background=e.get("background", ""),
            bias=e.get("bias", "neutral"),
            personality=e.get("personality", ""),
            asset_name=self.asset_info.get("asset_name", "the asset"),
            asset_class=self.asset_info.get("asset_class", "unknown"),
            market_context=market_context,
            thread_context=thread_context,
            round_num=round_num,
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
            user_message="Your turn. Speak now. Give a detailed, substantive response with specific data points and price levels.",
            temperature=0.6,
            max_tokens=800,
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

SUMMARY_PROMPT = """You are a senior chief investment strategist synthesizing a multi-agent discussion panel about {asset_name} ({asset_class}).

You've observed {entity_count} panelists debate across {round_count} rounds with {message_count} total messages.

## Early consensus (rounds 1-3):
{early_thread}

## Mid-debate developments (middle rounds):
{mid_thread}

## Final positions (last 3 rounds):
{late_thread}

## Your task
Produce a DEEP, ACTIONABLE investment report. This is NOT a casual summary — it's a professional research note that a portfolio manager would use to make a real trading decision. Be specific with price levels, timeframes, and risk quantification.

Respond with ONLY valid JSON (no markdown fences):
{{
  "consensus_direction": "BULLISH",
  "confidence": 72,
  "key_arguments": [
    "Argument 1 — with specific price level or data point",
    "Argument 2 — cite which panelists agree and their reasoning",
    "Argument 3 — reference technical or fundamental evidence mentioned",
    "Argument 4 — note any supporting cross-asset signals",
    "Argument 5 — mention volume, momentum, or sentiment evidence"
  ],
  "dissenting_views": [
    "Contrarian view 1 — cite the panelist and their specific concern",
    "Contrarian view 2 — note what would need to happen for bears to be right"
  ],
  "price_targets": {{ "low": 58000, "mid": 65000, "high": 75000 }},
  "risk_factors": [
    "Risk 1 — specific trigger event, not generic",
    "Risk 2 — quantified probability or impact if possible",
    "Risk 3 — timeframe-specific risk"
  ],
  "recommendation": {{
    "action": "BUY",
    "entry": 62000,
    "stop": 58000,
    "target": 72000,
    "position_size_pct": 2.0
  }}
}}

consensus_direction: BULLISH / BEARISH / NEUTRAL
confidence: an INTEGER from 0 to 100 representing the percentage of panelist alignment. For example, 72 means 72% of panelists agree on the direction. NEVER use a decimal like 0.72 — use the integer 72."""


class SummaryAgent:
    def summarize(self, thread_text: str, asset_info: dict, entity_count: int = 0, round_count: int = 0, message_count: int = 0) -> dict:
        # Split thread into early/mid/late for the summary prompt to see
        # the full arc of the debate, not just the last N chars.
        lines = thread_text.split("\n")
        third = max(1, len(lines) // 3)
        early_text = "\n".join(lines[:third])[-3000:]
        mid_text = "\n".join(lines[third:2*third])[-3000:]
        late_text = "\n".join(lines[2*third:])[-4000:]

        prompt = SUMMARY_PROMPT.format(
            asset_name=asset_info.get("asset_name", "Unknown"),
            asset_class=asset_info.get("asset_class", "unknown"),
            entity_count=entity_count,
            round_count=round_count,
            message_count=message_count,
            early_thread=early_text,
            mid_thread=mid_text,
            late_thread=late_text,
        )

        if not llm_available():
            return {
                "consensus_direction": "NEUTRAL",
                "confidence": 50,
                "key_arguments": ["Mock: LLM unavailable for summary"],
                "dissenting_views": [],
                "price_targets": {"low": 0, "mid": 0, "high": 0},
                "risk_factors": ["LLM not configured"],
                "recommendation": {"action": "HOLD", "entry": None, "stop": None, "target": None, "position_size_pct": 0},
            }

        result = chat_completion_json(
            system_prompt=prompt,
            user_message="Produce a deep, professional investment research report. Be specific with price levels, timeframes, and risk quantification. This should read like a real trading desk note.",
            temperature=0.3,
            max_tokens=3000,
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
