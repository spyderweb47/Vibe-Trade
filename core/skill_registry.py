"""
SkillRegistry — auto-discovers SKILL.md files from the skills/ directory.

Part of the 3-layer architecture:
  Layer 1 — Canvas:  UI components, store, chart        (apps/web/src/)
  Layer 2 — Tools:   product features skills can invoke  (core/tool_catalog.py)
  Layer 3 — Skills:  SKILL.md instruction files          (skills/{name}/SKILL.md)

Skills are pure natural-language instruction files — no Python code lives
inside a skill folder. Each SKILL.md is a program for the AI agent:
  - YAML frontmatter declares metadata, tools, output_tabs, input_hints
  - Markdown body contains instructions, examples, IO contracts

The registry scans `skills/` at import time, parses every SKILL.md, and
validates declared tools against the central catalog (core/tool_catalog.py).

Usage::

    from core.skill_registry import skill_registry
    skill = skill_registry.get("pattern")
    print(skill.metadata.tools)  # ["chart.pattern_selector", ...]
    print(skill.prompt_doc)      # markdown body of SKILL.md
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from core.skill_types import (
    InputHints,
    OutputTab,
    Skill,
    SkillMetadata,
)
from core.tool_catalog import validate_tools


def _find_skills_dir() -> Path:
    """
    Locate the `skills/` directory. Works both in a source checkout
    (skills/ is next to core/) and in an installed wheel (skills/ is
    installed as a package in site-packages).
    """
    # 1. Check relative to this file: core/ is a sibling of skills/
    here = Path(__file__).resolve().parent  # core/
    candidate = here.parent / "skills"
    if candidate.is_dir():
        return candidate

    # 2. Walk up looking for the repo root
    for parent in here.parents:
        c = parent / "skills"
        if c.is_dir() and (c / "pattern" / "SKILL.md").exists():
            return c
        if (parent / "pyproject.toml").exists():
            break

    # 3. Fallback: try the old location (skills as a Python package)
    try:
        import skills
        return Path(skills.__file__).parent
    except ImportError:
        pass

    return candidate  # best guess


def _parse_skill_md(path: Path) -> tuple[Dict, str]:
    """Parse a SKILL.md file into (frontmatter_dict, body_markdown)."""
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ValueError(f"{path} is missing YAML frontmatter (expected leading ---)")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"{path} has a malformed frontmatter block")
    frontmatter = yaml.safe_load(parts[1]) or {}
    body = parts[2].lstrip("\n")
    return frontmatter, body


def _build_metadata(fm: Dict) -> SkillMetadata:
    """Build a SkillMetadata dataclass from a parsed frontmatter dict."""
    output_tabs = [
        OutputTab(id=t["id"], label=t["label"], component=t["component"])
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
        skills_dir = _find_skills_dir()
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

        validate_tools(metadata.tools, skill_id=metadata.id)

        self.skills[metadata.id] = Skill(metadata=metadata, prompt_doc=body)
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
