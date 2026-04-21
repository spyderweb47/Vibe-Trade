"""
Base Agent class — the shared runtime object produced by AgentSwarm.spawn().

An Agent is a thin stateful wrapper around:
  - a persona (name, background, style, tool whitelist)
  - a per-agent memory of its prior outputs in this run
  - access to the shared tools registry in swarm_tools.py

This lives in `core/agents/` so specialised agents
(DiscussionAgent, CrossExaminer, ReACTReportAgent, QAAgent, etc.) can
inherit from it without pulling in orchestration code.

Orchestration (parallelism, timeouts, retries, QA loops) lives in
`core/engine/agent_swarm.py`. This module is intentionally the
opposite: it knows nothing about other agents, teams, or the event bus.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from core.agents.llm_client import chat_completion, chat_completion_json


# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class AgentSpec:
    """Declarative description of an agent you want AgentSwarm.spawn() to create."""

    role: str                                  # "researcher" / "qa" / "risk_manager" / etc.
    persona: Dict[str, Any] = field(default_factory=dict)
    """Persona fields the prompt uses:
       - name, background, style (stylistic)
       - bias (hawkish/dovish/neutral) — optional
       - influence (0.5–3.0) — optional, used by consensus math
       - specialization — optional, for ROLE_TOOL_MAP lookups
    """

    tools: Optional[List[str]] = None
    """Tool ids this agent can call. If None, AgentSwarm resolves via
    ROLE_TOOL_MAP[role]. Explicit empty list means "synthesise only, no tools"."""

    system_prompt: Optional[str] = None
    """Override the default system prompt for this role. If None, AgentSwarm
    constructs one from persona."""

    temperature: float = 0.3
    max_tokens: int = 1500
    timeout_s: Optional[float] = None


@dataclass
class AgentResponse:
    """The structured result of Agent.speak / reflect / use_tool."""

    content: str                               # natural-language output
    confidence: float = 0.5                    # self-reported 0-1
    tool_calls_made: Dict[str, str] = field(default_factory=dict)
    """Map of tool_id → short result summary (capped for prompt reuse)."""

    structured: Optional[Dict[str, Any]] = None
    """Parsed JSON payload, if the prompt requested one."""

    error: Optional[str] = None
    """If the call ultimately failed despite retries/fallbacks."""


# ─── Base Agent ──────────────────────────────────────────────────────────────


class Agent:
    """
    Runtime object. One Agent per AgentSpec per run — ephemeral.

    Subclasses (DiscussionAgent, QAAgent, etc.) override `build_prompt` or
    `parse_response` to customise behaviour; the public `speak` / `reflect` /
    `use_tool` surface stays stable so AgentSwarm can call them uniformly.
    """

    def __init__(self, spec: AgentSpec) -> None:
        self.spec = spec
        self.memory: List[str] = []     # prior outputs from this run
        self._tool_log: Dict[str, str] = {}  # running log across speak() calls

    # ─── Prompt construction ─────────────────────────────────────────────

    def _default_system_prompt(self) -> str:
        """Built from persona. Subclasses can override entirely via spec.system_prompt."""
        p = self.spec.persona
        name = p.get("name", f"Agent_{self.spec.role}")
        background = p.get("background", "")
        style = p.get("style", "")
        tools_list = ", ".join(self.spec.tools or []) or "none"
        return (
            f"You are {name}, a {self.spec.role}. {background}\n"
            f"Style: {style}\n"
            f"Tools available: {tools_list}\n"
        )

    def build_prompt(self, context: str, task: str) -> tuple[str, str]:
        """Return (system_prompt, user_message). Override to customise."""
        system = self.spec.system_prompt or self._default_system_prompt()
        memory_block = (
            "\n\nYour previous positions in this run:\n"
            + "\n".join(f"- {m}" for m in self.memory[-5:])
            if self.memory
            else ""
        )
        user = f"## Context\n{context}\n\n## Task\n{task}{memory_block}"
        return system, user

    # ─── Core methods ────────────────────────────────────────────────────

    def speak(self, context: str, task: str) -> AgentResponse:
        """
        One LLM call with this agent's persona + context. Returns
        AgentResponse with whatever the LLM produced. Synchronous — wrap
        in asyncio.to_thread at the call site.
        """
        system, user = self.build_prompt(context, task)
        try:
            text = chat_completion(
                system_prompt=system,
                user_message=user,
                temperature=self.spec.temperature,
                max_tokens=self.spec.max_tokens,
                timeout_s=self.spec.timeout_s,
            )
            resp = self.parse_response(text)
            if resp.content:
                self.memory.append(resp.content[:200])  # short-form memory
            return resp
        except Exception as err:  # noqa: BLE001
            return AgentResponse(
                content=f"(agent {self.spec.role} error)",
                confidence=0.0,
                error=f"{type(err).__name__}: {str(err)[:180]}",
            )

    def reflect(
        self,
        prior_output: str,
        feedback: str,
        original_task: str = "",
        original_context: str = "",
    ) -> AgentResponse:
        """
        Revise prior output given feedback. Used by AgentSwarm's QA loop
        when a verifier agent has asked the producer to iterate.

        `original_task` and `original_context` (when provided) are
        re-included verbatim so format constraints from the first call
        survive into subsequent iterations. Without this, a producer
        asked for "strict JSON only" on iteration 1 will happily return
        a prose changelog on iteration 2 because the JSON instructions
        are no longer in scope.
        """
        # Rebuild the system+user prompts using the original task/context
        # so the task-specific format rules (e.g. "return strict JSON
        # only, no preamble") are still in scope on iteration 2+.
        system, original_user = self.build_prompt(original_context, original_task)
        revise_instruction = (
            f"## Your prior output\n{prior_output}\n\n"
            f"## Verifier feedback\n{feedback}\n\n"
            f"## What to do now\n"
            f"Re-do the original task above, applying the verifier's feedback. "
            f"Return the FULL revised artifact in the SAME format as before — "
            f"do NOT write a changelog, do NOT explain what you changed, do "
            f"NOT add commentary. Just emit the new artifact."
        )
        user = f"{original_user}\n\n---\n\n{revise_instruction}" if original_user else revise_instruction
        try:
            text = chat_completion(
                system_prompt=system,
                user_message=user,
                temperature=self.spec.temperature,
                max_tokens=self.spec.max_tokens,
                timeout_s=self.spec.timeout_s,
            )
            resp = self.parse_response(text)
            if resp.content:
                self.memory.append(f"[revised] {resp.content[:180]}")
            return resp
        except Exception as err:  # noqa: BLE001
            return AgentResponse(
                content=f"(agent {self.spec.role} reflect error)",
                confidence=0.0,
                error=f"{type(err).__name__}: {str(err)[:180]}",
            )

    def use_tool(self, tool_id: str, args: Dict[str, Any]) -> str:
        """
        Invoke one of the shared tools (search_web, run_indicator, etc.).
        The AgentSwarm service injects the tool registry; this method is
        overridden by the swarm-spawned agent to route to the right tool.
        Base implementation is a safe no-op that logs.
        """
        msg = f"(tool {tool_id} not available in bare Agent — spawn via AgentSwarm)"
        self._tool_log[tool_id] = msg
        return msg

    def parse_response(self, text: str) -> AgentResponse:
        """
        Convert raw LLM text into AgentResponse. Subclasses override to
        extract structured JSON (DiscussionAgent pulls sentiment +
        price_prediction; QAAgent pulls pass/fail; etc.).
        """
        return AgentResponse(content=text.strip(), confidence=0.6)


# ─── JSON-producing helper ───────────────────────────────────────────────────


def speak_json(
    agent: Agent,
    context: str,
    task: str,
    schema_hint: str = "",
) -> AgentResponse:
    """
    Convenience: make the agent produce a strict JSON payload. Used by
    agents whose output needs to be machine-parsed (QA pass/fail, structured
    plans, etc.).
    """
    system, user = agent.build_prompt(context, task)
    user = (
        f"{user}\n\n"
        f"## Output format\nReturn STRICT JSON only — no prose, no markdown fences."
        f"{(' Schema: ' + schema_hint) if schema_hint else ''}"
    )
    try:
        raw = chat_completion_json(
            system_prompt=system,
            user_message=user,
            temperature=agent.spec.temperature,
            max_tokens=agent.spec.max_tokens,
            timeout_s=agent.spec.timeout_s,
        )
        if "raw" in raw and len(raw) == 1:
            return AgentResponse(content=raw["raw"], confidence=0.3, error="JSON parse failed")
        return AgentResponse(content="", confidence=0.7, structured=raw)
    except Exception as err:  # noqa: BLE001
        return AgentResponse(
            content="",
            confidence=0.0,
            error=f"{type(err).__name__}: {str(err)[:180]}",
        )
