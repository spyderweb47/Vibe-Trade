"""
TeamPlanner — decides which agents a skill should assemble for a given
user request, before any real execution happens.

This is the SECOND-LEVEL planner in the two-planner architecture:

  Level 1: core/agents/planner.py
           "Which SKILLS should run for this user request?"
           (e.g. data_fetcher → pattern → strategy)

  Level 2: core/agents/team_planner.py  (this file)
           "For THIS skill + THIS user request, which AGENTS do we need?
            What's each agent's task? Which tools do they need?"
           (e.g. for pattern skill: Writer + QA mandatory, add
            Researcher with search_web if the request mentions an
            unusual / academic pattern)

The output is a TeamPlan which:
  1. Is rendered in the frontend trace UI BEFORE execution starts, so
     the user can see what team is being assembled and why.
  2. Drives the actual AgentSwarm.assemble() call.

If the LLM is unavailable or returns unparseable output, TeamPlanner
falls back to the mandatory roles only with templated tasks — no
silent failures, no plans that can't be executed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion_json, is_available as llm_available


# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class RoleTemplate:
    """
    Describes one role the planner can CHOOSE to include in a team.

    A skill author defines a list of these (mandatory + optional) and
    hands them to TeamPlanner. The planner picks which optional roles
    to include based on the user's request.
    """

    role: str
    """Canonical role id. Used as the key in Team.agents."""

    description: str
    """What this role does. Fed to the planner LLM so it knows when to include it."""

    persona_defaults: Dict[str, Any] = field(default_factory=dict)
    """Persona fields the final AgentSpec will use (name, background, style)."""

    allowed_tools: List[str] = field(default_factory=list)
    """Tool ids this role may call. Planner decides whether to actually grant
    them based on the task."""

    mandatory: bool = False
    """Must always be included regardless of what the planner says.
    QA verifiers are typically mandatory."""

    default_task: str = ""
    """Default task description if the LLM planner is unavailable or returns
    garbage."""


@dataclass
class PlannedAgent:
    """An agent the planner has decided to include in the final team."""

    role: str
    task: str
    persona: Dict[str, Any]
    tools: List[str]
    is_mandatory: bool = False


@dataclass
class TeamPlan:
    """Plan-first output — handed to AgentSwarm to actually execute."""

    skill_id: str
    user_message: str

    reasoning: str
    """One-paragraph LLM explanation of why this team was assembled.
    Shown in the trace UI."""

    agents: List[PlannedAgent]

    execution_mode: str
    """How to run the team. One of:
       - 'qa_loop'      — producer + verifier with feedback loop
       - 'parallel'     — all agents work on same task concurrently
       - 'sequential'   — each agent sees prior outputs
       - 'discussion'   — N rounds of rotating speakers
    """

    qa_producer: Optional[str] = None  # role id, for qa_loop
    qa_verifier: Optional[str] = None  # role id, for qa_loop
    qa_max_iterations: int = 3

    def to_trace_payload(self) -> Dict[str, Any]:
        """Serialise for the frontend trace UI."""
        return {
            "skill_id": self.skill_id,
            "user_message": self.user_message,
            "reasoning": self.reasoning,
            "execution_mode": self.execution_mode,
            "agents": [
                {
                    "role": a.role,
                    "task": a.task,
                    "tools": a.tools,
                    "mandatory": a.is_mandatory,
                    "persona_name": a.persona.get("name", a.role),
                }
                for a in self.agents
            ],
            "qa": (
                {"producer": self.qa_producer,
                 "verifier": self.qa_verifier,
                 "max_iterations": self.qa_max_iterations}
                if self.execution_mode == "qa_loop" else None
            ),
        }


# ─── The planner ─────────────────────────────────────────────────────────────


TEAM_PLANNER_PROMPT = """You are the team-planning module for the Vibe Trade
skill system. Your job: given a user request + the list of roles a skill
offers, decide which agents to actually spawn and what each should do.

## Available roles
{roles_doc}

## Mandatory roles (MUST be included)
{mandatory_roles}

## Rules
1. Include ALL mandatory roles — they're required for this skill to function.
2. Include OPTIONAL roles only when the request genuinely benefits from them.
   - Don't add a researcher for "bullish engulfing" (classic pattern, well known).
   - DO add a researcher for "find the Wyckoff accumulation phase with
     volume-price divergence" (specialist pattern).
3. Assign each agent a CONCRETE task — what they specifically do in this run.
4. For each agent, list the tools they'll need. Only include tools from
   their role's allowed list. Empty array = agent reasons with no tools.
5. Pick execution_mode carefully:
   - qa_loop: producer generates, verifier checks, loop. Default for
     anything that produces code, config, or a generated artefact.
   - parallel: agents work independently on the same task.
   - sequential: each agent builds on prior agents' outputs.
   - discussion: multi-round debate with rotating speakers.
6. For qa_loop, name the producer role and verifier role.

## Output format
Return STRICT JSON only, no markdown:

{{
  "reasoning": "1-2 sentence explanation of the team composition",
  "execution_mode": "qa_loop" | "parallel" | "sequential" | "discussion",
  "agents": [
    {{
      "role": "<role id from available roles>",
      "task": "specific task for this agent in this run",
      "tools": ["tool_id", ...]
    }}
  ],
  "qa_producer": "<role id>",     // only if execution_mode == "qa_loop"
  "qa_verifier": "<role id>",     // only if execution_mode == "qa_loop"
  "qa_max_iterations": 3
}}

The user's request is in the next message.
"""


class TeamPlanner:
    """
    Plans the agent team for a skill invocation.

    Usage by a skill processor:
        planner = TeamPlanner()
        plan = planner.plan(
            skill_id="pattern",
            user_message=message,
            templates=[
                RoleTemplate(role="writer", mandatory=True, ...),
                RoleTemplate(role="qa", mandatory=True, ...),
                RoleTemplate(role="researcher", mandatory=False, ...),
            ],
            default_execution_mode="qa_loop",
        )
    """

    def plan(
        self,
        skill_id: str,
        user_message: str,
        templates: List[RoleTemplate],
        default_execution_mode: str = "qa_loop",
    ) -> TeamPlan:
        # Build the roles-doc for the LLM prompt
        mandatory_names = [t.role for t in templates if t.mandatory]
        roles_doc = "\n".join(
            f"- `{t.role}` — {t.description} "
            f"(tools available: {', '.join(t.allowed_tools) if t.allowed_tools else 'none'}"
            f"{', MANDATORY' if t.mandatory else ''})"
            for t in templates
        )
        mandatory_doc = (
            ", ".join(f"`{r}`" for r in mandatory_names)
            if mandatory_names else "(none)"
        )

        # LLM-driven plan
        parsed: Optional[Dict[str, Any]] = None
        if llm_available():
            try:
                parsed = chat_completion_json(
                    system_prompt=TEAM_PLANNER_PROMPT.format(
                        roles_doc=roles_doc,
                        mandatory_roles=mandatory_doc,
                    ),
                    user_message=user_message,
                    temperature=0.2,
                    max_tokens=700,
                )
            except Exception as err:  # noqa: BLE001
                print(f"[team_planner] LLM planning failed: {err}", flush=True)
                parsed = None

        if parsed and "agents" in parsed:
            return self._build_from_llm(
                skill_id, user_message, templates, parsed, default_execution_mode,
            )

        # Fallback — mandatory only with default tasks
        print(
            f"[team_planner] falling back to mandatory-only plan for {skill_id}",
            flush=True,
        )
        return self._fallback_plan(
            skill_id, user_message, templates, default_execution_mode,
        )

    def _build_from_llm(
        self,
        skill_id: str,
        user_message: str,
        templates: List[RoleTemplate],
        parsed: Dict[str, Any],
        default_mode: str,
    ) -> TeamPlan:
        template_map = {t.role: t for t in templates}
        agents: List[PlannedAgent] = []
        seen_roles: set = set()

        for raw in (parsed.get("agents") or []):
            if not isinstance(raw, dict):
                continue
            role = str(raw.get("role", "")).strip()
            if role not in template_map or role in seen_roles:
                continue
            seen_roles.add(role)
            tmpl = template_map[role]
            # Clamp requested tools to the role's allowed list
            req_tools = raw.get("tools") or []
            if not isinstance(req_tools, list):
                req_tools = []
            allowed = set(tmpl.allowed_tools)
            granted = [t for t in req_tools if isinstance(t, str) and t in allowed]
            agents.append(PlannedAgent(
                role=role,
                task=str(raw.get("task", tmpl.default_task)).strip() or tmpl.default_task,
                persona=dict(tmpl.persona_defaults),
                tools=granted,
                is_mandatory=tmpl.mandatory,
            ))

        # Always include missing mandatory roles with their defaults
        for tmpl in templates:
            if tmpl.mandatory and tmpl.role not in seen_roles:
                agents.append(PlannedAgent(
                    role=tmpl.role,
                    task=tmpl.default_task,
                    persona=dict(tmpl.persona_defaults),
                    tools=list(tmpl.allowed_tools),  # mandatory roles get all their tools
                    is_mandatory=True,
                ))

        mode = str(parsed.get("execution_mode", default_mode))
        if mode not in ("qa_loop", "parallel", "sequential", "discussion"):
            mode = default_mode

        return TeamPlan(
            skill_id=skill_id,
            user_message=user_message,
            reasoning=str(parsed.get("reasoning", "")).strip() or "Team assembled.",
            agents=agents,
            execution_mode=mode,
            qa_producer=parsed.get("qa_producer") if mode == "qa_loop" else None,
            qa_verifier=parsed.get("qa_verifier") if mode == "qa_loop" else None,
            qa_max_iterations=int(parsed.get("qa_max_iterations", 3) or 3),
        )

    def _fallback_plan(
        self,
        skill_id: str,
        user_message: str,
        templates: List[RoleTemplate],
        default_mode: str,
    ) -> TeamPlan:
        """When the LLM planner is unavailable or fails: use mandatory
        roles only with their default tasks. Guaranteed executable."""
        agents = [
            PlannedAgent(
                role=t.role,
                task=t.default_task or f"Execute your role as {t.role}",
                persona=dict(t.persona_defaults),
                tools=list(t.allowed_tools),
                is_mandatory=t.mandatory,
            )
            for t in templates if t.mandatory
        ]

        qa_producer = None
        qa_verifier = None
        if default_mode == "qa_loop":
            # Heuristic: first non-qa mandatory role is the producer,
            # first qa role is the verifier.
            for a in agents:
                if a.role in ("qa", "qa_verifier") or a.role.endswith("_verifier"):
                    qa_verifier = a.role
                elif qa_producer is None:
                    qa_producer = a.role

        return TeamPlan(
            skill_id=skill_id,
            user_message=user_message,
            reasoning="LLM team planner unavailable — using mandatory-only fallback.",
            agents=agents,
            execution_mode=default_mode,
            qa_producer=qa_producer,
            qa_verifier=qa_verifier,
            qa_max_iterations=3,
        )
