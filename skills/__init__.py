"""
SkillRegistry — auto-discovers skills from the filesystem at import time.

Skills live at the **top level** of the repo (`trading-platform/skills/`) so
they're a first-class, visible extension point. Each skill is a **single**
file:
  - SKILL.md  (YAML frontmatter + markdown documentation)

There is NO `handler.py` per skill. The Python logic that runs when a skill
is dispatched lives in `core/agents/processors.py` and is looked up by
`VibeTrade.dispatch(skill_id, ...)`.

Directories starting with `_` (e.g. `_template`) are skipped.

The unified "Vibe Trade" agent (`core/agents/vibe_trade_agent.py`) is the
single default agent the product exposes — it reads the skill's SKILL.md,
enforces its declared tool allowlist, and routes to the matching processor.

Usage::

    from skills import skill_registry
    skill = skill_registry.get("pattern")
    print(skill.metadata.tools)  # e.g. ["chart.pattern_selector", ...]
    print(skill.prompt_doc)      # the markdown body of SKILL.md
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

import yaml

from skills.base import (
    InputHints,
    OutputTab,
    Skill,
    SkillMetadata,
)
from skills.tools import validate_tools


def _parse_skill_md(path: Path) -> tuple[Dict, str]:
    """Parse a SKILL.md file into (frontmatter_dict, body_markdown)."""
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ValueError(f"{path} is missing YAML frontmatter (expected leading ---)")
    # Split on the next --- delimiter
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"{path} has a malformed frontmatter block")
    frontmatter = yaml.safe_load(parts[1]) or {}
    body = parts[2].lstrip("\n")
    return frontmatter, body


def _build_metadata(fm: Dict) -> SkillMetadata:
    """Build a SkillMetadata dataclass from a parsed frontmatter dict."""
    output_tabs = [
        OutputTab(
            id=t["id"],
            label=t["label"],
            component=t["component"],
        )
        for t in (fm.get("output_tabs") or [])
    ]
    hints = fm.get("input_hints") or {}
    input_hints = InputHints(
        placeholder=hints.get("placeholder", ""),
        supports_fingerprint=bool(hints.get("supports_fingerprint", False)),
    )
    return SkillMetadata(
        id=fm["id"],
        name=fm["name"],
        tagline=fm.get("tagline", fm["name"]),
        description=fm.get("description", ""),
        version=fm.get("version", "0.0.1"),
        author=fm.get("author", "Unknown"),
        category=fm.get("category", "general"),
        icon=fm.get("icon", "sparkles"),
        color=fm.get("color", "#ff6b00"),
        tools=list(fm.get("tools") or []),
        output_tabs=output_tabs,
        store_slots=list(fm.get("store_slots") or []),
        input_hints=input_hints,
    )


class SkillRegistry:
    """Registry of all loaded skills. Instantiated once at module import."""

    def __init__(self) -> None:
        self.skills: Dict[str, Skill] = {}
        self._discover()

    def _discover(self) -> None:
        skills_dir = Path(__file__).parent
        for item in sorted(skills_dir.iterdir()):
            if not item.is_dir():
                continue
            name = item.name
            if name.startswith("_") or name == "__pycache__":
                continue
            try:
                self._load_skill(item)
            except Exception as exc:  # noqa: BLE001
                print(f"[skill_registry] failed to load skill {name}: {exc}")

    def _load_skill(self, skill_dir: Path) -> None:
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            raise FileNotFoundError(f"Missing SKILL.md in {skill_dir}")

        frontmatter, body = _parse_skill_md(skill_md)
        metadata = _build_metadata(frontmatter)

        # Validate declared tools against the central catalog. Unknown tools
        # print a warning but don't block loading — a skill may reference
        # in-development tools that haven't shipped yet.
        validate_tools(metadata.tools, skill_id=metadata.id)

        self.skills[metadata.id] = Skill(
            metadata=metadata,
            prompt_doc=body,
        )
        print(f"[skill_registry] loaded skill: {metadata.id} ({metadata.name}) — tools: {len(metadata.tools)}")

    # ─── Public API ─────────────────────────────────────────────────────────

    def get(self, skill_id: str) -> Optional[Skill]:
        return self.skills.get(skill_id)

    def list(self) -> List[Skill]:
        return list(self.skills.values())

    def to_json(self) -> List[Dict]:
        return [s.metadata.to_dict() for s in self.skills.values()]


# Module singleton — discovered once at import time.
skill_registry = SkillRegistry()
