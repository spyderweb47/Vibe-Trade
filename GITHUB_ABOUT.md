# GitHub Repo "About" Configuration

This file is NOT rendered on GitHub — it's a copy-paste reference for the
values you should set on https://github.com/spyderweb47/Vibe-Trade (click
the ⚙ gear next to "About" on the repo's main page).

---

## Description (one-liner, max 350 chars)

Pick ONE of these depending on which angle you want to lead with.

### Option A — feature-led (recommended)

```
The AI-native trading platform. One agent with pluggable skills that fetches market data, detects patterns, generates JavaScript strategies, and backtests them in your browser — all from a single chat turn. pipx install vibe-trade.
```

### Option B — dev-led

```
AI trading agent with a skill system: drop a SKILL.md file, declare your tools, ship. Built-in planner, pattern detection, strategy backtesting, 9 LLM providers, multi-agent simulation, and a full Next.js web UI bundled into one pipx install.
```

### Option C — terse

```
AI-powered trading platform with skill-based architecture, built-in multi-step planner, data fetching (yfinance + ccxt), pattern detection, strategy backtesting, and multi-agent debate simulations. Install with pipx.
```

---

## Website

```
https://github.com/spyderweb47/Vibe-Trade
```

(Or the deployed demo URL if you host one.)

---

## Topics (max 20, comma-separated)

These are GitHub's searchable tags. Use the "Add topics" field under About.

```
ai-agents
trading
trading-bot
backtesting
algorithmic-trading
llm
pattern-recognition
ccxt
yfinance
fastapi
nextjs
python
typescript
openai
anthropic
claude
skill-system
multi-agent
langchain-alternative
tradingview
```

Recommended top 10 (if GitHub's limit is lower on your account):

```
ai-agents, trading, backtesting, algorithmic-trading, llm, pattern-recognition, ccxt, fastapi, nextjs, openai
```

---

## Repository settings checklist

- [ ] **Description** — paste one of the options above
- [ ] **Website** — repo URL or demo URL
- [ ] **Topics** — add from the list above
- [ ] **Include in the home page** — ✓ Releases, ✓ Packages, ✓ Deployments
- [ ] **Sponsor button** — enable if you have a funding.yml
- [ ] **Preserve this repository** — enable (Arctic Code Vault)
- [ ] **Social preview image** — upload a 1280×640 banner (the Vibe Trade logo + tagline)

---

## Social preview image copy

If you're making a banner image for the repo social card (Twitter/Discord unfurls), these work well at ~1280×640:

**Headline**: `VIBE TRADE`
**Subhead**: `The AI-native trading platform`
**Tagline**: `One agent. Unlimited skills.`
**Tagline 2**: `pipx install vibe-trade`

Colors (match the app's accent):
- Background: `#0f1419` (dark)
- Accent: `#ff6b00` (orange — the Vibe Trade accent)
- Success/Bullish: `#26a69a`
- Text: `#f0f0f3`

---

## Release notes template (v0.1.0)

Suggested GitHub release notes for the first pipx-installable release:

```
## Vibe Trade 0.1.0 — First pipx release 🚀

The AI-native trading platform now ships as a single `pipx install vibe-trade` command. One install gets you the backend, the pre-built web UI, and the `vibe-trade` CLI.

### ✨ Highlights
- **Built-in planner** — default agent decomposes multi-step requests and runs each step in the browser with real script execution between steps
- **Skill system** — pure SKILL.md files, central tool catalog (23 tools across 7 categories), auto-discovery on startup
- **Data Fetcher skill** — yfinance + ccxt with LLM-powered ticker aliasing (gold → GC=F, dogecoin → DOGE/USDT)
- **Multi-agent simulation** — 15-persona committee debate with 8 rounds and consensus recommendation
- **Persistent conversation history** — ChatGPT-style sidebar with per-conversation code/pattern/backtest state
- **Claude-style trace box** — inline agent-process view that auto-collapses when the plan completes
- **9 LLM providers** — OpenAI, Anthropic, DeepSeek, Groq, Gemini, OpenRouter, Together, Fireworks, Ollama
- **CLI** — `vibe-trade serve`, `fetch`, `simulate`, `skills`, `tools`

### 📦 Install

\`\`\`bash
pipx install vibe-trade
export OPENAI_API_KEY=sk-...
vibe-trade serve
\`\`\`

That's it. The web UI opens at http://localhost:8787.

### 🧩 Add your own skill

1. Drop a folder in `skills/<your-id>/` with a `SKILL.md`
2. Declare tools from the catalog
3. Add a processor to `core/agents/processors.py`
4. Restart — your skill appears as a chip in the frontend with zero frontend edits

See the README for the full contribution guide.

### 🐛 Bug fixes
- Fixed "Cannot read properties of undefined (reading 'time')" crash on conversation switch
- Fixed strategy results not showing up in the Portfolio tab after zero-skill plans
- Fixed "fetch X 1m last month" returning 30 bars instead of 43200
- Fixed chatbox chip overflow hiding the Send button
- Fixed "confidence is not defined" in LLM-generated pattern scripts via helper injection
- Fixed pattern detection "one result only" via improved NMS + top-K floor

Full changelog: https://github.com/spyderweb47/Vibe-Trade/commits/v0.1.0
```
