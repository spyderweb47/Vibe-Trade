"""
`vibe-trade skills list` / `vibe-trade skills show <id>` — inspect the
skill registry from the terminal.
"""

from __future__ import annotations

import sys
from pathlib import Path

from rich.console import Console
from rich.markdown import Markdown
from rich.table import Table

console = Console()


def _ensure_repo_on_path() -> None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "skills" / "__init__.py").exists():
            if str(parent) not in sys.path:
                sys.path.insert(0, str(parent))
            return


def run_skills_list() -> None:
    _ensure_repo_on_path()
    from core.skill_registry import skill_registry

    table = Table(title="Registered Skills", show_lines=False)
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Name", style="bold")
    table.add_column("Category", style="dim")
    table.add_column("Tools", justify="right")
    table.add_column("Tabs", justify="right")
    table.add_column("Description")

    for skill in skill_registry.list():
        m = skill.metadata
        table.add_row(
            m.id,
            m.name,
            m.category,
            str(len(m.tools)),
            str(len(m.output_tabs)),
            (m.description[:60] + "…") if len(m.description) > 60 else m.description,
        )

    console.print(table)


def run_skills_show(skill_id: str) -> None:
    _ensure_repo_on_path()
    from core.skill_registry import skill_registry

    skill = skill_registry.get(skill_id)
    if not skill:
        console.print(f"[red]No skill with id '{skill_id}'[/red]")
        all_ids = [s.metadata.id for s in skill_registry.list()]
        console.print(f"[dim]Available:[/dim] {', '.join(all_ids)}")
        raise SystemExit(1)

    m = skill.metadata
    console.rule(f"[bold cyan]{m.name}[/bold cyan] · [dim]{m.id}[/dim]")
    console.print(f"[dim]Version:[/dim] {m.version} · [dim]Author:[/dim] {m.author}")
    console.print(f"[dim]Category:[/dim] {m.category} · [dim]Color:[/dim] [{m.color}]●[/{m.color}]")
    console.print(f"\n[bold]Tools ({len(m.tools)}):[/bold]")
    for tool in m.tools:
        console.print(f"  • [cyan]{tool}[/cyan]")
    if m.output_tabs:
        console.print(f"\n[bold]Output tabs ({len(m.output_tabs)}):[/bold]")
        for tab in m.output_tabs:
            console.print(f"  • [bold]{tab.label}[/bold] [dim]({tab.id} → {tab.component})[/dim]")

    console.print()
    console.print(Markdown(skill.prompt_doc))
