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
        result.setdefault("asset_name", symbol)
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

Persona categories — cover ALL of these (2-3 personas per category):

PROFESSIONAL:
- Hedge fund PM / CIO (macro, long-short, multi-strat)
- Prop desk trader (high frequency, momentum)
- Family office advisor (wealth preservation, conservative)
- Venture capitalist (if crypto/tech — growth, early stage)

QUANTITATIVE:
- Quant researcher (ML models, backtesting, statistical)
- Algorithmic trader (systematic, execution-focused)

RETAIL:
- Conviction holder (DCA, long-term, high conviction)
- Active retail trader (swing trading, options)
- YOLO/meme trader (high risk, social media driven)

DOMAIN EXPERTS:
- Industry insider (miners for crypto, employees for stocks, farmers for commodities)
- Regulatory/legal analyst (government policy, compliance)
- On-chain/data analyst (if crypto — chain metrics, whale tracking)
- Sector specialist (the specific industry this asset belongs to)

ANALYSIS STYLES:
- Pure technical analyst (charts, Fibonacci, Elliott Wave, indicators)
- Fundamental analyst (DCF, earnings, revenue, competitive moat)
- Macro economist (rates, GDP, central bank, dollar, cross-asset)
- Geopolitical analyst (wars, sanctions, trade policy, elections)

CONTRARIANS & WILD CARDS:
- Permanent bear / skeptic (always argues against consensus)
- Contrarian (takes the opposite side of whatever is popular)
- Wild card outsider (brings unexpected perspective — philosopher, historian, psychologist)

MEDIA & COMMUNITY:
- Financial journalist (investigative, asks hard questions)
- Social media influencer (large following, shapes retail sentiment)
- Academic researcher (publishes papers, long-term structural view)

Respond with ONLY valid JSON (no markdown fences):
{{
  "entities": [
    {{
      "id": "marcus_wei",
      "name": "Marcus Wei",
      "role": "Macro Hedge Fund PM",
      "background": "Age 47. 15 years managing a $2B global macro fund at Citadel before going independent. CFA, MIT Sloan MBA. Famous for calling the 2022 crypto crash 3 months early. Lost 30% in 2020 being too bearish on tech. Now trades based on central bank policy divergences and cross-asset correlations. Manages risk religiously — never risks more than 2% per trade.",
      "bias": "cautious_bullish",
      "personality": "Speaks in measured, precise language. Always cites specific data points. Never uses exclamation marks. Prefers risk-adjusted returns over raw performance. Will say 'the data suggests' rather than 'I think'. Respects other analysts but challenges sloppy thinking."
    }},
    ...
  ]
}}

bias options: strongly_bullish, bullish, cautious_bullish, neutral, cautious_bearish, bearish, strongly_bearish, contrarian

Generate exactly 22-28 entities. Cover EVERY category above. Each one must feel like a real person you could have a conversation with — deep backstory, specific speaking style, earned bias."""


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
            max_tokens=8000,
        )
        entities = result.get("entities", [])
        if not entities or len(entities) < 5:
            return self._mock(asset_info)
        return entities[:28]

    def _mock(self, asset_info: dict) -> list:
        ac = asset_info.get("asset_class", "stock")
        if ac == "crypto":
            return [
                {"id": "marcus_wei", "name": "Marcus Wei", "role": "Macro Hedge Fund PM", "background": "Age 47. Ran a $2B macro fund at Citadel for 8 years, now independent. Called the 2022 crypto crash early. Lost 30% in 2020 being too bearish on tech. CFA, MIT Sloan. Trades based on central bank policy divergences.", "bias": "cautious_bullish", "personality": "Measured, precise. Says 'the data suggests' not 'I think'. Never uses exclamation marks. Cites specific numbers. Respects other analysts but dismantles sloppy reasoning."},
                {"id": "0xdegen", "name": "0xDegen", "role": "Crypto Whale / DeFi Degen", "background": "Age 29. Bought BTC at $200 in 2015, rode it to $69K, never sold. $50M+ portfolio across 40 protocols. Known for 100x leverage positions and viral Twitter threads. Lost $8M in the LUNA crash but 'learned nothing' by his own admission.", "bias": "strongly_bullish", "personality": "Chaotic energy. Uses crypto slang (ngmi, wagmi, ser). Drops alpha casually. Mocks bears as 'having fun staying poor'. Posts at 3am. Surprisingly sharp under the meme layer."},
                {"id": "ananya_patel", "name": "Dr. Ananya Patel", "role": "Quantitative Researcher", "background": "Age 34. PhD in statistical physics from Caltech, now at a crypto quant fund. Built ML models that predicted 3 of 4 major BTC moves in 2024. Refuses to look at Twitter or Reddit. Only trusts backtested signals.", "bias": "neutral", "personality": "Clinical, almost cold. 'Narratives are noise, show me the Sharpe ratio.' Uses precise decimal places. Will dismiss a bullish thesis if the p-value is above 0.05. Rarely changes her mind."},
                {"id": "jake_miller", "name": "Jake Miller", "role": "Retail DCA Investor", "background": "Age 31. Software engineer at a FAANG company. Has DCA'd $1000/month into BTC since 2020. Never traded, never sold. Read 'The Bitcoin Standard' twice. Down 15% on his total investment but doesn't care.", "bias": "bullish", "personality": "Earnest, conviction-based. Quotes Saylor and Satoshi. Genuinely believes in the technology. Gets emotional when people call BTC a scam. Says 'zoom out' a lot."},
                {"id": "elena_volkov", "name": "Dr. Elena Volkov", "role": "Macro Economist", "background": "Age 52. Former Fed economist for 12 years, now runs a research think tank. Published 40+ papers on monetary policy transmission. Called the 2008 crisis 6 months early. Thinks crypto is 'interesting but overhyped'.", "bias": "bearish", "personality": "Academic, methodical. Cites papers and Fed minutes. Uses phrases like 'given the current yield curve environment'. Gets frustrated when people ignore macro context. Speaks in paragraphs, not soundbites."},
                {"id": "glassnode_guru", "name": "Glassnode_Guru", "role": "On-Chain Analyst", "background": "Age 27. Runs the most popular on-chain analytics dashboard. 200K followers. Never reveals real name. Has predicted 5 of 7 major BTC tops using SOPR and MVRV. Background in data engineering.", "bias": "neutral", "personality": "Lets data speak. Posts charts, not opinions. Says 'the chain tells us...' rather than 'I believe'. Corrects other analysts' on-chain misinterpretations. Dry humor."},
                {"id": "zhang_wei", "name": "Zhang Wei", "role": "Bitcoin Miner / Farm Operator", "background": "Age 41. Runs a 500PH/s mining operation in Texas. Previously mined in Sichuan before China ban. Survived 3 bear markets. Knows production costs to the penny. Has 2000+ BTC in cold storage.", "bias": "bullish", "personality": "Practical, no-nonsense. Thinks in terms of production cost floors and hash rate. 'BTC can't stay below miner cost for long.' Quietly confident. Doesn't argue, just states facts about mining economics."},
                {"id": "peter_gold", "name": "Peter Thornton", "role": "Gold Bug / Crypto Skeptic", "background": "Age 58. 30 years in precious metals trading. Managed gold ETF. Thinks crypto is 'tulip mania 2.0'. Has been calling the top since $1000. Lost clients who went into BTC and outperformed him 50x.", "bias": "strongly_bearish", "personality": "Dismissive, condescending about crypto. Says 'when, not if' about crypto crashing. Compares everything to gold. Gets genuinely angry when people call gold a boomer asset. Uses sarcasm heavily."},
                {"id": "maria_defi", "name": "Maria Santos", "role": "DeFi Protocol Lead", "background": "Age 30. Lead developer on a top-10 DeFi protocol. Stanford CS grad. Understands tokenomics deeply. Sees BTC as 'digital gold but missing programmability'. Holds 70% ETH, 20% BTC, 10% alts.", "bias": "cautious_bullish", "personality": "Technical, ecosystem-focused. Explains complex things simply. Gets excited about protocol upgrades. Says 'this is actually bullish because...' after bad news. Optimistic but not naive."},
                {"id": "sarah_chen", "name": "Sarah Chen", "role": "Financial Journalist", "background": "Age 36. Senior crypto correspondent at Bloomberg. Won a Polk Award for investigation into FTX collapse. Has sources at 5 major exchanges. Knows things before they're public but can't always say.", "bias": "neutral", "personality": "Asks probing questions. Challenges bulls AND bears. Says 'but have you considered...' a lot. Drops hints about upcoming news without revealing sources. Professional but with a wry sense of humor."},
            ]
        return [
            {"id": "robert_hayes", "name": "Robert Hayes", "role": "Value Fund Manager", "background": "Age 55. 25 years managing a $5B value fund. Outperformed S&P in 18 of 25 years. Berkshire disciple. Only buys below intrinsic value. Missed the entire tech rally of 2020-2021.", "bias": "cautious_bullish", "personality": "Patient, methodical. Talks about 'margin of safety' and 'circle of competence'. Uses annual letter to shareholders language. Slow to change his mind. Cites Buffett and Munger constantly."},
            {"id": "mike_chen", "name": "Mike Chen", "role": "Day Trader / Price Action", "background": "Age 38. Full-time trader since 2016. Blew up his first account, rebuilt to $2M. Trades only price action and volume. Has a rule: 'if I can't explain the trade in one sentence, I don't take it.'", "bias": "neutral", "personality": "Blunt, aggressive. Only cares about the next 1-5 candles. Says 'the chart doesn't lie' and 'stop overthinking it'. Gets impatient with fundamental analysis. Quick to reverse position."},
            {"id": "sarah_kim", "name": "Dr. Sarah Kim", "role": "Sell-Side Equity Analyst", "background": "Age 33. Covers the sector at Goldman Sachs. Wharton MBA. Built the DCF model everyone copies. Known for conservative price targets that end up being right 70% of the time.", "bias": "neutral", "personality": "Rigorous, numbers-first. Builds everything from the model up. Says 'at current multiples' and 'assuming normalized margins'. Gets annoyed by analysts who don't show their work."},
            {"id": "tom_wsb", "name": "Tom 'DiamondHands' Rivera", "role": "Retail Investor / WallStreetBets", "background": "Age 26. Turned $5K into $180K during GameStop, then lost $120K on options. Still up overall. Full-time content creator now. 500K TikTok followers. YOLO mentality.", "bias": "bullish", "personality": "Loud, meme-heavy. Uses rocket emojis and 'to the moon'. Actually quite self-aware about his gambling addiction. Surprisingly likeable. Says 'this is not financial advice' before giving financial advice."},
            {"id": "michael_short", "name": "Dr. Michael Cross", "role": "Short Seller / Contrarian", "background": "Age 49. Runs a short-focused fund. Made $200M shorting in 2008. Published 3 famous short reports that brought down fraudulent companies. Currently short 12 positions. Investigated by the SEC twice (cleared both times).", "bias": "strongly_bearish", "personality": "Intense, confrontational. Sees fraud and overvaluation everywhere. Says 'this company is a zero' with alarming confidence. Backs every claim with forensic accounting. Secretly respects good companies but never admits it."},
            {"id": "janet_macro", "name": "Janet Thornburg", "role": "Global Macro Strategist", "background": "Age 44. Chief strategist at a top-3 investment bank. Former Treasury official. Testified before Congress on market structure. Her weekly note moves markets when leaked.", "bias": "neutral", "personality": "Top-down, rates-focused. Sees everything through the lens of the Fed, yields, and dollar strength. Uses 'in the context of' and 'against the backdrop of'. Polished, careful with words because she knows people trade on them."},
            {"id": "chartmaster", "name": "ChartMaster_5000", "role": "Technical Analyst", "background": "Age 42. CMT certified, 15 years of charting. Called the 2020 COVID bottom within 2 days using Fibonacci extensions. Runs a paid Discord with 8000 members. Has a Fibonacci tattoo.", "bias": "neutral", "personality": "Pure technical. If it's not on the chart, it doesn't exist. Sees patterns everywhere (sometimes too many). Says 'this level needs to hold' with religious conviction. Draws more lines than a geometry textbook."},
            {"id": "insider_anon", "name": "DeepIndustry", "role": "Anonymous Industry Insider", "background": "Age 39. Works at a direct competitor. Knows the industry dynamics from the inside. Can't reveal identity. Has seen the quarterly numbers competitors don't want public. Trades personal account based on industry knowledge (legally gray area).", "bias": "cautious_bearish", "personality": "Cryptic, drops hints. Says 'I can't say too much but...' and 'people would be surprised by the real numbers'. Conservative in predictions because one wrong leak could identify them. Credible because they've been right before."},
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

Keep it natural and conversational — like a real forum post (3-5 sentences). Don't be generic.
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
            # Only show the last ~3000 chars to keep context fresh and relevant
            recent_thread = thread_so_far[-3000:] if len(thread_so_far) > 3000 else thread_so_far
            thread_context = f"## Recent Discussion\n{recent_thread}"

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
