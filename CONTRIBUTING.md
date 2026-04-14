# Contributing to Vibe Trade

Thanks for your interest in contributing! This guide will help you get set up and submit changes.

## Development Setup

### Prerequisites

- Node.js 20+
- Python 3.12+
- Git

### Install

```bash
git clone https://github.com/spyderweb47/Vibe-Trade.git
cd Vibe-Trade

# Copy env file and add your OpenAI key
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...

# Python backend — set up venv and install from project root
python -m venv venv
source venv/bin/activate          # Mac/Linux
# .\venv\Scripts\Activate.ps1     # Windows PowerShell
pip install -r services/api/requirements.txt

# Frontend
cd apps/web && npm install && cd ../..
```

### Run Locally

Open **two terminals**:

```bash
# Terminal 1 — Backend (port 8000)
# From project root, with venv activated:
python -m uvicorn services.api.main:app --reload --port 8000

# Terminal 2 — Frontend (port 3000)
cd apps/web && npm run dev
```

Then open http://localhost:3000 in your browser.

See [README.md](README.md#troubleshooting) for troubleshooting common install issues.

## Project Architecture

### Frontend (`apps/web/`)

- **Framework**: Next.js 16 with App Router, React 19, TypeScript
- **Styling**: Tailwind CSS 4 with CSS custom properties for theming (dark/light)
- **State**: Single Zustand store at `src/store/useStore.ts`
- **Charting**: lightweight-charts v5 with custom `ISeriesPrimitive` renderers in `src/lib/chart-primitives/`
- **Script Execution**: Web Workers for sandboxed JS execution (pattern detection + strategy backtest)

### Backend (`services/api/`)

- **Framework**: FastAPI
- **Agents**: Python classes in `core/agents/` that call OpenAI to generate JavaScript scripts from natural language
- **Single endpoint**: `POST /api/chat` handles pattern and strategy requests

### Key Directories

| Path | Purpose |
|------|---------|
| `src/components/` | All React components |
| `src/components/playground/` | Playground mode UI (trading panel, positions, orders, history, wallet) |
| `src/lib/chart-primitives/` | Custom chart renderers (pattern boxes, trade boxes, drawings, Pine drawings) |
| `src/lib/playground/` | Replay engine and liquidation math |
| `src/hooks/` | Custom React hooks |
| `src/store/` | Zustand state management |
| `src/types/` | TypeScript type definitions |
| `core/agents/` | Python AI agents (pattern, strategy) |

## Making Changes

### Branch Naming

```
feature/short-description
fix/short-description
```

### Code Style

- **TypeScript**: Strict mode, no `any` where avoidable
- **CSS**: Use CSS custom properties (`var(--text-primary)`, `var(--surface)`, etc.) for all colors — never hardcode hex values
- **Components**: Functional components with hooks, colocate types
- **State**: All shared state goes through the Zustand store; local state is fine for UI-only concerns

### Adding a Chart Primitive

1. Create a new file in `src/lib/chart-primitives/` implementing `ISeriesPrimitive<Time>`
2. Add a renderer class implementing `IPrimitivePaneRenderer`
3. Create a ref in `Chart.tsx`, attach via `series.attachPrimitive()` in the chart creation effect
4. Clean up in the return callback of the same effect

### Adding a Playground Feature

1. Add types to `src/types/index.ts`
2. Add state + actions to `src/store/useStore.ts`
3. Update the matching engine in `src/lib/playground/replayEngine.ts` if it affects order/position logic
4. Create UI components in `src/components/playground/`

### Adding an Indicator

Built-in indicators are defined in `src/lib/indicators.ts`. Custom indicators run via the Script system (Web Worker execution).

## Submitting a PR

1. Fork the repo and create a feature branch
2. Make your changes
3. Test in both Building and Playground modes
4. Ensure `npm run build` passes (frontend)
5. Open a PR against `main` with a clear description of what changed and why

## Reporting Issues

Open an issue on GitHub with:
- Steps to reproduce
- Expected vs actual behavior
- Browser and OS
- Console errors (if any)
