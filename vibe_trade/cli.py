"""
Vibe Trade CLI — Typer-based entry point.

All commands are registered here. Subcommand implementations live in
sibling modules (serve_cmd.py, fetch_cmd.py, simulate_cmd.py, ...) so this
file stays focused on routing + UX.
"""

from __future__ import annotations

import sys

# Force stdout/stderr to UTF-8 BEFORE importing Rich. On Windows, Python
# defaults to cp1252 which can't encode the checkmark / arrow / box-drawing
# characters Rich uses, causing UnicodeEncodeError on every command. Python
# 3.7+ supports reconfigure(); we ignore failures on exotic streams.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

import typer  # noqa: E402
from rich.console import Console  # noqa: E402

from vibe_trade import __version__  # noqa: E402

console = Console()

app = typer.Typer(
    name="vibe-trade",
    help=(
        "AI-powered trading agent platform. Skill-based architecture with "
        "planner, pattern detection, strategy generation, data fetching, "
        "and multi-agent debate simulations.\n\n"
        "Quick start:\n"
        "  vibe-trade serve              # start the web UI on http://localhost:8787\n"
        "  vibe-trade fetch BTC/USDT 1h  # fetch market data to a CSV\n"
        "  vibe-trade simulate           # run a multi-agent debate in the terminal\n"
        "  vibe-trade skills list        # list registered skills"
    ),
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
)


# ─── version ─────────────────────────────────────────────────────────────
@app.command()
def version() -> None:
    """Print the installed Vibe Trade version."""
    console.print(f"[bold]vibe-trade[/bold] [cyan]{__version__}[/cyan]")


# ─── serve ───────────────────────────────────────────────────────────────
@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Bind the backend to this host"),
    port: int = typer.Option(8787, "--port", "-p", help="Port for the web UI + API"),
    reload: bool = typer.Option(False, "--reload", help="Enable auto-reload for development"),
    open_browser: bool = typer.Option(True, "--open/--no-open", help="Open the web UI in the default browser"),
    backend_only: bool = typer.Option(False, "--backend-only", help="Don't serve the frontend static files — only the JSON API"),
) -> None:
    """
    Start the Vibe Trade server (backend + bundled web UI).

    By default, the FastAPI backend serves BOTH the JSON API (under /chat,
    /skills, /fetch-data, /plan, etc.) AND the pre-built Next.js frontend
    as static files under /. Opening http://localhost:8787 gives you the
    full app. Use --backend-only to run just the API (e.g. for pairing
    with your own frontend or for headless automation).
    """
    from vibe_trade.serve_cmd import run_server

    run_server(host=host, port=port, reload=reload, open_browser=open_browser, backend_only=backend_only)


# ─── fetch ───────────────────────────────────────────────────────────────
@app.command()
def fetch(
    symbol: str = typer.Argument(..., help="Ticker or pair (BTC/USDT, AAPL, ^GSPC, EURUSD=X, ...)"),
    interval: str = typer.Argument("1d", help="1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1mo"),
    limit: int = typer.Option(1000, "--limit", "-l", help="Approximate number of bars (max 50000)"),
    source: str = typer.Option("auto", "--source", "-s", help="'auto' | 'yfinance' | 'ccxt'"),
    exchange: str = typer.Option("binance", "--exchange", "-e", help="ccxt exchange name when source is 'ccxt'"),
    output: str = typer.Option(None, "--output", "-o", help="Save to this CSV path (prints preview otherwise)"),
) -> None:
    """
    Fetch historical OHLCV bars from yfinance or ccxt.

    No API key required for either provider's public data. Auto-detects the
    right provider from the symbol shape:

      BTC/USDT, ETH-USD, SOL       → ccxt
      AAPL, SPY, ^GSPC, EURUSD=X    → yfinance

    Example:
      vibe-trade fetch BTC/USDT 1h --limit 500
      vibe-trade fetch AAPL 1d --limit 252 -o aapl.csv
    """
    from vibe_trade.fetch_cmd import run_fetch

    run_fetch(
        symbol=symbol,
        interval=interval,
        limit=limit,
        source=source,
        exchange=exchange,
        output=output,
    )


# ─── simulate ────────────────────────────────────────────────────────────
@app.command()
def simulate(
    asset: str = typer.Option(None, "--asset", "-a", help="Asset symbol to debate (e.g. 'BTC', 'AAPL', 'gold'). Prompts interactively if omitted."),
    rounds: int = typer.Option(6, "--rounds", "-r", help="Number of debate rounds"),
    speakers: int = typer.Option(5, "--speakers", "-s", help="Number of distinct agent personas"),
    report: str = typer.Option("", "--context", "-c", help="Optional market context / news report to seed the debate"),
) -> None:
    """
    Run a multi-agent debate simulation on an asset and stream it to the
    terminal. Uses the same engine that powers the web UI's Simulation
    mode, but renders the discussion live with Rich.

    Requires an LLM provider to be configured via .env (OPENAI_API_KEY,
    ANTHROPIC_API_KEY, or any other supported provider).

    Example:
      vibe-trade simulate --asset BTC --rounds 8 --speakers 5
      vibe-trade simulate -a gold -c "Fed just cut rates by 50bps"
    """
    from vibe_trade.simulate_cmd import run_simulate

    run_simulate(asset=asset, rounds=rounds, speakers=speakers, report=report)


# ─── skills ──────────────────────────────────────────────────────────────
skills_app = typer.Typer(help="Inspect the registered skills", no_args_is_help=True)
app.add_typer(skills_app, name="skills")


@skills_app.command("list")
def skills_list() -> None:
    """List every skill currently registered in skills/."""
    from vibe_trade.skills_cmd import run_skills_list

    run_skills_list()


@skills_app.command("show")
def skills_show(skill_id: str = typer.Argument(..., help="The skill id, e.g. 'pattern'")) -> None:
    """Show the full SKILL.md for a skill."""
    from vibe_trade.skills_cmd import run_skills_show

    run_skills_show(skill_id)


# ─── tools ───────────────────────────────────────────────────────────────
@app.command("tools")
def tools_list() -> None:
    """List every tool in the central tool catalog (skills/tools.py)."""
    from vibe_trade.tools_cmd import run_tools_list

    run_tools_list()


if __name__ == "__main__":
    app()
