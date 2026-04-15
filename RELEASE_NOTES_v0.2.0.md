# Vibe Trade v0.2.0 — Setup wizard + self-update

Two new CLI commands that make first-run setup painless and keep
installed copies current automatically.

## New commands

### `vibe-trade setup`

Interactive wizard that walks you through:

1. Picking an LLM provider from all 9 supported options, with direct
   sign-up links for each
2. Pasting your API key (masked input)
3. Optionally overriding the default model for that provider

Answers are saved to a user-scoped config file:

- **Linux/Mac:** `~/.config/vibe-trade/.env`
- **Windows:** `%APPDATA%\vibe-trade\.env`

Re-run the wizard any time to rotate keys or switch providers — existing
values show up as defaults.

```bash
pipx install vibe-trade
vibe-trade setup         # pick provider, paste key, done
vibe-trade serve         # keys are auto-loaded from user config
```

### `vibe-trade update`

Auto-detects how you installed (`pipx`, `pip`, or a dev checkout) and
runs the right upgrade command. If you're in a source checkout, it tells
you to `git pull` instead.

```bash
vibe-trade update
```

### Background update notifier

Every CLI invocation now checks PyPI (asynchronously, with a 3-second
timeout) for a newer version and prints a one-line yellow banner at the
end of the command if one is available. Results are cached for 24 hours
so the check is effectively free.

```
$ vibe-trade version
vibe-trade 0.1.0

⬆ A new version of vibe-trade is available: 0.2.0 (you have 0.1.0)
  Run vibe-trade update to upgrade.
```

Opt out any time with `VIBE_TRADE_SKIP_UPDATE_CHECK=1`. Automatically
disabled in CI environments.

## Bundled providers

All 9 providers from the first release remain supported. The setup
wizard surfaces them as a picker with sign-up URLs:

| # | Provider | Default model |
|---|---|---|
| 1 | OpenAI | gpt-4o-mini |
| 2 | Anthropic Claude | claude-sonnet-4-5 |
| 3 | Google Gemini | gemini-2.0-flash |
| 4 | Groq | llama-3.3-70b-versatile |
| 5 | DeepSeek | deepseek-chat |
| 6 | OpenRouter | openai/gpt-4o-mini |
| 7 | Together AI | meta-llama/Llama-3.3-70B-Instruct-Turbo |
| 8 | Fireworks AI | accounts/fireworks/models/llama-v3p3-70b-instruct |
| 9 | Ollama (local) | llama3.2 |

## Under the hood

- New `vibe_trade.user_config` module — one place for user config dir
  resolution, `.env` read/write, and XDG compliance on Linux
- `services/api/main.py` now loads the user `.env` in addition to the
  repo `.env` (repo wins, so dev checkouts still work normally)
- Version-check daemon thread + `atexit` hook for the notifier — never
  blocks the foreground command

## Install / upgrade

```bash
# First time
pipx install vibe-trade
vibe-trade setup
vibe-trade serve

# Upgrading from 0.1.0
vibe-trade update
# or:
pipx upgrade vibe-trade
```

## Links

- Source: <https://github.com/spyderweb47/Vibe-Trade>
- PyPI: <https://pypi.org/project/vibe-trade/>
- Issues: <https://github.com/spyderweb47/Vibe-Trade/issues>
