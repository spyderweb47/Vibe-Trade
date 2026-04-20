"""
ErrorHandlerAgent — diagnoses a runtime error in a generated script and
returns a fixed version, targeted at the Vibe Trade sandbox API.

Complementary to the QA Agent:
  - QA Agent  runs BEFORE the script is executed — static verification.
  - Error    runs AFTER a runtime error is reported from the Web Worker.
    Handler

Both follow the "producer → verifier/fixer → loop" pattern, but this
one is triggered by actual runtime failures (syntax errors, reference
errors, wrong API usage) rather than proactive review.

Used by the frontend's /fix-script endpoint — when a pattern or
strategy script throws in the browser Web Worker, the frontend POSTs
the broken script + error message + original user intent; this agent
reads all three, figures out what went wrong, and returns a fixed
script plus a short explanation the UI can show the user.

Currently scoped to `pattern` and `strategy` scripts. Extensible via
the `script_type` parameter.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from core.agents.llm_client import chat_completion_json, is_available as llm_available


# ─── Prompts ─────────────────────────────────────────────────────────────────


_PATTERN_API_CONTEXT = """\
The script runs inside `new Function("data", "Math", YOUR_CODE)` in a
Web Worker sandbox.

Available:
  - `data` — array of OHLC bars: { time, open, high, low, close, volume }
  - `Math` — standard JS Math object

Forbidden:
  - import / require / fetch / XMLHttpRequest / eval / Function / DOM APIs
  - async / await / Promises

Required shape:
  - Top-level: const results = []
  - For-loop iterating `data`: for (let i = 0; i < data.length; i++) { ... }
  - Push objects: { start_idx, end_idx, confidence (0-1), pattern_type }
  - End with: return results;

Common mistakes that cause "Unexpected identifier 'X'" errors:
  - Calling a variable without `let/const/var`
  - Missing commas in object literals
  - Arrow function where regular function needed (or vice versa)
  - Template literals with unmatched backticks
  - Trailing commas in older JS engines

Common mistakes that cause "X is not defined":
  - Typo in variable name
  - Using a helper function without defining it

Common mistakes that cause silent "0 matches" (not a crash but a bug):
  - Threshold too strict (e.g. correlation > 0.85 on noisy data)
  - Hardcoded confidence: 1.0 with no variability
"""

_STRATEGY_API_CONTEXT = """\
The script runs inside `new Function("data", "config", "Math", YOUR_CODE)`
in a Web Worker sandbox. See apps/web/src/lib/strategyExecutor.ts for
the exact runtime.

Available:
  - `data` — array of OHLC bars: { time, open, high, low, close, volume }
  - `config` — strategy config: { stopLoss (%), takeProfit (%),
              maxDrawdown, seedAmount }
  - `Math` — standard JS Math object

Forbidden:
  - import / require / fetch / XMLHttpRequest / eval / Function / DOM APIs
  - async / await / Promises

Required output:
  Script must return an object: { trades: [...], equity: [...] }

  Each trade object should have:
    - entryIdx (number)        — bar index where position opened
    - exitIdx (number)         — bar index where position closed
    - entryPrice (number)      — optional; falls back to data[entryIdx].close
    - exitPrice (number)       — optional; falls back to data[exitIdx].close
    - type / direction: "long" | "short"
    - pnl (number)             — optional; falls back to price delta

  `equity` is an array of account values per bar (or a single number).

Common mistakes:
  - Script forgets the `return { trades, equity }` — wrapper adds a
    fallback but only if `trades` and `equity` are defined
  - Using variables without `let/const/var` → "Unexpected identifier" error
  - Hardcoded seed that ignores config.seedAmount
  - Forgetting to update equity[] per bar
  - Entry/exit indices out of bounds (no `data.length` guard)
  - "Cannot read property 'close' of undefined" — off-by-one on data[i+1]
"""


_FIX_SYSTEM_PROMPT_TEMPLATE = """You are the Vibe Trade script fixer. A user's
{script_type} script just crashed in the Web Worker with this error:

  {error}

The original user request was:

  {intent}

## API Context
{api_context}

## Your job
Read the broken script below. Identify the exact cause of the error.
Produce a fixed version that keeps the original intent but compiles
and runs correctly in the sandbox. Don't strip out logic unless it's
the source of the error — the user wants the fix to preserve their
pattern/strategy concept.

## Output format
Return STRICT JSON only — no markdown fences, no prose outside the JSON:

{{
  "fixed_script": "<the corrected JavaScript, including the required results array and return statement>",
  "explanation": "<1-2 sentences explaining what was wrong and how you fixed it — written for the user, not internal>",
  "confidence": <0-1 float — how sure you are the fix works>,
  "changes": [
    "<specific change 1>",
    "<specific change 2>"
  ]
}}

The broken script is in the next message.
"""


# ─── Public API ─────────────────────────────────────────────────────────────


@dataclass
class FixResult:
    """The outcome of a fix attempt."""

    fixed_script: str
    """The corrected script text. Empty string on LLM unavailable / parse failure."""

    explanation: str
    """Short user-facing note: what was wrong, what changed."""

    confidence: float
    """Self-reported 0-1 — how confident the agent is the fix works."""

    changes: list
    """Bullet list of specific changes made."""

    error: Optional[str] = None
    """If the agent itself failed (LLM unavailable, unparseable output)."""


def fix_script(
    script: str,
    error: str,
    intent: str = "",
    script_type: str = "pattern",
) -> FixResult:
    """
    Ask an LLM to diagnose + fix a broken script.

    Args:
        script:       the broken JS source
        error:        runtime error message from the Web Worker
        intent:       original user request (helps the agent preserve meaning)
        script_type:  "pattern" (default) | "strategy" | "indicator"

    Returns FixResult. On LLM-unavailable or parse failure, returns
    FixResult with empty fixed_script and a non-None error field so
    the caller can fall back to "ask user to fix manually".
    """
    if not script.strip():
        return FixResult(
            fixed_script="", explanation="", confidence=0.0, changes=[],
            error="No script provided to fix",
        )

    if not llm_available():
        return FixResult(
            fixed_script="", explanation="", confidence=0.0, changes=[],
            error="LLM unavailable — cannot run error handler",
        )

    api_ctx = {
        "pattern": _PATTERN_API_CONTEXT,
        "strategy": _STRATEGY_API_CONTEXT,
    }.get(script_type, _PATTERN_API_CONTEXT)

    system_prompt = _FIX_SYSTEM_PROMPT_TEMPLATE.format(
        script_type=script_type,
        error=error,
        intent=intent or "(original request not provided)",
        api_context=api_ctx,
    )

    try:
        parsed: Dict[str, Any] = chat_completion_json(
            system_prompt=system_prompt,
            user_message=f"```javascript\n{script}\n```",
            temperature=0.2,       # low — we want precise debugging, not creative
            max_tokens=2000,
            timeout_s=120.0,       # longer than the default — fixing can be slow
        )
    except Exception as err:  # noqa: BLE001
        return FixResult(
            fixed_script="", explanation="", confidence=0.0, changes=[],
            error=f"Fixer LLM call failed: {type(err).__name__}: {str(err)[:180]}",
        )

    # Expected JSON shape check
    if not isinstance(parsed, dict) or "raw" in parsed and len(parsed) == 1:
        return FixResult(
            fixed_script="", explanation="", confidence=0.0, changes=[],
            error="Fixer returned unparseable output",
        )

    fixed = str(parsed.get("fixed_script", "")).strip()
    explanation = str(parsed.get("explanation", "")).strip()
    confidence = float(parsed.get("confidence", 0.5) or 0.5)
    changes = parsed.get("changes") or []
    if not isinstance(changes, list):
        changes = []

    # Strip code fences if the model wrapped the fixed_script anyway
    if fixed.startswith("```"):
        first_nl = fixed.index("\n") if "\n" in fixed else len(fixed)
        fixed = fixed[first_nl + 1:]
        if fixed.endswith("```"):
            fixed = fixed[:-3]
        fixed = fixed.strip()

    if not fixed:
        return FixResult(
            fixed_script="", explanation=explanation, confidence=confidence,
            changes=changes, error="Fixer returned empty fixed_script",
        )

    return FixResult(
        fixed_script=fixed,
        explanation=explanation or "Script corrected.",
        confidence=max(0.0, min(1.0, confidence)),
        changes=[str(c) for c in changes[:5]],
    )
