"""
`vibe-trade simulate` — run a multi-agent debate simulation in the terminal.

Uses the same DebateOrchestrator (5-stage pipeline) that powers the web UI's
Simulation mode, fetches real market bars via core.data.fetcher, and streams
the result to the terminal. Surfaces backend run-events (timeouts, warnings,
errors) at the end so the user can see what happened without reading server
logs.

Env vars that affect behavior (set in ~/.config/vibe-trade/.env):
  LLM_PROVIDER / LLM_MODEL      — which LLM to call
  LLM_CALL_TIMEOUT_S            — per-request timeout (default 90)
  LLM_MAX_RETRIES               — retries on transient failures (default 2)
  DEBATE_TIMEOUT_S              — hard ceiling on the whole run (default 2700)
"""

from __future__ import annotations

import asyncio
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


def _fetch_bars(asset: str, interval: str, limit: int) -> tuple[list[dict], str]:
    """Fetch OHLCV bars for the asset via core.data.fetcher. Returns
    (bars, resolved_symbol). Raises on failure so caller can stop."""
    from core.data.fetcher import fetch, _NAME_ALIASES

    resolved = asset
    lower = asset.strip().lower()
    if lower in _NAME_ALIASES:
        resolved = _NAME_ALIASES[lower]
        console.print(
            f"[dim]Alias[/dim] [cyan]{asset}[/cyan] → [bold]{resolved}[/bold]"
        )

    result = fetch(
        symbol=resolved,
        source="auto",
        interval=interval,
        limit=limit,
        exchange="binance",
    )
    return result["bars"], result["symbol"]


def _render_events(events: list[dict]) -> None:
    """Render backend run-events (warnings/errors) so the terminal user can
    see what went wrong without reading server logs."""
    errors = [e for e in events if e.get("level") == "error"]
    warnings = [e for e in events if e.get("level") == "warn"]
    if not errors and not warnings:
        return

    color = "red" if errors else "yellow"
    title = f"Run Warnings · {len(errors)} error(s), {len(warnings)} warning(s)"
    lines: list[str] = []
    for ev in [*errors, *warnings]:
        level = str(ev.get("level", "info")).upper()
        stage = ev.get("stage", "")
        ts = ev.get("timestamp", "")
        # keep just HH:MM:SS off the ISO-ish timestamp
        ts_short = ts[11:19] if len(ts) >= 19 else ts
        level_color = "red" if level == "ERROR" else "yellow"
        lines.append(
            f"[bold {level_color}][{level}][/bold {level_color}] "
            f"[dim]{stage} @ {ts_short}[/dim]\n  {ev.get('message', '')}"
        )
    console.print(
        Panel(
            "\n\n".join(lines),
            title=f"[bold {color}]{title}[/bold {color}]",
            border_style=color,
            padding=(0, 2),
        )
    )


def run_simulate(
    asset: str | None,
    rounds: int,
    speakers: int,
    report: str,
    interval: str = "1d",
    bars_limit: int = 500,
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

    # ─── LLM availability check ─────────────────────────────────────────
    try:
        from core.agents.llm_client import (
            is_available as llm_available,
            active_provider_info,
            LLM_CALL_TIMEOUT_S,
            LLM_MAX_RETRIES,
        )
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
                "  [cyan]GEMINI_API_KEY[/cyan]\n\n"
                "Or run [bold]vibe-trade setup[/bold] to be guided through it.",
                title="[bold red]LLM required[/bold red]",
                border_style="red",
            )
        )
        raise SystemExit(1)

    provider = active_provider_info()
    console.print(
        f"[dim]Using[/dim] [bold cyan]{provider.get('provider', 'unknown')}[/bold cyan] · "
        f"[dim]{provider.get('model', '')}[/dim] "
        f"[dim](timeout={LLM_CALL_TIMEOUT_S}s, retries={LLM_MAX_RETRIES})[/dim]"
    )

    # ─── Fetch bars (the orchestrator needs real OHLCV to run stages 1+) ─
    with console.status(f"[cyan]Fetching {asset} {interval} bars...[/cyan]"):
        try:
            bars, symbol = _fetch_bars(asset, interval, bars_limit)
        except Exception as exc:  # noqa: BLE001
            console.print(f"[red]x Fetch failed:[/red] {exc}")
            raise SystemExit(1)

    if not bars:
        console.print(f"[red]x No bars returned for {asset}.[/red]")
        raise SystemExit(1)

    console.print(
        f"[green]OK[/green] Loaded [bold]{len(bars)}[/bold] {interval} bars of [bold]{symbol}[/bold]"
    )

    # ─── Run the debate through the real DebateOrchestrator ─────────────
    try:
        from core.engine.dag_orchestrator import DebateOrchestrator
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]Failed to import DebateOrchestrator:[/red] {exc}")
        raise SystemExit(1)

    orchestrator = DebateOrchestrator()
    # Override the class-level constants on this instance so the CLI can run
    # a lighter debate than the full web-UI preset (30x15 = 450 messages).
    orchestrator.MAX_ROUNDS = max(1, rounds)
    orchestrator.SPEAKERS_PER_ROUND = max(1, speakers)

    console.rule(f"[bold cyan]Debate: {symbol}[/bold cyan]")
    console.print(
        f"[dim]{rounds} rounds x {speakers} speakers · up to {rounds * speakers} messages · "
        "progress lines stream below.[/dim]\n"
    )

    # Run the async orchestrator. asyncio.run() is the safest CLI entry point
    # — it creates a fresh event loop and cleans it up on exit / ctrl+c.
    try:
        result = asyncio.run(
            orchestrator.run(bars, symbol, report_text=report or "")
        )
    except KeyboardInterrupt:
        console.print("\n[yellow]! Interrupted by user. Partial results below:[/yellow]")
        _render_events(list(orchestrator.run_events))
        raise SystemExit(130)
    except Exception as exc:  # noqa: BLE001
        console.print(f"\n[red]x Simulation failed:[/red] {exc}")
        # Still surface anything the orchestrator captured before the crash
        _render_events(list(orchestrator.run_events))
        raise SystemExit(1)

    # ─── Stream the debate thread ───────────────────────────────────────
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
        tools_used = msg.get("tools_used") or []
        tools_suffix = f" [dim]· tools: {', '.join(tools_used)}[/dim]" if tools_used else ""
        header = f"[bold {sentiment_color}]{name}[/bold {sentiment_color}] [dim]· {role}[/dim]{tools_suffix}"
        console.print(header)
        console.print(f"  {content}\n")

    # ─── Final summary panel ────────────────────────────────────────────
    summary = result.get("summary") or {}
    if summary:
        dir_ = summary.get("consensus_direction", "NEUTRAL")
        conf = summary.get("confidence", 0)
        dir_color = "green" if dir_ == "BULLISH" else "red" if dir_ == "BEARISH" else "yellow"
        console.rule(f"[bold {dir_color}]Consensus: {dir_}[/bold {dir_color}]", style=dir_color)

        # Normalize confidence to 0-100 (backend already does this, but the
        # orchestrator returns raw values in some fallback paths)
        conf_pct = conf if conf > 1 else int(conf * 100)
        lines = [
            f"[bold]Confidence:[/bold] {int(conf_pct)}%",
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
                lines.append(f"  - {arg}")
        dissent = summary.get("dissenting_views") or []
        if dissent:
            lines.append("")
            lines.append("[bold]Dissenting:[/bold]")
            for d in dissent[:3]:
                lines.append(f"  - {d}")
        risks = summary.get("risk_factors") or []
        if risks:
            lines.append("")
            lines.append("[bold]Risks:[/bold]")
            for r in risks[:3]:
                lines.append(f"  - {r}")
        rec = summary.get("recommendation") or {}
        if rec.get("action"):
            lines.append("")
            lines.append(
                f"[bold]Recommendation:[/bold] [bold {dir_color}]{rec.get('action')}[/bold {dir_color}]"
            )
            bits = []
            if rec.get("entry") is not None:
                bits.append(f"entry={rec.get('entry')}")
            if rec.get("stop") is not None:
                bits.append(f"stop={rec.get('stop')}")
            if rec.get("target") is not None:
                bits.append(f"target={rec.get('target')}")
            if rec.get("position_size_pct") is not None:
                bits.append(f"size={rec.get('position_size_pct')}%")
            if bits:
                lines.append("  " + " · ".join(bits))

        console.print(Panel("\n".join(lines), border_style=dir_color, padding=(0, 2)))

    # ─── Cross-exam snapshot (optional) ─────────────────────────────────
    cross = result.get("cross_exam_results") or []
    if cross:
        console.rule("[bold]Cross-Examination[/bold]", style="dim")
        for ex in cross[:5]:
            name = ex.get("entity_name", "?")
            change = ex.get("conviction_change", "unchanged")
            change_color = {
                "strengthened": "green",
                "weakened": "yellow",
                "reversed": "red",
            }.get(change, "white")
            console.print(
                f"[bold]{name}[/bold] "
                f"[dim]·[/dim] [{change_color}]{change}[/{change_color}]"
            )
            q = ex.get("question", "")
            if q:
                console.print(f"  [dim]Q:[/dim] {q[:160]}")
            r = ex.get("response", "")
            if r:
                console.print(f"  [dim]A:[/dim] {r[:240]}\n")

    # ─── Run events (errors/warnings) — always last so the user sees them ─
    events = result.get("events") or []
    _render_events(events)
