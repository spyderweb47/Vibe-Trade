"""
AgentSwarm — the Canvas-level agent orchestration service.

This is a **platform capability**, not a skill. Every skill can
instantiate an AgentSwarm and use it to spawn agents with personas,
run them in parallel, run them sequentially, or run them in a
closed QA loop where a producer agent iterates based on feedback
from a verifier agent.

Design goals (see docs/AGENT_SWARM.md):
  - Skills declare WHAT team they need (via AgentSpec list)
  - The service handles HOW: parallelism, timeouts, retries,
    event recording
  - Reliability is inherited by every skill that uses it

This module is the entry point. The actual agent runtime
(`Agent`, `AgentSpec`, `AgentResponse`) lives in
`core/agents/base_agent.py`; the QA loop lives in
`core/agents/qa_agent.py`; the shared tools live in
`core/agents/swarm_tools.py`. This file composes them into a
coherent service.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from core.agents.base_agent import Agent, AgentResponse, AgentSpec
from core.agents.qa_agent import QASpec, QAResult, QAVerifierAgent, run_qa_loop

# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class RunEvent:
    """A notable event during a swarm run (error, timeout, warning).

    Surfaces to the UI via the calling skill's SkillResponse so the user
    knows what happened without reading server logs.
    """

    timestamp: str
    level: str                                 # info | warn | error
    stage: str                                 # free-form — caller chooses
    agent_role: Optional[str] = None
    message: str = ""


@dataclass
class DiscussionMessage:
    """One message in a Team.discussion() flow. Mirrors the shape used
    by predict_analysis's Stage 3, but available to any skill that wants
    a round-based debate."""

    round: int
    agent_role: str
    content: str
    sentiment: float = 0.0
    confidence: float = 0.5
    structured: Optional[Dict[str, Any]] = None


@dataclass
class DiscussionResult:
    """Output of Team.discussion()."""

    messages: List[DiscussionMessage]
    rounds_actual: int                         # may be less than requested if converged
    converged_early: bool = False


# ─── The service ─────────────────────────────────────────────────────────────


class AgentSwarm:
    """
    Entry point for skills that want to use the agentic capability.

    Usage:
        swarm = AgentSwarm()
        team = swarm.assemble([AgentSpec(...), AgentSpec(...)])
        results = await team.run_parallel(task="...", context="...")
        qa = await team.run_with_qa_loop(producer_role="writer", ...)
        swarm.events()   # → list of RunEvents for surfacing to UI
    """

    # Reliability defaults — override per-call with keyword arguments on
    # the Team methods. The LLM client and base_agent respect these.
    DEFAULT_TIMEOUT_S: float = 180.0
    DEFAULT_MAX_CONCURRENCY: int = 15

    def __init__(self) -> None:
        self._events: List[RunEvent] = []

    # ─── Event API ───────────────────────────────────────────────────────

    def events(self) -> List[RunEvent]:
        """All recorded events so far. Skills pass this through to
        SkillResponse.data['events'] so the UI can render them."""
        return list(self._events)

    def _event(
        self,
        level: str,
        stage: str,
        message: str,
        agent_role: Optional[str] = None,
    ) -> None:
        """Record an event AND print to the server console.

        The print is Unicode-safe — Windows' default console encoding
        (cp1252) can't render symbols like → or ±, and a raw print()
        crash here used to bubble up as a 500 in /chat. We try the full
        unicode string first, then fall back to ASCII with replacement.
        """
        ts_iso = time.strftime("%Y-%m-%dT%H:%M:%S")
        ts_hms = time.strftime("%H:%M:%S")
        prefix = {"info": "i", "warn": "!", "error": "x"}.get(level, "-")
        role = f"[{agent_role}]" if agent_role else ""
        line = f"[{ts_hms}] [swarm.{stage}]{role} {prefix} {message}"
        try:
            print(line, flush=True)
        except UnicodeEncodeError:
            # Re-encode using the actual stdout encoding with replacement
            # so unprintable chars become "?" instead of crashing the
            # whole request. Most common on Windows where the default
            # console is cp1252.
            import sys
            enc = (getattr(sys.stdout, "encoding", None) or "ascii")
            try:
                print(line.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)
            except Exception:  # noqa: BLE001
                print(line.encode("ascii", errors="replace").decode("ascii"), flush=True)
        self._events.append(RunEvent(
            timestamp=ts_iso,
            level=level,
            stage=stage,
            agent_role=agent_role,
            message=message,
        ))

    # ─── Agent spawning ──────────────────────────────────────────────────

    def spawn(self, spec: AgentSpec) -> "SwarmAgent":
        """
        Create a single agent. Resolves tools from ROLE_TOOL_MAP if not
        explicitly provided, and wires the tool executor so
        `Agent.use_tool(id, args)` actually runs the right thing.
        """
        # Resolve tool list if unset
        if spec.tools is None:
            from core.agents.swarm_tools import ROLE_TOOL_MAP
            resolved = list(ROLE_TOOL_MAP.get(
                spec.persona.get("specialization", spec.role), [],
            ))
            spec = AgentSpec(
                role=spec.role,
                persona=spec.persona,
                tools=resolved,
                system_prompt=spec.system_prompt,
                temperature=spec.temperature,
                max_tokens=spec.max_tokens,
                timeout_s=spec.timeout_s,
            )
        # Pick the right Agent subclass for the role
        if spec.role == "qa" or spec.role.endswith("_verifier"):
            return SwarmQAAgent(spec, event_sink=self._event)
        return SwarmAgent(spec, event_sink=self._event)

    def assemble(self, specs: List[AgentSpec]) -> "Team":
        """Create a team from a list of specs. Sugar around spawn()."""
        return Team(
            agents={s.role: self.spawn(s) for s in specs},
            event_sink=self._event,
        )


# ─── Agent with tool wiring + event sink ─────────────────────────────────────


class SwarmAgent(Agent):
    """
    Agent subclass that actually routes tool calls through the shared
    tools registry and emits events via the swarm's sink.

    The base Agent class's `use_tool` is a no-op safety net — this
    override is where tool execution actually happens.
    """

    def __init__(
        self,
        spec: AgentSpec,
        event_sink: Callable[[str, str, str, Optional[str]], None],
    ) -> None:
        super().__init__(spec)
        self._emit = event_sink

    def use_tool(self, tool_id: str, args: Dict[str, Any]) -> str:
        """Route to swarm_tools.execute_tool if allowed; record event otherwise."""
        if tool_id not in (self.spec.tools or []):
            msg = f"denied: tool '{tool_id}' not in spec.tools"
            self._emit("warn", "tool_use", msg, self.spec.role)
            self._tool_log[tool_id] = f"(denied: not in allowed tools)"
            return self._tool_log[tool_id]
        try:
            from core.agents.swarm_tools import execute_tool
            result = execute_tool(tool_id, **args)
            # Cap for prompt reuse
            short = result[:500] if isinstance(result, str) else str(result)[:500]
            self._tool_log[tool_id] = short
            return short
        except Exception as err:  # noqa: BLE001
            msg = f"{type(err).__name__}: {str(err)[:180]}"
            self._emit("warn", "tool_use", msg, self.spec.role)
            self._tool_log[tool_id] = f"Error: {msg}"
            return self._tool_log[tool_id]


class SwarmQAAgent(QAVerifierAgent, SwarmAgent):  # type: ignore[misc]
    """A QA verifier with swarm tool wiring. Multi-inherits to compose."""
    pass


# ─── Team — orchestration primitives ─────────────────────────────────────────


class Team:
    """
    A group of agents assembled for a skill. Exposes the orchestration
    primitives: parallel, sequential, discussion, QA loop.

    All methods are async. Internally they wrap `asyncio.to_thread` over
    the agents' synchronous `speak` / `reflect` / `use_tool` — keeping
    the agent code simple while still letting the caller await the
    service from async skill processors.
    """

    def __init__(
        self,
        agents: Dict[str, SwarmAgent],
        event_sink: Callable[[str, str, str, Optional[str]], None],
    ) -> None:
        self.agents = agents
        self._emit = event_sink

    # ─── Primitive 1: parallel execution ─────────────────────────────────

    async def run_parallel(
        self,
        task: str,
        context: str,
        timeout_s: float = AgentSwarm.DEFAULT_TIMEOUT_S,
    ) -> Dict[str, AgentResponse]:
        """
        All agents work on the same task concurrently. Timeouts are
        per-agent (not per-team) so one slow agent can't block the rest.
        """
        async def _run_one(role: str, agent: SwarmAgent) -> tuple[str, AgentResponse]:
            try:
                resp = await asyncio.wait_for(
                    asyncio.to_thread(agent.speak, context, task),
                    timeout=timeout_s,
                )
                return role, resp
            except asyncio.TimeoutError:
                self._emit(
                    "warn", "run_parallel",
                    f"agent timed out after {timeout_s:.0f}s — skipping",
                    role,
                )
                return role, AgentResponse(
                    content=f"(agent {role} timed out)",
                    confidence=0.0,
                    error="timeout",
                )

        results = await asyncio.gather(
            *[_run_one(role, a) for role, a in self.agents.items()]
        )
        return dict(results)

    # ─── Primitive 2: sequential execution ───────────────────────────────

    async def run_sequential(
        self,
        task: str,
        context: str,
        order: List[str],
        timeout_s: float = AgentSwarm.DEFAULT_TIMEOUT_S,
    ) -> Dict[str, AgentResponse]:
        """
        Each agent gets prior agents' outputs as additional context. Later
        agents therefore build on earlier agents' reasoning.
        """
        results: Dict[str, AgentResponse] = {}
        accumulated_context = context
        for role in order:
            agent = self.agents.get(role)
            if agent is None:
                self._emit("error", "run_sequential", f"unknown role '{role}'")
                continue
            try:
                resp = await asyncio.wait_for(
                    asyncio.to_thread(agent.speak, accumulated_context, task),
                    timeout=timeout_s,
                )
            except asyncio.TimeoutError:
                self._emit(
                    "warn", "run_sequential",
                    f"agent timed out after {timeout_s:.0f}s — chain continues without",
                    role,
                )
                resp = AgentResponse(
                    content=f"(agent {role} timed out)",
                    confidence=0.0,
                    error="timeout",
                )
            results[role] = resp
            accumulated_context = (
                accumulated_context
                + f"\n\n## Prior output from {role}\n{resp.content}"
            )
        return results

    # ─── Primitive 3: QA loop ────────────────────────────────────────────

    async def run_with_qa_loop(
        self,
        task: str,
        context: str,
        producer_role: str,
        verifier_role: str,
        max_iterations: int = 3,
        spec: Optional[QASpec] = None,
        timeout_s: float = AgentSwarm.DEFAULT_TIMEOUT_S,
    ) -> QAResult:
        """
        Producer generates → verifier checks → producer iterates on
        feedback. The actual loop logic is in `core/agents/qa_agent.py`;
        this wraps it in asyncio.to_thread and wires events.
        """
        producer = self.agents.get(producer_role)
        verifier = self.agents.get(verifier_role)
        if producer is None or verifier is None:
            self._emit(
                "error", "qa_loop",
                f"missing agents — producer={producer_role} verifier={verifier_role}",
            )
            return QAResult(
                passed=False,
                final_artifact=AgentResponse(content="", error="missing agents"),
                iterations=0,
                final_reason="missing_agents",
            )

        if not isinstance(verifier, QAVerifierAgent):
            self._emit(
                "error", "qa_loop",
                f"verifier agent '{verifier_role}' is not a QA verifier "
                f"(ensure its role is 'qa' or ends with '_verifier')",
            )
            return QAResult(
                passed=False,
                final_artifact=AgentResponse(content="", error="verifier not QA agent"),
                iterations=0,
                final_reason="wrong_verifier_type",
            )

        spec = spec or QASpec(acceptance_criteria=task)

        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(
                    run_qa_loop,
                    producer, verifier, task, context, spec, max_iterations,
                ),
                timeout=timeout_s * max_iterations,  # generous outer ceiling
            )
            self._emit(
                "info" if result.passed else "warn",
                "qa_loop",
                f"{'passed' if result.passed else 'did not pass'} after "
                f"{result.iterations} iteration(s) — reason={result.final_reason}",
            )
            return result
        except asyncio.TimeoutError:
            self._emit("error", "qa_loop", "entire QA loop timed out")
            return QAResult(
                passed=False,
                final_artifact=AgentResponse(content="", error="outer timeout"),
                iterations=0,
                final_reason="outer_timeout",
            )

    # ─── Primitive 4: discussion (round-based debate) ────────────────────

    async def discussion(
        self,
        rounds: int,
        speakers_per_round: int,
        task: str,
        context: str,
        timeout_s_per_speaker: float = AgentSwarm.DEFAULT_TIMEOUT_S,
        convergence_threshold: float = 0.05,
    ) -> DiscussionResult:
        """
        Round-based debate with rotating speakers. This is the Stage-3
        primitive from predict_analysis, but usable by any skill that
        wants multiple agents to argue over N rounds.

        predict_analysis-specific details (data feeds, intel briefing
        injection, per-agent research) are handled at the caller level —
        this method is the generic skeleton.
        """
        agent_list = list(self.agents.items())
        n_agents = len(agent_list)
        if n_agents == 0:
            return DiscussionResult(messages=[], rounds_actual=0)

        messages: List[DiscussionMessage] = []
        sentiments_by_round: List[float] = []
        rounds_actual = 0
        converged = False

        for round_num in range(1, rounds + 1):
            rounds_actual = round_num
            # Rotate speakers
            start_idx = ((round_num - 1) * speakers_per_round) % n_agents
            speaker_indices = [
                (start_idx + j) % n_agents for j in range(speakers_per_round)
            ]
            speakers = [agent_list[i] for i in speaker_indices]

            # Build thread text for this round
            thread_text = "\n".join(
                f"R{m.round} {m.agent_role}: {m.content}" for m in messages[-50:]
            )
            round_context = (
                f"{context}\n\n"
                f"## Conversation so far (round {round_num}/{rounds})\n"
                f"{thread_text or '(no messages yet)'}"
            )

            # Run all speakers in parallel with per-speaker timeout
            async def _run_speaker(role: str, agent: SwarmAgent):
                try:
                    return role, await asyncio.wait_for(
                        asyncio.to_thread(agent.speak, round_context, task),
                        timeout=timeout_s_per_speaker,
                    )
                except asyncio.TimeoutError:
                    self._emit(
                        "warn", "discussion",
                        f"speaker timed out round {round_num}",
                        role,
                    )
                    return role, AgentResponse(
                        content="(timed out)", confidence=0.0, error="timeout",
                    )

            round_results = await asyncio.gather(
                *[_run_speaker(role, agent) for role, agent in speakers]
            )

            round_sentiments: List[float] = []
            for role, resp in round_results:
                sentiment = 0.0
                if resp.structured and "sentiment" in resp.structured:
                    try:
                        sentiment = float(resp.structured["sentiment"])
                    except (TypeError, ValueError):
                        sentiment = 0.0
                messages.append(DiscussionMessage(
                    round=round_num,
                    agent_role=role,
                    content=resp.content,
                    sentiment=sentiment,
                    confidence=resp.confidence,
                    structured=resp.structured,
                ))
                round_sentiments.append(sentiment)

            if round_sentiments:
                sentiments_by_round.append(
                    sum(round_sentiments) / len(round_sentiments)
                )

            # Convergence check (like predict_analysis's Stage 3)
            if round_num >= 20 and len(sentiments_by_round) >= 5:
                recent = sentiments_by_round[-5:]
                if max(recent) - min(recent) < convergence_threshold:
                    converged = True
                    self._emit(
                        "info", "discussion",
                        f"converged early at round {round_num}",
                    )
                    break

        return DiscussionResult(
            messages=messages,
            rounds_actual=rounds_actual,
            converged_early=converged,
        )
