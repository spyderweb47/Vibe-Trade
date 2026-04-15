"""
PyPI version check + self-update for the installed CLI.

Two entry points:

1. `maybe_notify_update()` — called at the END of every CLI invocation.
   Spawns a short-lived daemon thread on the first call that hits PyPI's
   JSON API for the latest `vibe-trade` version, caches the result for
   24 hours in the user config dir, and if a newer version is available
   prints a one-line yellow banner before the process exits.

2. `run_update()` — the `vibe-trade update` command. Detects how
   vibe-trade was installed (pipx vs pip vs dev checkout) and runs the
   appropriate upgrade command.

The version check is OFF when any of these are true:
  - env var VIBE_TRADE_SKIP_UPDATE_CHECK is set
  - we're running an offline/airgapped build (the network call just
    times out and is swallowed)
  - the cache says we checked within the last 24 hours
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from rich.console import Console

from vibe_trade import __version__
from vibe_trade.user_config import user_config_dir

console = Console()

_PYPI_URL = "https://pypi.org/pypi/vibe-trade/json"
_CACHE_TTL_SECONDS = 24 * 60 * 60  # 24h
_CACHE_FILENAME = "update_cache.json"
_REQUEST_TIMEOUT = 3.0  # seconds — fail fast if PyPI is slow/down

# Module-level state so we don't register multiple atexit hooks if someone
# calls maybe_notify_update() twice in the same process
_NOTIFY_REGISTERED = False
_LATEST_VERSION: Optional[str] = None
_CHECK_LOCK = threading.Lock()


def _cache_path() -> Path:
    return user_config_dir() / _CACHE_FILENAME


def _read_cache() -> Optional[dict]:
    path = _cache_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(latest: str) -> None:
    try:
        _cache_path().write_text(
            json.dumps({"latest": latest, "checked_at": int(time.time())}),
            encoding="utf-8",
        )
    except OSError:
        pass  # cache write failure is never worth crashing the CLI over


def _parse_version(v: str) -> tuple[int, ...]:
    """
    Tuple-of-ints comparator for PEP 440 release segments. Good enough to
    answer 'is X newer than Y' for simple N.N.N versions — we fall back to
    a string compare for pre-releases / post-releases which is fine for
    the notification use case (false negative at worst).
    """
    parts: list[int] = []
    for chunk in v.split("."):
        num = ""
        for ch in chunk:
            if ch.isdigit():
                num += ch
            else:
                break
        if num:
            parts.append(int(num))
    return tuple(parts)


def _is_newer(candidate: str, current: str) -> bool:
    try:
        return _parse_version(candidate) > _parse_version(current)
    except Exception:  # noqa: BLE001
        return candidate != current


def _fetch_latest_version() -> Optional[str]:
    """Hit the PyPI JSON API. Returns None on any network/parse failure."""
    try:
        req = urllib.request.Request(
            _PYPI_URL,
            headers={"User-Agent": f"vibe-trade/{__version__}"},
        )
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("info", {}).get("version")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def _background_check() -> None:
    """Run in a daemon thread — fetches latest version and updates cache."""
    global _LATEST_VERSION
    latest = _fetch_latest_version()
    if latest:
        with _CHECK_LOCK:
            _LATEST_VERSION = latest
            _write_cache(latest)


def _should_skip() -> bool:
    if os.environ.get("VIBE_TRADE_SKIP_UPDATE_CHECK", "").strip():
        return True
    if os.environ.get("CI", "").strip():
        # Don't nag CI runs
        return True
    return False


def _print_banner(latest: str) -> None:
    """One-line notification. Prints after the main command output."""
    console.print()
    console.print(
        f"[yellow]⬆ A new version of vibe-trade is available:[/yellow] "
        f"[bold]{latest}[/bold] [dim](you have {__version__})[/dim]"
    )
    console.print(
        "  Run [bold cyan]vibe-trade update[/bold cyan] to upgrade."
    )


def _atexit_notify() -> None:
    """atexit hook — print banner if a newer version is known."""
    with _CHECK_LOCK:
        latest = _LATEST_VERSION
    if latest and _is_newer(latest, __version__):
        _print_banner(latest)


def maybe_notify_update() -> None:
    """
    Called at CLI startup. Kicks off a background PyPI check (respecting
    the 24h cache) and registers an atexit hook that prints a notice if
    we discover a newer version before the command exits.
    """
    global _NOTIFY_REGISTERED, _LATEST_VERSION

    if _NOTIFY_REGISTERED:
        return
    _NOTIFY_REGISTERED = True

    if _should_skip():
        return

    # Check the cache first — if we already know a newer version, prime
    # _LATEST_VERSION and skip the network call entirely.
    cached = _read_cache()
    now = int(time.time())
    if cached and isinstance(cached, dict):
        checked_at = int(cached.get("checked_at", 0))
        latest = cached.get("latest")
        if latest and (now - checked_at) < _CACHE_TTL_SECONDS:
            _LATEST_VERSION = latest
            atexit.register(_atexit_notify)
            return  # cache is fresh, don't bother PyPI

    # Cache stale or missing — spawn a daemon thread and hope it finishes
    # before the process exits. If the user runs a quick command, it might
    # not — that's fine, we'll catch it next time.
    thread = threading.Thread(target=_background_check, daemon=True)
    thread.start()
    atexit.register(_atexit_notify)


# ─── install method detection ─────────────────────────────────────────────


def _detect_install_method() -> str:
    """
    Return one of 'pipx', 'pip', 'dev'. Best-effort — we use this to
    pick the right upgrade command for `vibe-trade update`.
    """
    exe = Path(sys.executable).resolve()
    exe_str = str(exe).lower().replace("\\", "/")

    # Dev checkout: installed in editable mode usually means the package
    # file lives inside the repo tree rather than site-packages
    try:
        import vibe_trade
        pkg_path = Path(vibe_trade.__file__).resolve()
        if "site-packages" not in str(pkg_path).lower() and (pkg_path.parent.parent / "pyproject.toml").exists():
            return "dev"
    except Exception:  # noqa: BLE001
        pass

    # pipx installs live under ~/.local/pipx/venvs/vibe-trade or
    # %USERPROFILE%/pipx/venvs/vibe-trade. Check the venv path.
    if "pipx/venvs/vibe-trade" in exe_str or "pipx\\venvs\\vibe-trade" in str(exe).lower():
        return "pipx"

    return "pip"


def run_update() -> None:
    """`vibe-trade update` — upgrade the installed package."""
    method = _detect_install_method()
    console.print(f"[dim]Install method detected: [cyan]{method}[/cyan][/dim]\n")

    if method == "dev":
        console.print(
            "[yellow]⚠ You're running Vibe Trade from a source checkout.[/yellow]\n"
            "  Run [cyan]git pull[/cyan] in the repo directory to update.\n"
            "  The installed package isn't managed by pip/pipx in this mode."
        )
        return

    if method == "pipx":
        cmd = ["pipx", "upgrade", "vibe-trade"]
    else:
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade", "vibe-trade"]

    console.print(f"[dim]$ {' '.join(cmd)}[/dim]\n")
    try:
        result = subprocess.run(cmd, shell=(os.name == "nt" and method == "pipx"))
    except FileNotFoundError:
        console.print(
            f"[red]✕ Couldn't find [cyan]{cmd[0]}[/cyan] on PATH.[/red]\n"
            f"  Install {method} first, or run the upgrade command manually."
        )
        return

    if result.returncode == 0:
        # Clear the cache so the next CLI run doesn't keep nagging about
        # the version we just upgraded to.
        try:
            _cache_path().unlink(missing_ok=True)
        except OSError:
            pass
        console.print("\n[green]✓ Update complete.[/green] Run [cyan]vibe-trade version[/cyan] to confirm.")
    else:
        console.print(f"\n[red]✕ Upgrade failed (exit {result.returncode}).[/red]")
        raise SystemExit(result.returncode)
