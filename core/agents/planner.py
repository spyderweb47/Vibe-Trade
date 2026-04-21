"""
Vibe Trade planner — decomposes complex multi-skill requests into ordered steps.

Given a natural-language goal and the registry of available skills, the
planner asks an LLM to emit a structured JSON plan of skill invocations.
The planner processor then executes each step in order via
`vibe_trade.dispatch`, passing accumulated context between steps so a later
step can see what an earlier step produced (dataset, generated script, etc.).

Example user request:
    "Fetch BTC 1m data for the last month, find a bullish engulfing
    pattern, then build a strategy that takes a long entry on each match
    with $1000 starting capital."

Example plan:
    [
      {"skill": "data_fetcher", "message": "Fetch BTC/USDT 1m last 30 days"},
      {"skill": "pattern", "message": "detect a bullish engulfing pattern"},
      {"skill": "strategy", "message": "build long-on-engulfing strategy",
       "context": {"strategy_config": {...}, "mode": "generate"}},
    ]
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion, is_available as llm_available
from core.skill_registry import skill_registry


PLAN_SYSTEM_PROMPT = """You are Vibe Trade's planning module. Your job is to decompose a user's
trading request into an ORDERED sequence of skill invocations that a trading
platform can execute.

## Available skills

{skills_doc}

## Output format

Return STRICT JSON only — no markdown fences, no commentary, no prose.
The shape MUST be:

{{
  "steps": [
    {{
      "skill": "<skill_id from the list above>",
      "message": "<self-contained natural-language task for that skill>",
      "rationale": "<one short sentence explaining why this step>",
      "context": {{ /* optional per-step context overrides */ }}
    }}
  ]
}}

## Rules

1. Use ONLY skill ids from the list above — never invent new ones.
2. Each step's `message` is the ONLY thing the downstream skill sees — make
   it SELF-CONTAINED with the FULL asset name/ticker included. The skill
   cannot see the original user message, so if the user said "fetch oil and
   run debate", the data_fetcher step MUST say "Fetch crude oil (CL=F) 1d
   data" — NOT "fetch data for the asset" or "load the chart". ALWAYS
   include the specific ticker/asset name in every step's message.
3. Steps run in order. Earlier steps' outputs are accumulated into the
   downstream context (e.g. a fetched dataset becomes the active dataset
   for the pattern step).
4. For the `strategy` skill, you MUST include a structured `context` with
   `mode: "generate"` and a full `strategy_config` object. Build it from
   the user's request:
     {{
       "mode": "generate",
       "strategy_config": {{
         "entryCondition": "<natural language describing entry>",
         "exitCondition": "<natural language describing exit>",
         "takeProfit": {{"type": "percentage", "value": <number>}},
         "stopLoss": {{"type": "percentage", "value": <number>}},
         "maxDrawdown": 20,
         "seedAmount": <user's capital, default 10000>,
         "specialInstructions": "<extra notes from the user>"
       }}
     }}
5. If the request is simple (one skill suffices), return one step.
6. If the request is out of scope for ALL listed skills, return:
   {{"steps": []}}
7. Return AT MOST 5 steps. Bigger plans are usually overengineered.

8. DO NOT use data_fetcher unless the user is EXPLICITLY asking to
   load a new ticker's historical bars onto the chart. Specifically:
   - ONLY emit a data_fetcher step when the message names a ticker,
     asset, or symbol that isn't already on the chart and the user
     wants to fetch/load/download its OHLC data.
   - DO NOT emit data_fetcher for messages like "show me the debate
     results", "display the pattern matches", "load my strategy",
     "pull up the backtest", "fetch the agent findings". The words
     show/load/pull/fetch are generic; what matters is whether the
     user wants MARKET DATA or just wants to display/interact with
     something already computed.
   - When the user asks a skill-specific question on an ALREADY-LOADED
     chart (e.g. "run swarm on this chart", "find engulfing patterns",
     "build a mean-reversion strategy") — skip data_fetcher entirely.
     The chart data is already there; the skill will use it.

## Common decompositions

- "Fetch BTC/USDT 1h data and find engulfing" → 2 steps: data_fetcher → pattern
- "Backtest a strategy on AAPL daily" → 2 steps: data_fetcher → strategy
- "Find engulfing patterns in the current chart and build a strategy"
  → 2 steps: pattern → strategy  (NO data_fetcher — chart already loaded)
- "Run swarm intelligence on this asset" → 1 step: predict_analysis
  (NO data_fetcher — "this asset" means what's on the chart)
- Just "fetch BTC 1h" → 1 step: data_fetcher
- "What news events moved AAPL in the last 3 months" → 1 step: historic_news
  (NO data_fetcher — historic_news reads the current chart's asset; the
  skill itself researches and plots news dots on the already-loaded chart)
- "Fetch TSLA daily and show me historic news" → 2 steps: data_fetcher → historic_news
- "Show me the cross-exam results" → 0 steps (out of scope —
  user is asking to navigate existing output, not run a skill)

Return ONLY the JSON object."""


def _format_skills_doc(skills) -> str:
    """Format the skill list for the LLM prompt."""
    lines = []
    for s in skills:
        m = s.metadata
        lines.append(f"- `{m.id}` — **{m.name}**: {m.description}")
    return "\n".join(lines)


def _strip_fences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        # Strip leading ```json or ``` line
        nl = s.find("\n")
        if nl != -1:
            s = s[nl + 1:]
        if s.endswith("```"):
            s = s[: -3]
    return s.strip()


def plan(
    message: str,
    max_steps: int = 5,
    available_skills: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Build an execution plan for a multi-skill request.

    Returns a list of validated step dicts:
        [{"skill": str, "message": str, "rationale": str, "context": dict}, ...]

    Args:
        message: The user's request
        max_steps: Cap on plan length (prevents runaway plans)
        available_skills: If provided and non-empty, restricts the planner to
            ONLY these skill ids — respects the user's explicit skill
            selection. When None/empty, all registered skills are available.

    Returns an empty list if:
      - The LLM is unavailable
      - The LLM response can't be parsed
      - The plan references no valid skill ids
    """
    if not llm_available():
        return []

    # Exclude the planner itself from the available list to prevent recursion.
    skills = [s for s in skill_registry.list() if s.metadata.id != "planner"]

    # Honor the user's explicit skill selection if provided.
    if available_skills:
        allowed = set(available_skills)
        skills = [s for s in skills if s.metadata.id in allowed]

    if not skills:
        return []

    prompt = PLAN_SYSTEM_PROMPT.format(skills_doc=_format_skills_doc(skills))

    try:
        raw = chat_completion(
            system_prompt=prompt,
            user_message=message,
            temperature=0.2,
            max_tokens=900,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[planner] LLM call failed: {exc}")
        return []

    cleaned = _strip_fences(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        # Try to extract the JSON object substring (LLM sometimes wraps it)
        try:
            start = cleaned.index("{")
            end = cleaned.rindex("}") + 1
            parsed = json.loads(cleaned[start:end])
        except (ValueError, json.JSONDecodeError):
            print(f"[planner] failed to parse plan JSON: {cleaned[:200]}")
            return []

    raw_steps = parsed.get("steps") if isinstance(parsed, dict) else None
    if not isinstance(raw_steps, list):
        return []

    valid_ids = {s.metadata.id for s in skills}
    validated: List[Dict[str, Any]] = []
    for step in raw_steps[:max_steps]:
        if not isinstance(step, dict):
            continue
        skill_id = step.get("skill")
        msg = step.get("message")
        if skill_id not in valid_ids or not isinstance(msg, str) or not msg.strip():
            continue

        # Post-hoc validation: the LLM planner sometimes emits a
        # data_fetcher step even when the user's message doesn't
        # actually name a ticker ("show me the debate results",
        # "load my script", "pull up the pattern matches"). Those
        # steps would hit parse_query on the backend, find no symbol,
        # and fail with the "I couldn't find a ticker or pair"
        # message — confusing the user who never asked to fetch
        # anything. Drop silently instead.
        if skill_id == "data_fetcher" and not _fetch_looks_intended(msg.strip()):
            print(
                f"[planner] dropping data_fetcher step with no ticker in message: "
                f"{msg.strip()[:100]}",
                flush=True,
            )
            continue

        validated.append({
            "skill": skill_id,
            "message": msg.strip(),
            "rationale": str(step.get("rationale", "")).strip(),
            "context": step.get("context") if isinstance(step.get("context"), dict) else {},
        })

    # If the LLM returned nothing usable, fall back to keyword-based
    # single-skill detection so the user still gets trace-UI progress.
    # The planner pipeline is what drives the live "what's happening"
    # bar in chat — without a plan, the frontend silently routes through
    # plain chat and the user sees no activity indicator at all.
    if not validated:
        guess = _keyword_fallback(message, valid_ids)
        if guess:
            print(
                f"[planner] LLM returned no valid steps — using keyword fallback: {guess['skill']}",
                flush=True,
            )
            validated = [guess]

    return validated


# ─── Keyword fallback ────────────────────────────────────────────────────────

# Verb phrases that map obviously to a single skill. Kept intentionally
# conservative — only clear matches. When the user's intent doesn't
# match any of these, we fall through to plain chat (not bogus plans).
#
# ORDERING MATTERS. Specific-skill rules come FIRST so a message like
# "run swarm debate on BTC" matches predict_analysis (not data_fetcher,
# even though "BTC" is in the text). data_fetcher is the LAST fallback
# and requires BOTH an explicit fetch verb AND a parseable ticker —
# see `_fetch_looks_intended` below.
_FALLBACK_RULES: List[Dict[str, Any]] = [
    {
        # Renamed from swarm_intelligence. Keep BOTH skill ids as valid
        # targets; the backend processor registry aliases them. The
        # planner prefers the new name, the keyword fallback resolves to
        # whichever id is in the valid_ids set (new wins if both are
        # registered, which they are).
        "skill": "predict_analysis",
        "keywords": (
            "predict", "prediction", "predict direction", "forecast direction",
            "swarm", "committee", "debate", "multi-agent", "multi agent",
            "run agents", "analyze with agents", "panel debate",
        ),
    },
    {
        "skill": "pattern",
        "keywords": (
            "detect pattern", "find pattern", "pattern detector",
            "engulfing", "head and shoulders", "double top", "double bottom",
            "scan for", "find occurrences",
        ),
    },
    {
        "skill": "strategy",
        "keywords": (
            "backtest", "strategy", "build a strategy", "run a strategy",
            "profit factor", "sharpe", "pnl",
        ),
    },
    {
        # Historic news — researches price-moving events for an asset,
        # plots them on the chart as dots, and shows the articles in
        # the bottom panel. Matches queries like "historic news for
        # AAPL" / "what news moved BTC" / "key news events".
        "skill": "historic_news",
        "keywords": (
            "historic news", "historical news", "news for", "news on",
            "news about", "what news", "price moving news",
            "price-moving news", "news events", "key news",
            "market moving news", "news catalyst", "news catalysts",
            "news impact", "news that affected", "news affecting",
        ),
    },
    {
        # data_fetcher LAST and with a ticker-requirement guard
        # (see _fetch_looks_intended). Previously this rule ran first
        # with generic verbs like "load" / "fetch" / "pull" / "show",
        # which misfired on "load my script" / "pull up the debate" /
        # "show me the matches" — all of those should NOT trigger a
        # market-data fetch.
        "skill": "data_fetcher",
        "keywords": (
            # Verbs that strongly suggest a data fetch, but still need
            # a ticker present (enforced in _fetch_looks_intended).
            "fetch", "download", "pull data", "get data", "get ohlc",
            "load data", "load bars", "add chart", "new chart",
            "bring up",
        ),
        "require_ticker": True,
    },
]


def _fetch_looks_intended(message: str) -> bool:
    """
    Returns True iff the message plausibly contains a tradeable
    asset reference — ticker, common asset name, or forex pair.

    Uses the regex-only path of core.data.fetcher.parse_query (not the
    LLM path; we don't want to burn a round-trip just to decide
    whether a planner step is real). If the regex can't find a
    symbol, the message is almost certainly NOT a fetch request —
    drop the data_fetcher step.
    """
    try:
        from core.data.fetcher import _parse_query_regex
        parsed = _parse_query_regex(message)
        return bool(parsed.get("symbol"))
    except Exception:  # noqa: BLE001
        # If the regex parser itself errors, don't block — be lenient
        # and trust the keyword match alone.
        return True


def _keyword_fallback(message: str, valid_ids: set) -> Optional[Dict[str, Any]]:
    """
    Rule-based single-skill detection for when the LLM planner returns
    nothing. Returns the matched step dict, or None if no rule fires.
    """
    low = message.lower().strip()
    if not low:
        return None
    for rule in _FALLBACK_RULES:
        if rule["skill"] not in valid_ids:
            continue
        if not any(kw in low for kw in rule["keywords"]):
            continue
        # data_fetcher additionally requires a parseable ticker so
        # "load my script" / "fetch the strategy output" don't
        # misfire into a failing market-data request.
        if rule.get("require_ticker") and not _fetch_looks_intended(message):
            continue
        return {
            "skill": rule["skill"],
            "message": message.strip(),
            "rationale": f"keyword match on '{rule['skill']}' (LLM plan empty)",
            "context": {},
        }
    return None
