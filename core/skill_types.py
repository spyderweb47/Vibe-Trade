"""
Core types for the Vibe Trade skill system.

Part of the 3-layer architecture:
  Layer 1 — Canvas:  UI components, store, chart        (apps/web/src/)
  Layer 2 — Tools:   product features skills can invoke  (core/tool_catalog.py)
  Layer 3 — Skills:  SKILL.md instruction files          (skills/{name}/SKILL.md)

These types bridge all three layers:
  - SkillMetadata   → parsed from SKILL.md, served to the Canvas via /skills
  - ToolContext      → passed to processors, carries the tool allowlist
  - SkillResponse    → returned by processors, contains reply + tool_calls
  - Skill            → loaded skill = metadata + documentation body

The SkillRegistry (core/skill_registry.py) discovers skills at import time.
The VibeTrade agent (core/agents/vibe_trade_agent.py) dispatches to processors.
Processors (core/agents/processors.py) return SkillResponse with tool_calls.
The frontend tool registry (apps/web/src/lib/toolRegistry.ts) executes them.
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
    """Passed to a skill processor describing which tools it is allowed to invoke."""

    skill_id: str
    allowed_tools: List[str]


@dataclass
class Skill:
    """
    A loaded skill. Skills are pure SKILL.md instruction files — natural
    language programs for the AI agent. No Python handler lives inside the
    skill folder. The SkillRegistry only parses what the skill declares in
    SKILL.md; the actual Python logic lives in core/agents/processors.py.
    """

    metadata: SkillMetadata
    prompt_doc: str  # The markdown body of SKILL.md after the frontmatter


@dataclass
class SkillResponse:
    """
    Returned by a skill processor. Carries the chat reply, optional script,
    data payload, and tool_calls the frontend should execute (e.g. load
    script into editor, push debate data, switch bottom-panel tab).
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
