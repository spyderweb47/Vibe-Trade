"""
User config directory + .env loading for the installed CLI.

When Vibe Trade is installed globally via `pipx install vibe-trade`, there is
no repo `.env` to read from — the user's API keys have to live somewhere
persistent and user-owned. This module centralizes that location so every
subcommand (serve, fetch, simulate, setup, ...) reads and writes the same
place.

Layout:

    Linux/Mac:  ~/.config/vibe-trade/
    Windows:    %APPDATA%\\vibe-trade\\
                (falls back to ~/.vibe-trade/ if APPDATA isn't set)

Inside that dir:

    .env               user-edited API keys + LLM_PROVIDER / LLM_MODEL
    update_cache.json  PyPI version-check cache (see updater.py)
"""

from __future__ import annotations

import os
from pathlib import Path


def user_config_dir() -> Path:
    """
    Return the platform-appropriate user config directory for vibe-trade.

    Creates the directory if it doesn't exist. This is where `.env`,
    update cache files, and any other persistent user state live.
    """
    override = os.environ.get("VIBE_TRADE_CONFIG_DIR", "").strip()
    if override:
        path = Path(override).expanduser().resolve()
    elif os.name == "nt":
        # Windows: prefer %APPDATA%, fall back to ~/.vibe-trade
        appdata = os.environ.get("APPDATA", "").strip()
        if appdata:
            path = Path(appdata) / "vibe-trade"
        else:
            path = Path.home() / ".vibe-trade"
    else:
        # Linux/Mac: follow XDG if set, else ~/.config
        xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
        if xdg:
            path = Path(xdg) / "vibe-trade"
        else:
            path = Path.home() / ".config" / "vibe-trade"

    path.mkdir(parents=True, exist_ok=True)
    return path


def user_env_path() -> Path:
    """Path to the user-scoped .env file (may or may not exist)."""
    return user_config_dir() / ".env"


def load_user_env(override: bool = False) -> bool:
    """
    Load the user-scoped .env file into os.environ if it exists.

    Args:
        override: if True, user .env values overwrite any existing
                  environment variables. If False (default), existing
                  environment variables take precedence — so a dev running
                  in a checkout with a repo .env still gets their repo
                  settings.

    Returns:
        True if the file existed and was loaded, False otherwise.
    """
    env_path = user_env_path()
    if not env_path.exists():
        return False

    try:
        from dotenv import load_dotenv
        load_dotenv(str(env_path), override=override)
        return True
    except ImportError:
        # python-dotenv should always be installed (it's in pyproject
        # dependencies), but fall back to a naive parser just in case.
        _naive_load_env(env_path, override=override)
        return True


def _naive_load_env(path: Path, override: bool) -> None:
    """Bare-bones .env parser for the unlikely case python-dotenv is missing."""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if override or key not in os.environ:
            os.environ[key] = value


def read_user_env() -> dict[str, str]:
    """
    Read the user .env file as a dict (does NOT mutate os.environ).

    Used by the setup wizard to show the user what's currently configured
    and preserve values across re-runs.
    """
    env_path = user_env_path()
    if not env_path.exists():
        return {}

    result: dict[str, str] = {}
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def write_user_env(values: dict[str, str]) -> Path:
    """
    Write (or merge) values into the user .env file, preserving existing
    keys that weren't passed in.

    Writes one `KEY=VALUE` per line with a header comment. Returns the
    path to the written file.
    """
    existing = read_user_env()
    existing.update(values)

    env_path = user_env_path()
    lines = [
        "# Vibe Trade user config — edit via `vibe-trade setup` or by hand.",
        "# This file is read on every vibe-trade CLI invocation.",
        "",
    ]
    for key, value in existing.items():
        # Quote values that contain whitespace or special chars
        if any(c in value for c in " \t#\"'"):
            safe = value.replace('"', '\\"')
            lines.append(f'{key}="{safe}"')
        else:
            lines.append(f"{key}={value}")

    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return env_path
