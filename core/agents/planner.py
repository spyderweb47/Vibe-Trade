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
from skills import skill_registry


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
   it SELF-CONTAINED. Don't reference "the user" or "the request"; instead
   say what to do directly. Example: "Fetch BTC/USDT 1m bars for the last
   30 days" — not "fetch the data the user asked for".
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

## Common decompositions

- "Fetch X data and find Y pattern" → 2 steps: data_fetcher → pattern
- "Backtest a strategy on Y data" → 2 steps: data_fetcher → strategy
- "Find Y patterns in the current chart and build a strategy on them"
  → 2 steps: pattern → strategy
- "Fetch data, find pattern, build strategy" → 3 steps
- Just "fetch X" → 1 step (data_fetcher only)

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
        validated.append({
            "skill": skill_id,
            "message": msg.strip(),
            "rationale": str(step.get("rationale", "")).strip(),
            "context": step.get("context") if isinstance(step.get("context"), dict) else {},
        })

    return validated
