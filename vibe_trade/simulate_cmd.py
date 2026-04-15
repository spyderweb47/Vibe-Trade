"""
`vibe-trade simulate` — run a multi-agent debate simulation in the terminal.

Reuses the same backend engine the web UI's Simulation mode calls into, but
streams the discussion to the terminal with Rich for a readable live view.

Requires an LLM provider to be configured via .env (OPENAI_API_KEY,
ANTHROPIC_API_KEY, or any other key supported by core.agents.llm_client).
"""

from __future__ import annotations

import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt

console = Console()


def _ensure_repo_on_path() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "core" / "agents" / "simulation_agents.py").exists():
            if str(parent) not in sys.path:
                sys.path.insert(0, str(parent))
            return parent
    return current.parents[1]


def run_simulate(
    asset: str | None,
    rounds: int,
    speakers: int,
    report: str,
) -> None:
    _ensure_repo_on_path()

    # Prompt interactively if no asset was passed on the command line
    if not asset:
        console.print(
            Panel(
                "Run an AI committee debate on any asset and watch it stream in the terminal.\n"
                "Examples: [bold]BTC[/bold], [bold]AAPL[/bold], [bold]gold[/bold], [bold]tsla[/bold], [bold]EURUSD[/bold]",
                title="[bold]Vibe Trade · Simulate[/bold]",
                border_style="cyan",
                padding=(0, 2),
            )
        )
        asset = Prompt.ask("[cyan]Asset to debate[/cyan]")
        if not asset:
            console.print("[red]No asset provided — aborting.[/red]")
            raise SystemExit(1)

    # Check LLM availability before burning cycles
    try:
        from core.agents.llm_client import is_available as llm_available, active_provider_info
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]Can't import llm_client:[/red] {exc}")
        raise SystemExit(1)

    if not llm_available():
        console.print(
            Panel(
                "[red]No LLM provider configured.[/red]\n\n"
                "Set one of these in your .env and try again:\n"
                "  [cyan]OPENAI_API_KEY[/cyan]     (OpenAI / compat)\n"
                "  [cyan]ANTHROPIC_API_KEY[/cyan]  (Claude)\n"
                "  [cyan]DEEPSEEK_API_KEY[/cyan]\n"
                "  [cyan]GROQ_API_KEY[/cyan]\n"
                "  [cyan]GEMINI_API_KEY[/cyan]",
                title="[bold red]LLM required[/bold red]",
                border_style="red",
            )
        )
        raise SystemExit(1)

    provider = active_provider_info()
    console.print(
        f"[dim]Using[/dim] [bold cyan]{provider.get('provider', 'unknown')}[/bold cyan] · "
        f"[dim]{provider.get('model', '')}[/dim]"
    )

    # Run the debate engine. We import here (not at module top) so the CLI
    # can show a nice error if the simulation module has issues.
    try:
        from core.agents.simulation_agents import run_discussion
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]Failed to import simulation engine:[/red] {exc}")
        raise SystemExit(1)

    console.rule(f"[bold cyan]Debate: {asset}[/bold cyan]")

    with console.status(f"[cyan]Classifying asset + generating {speakers} personas...[/cyan]"):
        try:
            result = run_discussion(
                dataset_name=asset,
                bars_summary={"asset_name": asset, "bars_analyzed": 0},
                user_context=report,
                num_speakers=speakers,
                num_rounds=rounds,
            )
        except Exception as exc:  # noqa: BLE001
            console.print(f"[red]✕ Simulation failed:[/red] {exc}")
            raise SystemExit(1)

    # Stream the thread
    thread = result.get("thread", [])
    current_round = 0
    for msg in thread:
        msg_round = msg.get("round", 0)
        if msg_round != current_round:
            current_round = msg_round
            console.rule(f"[bold]Round {current_round}[/bold]", style="dim")
        name = msg.get("entity_name", "?")
        role = msg.get("entity_role", "")
        content = msg.get("content", "")
        sentiment = msg.get("sentiment", 0)
        sentiment_color = "green" if sentiment > 0.2 else "red" if sentiment < -0.2 else "white"
        header = f"[bold {sentiment_color}]{name}[/bold {sentiment_color}] [dim]· {role}[/dim]"
        console.print(header)
        console.print(f"  {content}\n")

    # Final summary
    summary = result.get("summary") or {}
    if summary:
        dir_ = summary.get("consensus_direction", "NEUTRAL")
        conf = summary.get("confidence", 0)
        dir_color = "green" if dir_ == "BULLISH" else "red" if dir_ == "BEARISH" else "yellow"
        console.rule(f"[bold {dir_color}]Consensus: {dir_}[/bold {dir_color}]", style=dir_color)

        lines = [
            f"[bold]Confidence:[/bold] {int(conf * 100)}%",
        ]
        targets = summary.get("price_targets") or {}
        if targets:
            lines.append(
                f"[bold]Price targets:[/bold] low={targets.get('low', '?')} · "
                f"mid={targets.get('mid', '?')} · high={targets.get('high', '?')}"
            )
        key_args = summary.get("key_arguments") or []
        if key_args:
            lines.append("")
            lines.append("[bold]Key arguments:[/bold]")
            for arg in key_args[:5]:
                lines.append(f"  • {arg}")
        dissent = summary.get("dissenting_views") or []
        if dissent:
            lines.append("")
            lines.append("[bold]Dissenting:[/bold]")
            for d in dissent[:3]:
                lines.append(f"  • {d}")
        rec = summary.get("recommendation") or {}
        if rec.get("action"):
            lines.append("")
            lines.append(
                f"[bold]Recommendation:[/bold] [bold {dir_color}]{rec.get('action')}[/bold {dir_color}]"
            )
            if rec.get("entry"):
                lines.append(f"  entry={rec.get('entry')} stop={rec.get('stop')} target={rec.get('target')}")

        console.print(Panel("\n".join(lines), border_style=dir_color, padding=(0, 2)))
