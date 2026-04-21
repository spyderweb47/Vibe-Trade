---
id: historic_news
name: Historic News
tagline: News factors on chart
description: >
  Research historical news events that moved (or are moving) an asset's price
  and plot them as data points directly on the chart. Click a marker in the
  Historic News tab to zoom the chart to that event and read the article.
  Useful for identifying the fundamental drivers behind price action —
  earnings, regulation, product launches, macro shocks, geopolitical events.
version: 1.0.0
author: Vibe Trade Core
category: research
icon: newspaper
color: "#3b82f6"
tools:
  - news.events.set
  - bottom_panel.activate_tab
  - chart.focus_range
  - notify.toast
output_tabs:
  - id: historic_news
    label: Historic News
    component: HistoricNewsTab
store_slots:
  - newsEvents
  - selectedNewsEventId
input_hints:
  placeholder: "Find historic news events that moved this asset..."
  supports_fingerprint: false
---

# Historic News Skill

> Research and annotate price-moving news events on the chart. Uses the
> shared AgentSwarm service to spawn a research team.

## The team

| Role | Mandatory | Tools | Added when |
|---|---|---|---|
| **Researcher** | ✅ | `search_web`, `fetch_news`, `fetch_url` | Always — does the actual web queries for historic news |
| **Analyzer** | ✅ | — | Always — parses raw findings into structured NewsEvent objects with timestamps, categories, impact ratings, and direction |
| **QA** | ✅ | — | Always — filters out unsubstantiated events, checks timestamps are plausible, drops duplicates |
| **Macro Researcher** | ⏳ optional | `search_web`, `fetch_policy` | Added when the asset is a commodity, currency, or index (where macro news dominates price action) |
| **Regulatory Researcher** | ⏳ optional | `fetch_policy`, `fetch_url` | Added when the asset has active policy considerations (crypto, pharma, defense) |

## Flow

1. Team Planner picks which researchers to include based on asset class
2. Researchers run in parallel — each does 2-4 targeted web searches for news in different periods (pre-rally, drawdown, range-bound, etc.)
3. Analyzer merges findings into a structured event list with:
   - `timestamp` (unix seconds)
   - `headline`, `summary`, `source`, `url`
   - `category` — earnings | regulatory | macro | product | sentiment | geopolitical | technical
   - `impact` — high | medium | low
   - `direction` — bullish | bearish | neutral
   - `price_impact_pct` — rough estimate of the event's price effect (optional)
4. QA reviews: drops duplicates, flags timestamps outside the chart's data range, ensures each event has a credible source
5. Final event list is pushed to the store → chart renders vertical markers → Historic News tab lists them

## Output

- **On chart**: colored vertical line + dot at each event's timestamp. Red for bearish, green for bullish, orange for neutral. Hover for tooltip.
- **Bottom-panel tab**: timeline list of events sorted newest-first. Click an event → chart zooms to that time range + selected article detail appears on the right.

## Input

- Natural language: "find historic news for AAPL", "what news drove BTC up last year", "historic news events for CL=F", "show me price-moving news"
- Requires a dataset loaded on the chart (the skill queries around the chart's visible date range).

## Example

> User: *"Find historic news events that moved AAPL"*
>
> → Team: Researcher + Analyzer + QA. Researcher queries for AAPL
> earnings, product launches, and macro shocks in the chart's date
> range. Analyzer extracts ~15-25 events with timestamps + summaries.
> QA drops 3 unsubstantiated ones. Final: 20 events plotted on
> chart with category-coloured markers. Bottom panel shows timeline.
>
> User clicks the "Q1 earnings surprise" event → chart zooms to
> that date; right panel shows the full article summary + link.
