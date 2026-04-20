# Swarm Intelligence Pipeline

MiroFish-inspired 6-stage pipeline for multi-agent market debate with
tool-augmented personas, internet research, and structured intelligence
gathering.

```
User: "Run a swarm debate on crude oil"
                    |
    +---------------v---------------+
    | Stage 1: Context Analysis     |
    | Extract regime, S/R, signals  |
    | from raw OHLC bars            |
    +---------------+---------------+
                    |
    +---------------v---------------+
    | Stage 1.5: Intelligence       |
    | Gathering                     |
    |                               |
    | Web search: latest news       |
    | Fetch news: 8 articles        |
    | Run indicators: RSI, MACD,    |
    |   Bollinger, ATR, VWAP        |
    | Compute S/R levels            |
    | Regulatory search             |
    |                               |
    | -> Synthesize into briefing:  |
    |   bull case, bear case,       |
    |   key events, sentiment,      |
    |   data points to cite         |
    +---------------+---------------+
                    |
    +---------------v---------------+
    | Stage 2: Persona Generation   |
    | 50 agents, each assigned      |
    | tools based on role:          |
    |                               |
    | Hedge Fund PM -> web, news    |
    | Tech Analyst -> indicators    |
    | Journalist -> web, news, url  |
    | Regulator -> web, policy      |
    | Quant -> indicators, levels   |
    | Observer -> web, indicators   |
    +---------------+---------------+
                    |
    +---------------v---------------+
    | Stage 3: Debate (30 rounds)   |
    |                               |
    | Rounds 1-3: RESEARCH PHASE    |
    | Agents use their tools:       |
    |  - Journalist fetches news    |
    |  - Quant runs RSI + MACD      |
    |  - Macro guy searches policy  |
    |  Tool results injected into   |
    |  their arguments              |
    |                               |
    | Rounds 4-30: DEBATE PHASE     |
    | Memory + selective routing    |
    | + intelligence briefing       |
    +---------------+---------------+
                    |
    +---------------v---------------+
    | Stage 4: Cross-Examination    |
    | 6-8 most divergent agents     |
    | grilled on their thesis       |
    +---------------+---------------+
                    |
    +---------------v---------------+
    | Stage 5: ReACT Report         |
    | Cites panelists + real data   |
    | + news + indicators           |
    +---------------+---------------+
```


## Stage 1: Context Analysis

**Agent:** `ContextAnalyzer` (`core/agents/simulation_agents.py`)

Extracts structured knowledge from the raw OHLC bars:

| Output | Description |
|--------|-------------|
| `market_regime` | trending_up, trending_down, ranging, breakout, breakdown, volatile |
| `key_price_levels` | strong_resistance[], strong_support[], recent_pivot |
| `technical_signals` | 3-5 specific observations (e.g. "price above 200 SMA") |
| `volume_analysis` | Volume trend observation |
| `key_themes` | Themes from user context or data patterns |
| `risk_events` | Potential catalysts or risks |


## Stage 1.5: Intelligence Gathering

**Agent:** `IntelligenceGatherer` (`core/agents/simulation_agents.py`)
**Tools:** `run_research_suite()` (`core/agents/swarm_tools.py`)

Runs a comprehensive research suite BEFORE persona generation:

1. **Recent news** — DuckDuckGo search for "{asset} latest news analysis" (8 results)
2. **Market analysis** — Search for "{asset} technical analysis outlook" (5 results)
3. **Regulatory** — Search for "{asset} regulation policy" (3 results, if commodity/crypto/forex)
4. **Technical indicators** — RSI, MACD, Bollinger, ATR, VWAP computed from bars
5. **Key levels** — Support/resistance from swing high/low analysis

The LLM synthesizes these into a structured briefing:

```json
{
  "executive_summary": "2-3 sentence overview",
  "bull_case": ["specific bullish factors with data"],
  "bear_case": ["specific bearish factors with data"],
  "key_events": ["upcoming events that could move the price"],
  "sentiment_reading": "bullish/bearish/mixed",
  "data_points": ["specific numbers/dates panelists should cite"]
}
```

This briefing is injected into every debate persona's context.


## Stage 2: Persona Generation

**Agent:** `EntityGenerator` (`core/agents/simulation_agents.py`)
**Target:** 50 personas across 5 LLM batches

Each persona has:

| Field | Description |
|-------|-------------|
| `id` | Unique snake_case identifier |
| `name` | Full name |
| `role` | Professional title |
| `background` | 2-3 sentences of rich backstory |
| `bias` | strongly_bullish → strongly_bearish / contrarian |
| `personality` | Speaking style, catchphrases, quirks |
| `stance` | bull / bear / neutral / observer |
| `influence` | 0.5 – 3.0 (weight in consensus calculation) |
| `specialization` | technical / fundamental / macro / quant / sentiment / geopolitical / industry / general |
| `tools` | List of tool names this persona can use (assigned from ROLE_TOOL_MAP) |

### Role → Tool Mapping

```
technical    → run_indicator, compute_levels
quant        → run_indicator, compute_levels
fundamental  → web_search, fetch_news, fetch_url
macro        → web_search, fetch_news, fetch_policy
industry     → web_search, fetch_news, fetch_url
sentiment    → web_search, fetch_news
geopolitical → web_search, fetch_policy, fetch_url
general      → web_search, fetch_news
observer     → web_search, fetch_news, run_indicator
```

### Observer Agents

2-3 personas are assigned `stance: "observer"`. Their job is NOT to argue
a direction but to:
- Fact-check other agents' claims
- Flag logical inconsistencies
- Point out when conclusions don't follow from data
- Track which arguments are supported by evidence vs. opinion


## Stage 3: Multi-Round Debate

**Agent:** `DiscussionAgent` (`core/agents/simulation_agents.py`)
**Config:** 30 rounds × 15 speakers per round = up to 450 messages

### Data Feeds (per-agent specialization routing)

Each agent receives data matched to their specialization:

| Specialization | Data Feed | Content |
|---------------|-----------|---------|
| technical | `technical` | Last 50 raw OHLC bars + candle pattern analysis |
| quant | `quant` | Mean return, std dev, skewness, autocorrelation |
| macro | `macro` | Multi-timeframe performance, SMA crosses, S/R clusters |
| fundamental | `structure` | Swing highs/lows, trend structure (HH/HL) |
| sentiment | `volume` | Volume trends, high-volume bars, institutional signals |
| general | `general` | 10-line summary (baseline) |

### Memory System

Each agent maintains a personal memory of their last 5 positions:
```
## Your previous positions:
- Round 1: "I believe oil will test $92 resistance..."
- Round 3: "After seeing the OPEC report, I'm revising..."
- Round 7: "The technical breakdown below SMA50 concerns me..."
```

This prevents circular debates and forces thesis evolution.

### Selective Information Routing

Instead of every agent seeing the full thread, messages are scored by
relevance to each agent:

| Signal | Score |
|--------|-------|
| Agent mentioned by name | +10.0 |
| Overlapping role keywords | +2.0 per keyword |
| Recency (last 2 rounds) | +3.0 (decays by 0.5 per round) |
| High-influence author | +0.5 × influence |

Top-scored messages up to 6000 chars are shown to each agent.

### Tool Usage (Research Phase)

In rounds 1-3, agents use their assigned tools before speaking:
- Technical analyst runs RSI + MACD on the chart
- Journalist fetches latest news articles
- Regulatory analyst searches for policy documents
- Max 2 tools per agent per round
- Tool results injected as "Your research findings:" in their context

### Convergence Check

Influence-weighted sentiment tracked per round. Early exit if last 5
rounds have sentiment spread < 0.05, but only after round 20.


## Stage 4: Cross-Examination

**Agent:** `CrossExaminer` (`core/agents/simulation_agents.py`)
**Targets:** 6-8 most divergent agents

After the main debate:
1. Score all agents by `|avg_sentiment| × influence`
2. Pick top 6 most extreme (highest conviction × influence)
3. Pick 2 more from the opposite side for balance
4. Each target receives:
   - Their own previous positions
   - 3 strongest counterarguments from opposing agents
   - A pointed question: "Can you defend your thesis against these objections?"
5. Response includes `conviction_change`: unchanged / strengthened / weakened / reversed


## Stage 5: ReACT Report Generation

**Agent:** `ReACTReportAgent` (`core/agents/simulation_agents.py`)

Multi-step report with 3 analytical tools used before writing:

| Tool | What it does |
|------|-------------|
| `DEEP_ANALYSIS` | Find consensus clusters, divergence points, sentiment evolution |
| `INTERVIEW` | Pick 2 agents whose views changed and analyze WHY |
| `VERIFY` | Cross-reference claims against actual market data |

The report receives:
- Early thread (first 1/3, 3000 chars)
- Late thread + cross-exam (last 2/3, 6000 chars)
- Raw OHLC data (technical feed, 3000 chars)
- Volume/institutional data (1500 chars)
- Statistical properties (1000 chars)
- Knowledge base (regime, S/R, signals)

### Output

```json
{
  "consensus_direction": "BULLISH/BEARISH/NEUTRAL",
  "confidence": 72,
  "key_arguments": ["5 data-backed arguments citing panelists by name"],
  "dissenting_views": ["2 contrarian views with evidence"],
  "price_targets": { "low": 82, "mid": 89, "high": 95 },
  "risk_factors": ["3 specific triggers with probabilities"],
  "recommendation": {
    "action": "BUY/SELL/HOLD",
    "entry": 85.50,
    "stop": 82.00,
    "target": 93.00,
    "position_size_pct": 2.0
  },
  "conviction_shifts": ["Agent X shifted from bearish to neutral because Y"]
}
```


## Swarm Agent Tools

**File:** `core/agents/swarm_tools.py`

| Tool | Function | API Key | Description |
|------|----------|---------|-------------|
| `web_search` | DuckDuckGo search | None | General internet search |
| `fetch_news` | DuckDuckGo search | None | Asset-specific news |
| `fetch_policy` | DuckDuckGo search | None | Regulatory/policy docs |
| `fetch_url` | requests + BeautifulSoup | None | Fetch and parse any URL |
| `fetch_pdf` | requests + PyPDF2 | None | Download and extract PDF text |
| `run_indicator` | Pure Python | None | RSI, MACD, Bollinger, ATR, VWAP, OBV, SMA, EMA |
| `compute_levels` | Pure Python | None | Support/resistance from swings |
| `run_research_suite` | All of the above | None | Full research run for gatherer |


## Scale

| Metric | Value |
|--------|-------|
| Target personas | 50 |
| Max rounds | 30 |
| Speakers per round | 15 |
| Max messages | ~450 |
| Tokens per message | 1200 |
| Cross-exam targets | 6-8 |
| Cross-exam tokens | 1000 each |
| Report tokens | 8000 |
| Intelligence gathering | ~15 web searches + 5 indicators |
| Total LLM calls | ~470 |
| Estimated runtime | 15-40 minutes |
| Web requests | ~20 (news + analysis + policy) |


## File Map

```
core/
  agents/
    swarm_tools.py          # 8 tools + ROLE_TOOL_MAP + research suite
    simulation_agents.py    # All 7 agent classes:
                            #   AssetClassifier
                            #   ChartSupportAgent
                            #   ContextAnalyzer
                            #   IntelligenceGatherer  (NEW)
                            #   EntityGenerator       (enhanced)
                            #   DiscussionAgent       (enhanced)
                            #   CrossExaminer         (NEW)
                            #   ReACTReportAgent      (NEW)
                            #   SummaryAgent          (legacy, kept for compat)
                            #   DataFeedBuilder
  engine/
    dag_orchestrator.py     # DebateOrchestrator — runs the 6-stage pipeline

skills/
  swarm_intelligence/
    SKILL.md                # Skill definition + tool declarations

apps/web/src/
  components/tabs/
    DAGGraphTab.tsx          # Entity network graph
    PersonalitiesTab.tsx     # Entity card grid
    DebateThreadTab.tsx      # Conversation messages
    RunStatsTab.tsx          # Summary dashboard
```
