"""
`vibe-trade setup` — interactive first-run wizard.

Walks the user through:
  1. Picking an LLM provider from the supported list
  2. Entering their API key (masked input)
  3. Optionally overriding the default model for that provider
  4. Writing everything to the user-scoped .env

Re-running the wizard is safe — existing values are shown as defaults and
the user can hit Enter to keep them unchanged.
"""

from __future__ import annotations

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt, Confirm
from rich.table import Table

from vibe_trade.user_config import read_user_env, user_env_path, write_user_env

console = Console()


# Curated provider list — mirrors PROVIDER_CONFIG in core/agents/llm_client.py
# but lives in its own module so the setup wizard doesn't drag the whole
# agent runtime into import time. Tuple: (id, display_name, env_var,
# default_model, signup_url, needs_key)
PROVIDERS: list[tuple[str, str, str, str, str, bool]] = [
    ("openai",     "OpenAI",            "OPENAI_API_KEY",     "gpt-4o-mini",                              "https://platform.openai.com/api-keys",    True),
    ("anthropic",  "Anthropic Claude",  "ANTHROPIC_API_KEY",  "claude-sonnet-4-5",                        "https://console.anthropic.com/settings/keys", True),
    ("gemini",     "Google Gemini",     "GOOGLE_API_KEY",     "gemini-2.0-flash",                         "https://aistudio.google.com/app/apikey",  True),
    ("groq",       "Groq",              "GROQ_API_KEY",       "llama-3.3-70b-versatile",                  "https://console.groq.com/keys",           True),
    ("deepseek",   "DeepSeek",          "DEEPSEEK_API_KEY",   "deepseek-chat",                            "https://platform.deepseek.com/api_keys",  True),
    ("openrouter", "OpenRouter",        "OPENROUTER_API_KEY", "openai/gpt-4o-mini",                       "https://openrouter.ai/keys",              True),
    ("together",   "Together AI",       "TOGETHER_API_KEY",   "meta-llama/Llama-3.3-70B-Instruct-Turbo",  "https://api.together.xyz/settings/api-keys", True),
    ("fireworks",  "Fireworks AI",      "FIREWORKS_API_KEY",  "accounts/fireworks/models/llama-v3p3-70b-instruct", "https://fireworks.ai/api-keys", True),
    ("ollama",     "Ollama (local)",    "",                   "llama3.2",                                 "https://ollama.com/download",             False),
]


def _render_provider_table(current_provider: Optional[str]) -> None:
    """Pretty-print the provider list so the user can pick one by number."""
    table = Table(
        title="Available LLM providers",
        title_style="bold cyan",
        show_lines=False,
        header_style="bold",
    )
    table.add_column("#", justify="right", style="dim", width=3)
    table.add_column("Provider", style="cyan")
    table.add_column("Default model", style="white")
    table.add_column("Sign up", style="dim")

    for idx, (pid, name, _env, default_model, signup, _needs_key) in enumerate(PROVIDERS, start=1):
        marker = " [green](current)[/green]" if pid == current_provider else ""
        table.add_row(
            str(idx),
            f"{name}{marker}",
            default_model,
            signup,
        )
    console.print(table)


def _pick_provider(current: Optional[str]) -> tuple[str, str, str, str, bool]:
    """Prompt the user to pick a provider by number. Returns the tuple row."""
    _render_provider_table(current)
    default_idx: Optional[str] = None
    if current:
        for idx, row in enumerate(PROVIDERS, start=1):
            if row[0] == current:
                default_idx = str(idx)
                break

    while True:
        choice = Prompt.ask(
            "[bold]Pick a provider[/bold] (enter number)",
            default=default_idx or "1",
        )
        try:
            i = int(choice)
            if 1 <= i <= len(PROVIDERS):
                row = PROVIDERS[i - 1]
                # Drop signup_url (5th element) — not needed downstream
                return row[0], row[1], row[2], row[3], row[5]
        except ValueError:
            pass
        console.print(f"[red]✕ Invalid choice. Enter 1–{len(PROVIDERS)}.[/red]")


def _prompt_api_key(provider_name: str, env_var: str, existing: str) -> str:
    """Prompt for an API key, masking input. Returns the value to save."""
    if existing:
        masked = existing[:6] + "…" + existing[-4:] if len(existing) > 12 else "(saved)"
        console.print(f"  Current {env_var}: [dim]{masked}[/dim]")
        keep = Confirm.ask("  Keep the existing key?", default=True)
        if keep:
            return existing

    while True:
        key = Prompt.ask(
            f"  Paste your [cyan]{provider_name}[/cyan] API key",
            password=True,
        )
        key = key.strip()
        if key:
            return key
        console.print("[red]  ✕ Key cannot be empty.[/red]")


def _prompt_model(provider_name: str, default_model: str, existing: str) -> str:
    """Ask whether to keep the default model or override it."""
    current = existing or default_model
    console.print(f"  Default model for [cyan]{provider_name}[/cyan]: [white]{default_model}[/white]")
    if existing and existing != default_model:
        console.print(f"  You currently have: [green]{existing}[/green]")
    override = Prompt.ask(
        "  Model (press Enter to keep shown value)",
        default=current,
    )
    return override.strip() or default_model


def run_setup() -> None:
    """Main entry point — wire everything together and write .env."""
    console.print(
        Panel(
            "[bold]Welcome to Vibe Trade setup[/bold]\n\n"
            "This wizard will configure your LLM provider and API key so the\n"
            "agents (pattern detection, strategy, planner, simulation) can\n"
            "talk to a model. Your answers are saved to a user config file\n"
            f"at [cyan]{user_env_path()}[/cyan] — edit it by hand any time\n"
            "or re-run [cyan]vibe-trade setup[/cyan] to change providers.",
            title="[bold cyan]vibe-trade · setup[/bold cyan]",
            border_style="cyan",
            padding=(1, 2),
        )
    )

    existing = read_user_env()
    current_provider = existing.get("LLM_PROVIDER", "").lower() or None

    # Step 1 — provider
    provider_id, provider_name, env_var, default_model, needs_key = _pick_provider(current_provider)
    console.print(f"\n[green]✓[/green] Selected [bold]{provider_name}[/bold]")

    # Step 2 — API key (skipped for ollama)
    values: dict[str, str] = {"LLM_PROVIDER": provider_id}
    if needs_key:
        api_key = _prompt_api_key(provider_name, env_var, existing.get(env_var, ""))
        values[env_var] = api_key
        console.print(f"[green]✓[/green] {env_var} saved")
    else:
        console.print("[dim]  Ollama runs locally — no API key needed.[/dim]")
        ollama_url = Prompt.ask(
            "  Ollama base URL",
            default=existing.get("OLLAMA_BASE_URL", "http://localhost:11434"),
        )
        values["OLLAMA_BASE_URL"] = ollama_url.strip()

    # Step 3 — model override
    chosen_model = _prompt_model(provider_name, default_model, existing.get("LLM_MODEL", ""))
    values["LLM_MODEL"] = chosen_model
    console.print(f"[green]✓[/green] Model: [bold]{chosen_model}[/bold]")

    # Step 4 — write .env
    path = write_user_env(values)
    console.print(
        Panel(
            f"[green]Setup complete![/green]\n\n"
            f"Wrote [cyan]{path}[/cyan]\n\n"
            f"Try it out:\n"
            f"  [dim]$[/dim] [bold]vibe-trade serve[/bold]          [dim]# launch the full web UI[/dim]\n"
            f"  [dim]$[/dim] [bold]vibe-trade simulate -a BTC[/bold]  [dim]# run a debate in the terminal[/dim]",
            title="[bold green]✓ Ready to go[/bold green]",
            border_style="green",
            padding=(1, 2),
        )
    )
