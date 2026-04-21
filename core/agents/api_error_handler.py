"""
ApiErrorHandlerAgent — converts an unhandled API exception into a graceful,
user-facing ChatResponse instead of a raw HTTP 500.

Complements the existing error agents:
  - QA Agent             — pre-execution static review of generated scripts
  - ErrorHandlerAgent    — fixes a generated script after it crashes in the
                           browser sandbox
  - **ApiErrorHandlerAgent** (this one) — catches anything thrown out of a
                           skill processor or the dispatch layer itself
                           (encoding errors, LLM provider outages, type
                           errors, key errors, network timeouts) and turns
                           them into a structured chat reply with a clear
                           cause, suggested action, and the full traceback
                           tucked into `data` for debugging.

Triggered from `services/api/routers/chat.py` — the entire `/chat` handler
body is wrapped in `try / except` and any exception is routed here.

Design goals:
  - **Never crash the request** — even if this agent itself blows up, fall
    back to a simple text reply with the raw exception class + first 200
    chars of the message.
  - **No LLM dependency** for the categorization step — pattern-match the
    exception type/message offline so the user gets a useful response even
    when the LLM provider is what broke.
  - **Optional LLM polish** — if `llm_available()` and the error isn't
    itself an LLM error, call the model to write 1-2 user-friendly
    sentences of explanation.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion, is_available as llm_available


# ─── Categorization ─────────────────────────────────────────────────────────


@dataclass
class ErrorCategory:
    """One row in the categorisation table."""

    name: str                        # short slug, e.g. "encoding"
    title: str                       # user-facing one-liner
    suggested_action: str            # what to do next
    is_llm_problem: bool = False     # if True, skip the LLM polish step


def _categorize(exc: BaseException) -> ErrorCategory:
    """
    Inspect the exception (type + message) and return a category. Pure
    pattern-matching so this works even when the LLM provider is down.
    """
    name = type(exc).__name__
    msg = str(exc)
    msg_l = msg.lower()

    # Order matters: isinstance checks (most specific) before substring
    # matching. Otherwise an asyncio.TimeoutError gets caught by the
    # LLM-provider bucket because "timeout" appears in both lists.

    # Encoding — Windows charmap can't print Unicode arrows / +/- / etc.
    if isinstance(exc, UnicodeEncodeError):
        return ErrorCategory(
            name="encoding",
            title="The server console couldn't display a character in the response.",
            suggested_action=(
                "This is a Windows-specific issue with the cp1252 console "
                "encoding. The fix is in place for new responses; if it "
                "happens again, set the env var `PYTHONIOENCODING=utf-8` "
                "before starting the API server."
            ),
        )

    # Asyncio timeout (must come BEFORE the LLM-provider substring check
    # because that bucket also matches "timeout" / "timed out").
    import asyncio
    if isinstance(exc, asyncio.TimeoutError):
        return ErrorCategory(
            name="timeout",
            title="The skill took too long and timed out.",
            suggested_action=(
                "Try a shorter task (smaller date range, fewer assets) or "
                "re-run — the agents may have stalled on a single slow "
                "research call."
            ),
        )

    # Substring-based encoding catch (string messages from libraries that
    # raise plain Exception with a charmap message).
    if "codec can't encode" in msg_l or "charmap" in msg_l:
        return ErrorCategory(
            name="encoding",
            title="The server console couldn't display a character in the response.",
            suggested_action=(
                "Set `PYTHONIOENCODING=utf-8` before starting the API "
                "server. The internal print path is now Unicode-safe but "
                "some library prints aren't."
            ),
        )

    # LLM provider — anything that smells like an HTTP/network/auth/quota
    # error. Note: substring lists overlap with the timeout bucket above
    # (which is why isinstance(asyncio.TimeoutError) runs first).
    if any(s in msg_l for s in (
        "openai", "anthropic", "groq", "ollama",
        "401", "403", "429", "rate limit", "quota",
        "api key", "apikey", "authentication", "unauthorized",
        "connection", "timed out", "timeout", "read timeout",
        "ssl", "certificate", "dns",
    )):
        return ErrorCategory(
            name="llm_provider",
            title="The LLM provider failed.",
            suggested_action=(
                "Check that your provider env vars are set (OPENAI_API_KEY / "
                "ANTHROPIC_API_KEY / OLLAMA_HOST etc.) and that the provider "
                "is reachable. If you're rate-limited, wait a minute and "
                "retry."
            ),
            is_llm_problem=True,
        )

    # Missing dataset / store key
    if isinstance(exc, KeyError) or "key" in msg_l and "not found" in msg_l:
        return ErrorCategory(
            name="missing_data",
            title="A required piece of data was missing.",
            suggested_action=(
                "Make sure a dataset is loaded on the chart before running "
                "this skill. If you just deleted or refreshed something, "
                "try fetching the data again."
            ),
        )

    # Type / attribute errors usually mean a bug — surface them with stack
    if isinstance(exc, (TypeError, AttributeError, ValueError)):
        return ErrorCategory(
            name="bug",
            title=f"Internal error: {name}.",
            suggested_action=(
                "This looks like a code bug rather than something you did "
                "wrong. The full traceback is in the server log. Try "
                "re-running; if it happens consistently, please report it "
                "with the message you sent."
            ),
        )

    # File / IO
    if isinstance(exc, (FileNotFoundError, IsADirectoryError, PermissionError)):
        return ErrorCategory(
            name="filesystem",
            title=f"A filesystem error occurred ({name}).",
            suggested_action=(
                "The server couldn't read or write a file it needed. Check "
                "the server log for the specific path."
            ),
        )

    # Catch-all
    return ErrorCategory(
        name="unknown",
        title=f"Unexpected error: {name}.",
        suggested_action=(
            "The agents hit an unexpected condition. Try re-running; if it "
            "happens again, the server log has the full traceback."
        ),
    )


# ─── LLM polish (optional) ──────────────────────────────────────────────────


_POLISH_SYSTEM = """You are a friendly error-explainer for a trading platform.
A backend agent crashed. Given the exception class, the message, and a brief
category description, write 1-2 sentences in plain English that:
- Tell the user what likely went wrong (avoid jargon)
- Reference the specific symbol/skill if mentioned in the original request

Do NOT include a stack trace, do NOT add "I apologize", do NOT add a fake
suggested fix. Just the explanation. Two sentences max.
"""


def _polish_with_llm(
    exc: BaseException,
    category: ErrorCategory,
    user_message: str,
    skill_id: Optional[str],
) -> str:
    """Call the LLM for a short user-facing explanation. Empty string on failure."""
    if category.is_llm_problem or not llm_available():
        return ""
    try:
        prompt = (
            f"Exception class: {type(exc).__name__}\n"
            f"Exception message: {str(exc)[:400]}\n"
            f"Category: {category.name} ({category.title})\n"
            f"User's original request: {user_message[:300]}\n"
            f"Active skill: {skill_id or '(planner)'}\n"
        )
        text = chat_completion(
            system_prompt=_POLISH_SYSTEM,
            user_message=prompt,
            temperature=0.2,
            max_tokens=180,
            timeout_s=15.0,
        )
        return (text or "").strip()
    except Exception:  # noqa: BLE001
        # The polish itself failed — degrade silently, the categorized
        # response is already good enough.
        return ""


# ─── Public API ─────────────────────────────────────────────────────────────


@dataclass
class HandledError:
    """The agent's verdict on an unhandled exception."""

    reply: str                         # ready-to-send chat reply (markdown)
    data: Dict[str, Any]               # diagnostic payload for the frontend
    category: str                      # short slug for analytics
    log_line: str                      # one-line summary for the server log


def handle_api_error(
    exc: BaseException,
    user_message: str = "",
    skill_id: Optional[str] = None,
    extra_context: Optional[Dict[str, Any]] = None,
) -> HandledError:
    """
    Top-level entry point. Always returns a HandledError — never raises.

    Args:
        exc:           the exception that escaped the request handler
        user_message:  the original chat message (lets the polish step
                       reference the asset/skill the user asked about)
        skill_id:      the skill that was dispatching when this blew up
        extra_context: anything else the caller wants attached to data
                       (e.g. dataset_id, plan steps so far)
    """
    try:
        category = _categorize(exc)
        # Always log the full traceback to the server console so devs can
        # diagnose. The user reply only includes class + message.
        tb_text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        # Use a Unicode-safe print — same problem this agent exists to
        # solve for the user-facing path.
        try:
            print(f"[api_error_handler] caught {type(exc).__name__}: {str(exc)[:200]}\n{tb_text}", flush=True)
        except UnicodeEncodeError:
            print(
                f"[api_error_handler] caught {type(exc).__name__}: "
                f"{str(exc)[:200].encode('ascii', errors='replace').decode('ascii')}",
                flush=True,
            )

        polish = _polish_with_llm(exc, category, user_message, skill_id)

        # Build the reply
        parts: List[str] = [f"**{category.title}**"]
        if polish:
            parts.append("")
            parts.append(polish)
        parts.append("")
        parts.append(f"_{category.suggested_action}_")
        parts.append("")
        parts.append(f"```\n{type(exc).__name__}: {str(exc)[:400]}\n```")

        log_line = (
            f"[api_error_handler] category={category.name} "
            f"exc={type(exc).__name__} skill={skill_id or '-'} "
            f"msg={str(exc)[:150]!r}"
        )

        return HandledError(
            reply="\n".join(parts),
            data={
                "error": {
                    "category": category.name,
                    "type": type(exc).__name__,
                    "message": str(exc)[:1000],
                    "skill_id": skill_id,
                    "user_message_preview": user_message[:200],
                    "extra": extra_context or {},
                },
            },
            category=category.name,
            log_line=log_line,
        )
    except Exception as meta_exc:  # noqa: BLE001
        # Last-ditch fallback — even the handler itself blew up.
        # Hard-code an ASCII-only message so we KNOW it'll print + send.
        return HandledError(
            reply=(
                f"**Internal error.** The error handler itself failed.\n\n"
                f"Original: `{type(exc).__name__}: {str(exc)[:200]}`\n"
                f"Handler:  `{type(meta_exc).__name__}: {str(meta_exc)[:200]}`"
            ),
            data={
                "error": {
                    "category": "handler_meta_failure",
                    "type": type(exc).__name__,
                    "message": str(exc)[:500],
                    "handler_exc": str(meta_exc)[:500],
                },
            },
            category="handler_meta_failure",
            log_line=f"[api_error_handler] meta-failure: {type(meta_exc).__name__}",
        )
