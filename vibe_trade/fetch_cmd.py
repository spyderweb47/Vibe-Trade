"""
`vibe-trade fetch <SYMBOL> <INTERVAL>` — CLI wrapper around
`core.data.fetcher.fetch()`.

Reuses the same fetcher the web UI and the data_fetcher skill use, so every
alias ("gold" → GC=F), time-period conversion ("last 30 days" → N bars),
and provider auto-detection works identically from the terminal.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

from rich.console import Console
from rich.table import Table

console = Console()


def run_fetch(
    symbol: str,
    interval: str,
    limit: int,
    source: str,
    exchange: str,
    output: str | None,
) -> None:
    # Make sure repo root is on sys.path so core.* imports work
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "core" / "data" / "fetcher.py").exists():
            if str(parent) not in sys.path:
                sys.path.insert(0, str(parent))
            break

    from core.data.fetcher import fetch, _NAME_ALIASES

    # Route plain-English names through the alias map so `vibe-trade fetch
    # gold 1d` picks up the COMEX gold futures symbol (GC=F) instead of the
    # Barrick Gold mining stock (GOLD), and "oil" / "silver" / "xauusd" etc.
    # resolve to their yfinance equivalents.
    resolved = symbol
    lower = symbol.strip().lower()
    if lower in _NAME_ALIASES:
        resolved = _NAME_ALIASES[lower]
        console.print(
            f"[dim]Alias[/dim] [cyan]{symbol}[/cyan] → [bold]{resolved}[/bold]"
        )

    with console.status(f"[cyan]Fetching {resolved} {interval}...[/cyan]"):
        try:
            result = fetch(
                symbol=resolved,
                source=source,
                interval=interval,
                limit=limit,
                exchange=exchange,
            )
        except Exception as exc:  # noqa: BLE001
            console.print(f"[red]✕ Fetch failed:[/red] {exc}")
            raise SystemExit(1)

    bars = result["bars"]
    meta = result["metadata"]

    # Summary panel
    console.print(
        f"[green]✓[/green] Loaded [bold cyan]{meta['rows']}[/bold cyan] bars of "
        f"[bold]{result['symbol']}[/bold] ({result['interval']}) from "
        f"[dim]{result['source']}[/dim]"
    )
    console.print(
        f"  [dim]Range:[/dim] {meta['startDate'][:19]} → {meta['endDate'][:19]}"
    )

    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["time", "open", "high", "low", "close", "volume"])
            for b in bars:
                writer.writerow([b["time"], b["open"], b["high"], b["low"], b["close"], b.get("volume", 0)])
        console.print(f"[green]✓ Wrote[/green] {out_path} ({len(bars)} rows)")
        return

    # Preview table — first 5 + last 5 bars
    table = Table(title=f"{result['symbol']} · {result['interval']} · {meta['rows']} bars", show_lines=False)
    table.add_column("Time", style="dim")
    table.add_column("Open", justify="right")
    table.add_column("High", justify="right", style="green")
    table.add_column("Low", justify="right", style="red")
    table.add_column("Close", justify="right", style="bold")
    table.add_column("Volume", justify="right", style="dim")

    def _row(b):
        from datetime import datetime, timezone
        ts = datetime.fromtimestamp(int(b["time"]), tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        return (
            ts,
            f"{b['open']:.2f}",
            f"{b['high']:.2f}",
            f"{b['low']:.2f}",
            f"{b['close']:.2f}",
            f"{b.get('volume', 0):.2f}",
        )

    preview = bars[:5] + ([{"time": "...", "open": 0, "high": 0, "low": 0, "close": 0, "volume": 0}] if len(bars) > 10 else []) + bars[-5:] if len(bars) > 10 else bars
    for b in preview:
        if b.get("time") == "...":
            table.add_row("…", "…", "…", "…", "…", "…")
        else:
            table.add_row(*_row(b))
    console.print(table)
    console.print(f"\n[dim]Use --output <file.csv> to save all {len(bars)} bars to disk.[/dim]")
