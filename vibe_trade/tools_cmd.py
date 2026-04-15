"""`vibe-trade tools` — list the central tool catalog."""

from __future__ import annotations

import sys
from pathlib import Path
from collections import defaultdict

from rich.console import Console
from rich.table import Table

console = Console()


def _ensure_repo_on_path() -> None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "skills" / "tools.py").exists():
            if str(parent) not in sys.path:
                sys.path.insert(0, str(parent))
            return


def run_tools_list() -> None:
    _ensure_repo_on_path()
    from skills.tools import TOOL_CATALOG

    # Group by category
    by_cat: dict[str, list] = defaultdict(list)
    for tool in TOOL_CATALOG:
        by_cat[tool.category].append(tool)

    for cat in sorted(by_cat.keys()):
        table = Table(title=f"[bold]{cat}[/bold]", show_lines=False, show_header=True, header_style="dim")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Name", style="bold")
        table.add_column("Description")
        for tool in by_cat[cat]:
            desc = tool.description if len(tool.description) <= 80 else tool.description[:77] + "…"
            table.add_row(tool.id, tool.name, desc)
        console.print(table)
        console.print()

    console.print(f"[dim]{len(TOOL_CATALOG)} tools across {len(by_cat)} categories.[/dim]")
