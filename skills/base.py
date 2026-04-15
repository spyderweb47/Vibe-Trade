"""
Core types for the skill system.

Skills live at the **top level** of the repo (`trading-platform/skills/`).
Each skill is a self-contained capability package:
  - SKILL.md   → YAML frontmatter metadata + markdown documentation
  - handler.py → async `handle(message, context, tools) -> SkillResponse`

The SkillRegistry (see `__init__.py`) auto-discovers all skills at import time
by scanning this directory for subfolders (except those starting with `_`) and
parsing their SKILL.md + importing their handler.py.

The unified "Vibe Trade" agent (see `core/agents/vibe_trade_agent.py`) is the
single default agent the product exposes to the user. It dispatches messages
to skills by id. Skills declare the tools they need in their metadata; the
frontend tool registry (`apps/web/src/lib/toolRegistry.ts`) enforces that
allowlist when executing `tool_calls` returned in a SkillResponse.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class OutputTab:
    """A bottom-panel tab contributed by a skill."""

    id: str
    label: str
    component: str  # Frontend React component name (looked up in BOTTOM_PANEL_COMPONENTS)


@dataclass
class InputHints:
    """Hints for how the frontend should configure the chat input for this skill."""

    placeholder: str = ""
    supports_fingerprint: bool = False


@dataclass
class SkillMetadata:
    """Metadata parsed from a skill's SKILL.md frontmatter."""

    id: str
    name: str
    tagline: str
    description: str
    version: str
    author: str
    category: str
    icon: str
    color: str
    tools: List[str]
    output_tabs: List[OutputTab]
    store_slots: List[str]
    input_hints: InputHints

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "tagline": self.tagline,
            "description": self.description,
            "version": self.version,
            "author": self.author,
            "category": self.category,
            "icon": self.icon,
            "color": self.color,
            "tools": list(self.tools),
            "output_tabs": [
                {"id": t.id, "label": t.label, "component": t.component}
                for t in self.output_tabs
            ],
            "store_slots": list(self.store_slots),
            "input_hints": {
                "placeholder": self.input_hints.placeholder,
                "supports_fingerprint": self.input_hints.supports_fingerprint,
            },
        }


@dataclass
class ToolContext:
    """Passed to a skill handler describing which tools it is allowed to invoke."""

    skill_id: str
    allowed_tools: List[str]


@dataclass
class Skill:
    """
    A loaded skill. Skills are pure documentation + metadata — there is NO
    `handler` here. The SkillRegistry only knows what the skill declares in
    SKILL.md; the actual Python logic lives in `core/agents/processors.py`
    and is looked up at dispatch time by `VibeTrade.dispatch(skill_id, ...)`.
    """

    metadata: SkillMetadata
    prompt_doc: str  # The markdown body of SKILL.md after the frontmatter


@dataclass
class SkillResponse:
    """
    Returned by a skill handler. Carries the chat reply, optional generated
    script, arbitrary data payload, and a list of tool_calls the frontend
    should execute (e.g. load script into editor, switch bottom-panel tab).
    """

    reply: str
    script: Optional[str] = None
    script_type: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "reply": self.reply,
            "script": self.script,
            "script_type": self.script_type,
            "data": self.data,
            "tool_calls": self.tool_calls,
        }
