"""
Swarm Intelligence Engine — MiroFish-inspired 5-stage pipeline.

  Stage 1: ContextAnalyzer + AssetClassifier — extract knowledge from data
  Stage 2: EntityGenerator — create personas with stances + influence weights
  Stage 3: DiscussionAgent — debate with memory + selective routing
  Stage 4: CrossExaminer — targeted follow-up to divergent agents
  Stage 5: ReACTReportAgent — multi-step report with interview tool
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

CRITICAL: Use the PRICE RANGE to identify the asset. A $60-$100 price range is NOT Bitcoin
(which trades at $50K-$100K). It could be crude oil, a mid-cap stock, or a commodity.
Match the price range to the asset class:
  - $50K-$100K → likely Bitcoin
  - $2K-$5K → likely Ethereum or gold
  - $100-$300 → likely a large-cap stock (AAPL, MSFT)
  - $20-$200 → likely a commodity (crude oil, natural gas) or mid-cap stock
  - $1-$50 → likely a small-cap stock, forex pair, or altcoin

Respond with ONLY valid JSON (no markdown fences):
{{
  "asset_class": "<crypto|stock|commodity|forex|index|etf>",
  "asset_name": "<Full Name (TICKER)>",
  "description": "<One sentence describing the asset>",
  "price_drivers": ["driver 1", "driver 2", "driver 3", "driver 4"]
}}"""


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
stance options: bull, bear, neutral, observer (observers fact-check and flag inconsistencies — they don't argue a direction)
influence: a number from 0.5 to 3.0. Institutional PMs and senior analysts get 2.0-3.0. Retail traders and media get 0.5-1.0. Quants and researchers get 1.5-2.0. Observers get 1.0.

ALSO include these ADDITIONAL fields for each entity:
  "stance": "bull" | "bear" | "neutral" | "observer"
  "influence": 1.5
  "specialization": "technical" | "fundamental" | "macro" | "sentiment" | "quant" | "industry" | "geopolitical" | "general"

Include AT LEAST 2-3 OBSERVER entities whose job is NOT to have a bull/bear opinion but to:
- Fact-check other agents' claims
- Flag logical inconsistencies
- Point out when someone's conclusion doesn't follow from their data
- Track which arguments are supported by evidence vs. opinion

Generate exactly 40-50 entities. Maximum diversity and depth. Each must feel like a real person."""


class EntityGenerator:
    TARGET_ENTITIES = 50
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

        # Assign tools to each entity based on their specialization
        from core.agents.swarm_tools import ROLE_TOOL_MAP
        for entity in all_entities:
            spec = entity.get("specialization", "general")
            entity["tools"] = ROLE_TOOL_MAP.get(spec, ROLE_TOOL_MAP["general"])

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
5. If you feel confident, give a SPECIFIC price prediction with your timeframe.
   CRITICAL: Price predictions MUST be in the CORRECT SCALE for the asset.
   Look at the current price in the market data above. If the asset trades
   at ~$90, your prediction should be in the $70-$120 range — NOT $70,000-$120,000.
   If the asset trades at ~$85,000, then $80,000-$100,000 is appropriate.

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
            recent_thread = thread_so_far[-8000:] if len(thread_so_far) > 8000 else thread_so_far
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
            max_tokens=1200,
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
  "price_targets": {{ "low": "<number matching asset price scale>", "mid": "<number>", "high": "<number>" }},
  "risk_factors": [
    "Risk 1 — specific trigger event, not generic",
    "Risk 2 — quantified probability or impact if possible",
    "Risk 3 — timeframe-specific risk"
  ],
  "recommendation": {{
    "action": "BUY",
    "entry": "<price matching the asset's actual price scale>",
    "stop": "<price below entry>",
    "target": "<price above entry>",
    "position_size_pct": 2.0
  }}
}}

consensus_direction: BULLISH / BEARISH / NEUTRAL
confidence: an INTEGER from 0 to 100 representing the percentage of panelist alignment. For example, 72 means 72% of panelists agree on the direction. NEVER use a decimal like 0.72 — use the integer 72.

CRITICAL: All price targets, entry, stop, and target values MUST match the asset's ACTUAL price scale from the market data. If the asset trades at ~$90, targets should be $80-$100 range. If it trades at ~$85,000, targets should be $75,000-$95,000. NEVER use BTC-scale prices for non-BTC assets."""


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

# ---------------------------------------------------------------------------
# Data Feed Builder — creates rich, specialization-specific data for agents
# ---------------------------------------------------------------------------


class DataFeedBuilder:
    """
    Builds different data views for different agent specializations.
    Technical agents see candlestick patterns and indicators.
    Fundamental agents see volume trends and price structure.
    Macro agents see multi-timeframe context.
    Quant agents see statistical properties.
    """

    @staticmethod
    def build_feeds(bars: list, symbol: str) -> Dict[str, str]:
        """Build all data feeds from raw bars. Returns dict of feed_name → text."""
        if not bars:
            return {"general": "No data available."}

        closes = [b["close"] for b in bars]
        highs = [b["high"] for b in bars]
        lows = [b["low"] for b in bars]
        volumes = [b.get("volume", 0) for b in bars]
        n = len(bars)

        feeds: Dict[str, str] = {}

        # ── General feed (for all agents as baseline) ──
        feeds["general"] = format_ohlc_summary(bars, symbol, f"Full ({n} bars)")

        # ── Technical feed: last 50 bars as actual OHLC + pattern info ──
        tech_lines = [f"## {symbol} — Last 50 bars (raw OHLC data)"]
        recent = bars[-50:] if n > 50 else bars
        for b in recent:
            t = b.get("time", 0)
            tech_lines.append(
                f"  T={t} O={b['open']:.2f} H={b['high']:.2f} L={b['low']:.2f} C={b['close']:.2f} V={b.get('volume',0):.0f}"
            )
        # Add candle patterns in last 10 bars
        tech_lines.append("\n## Recent candle analysis (last 10 bars):")
        for i in range(-min(10, n), 0):
            b = bars[i]
            body = abs(b["close"] - b["open"])
            total = b["high"] - b["low"] if b["high"] != b["low"] else 0.0001
            body_ratio = body / total
            direction = "green" if b["close"] >= b["open"] else "red"
            upper_wick = b["high"] - max(b["close"], b["open"])
            lower_wick = min(b["close"], b["open"]) - b["low"]
            pattern = "doji" if body_ratio < 0.1 else "hammer" if lower_wick > body * 2 else "shooting_star" if upper_wick > body * 2 else "marubozu" if body_ratio > 0.85 else "normal"
            tech_lines.append(f"  Bar[{i}]: {direction} {pattern} body={body_ratio:.0%} range={total:.2f}")
        feeds["technical"] = "\n".join(tech_lines)

        # ── Volume feed: volume analysis ──
        vol_lines = [f"## {symbol} — Volume Analysis"]
        if any(v > 0 for v in volumes):
            avg_vol = sum(volumes[-20:]) / min(20, n)
            recent_vol = volumes[-1] if volumes else 0
            vol_ratio = recent_vol / avg_vol if avg_vol > 0 else 0
            vol_lines.append(f"Current volume: {recent_vol:,.0f}")
            vol_lines.append(f"20-bar avg volume: {avg_vol:,.0f}")
            vol_lines.append(f"Volume ratio: {vol_ratio:.2f}x average")
            # Volume trend
            if n >= 20:
                early_avg = sum(volumes[-20:-10]) / 10
                late_avg = sum(volumes[-10:]) / 10
                trend = "increasing" if late_avg > early_avg * 1.1 else "decreasing" if late_avg < early_avg * 0.9 else "flat"
                vol_lines.append(f"Volume trend: {trend}")
            # High volume bars (potential institutional activity)
            vol_lines.append("\nHigh-volume bars (>2x average):")
            for i in range(-min(50, n), 0):
                if volumes[i] > avg_vol * 2:
                    b = bars[i]
                    direction = "up" if b["close"] > b["open"] else "down"
                    vol_lines.append(f"  Bar[{i}]: {direction} close={b['close']:.2f} vol={volumes[i]:,.0f} ({volumes[i]/avg_vol:.1f}x)")
        feeds["volume"] = "\n".join(vol_lines)

        # ── Statistical feed: for quant agents ──
        stat_lines = [f"## {symbol} — Statistical Properties"]
        if n >= 20:
            import statistics
            returns = [(closes[i] - closes[i-1]) / closes[i-1] for i in range(1, n) if closes[i-1] != 0]
            if returns:
                stat_lines.append(f"Mean return: {statistics.mean(returns)*100:.4f}%")
                stat_lines.append(f"Std dev: {statistics.stdev(returns)*100:.4f}%")
                stat_lines.append(f"Skewness: {sum((r - statistics.mean(returns))**3 for r in returns) / (len(returns) * statistics.stdev(returns)**3):.2f}" if statistics.stdev(returns) > 0 else "Skewness: N/A")
                stat_lines.append(f"Max drawdown from peak: {min(returns)*100:.2f}%")
                stat_lines.append(f"Best single bar: {max(returns)*100:.2f}%")
                # Autocorrelation (are returns trending or mean-reverting?)
                if len(returns) > 5:
                    lag1 = sum(returns[i] * returns[i-1] for i in range(1, len(returns))) / sum(r**2 for r in returns) if sum(r**2 for r in returns) > 0 else 0
                    stat_lines.append(f"Lag-1 autocorrelation: {lag1:.3f} ({'trending' if lag1 > 0.1 else 'mean-reverting' if lag1 < -0.1 else 'random walk'})")
                # Distribution of returns
                pos = sum(1 for r in returns if r > 0)
                stat_lines.append(f"Up bars: {pos}/{len(returns)} ({pos/len(returns)*100:.0f}%)")
        feeds["quant"] = "\n".join(stat_lines)

        # ── Multi-timeframe feed: for macro agents ──
        mtf_lines = [f"## {symbol} — Multi-Timeframe View"]
        mtf_lines.append(format_ohlc_summary(bars, symbol, f"Base ({n} bars)"))
        # Compute longer-term context
        if n >= 50:
            mtf_lines.append(f"\n50-bar performance: {((closes[-1] - closes[-50]) / closes[-50] * 100):+.2f}%")
        if n >= 200:
            mtf_lines.append(f"200-bar performance: {((closes[-1] - closes[-200]) / closes[-200] * 100):+.2f}%")
            # Trend structure
            sma50 = sum(closes[-50:]) / 50
            sma200 = sum(closes[-200:]) / 200
            mtf_lines.append(f"SMA50 vs SMA200: {'golden cross (bullish)' if sma50 > sma200 else 'death cross (bearish)'}")
        if n >= 20:
            # Support/resistance from price clustering
            price_min, price_max = min(lows[-100:] if n >= 100 else lows), max(highs[-100:] if n >= 100 else highs)
            bucket_size = (price_max - price_min) / 20 if price_max > price_min else 1
            buckets: Dict[int, int] = {}
            for h, l in zip(highs[-100:] if n >= 100 else highs, lows[-100:] if n >= 100 else lows):
                for price in [h, l]:
                    b_idx = int((price - price_min) / bucket_size)
                    buckets[b_idx] = buckets.get(b_idx, 0) + 1
            top_levels = sorted(buckets.items(), key=lambda x: -x[1])[:5]
            mtf_lines.append("\nKey price levels (by touch frequency):")
            for b_idx, count in top_levels:
                level = price_min + b_idx * bucket_size
                mtf_lines.append(f"  ${level:.2f} — {count} touches")
        feeds["macro"] = "\n".join(mtf_lines)

        # ── Price structure feed: for fundamental/industry agents ──
        struct_lines = [f"## {symbol} — Price Structure"]
        if n >= 5:
            # Recent swing highs/lows
            swings_high = []
            swings_low = []
            for i in range(2, min(n - 2, 100)):
                if highs[-i] > highs[-i-1] and highs[-i] > highs[-i+1] and highs[-i] > highs[-i-2]:
                    swings_high.append(highs[-i])
                if lows[-i] < lows[-i-1] and lows[-i] < lows[-i+1] and lows[-i] < lows[-i-2]:
                    swings_low.append(lows[-i])
            if swings_high:
                struct_lines.append(f"Recent swing highs: {', '.join(f'${p:.2f}' for p in swings_high[:5])}")
            if swings_low:
                struct_lines.append(f"Recent swing lows: {', '.join(f'${p:.2f}' for p in swings_low[:5])}")
            # Higher highs / lower lows structure
            if len(swings_high) >= 2:
                hh = swings_high[0] > swings_high[1]
                struct_lines.append(f"Swing structure: {'higher highs (uptrend)' if hh else 'lower highs (downtrend)'}")
            if len(swings_low) >= 2:
                hl = swings_low[0] > swings_low[1]
                struct_lines.append(f"Swing lows: {'higher lows (uptrend)' if hl else 'lower lows (downtrend)'}")
        feeds["structure"] = "\n".join(struct_lines)

        return feeds


# ---------------------------------------------------------------------------
# Stage 1.5 (new): Intelligence Gatherer — pre-debate internet research
# ---------------------------------------------------------------------------

INTELLIGENCE_PROMPT = """You are a research analyst preparing a comprehensive intelligence briefing about {asset_name} ({asset_class}).

You have gathered the following raw research from multiple sources. Your job is to synthesize it into a STRUCTURED BRIEFING that debate panelists can use.

## Recent News
{news}

## Market Analysis
{analysis}

## Regulatory Updates
{regulatory}

## Technical Indicator Readings
{indicators}

## Key Price Levels
{levels}

Produce a structured intelligence briefing as JSON:
{{
  "executive_summary": "2-3 sentence overview of the current situation",
  "bull_case": ["3-5 specific bullish factors with data"],
  "bear_case": ["3-5 specific bearish factors with data"],
  "key_events": ["upcoming events that could move the price"],
  "sentiment_reading": "overall market sentiment from news (bullish/bearish/mixed)",
  "data_points": ["specific numbers, dates, or facts from the research that panelists should cite"]
}}"""


class IntelligenceGatherer:
    """
    Pre-debate research agent. Runs a comprehensive research suite
    (web search, news, indicators, levels) and synthesizes findings
    into a structured briefing for all debate personas.
    """

    def gather(self, asset_name: str, asset_class: str, bars: list) -> dict:
        from core.agents.swarm_tools import run_research_suite

        # Run the full research suite (web + indicators + levels)
        raw_findings = run_research_suite(asset_name, asset_class, bars)

        if not llm_available():
            return {
                "executive_summary": "Research unavailable (no LLM)",
                "bull_case": [],
                "bear_case": [],
                "key_events": [],
                "sentiment_reading": "unknown",
                "data_points": [],
                "raw_findings": raw_findings,
            }

        prompt = INTELLIGENCE_PROMPT.format(
            asset_name=asset_name,
            asset_class=asset_class,
            news=raw_findings.get("recent_news", "None")[:3000],
            analysis=raw_findings.get("market_analysis", "None")[:2000],
            regulatory=raw_findings.get("regulatory", "None")[:1500],
            indicators=raw_findings.get("technical_indicators", "None")[:1000],
            levels=raw_findings.get("key_levels", "None")[:500],
        )

        result = chat_completion_json(
            system_prompt=prompt,
            user_message="Synthesize the research into a structured briefing now.",
            temperature=0.2,
            max_tokens=2000,
        )
        result.setdefault("executive_summary", "")
        result.setdefault("bull_case", [])
        result.setdefault("bear_case", [])
        result.setdefault("key_events", [])
        result.setdefault("sentiment_reading", "unknown")
        result.setdefault("data_points", [])
        result["raw_findings"] = raw_findings
        return result


# ---------------------------------------------------------------------------
# Stage 1 (new): Context Analyzer — extracts structured knowledge from data
# ---------------------------------------------------------------------------

CONTEXT_ANALYSIS_PROMPT = """You are a senior market analyst. Analyze this OHLC market data and extract structured knowledge.

## Data
{data_summary}

## User Context
{report_text}

Extract the following as JSON:
{{
  "market_regime": "trending_up | trending_down | ranging | breakout | breakdown | volatile",
  "key_price_levels": {{
    "strong_resistance": [list of 2-3 significant resistance levels],
    "strong_support": [list of 2-3 significant support levels],
    "recent_pivot": "the most recent swing high or low price"
  }},
  "technical_signals": [
    "Signal 1 — specific observation (e.g. 'price above 200 SMA, bullish trend')",
    "Signal 2 — specific observation",
    "Signal 3 — specific observation"
  ],
  "volume_analysis": "brief volume trend observation",
  "key_themes": ["theme 1 from user context or data", "theme 2", "theme 3"],
  "risk_events": ["potential risk 1", "potential risk 2"]
}}"""


class ContextAnalyzer:
    """Stage 1: Extract structured knowledge from OHLC data + context."""

    def analyze(self, bars: list, symbol: str, report_text: str = "") -> dict:
        data_summary = format_ohlc_summary(bars, symbol, "Analysis")

        if not llm_available():
            return {
                "market_regime": "unknown",
                "key_price_levels": {"strong_resistance": [], "strong_support": [], "recent_pivot": 0},
                "technical_signals": [],
                "volume_analysis": "N/A",
                "key_themes": [],
                "risk_events": [],
            }

        result = chat_completion_json(
            system_prompt=CONTEXT_ANALYSIS_PROMPT.format(
                data_summary=data_summary,
                report_text=report_text[:2000] if report_text else "None provided",
            ),
            user_message="Analyze the data and extract structured knowledge now.",
            temperature=0.2,
            max_tokens=1000,
        )
        result.setdefault("market_regime", "unknown")
        result.setdefault("key_price_levels", {})
        result.setdefault("technical_signals", [])
        result.setdefault("key_themes", [])
        return result


# ---------------------------------------------------------------------------
# Stage 4 (new): Cross-Examiner — targeted follow-up to divergent agents
# ---------------------------------------------------------------------------

CROSS_EXAM_PROMPT = """You are {name}, a {role}.
Background: {background}

You just finished a multi-round debate about {asset_name}. Now you are being
CROSS-EXAMINED by the moderator. You must defend your thesis.

## The question directed at you:
{question}

## Your previous positions in the debate:
{positions}

## Key counterarguments from other panelists:
{counterarguments}

RULES:
1. Address the specific question directly — don't dodge
2. Acknowledge valid counterarguments before rebutting them
3. If your view has shifted, explain exactly what changed your mind and by how much
4. Give a FINAL price prediction with confidence level and timeframe
5. Stay in character

Respond with JSON:
{{
  "content": "Your detailed response to the cross-examination",
  "final_sentiment": 0.5,
  "final_price_prediction": null,
  "conviction_change": "unchanged | strengthened | weakened | reversed"
}}"""


class CrossExaminer:
    """Stage 4: Cross-examine the most divergent agents after the main debate."""

    def examine(
        self,
        thread: list,
        entities: list,
        asset_info: dict,
        market_summary: str,
    ) -> list:
        """Pick 3-5 key agents and ask pointed questions."""
        if not llm_available() or len(thread) < 5:
            return []

        # Find the most divergent agents by sentiment spread
        agent_sentiments: Dict[str, list] = {}
        agent_messages: Dict[str, list] = {}
        for msg in thread:
            eid = msg.get("entity_id", "")
            if eid == "chart_support":
                continue
            agent_sentiments.setdefault(eid, []).append(msg.get("sentiment", 0))
            agent_messages.setdefault(eid, []).append(msg.get("content", "")[:150])

        if not agent_sentiments:
            return []

        # Score agents by how extreme + influential they are
        scored = []
        for eid, sents in agent_sentiments.items():
            avg = sum(sents) / len(sents) if sents else 0
            entity = next((e for e in entities if e.get("id") == eid), None)
            if not entity:
                continue
            influence = float(entity.get("influence", 1.0))
            extremity = abs(avg) * influence
            scored.append((extremity, eid, entity, avg))

        scored.sort(key=lambda x: -x[0])
        # Pick top 6 most extreme (highest conviction * influence)
        targets = scored[:6]
        # Also pick 2 from the opposite side if available
        if len(scored) > 6:
            top_direction = scored[0][3]  # sentiment of most extreme
            opposite = [s for s in scored[6:] if s[3] * top_direction < 0]
            targets.extend(opposite[:2])

        results = []
        for _, eid, entity, avg_sent in targets:
            positions = "\n".join(f"- {m}" for m in agent_messages.get(eid, []))
            # Find counterarguments from agents with opposite sentiment
            opposite_msgs = [
                f"{msg['entity_name']}: {msg['content'][:200]}"
                for msg in thread
                if msg.get("entity_id") != eid
                and msg.get("sentiment", 0) * avg_sent < 0  # opposite sign
                and not msg.get("is_chart_support")
            ][:3]
            counterargs = "\n".join(opposite_msgs) if opposite_msgs else "None — you're in the minority."

            direction = "bullish" if avg_sent > 0 else "bearish" if avg_sent < 0 else "neutral"
            question = (
                f"You've been consistently {direction} throughout this debate. "
                f"Several panelists disagree with you. Can you defend your thesis "
                f"against their specific objections? What would change your mind?"
            )

            prompt = CROSS_EXAM_PROMPT.format(
                name=entity.get("name", "Analyst"),
                role=entity.get("role", "Analyst"),
                background=entity.get("background", ""),
                asset_name=asset_info.get("asset_name", "the asset"),
                question=question,
                positions=positions,
                counterarguments=counterargs,
            )

            result = chat_completion_json(
                system_prompt=prompt,
                user_message="Respond to the cross-examination now. Be thorough — defend or revise with specific evidence.",
                temperature=0.4,
                max_tokens=1000,
            )

            response_content = result.get("content", "No response.")
            results.append({
                "id": str(uuid.uuid4()),
                "entity_id": eid,
                "entity_name": entity.get("name", "Unknown"),
                "entity_role": entity.get("role", "Analyst"),
                # For thread display
                "content": f"[Cross-examination] {response_content}",
                "sentiment": float(result.get("final_sentiment", avg_sent)),
                "price_prediction": result.get("final_price_prediction"),
                "agreed_with": [],
                "disagreed_with": [],
                "is_chart_support": False,
                "data_request": None,
                "influence": float(entity.get("influence", 1.0)),
                "stance": entity.get("stance", "neutral"),
                "conviction_change": result.get("conviction_change", "unchanged"),
                # For structured UI display (CrossExamResult)
                "question": question,
                "response": response_content,
                "new_sentiment": float(result.get("final_sentiment", avg_sent)),
            })

        return results


# ---------------------------------------------------------------------------
# Stage 5 (new): ReACT Report Agent — multi-step with tools
# ---------------------------------------------------------------------------

REACT_REPORT_PROMPT = """You are a chief investment strategist writing a professional research note about {asset_name} ({asset_class}).

You observed {entity_count} panelists debate across {round_count} rounds ({message_count} messages), followed by a cross-examination round.

You have access to these analytical tools — USE ALL OF THEM before writing your report:

TOOL 1 — DEEP_ANALYSIS: Analyze the full debate thread to find consensus clusters,
  divergence points, and sentiment evolution across rounds.
TOOL 2 — INTERVIEW: Ask a specific agent a follow-up question about their analysis.
TOOL 3 — VERIFY: Cross-reference a claim from the debate against the actual market data.

## Market Context
{market_context}

## Knowledge Base
Market regime: {regime}
Key support: {support}
Key resistance: {resistance}
Technical signals: {signals}

## RAW MARKET DATA (for VERIFY tool — cross-reference claims against this)
{raw_data}

## VOLUME & INSTITUTIONAL ACTIVITY DATA
{volume_data}

## STATISTICAL PROPERTIES
{quant_data}

## Debate Summary (early rounds)
{early_thread}

## Debate Summary (late rounds + cross-examination)
{late_thread}

## Instructions
1. First, call DEEP_ANALYSIS mentally — identify the 3 strongest bull arguments, 3 strongest bear arguments, and which side had higher-influence panelists
2. Then INTERVIEW mentally — pick 2 agents whose views changed during the debate and analyze WHY
3. Then VERIFY mentally — check if the key price levels mentioned by panelists match the actual data
4. Finally, write a DETAILED research note

Your report MUST:
- Cite specific panelists by name ("As Marcus noted in round 3...")
- Reference actual price levels from the data (not vague "support/resistance")
- Quantify confidence based on influence-weighted sentiment
- Provide a concrete trade setup (entry, stop, target, position size)
- List specific triggers that would invalidate the thesis

Respond with JSON:
{{
  "consensus_direction": "BULLISH",
  "confidence": 72,
  "key_arguments": [
    "Argument 1 — cite panelist + specific data (min 2 sentences each)",
    "Argument 2 — cite panelist + specific data",
    "Argument 3 — cite panelist + specific data",
    "Argument 4 — cite panelist + specific data",
    "Argument 5 — cite panelist + specific data"
  ],
  "dissenting_views": [
    "View 1 — cite the dissenting panelist, their reasoning, and what would prove them right",
    "View 2 — cite dissenter"
  ],
  "price_targets": {{ "low": "<number matching asset price scale>", "mid": "<number>", "high": "<number>" }},
  "risk_factors": [
    "Risk 1 — specific trigger + estimated probability",
    "Risk 2 — specific trigger",
    "Risk 3 — specific trigger"
  ],
  "recommendation": {{
    "action": "BUY",
    "entry": "<price matching the asset's actual price scale>",
    "stop": "<price below entry>",
    "target": "<price above entry>",
    "position_size_pct": 2.0
  }},
  "conviction_shifts": [
    "Agent X shifted from bearish to neutral in round Y because Z"
  ]
}}

confidence: INTEGER 0-100 (influence-weighted agreement %). NEVER a decimal.

CRITICAL: All price targets, entry, stop, and target values MUST match the asset's ACTUAL
price scale. Look at the market data above — if the current price is ~$90, your targets should
be in the $70-$120 range. If the current price is ~$85,000, use $75,000-$95,000. NEVER mix
up scales (e.g., putting $85,000 targets for a $90 commodity)."""


# ---------------------------------------------------------------------------
# Interview Agent — on-demand follow-up Q&A after the debate completes
# ---------------------------------------------------------------------------

INTERVIEW_PROMPT = """You are {name}, a {role}.
Background: {background}
Natural bias: {bias}
Personality: {personality}

You just finished a multi-round debate about {asset_name} ({asset_class}).
A user is now asking YOU a follow-up question directly. Stay FULLY in
character — use your speaking style, your specific knowledge, your natural
bias. Reference your previous positions when relevant.

## Your previous positions in the debate:
{previous_positions}

## Previous interview exchange (if any):
{interview_history}

## User's question:
{question}

Answer in 4-8 sentences. Be direct, substantive, and in character. Cite
specific price levels or data points when possible. If the user's question
is outside your expertise, acknowledge it and give your best take anyway.

Respond with ONLY valid JSON (no markdown fences):
{{
  "response": "Your answer in character",
  "sentiment": 0.5
}}

sentiment: -1.0 (very bearish) to +1.0 (very bullish) based on your current stance.
"""


class InterviewAgent:
    """On-demand interview with a specific persona after the debate is done."""

    def ask(
        self,
        entity: dict,
        asset_info: dict,
        previous_positions: List[str],
        question: str,
        interview_history: Optional[List[Dict[str, str]]] = None,
    ) -> dict:
        """Ask this entity a follow-up question. Returns dict with response + sentiment."""
        if not llm_available():
            return {
                "response": f"[Mock] {entity.get('name', 'Agent')}: Interview requires an LLM API key.",
                "sentiment": 0.0,
            }

        positions_text = "\n".join(f"- {p}" for p in (previous_positions or [])[-5:]) or "No previous positions recorded."

        history_text = ""
        if interview_history:
            for turn in interview_history[-6:]:
                role_label = "User" if turn.get("role") == "user" else entity.get("name", "Agent")
                history_text += f"{role_label}: {turn.get('content', '')}\n"
        history_text = history_text or "(This is the first question.)"

        prompt = INTERVIEW_PROMPT.format(
            name=entity.get("name", "Analyst"),
            role=entity.get("role", "Analyst"),
            background=entity.get("background", ""),
            bias=entity.get("bias", "neutral"),
            personality=entity.get("personality", ""),
            asset_name=asset_info.get("asset_name", "the asset"),
            asset_class=asset_info.get("asset_class", "unknown"),
            previous_positions=positions_text,
            interview_history=history_text,
            question=question,
        )

        result = chat_completion_json(
            system_prompt=prompt,
            user_message="Answer the user's question now, in character.",
            temperature=0.5,
            max_tokens=800,
        )
        result.setdefault("response", f"{entity.get('name', 'Agent')}: I have no comment on that.")
        result.setdefault("sentiment", 0.0)
        return result


class ReACTReportAgent:
    """Stage 5: Multi-step ReACT report with deep analysis, interviews, and verification."""

    def generate_report(
        self,
        thread_text: str,
        thread: list,
        entities: list,
        asset_info: dict,
        knowledge: dict,
        entity_count: int = 0,
        round_count: int = 0,
        message_count: int = 0,
    ) -> dict:
        context = knowledge.get("context", {})
        regime = context.get("market_regime", "unknown")
        levels = context.get("key_price_levels", {})
        signals = context.get("technical_signals", [])

        # Split thread into early + late — give more to late (recent = more relevant)
        lines = thread_text.split("\n")
        third = max(1, len(lines) // 3)
        early = "\n".join(lines[:third])[-3000:]
        late = "\n".join(lines[third:])[-6000:]

        # Get raw data feeds for fact-checking
        data_feeds = knowledge.get("data_feeds", {})

        prompt = REACT_REPORT_PROMPT.format(
            asset_name=asset_info.get("asset_name", "Unknown"),
            asset_class=asset_info.get("asset_class", "unknown"),
            entity_count=entity_count,
            round_count=round_count,
            message_count=message_count,
            market_context=knowledge.get("market_summary", "")[:2000],
            regime=regime,
            support=json.dumps(levels.get("strong_support", [])),
            resistance=json.dumps(levels.get("strong_resistance", [])),
            signals="\n".join(f"- {s}" for s in signals[:5]),
            raw_data=data_feeds.get("technical", "N/A")[:3000],
            volume_data=data_feeds.get("volume", "N/A")[:1500],
            quant_data=data_feeds.get("quant", "N/A")[:1000],
            early_thread=early,
            late_thread=late,
        )

        if not llm_available():
            return {
                "consensus_direction": "NEUTRAL",
                "confidence": 50,
                "key_arguments": ["LLM unavailable"],
                "dissenting_views": [],
                "price_targets": {"low": 0, "mid": 0, "high": 0},
                "risk_factors": [],
                "recommendation": {"action": "HOLD"},
                "conviction_shifts": [],
            }

        result = chat_completion_json(
            system_prompt=prompt,
            user_message=(
                "Generate a detailed investment research note. "
                "Use the DEEP_ANALYSIS, INTERVIEW, and VERIFY tools mentally before writing. "
                "Cite specific panelists by name with round numbers. "
                "Reference actual price levels from the data."
            ),
            temperature=0.3,
            max_tokens=8000,
        )
        result.setdefault("consensus_direction", "NEUTRAL")
        result.setdefault("confidence", 50)
        result.setdefault("key_arguments", [])
        result.setdefault("dissenting_views", [])
        result.setdefault("price_targets", {"low": 0, "mid": 0, "high": 0})
        result.setdefault("risk_factors", [])
        result.setdefault("recommendation", {"action": "HOLD"})
        result.setdefault("conviction_shifts", [])

        # Normalize confidence
        conf = result["confidence"]
        if isinstance(conf, (int, float)) and conf <= 1.0:
            result["confidence"] = round(conf * 100)

        return result


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

import uuid  # noqa: E402 — needed by CrossExaminer


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
