"""
Vibe Trade — the unified agent.

Vibe Trade is the only agent the user interacts with. It does two things:

  1. **Single-skill dispatch** — when the user has a skill explicitly active,
     `dispatch(skill_id, message, context)` looks up the skill's processor in
     `core.agents.processors`, builds a ToolContext with the skill's declared
     tool allowlist, and calls it.

  2. **Built-in multi-step planning** — when no specific skill is active and
     the user's message looks multi-step, `try_plan_and_execute()` calls the
     LLM-based planner, decomposes the request into ordered skill invocations,
     runs each step via `dispatch()`, accumulates context between steps, and
     returns a single combined SkillResponse. This is NOT a registered skill
     — it's a feature of the default agent that activates automatically based
     on the user's input.

The frontend tool registry (`apps/web/src/lib/toolRegistry.ts`) enforces each
skill's allowlist when executing tool_calls returned in a SkillResponse.

Skills are pure SKILL.md files — there is no handler.py anymore. Python
logic lives in `core/agents/processors.py`.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from core.agents.processors import get_processor
from skills import skill_registry
from skills.base import Skill, SkillResponse, ToolContext


# ─── Multi-step heuristic ──────────────────────────────────────────────────
# Cheap regex check that runs BEFORE the LLM planner, so simple messages
# (e.g. "hi", "what is RSI") don't trigger an expensive plan() call.

_ACTION_VERBS = {
    "fetch", "get", "load", "pull", "download", "grab",
    "find", "detect", "scan", "search", "identify", "spot",
    "build", "generate", "create", "make", "construct",
    "backtest", "run", "test", "simulate",
    "analyze", "analyse", "evaluate", "assess", "measure",
}

_CONNECTORS_RE = re.compile(r"\b(then|and then|after that|next|followed by|plus)\b", re.IGNORECASE)


def looks_multi_step(message: str) -> bool:
    """
    True if the message looks like a multi-skill request worth planning.

    Triggers when EITHER:
      - The message contains 2+ distinct action verbs (fetch + find, find + build, ...)
      - The message contains an explicit connector ("then", "and then", "next")
        AND at least one action verb
      - The message is very long (≥ 18 words) AND has at least one action verb
    """
    words = message.lower().split()
    if not words:
        return False

    verb_hits = sum(1 for w in words if w.strip(",.?!") in _ACTION_VERBS)
    if verb_hits >= 2:
        return True

    has_connector = bool(_CONNECTORS_RE.search(message))
    if has_connector and verb_hits >= 1:
        return True

    if len(words) >= 18 and verb_hits >= 1:
        return True

    return False


class VibeTrade:
    """Module-level singleton that dispatches messages to skills."""

    def __init__(self) -> None:
        self.registry = skill_registry

    def get_skill(self, skill_id: str) -> Optional[Skill]:
        return self.registry.get(skill_id)

    def list_skills(self) -> List[Skill]:
        return self.registry.list()

    async def dispatch(
        self,
        skill_id: str,
        message: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> SkillResponse:
        """
        Route a chat message to the given skill.

        Raises ValueError if the skill is unknown or has no registered processor.
        """
        skill = self.registry.get(skill_id)
        if skill is None:
            raise ValueError(f"Unknown skill: {skill_id}")

        processor = get_processor(skill_id)
        if processor is None:
            raise ValueError(
                f"No processor registered for skill '{skill_id}'. "
                f"Add an entry to core/agents/processors.py::PROCESSORS."
            )

        tools = ToolContext(
            skill_id=skill_id,
            allowed_tools=list(skill.metadata.tools),
        )
        return await processor(message, context or {}, tools)

    async def try_plan_and_execute(
        self,
        message: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Optional[SkillResponse]:
        """
        Built-in planning path of the default agent.

        If the message looks multi-step and the LLM-based planner can produce
        a non-empty plan, executes each step in order and returns a combined
        SkillResponse. Otherwise returns None — the caller should fall through
        to the general LLM chat handler.

        This is NOT a registered skill — it's an internal capability of the
        Vibe Trade agent that activates based on the user's input shape.
        """
        if not looks_multi_step(message):
            return None

        # Lazy import to keep the module load graph clean
        from core.agents.planner import plan as build_plan

        steps = build_plan(message)
        if not steps:
            return None

        ctx = dict(context or {})

        header_lines = [f"📋 **Plan** ({len(steps)} step{'s' if len(steps) > 1 else ''}):"]
        for i, s in enumerate(steps, 1):
            rationale = f" — {s['rationale']}" if s.get("rationale") else ""
            header_lines.append(f"{i}. **{s['skill']}**: {s['message']}{rationale}")

        combined_reply_parts: List[str] = ["\n".join(header_lines)]
        combined_tool_calls: List[Dict[str, Any]] = []
        step_results: List[Dict[str, Any]] = []

        for i, step in enumerate(steps, 1):
            step_ctx = dict(ctx)
            if step.get("context"):
                step_ctx.update(step["context"])

            try:
                step_response = await self.dispatch(step["skill"], step["message"], step_ctx)
            except Exception as exc:  # noqa: BLE001
                combined_reply_parts.append(
                    f"\n**Step {i}/{len(steps)}** (`{step['skill']}`) FAILED: {exc}"
                )
                step_results.append({
                    "step": i,
                    "skill": step["skill"],
                    "message": step["message"],
                    "error": str(exc),
                })
                break

            reply_snippet = (step_response.reply or "(no reply)").strip()
            combined_reply_parts.append(
                f"\n**Step {i}/{len(steps)}** (`{step['skill']}`):\n{reply_snippet}"
            )
            combined_tool_calls.extend(step_response.tool_calls or [])
            step_results.append({
                "step": i,
                "skill": step["skill"],
                "message": step["message"],
                "reply": step_response.reply,
                "data": step_response.data,
                "script_type": step_response.script_type,
            })

            # Carry forward outputs so step N+1 sees what step N produced
            if step_response.data:
                for k, v in step_response.data.items():
                    ctx[k] = v
            if step_response.script:
                ctx["pattern_script"] = step_response.script
                ctx["currentScript"] = step_response.script

        return SkillResponse(
            reply="\n".join(combined_reply_parts),
            data={
                "plan": steps,
                "step_results": step_results,
            },
            tool_calls=combined_tool_calls,
        )


# Module singleton.
vibe_trade = VibeTrade()
