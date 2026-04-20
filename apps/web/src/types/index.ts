export interface OHLCBar {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Dataset {
  id: string;
  name: string;
  metadata: {
    rows: number;
    startDate: string;
    endDate: string;
    symbol?: string;
    nativeTimeframe?: string;
    chartTimeframe?: string;
  };
}

export interface PatternMatch {
  id: string;
  name: string;
  startIndex: number;
  endIndex: number;
  startTime: string;
  endTime: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  description?: string;
}

export interface Strategy {
  id: string;
  name: string;
  code: string;
  type: 'pattern' | 'indicator' | 'composite';
  parameters: Record<string, number | string | boolean>;
}

export interface Trade {
  id: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  quantity: number;
  pnl: number;
  pnlPercent: number;
  reason?: string;
  // Expanded fields for deep analysis
  entryIdx?: number;
  exitIdx?: number;
  maxAdverseExcursion?: number;
  maxFavorableExcursion?: number;
  holdingBars?: number;
  drawdownAtEntry?: number;
  entryReason?: string;
  exitReason?: string;
}

export interface StrategyConfig {
  entryCondition: string;
  exitCondition: string;
  takeProfit: { type: 'percentage' | 'fixed'; value: number };
  stopLoss: { type: 'percentage' | 'trailing'; value: number };
  maxDrawdown: number;
  seedAmount: number;
  specialInstructions: string;
}

export interface PortfolioMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalReturn: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldingBars: number;
  winStreak: number;
  loseStreak: number;
}

export interface StrategyResult {
  config: StrategyConfig;
  metrics: PortfolioMetrics;
  trades: Trade[];
  equity: number[];
  pnlPerTrade: number[];
  analysis: string;
  suggestions: string[];
}

export interface BacktestResult {
  strategyId: string;
  strategyName: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalReturn: number;
  annualizedReturn: number;
  trades: Trade[];
  equityCurve: { time: string; value: number }[];
  // Extended
  metrics?: PortfolioMetrics;
  pnlPerTrade?: number[];
  analysis?: string;
  suggestions?: string[];
}

/**
 * One step inside an agent-process trace. Used by the planner to surface
 * its real-time execution state inline in the chat (Claude-style thinking box).
 */
export interface TraceSubStep {
  label: string;
  status: 'pending' | 'running' | 'done';
}

export interface TraceStep {
  skill: string;
  message: string;
  rationale?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;        // short summary like "63 matches found"
  error?: string;         // populated when status === 'failed'
  subSteps?: TraceSubStep[];  // internal progress for long-running skills
}

/**
 * The agent-process metadata attached to a `'trace'` message. Lives inline
 * in the chat but is rendered as a distinct collapsible box, NOT as a regular
 * agent reply, so the user can scroll past it without it cluttering the
 * back-and-forth conversation.
 */
export interface TraceData {
  status: 'planning' | 'running' | 'done' | 'failed';
  steps: TraceStep[];
  title?: string;          // e.g. "Vibe Trade is planning..."
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'trace';
  content: string;
  timestamp: string;
  image?: string; // data URL for snapshot images
  /** Only set when role === 'trace'. Drives the collapsible TraceMessage UI. */
  trace?: TraceData;
}

/**
 * A persisted conversation. Holds a snapshot of all per-conversation state
 * so the user can switch between threads without losing work. Stored in
 * localStorage and restored on mount.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  // App mode (building / playground) at last sync
  appMode: 'building' | 'playground' | 'simulation';
  // Chat messages, split by skill (matches the live store split)
  patternMessages: Message[];
  strategyMessages: Message[];
  // Code editor + outputs
  currentScript: string;
  // Pattern detection results
  patternMatches: PatternMatch[];
  // Strategy/backtest results
  strategyConfig: StrategyConfig | null;
  backtestResults: BacktestResult | null;
  // Active selections at last sync
  activeDataset: string | null;
  activeSkillIds: string[]; // serialized Set<string>
  // ─── Full session isolation ──────────────────────────────────────
  // Chart data — OHLCV bars displayed when this conversation was last active
  chartData?: OHLCBar[];
  // All datasets loaded in this session
  datasets?: Array<{ id: string; name: string; metadata: Record<string, unknown> }>;
  // Per-dataset chart data cache (avoids re-fetch on dataset switch)
  datasetChartData?: Record<string, OHLCBar[]>;
  // Selected timeframe (null = auto)
  selectedTimeframe?: string | null;
  // Swarm Intelligence debate result
  currentDebate?: SimulationDebate | null;
  // Chart drawings (trend lines, fibs, rectangles, etc.)
  drawings?: unknown[];
}

export interface IndicatorConfig {
  name: string;
  backendName: string;
  active: boolean;
  params: Record<string, number | string>;
  /** Custom JS script for user-created indicators */
  script?: string;
  /** Whether this is a custom (AI-generated) indicator */
  custom?: boolean;
  /** Color for chart line */
  color?: string;
}

/**
 * A single chart window floating on the Canvas. Each window is a freely
 * draggable + resizable rectangle that shows OHLCV data for ONE dataset.
 * Users can add multiple windows with different tickers, resize them, and
 * close individual ones without affecting the others.
 *
 * Coordinates (x, y, width, height) are in pixels, relative to the Canvas
 * container's top-left corner. The Canvas uses absolute positioning; bounds
 * are clamped in the store actions so a window can't be dragged off-screen.
 */
export interface ChartWindow {
  /** uuid — stable across position updates. */
  id: string;
  /** Which dataset this window shows. null = empty/placeholder window. */
  datasetId: string | null;
  /** Position in px from Canvas top-left. */
  x: number;
  y: number;
  /** Size in px. */
  width: number;
  height: number;
  /** Stacking order. The most recently focused window has the highest z. */
  zIndex: number;
  /** Optional custom title. Falls back to the dataset's symbol. */
  title?: string;
}

export interface Script {
  id: string;
  name: string;
  code: string;
  type: 'pattern' | 'strategy' | 'indicator';
}

export interface CapturedPatternData {
  bars: OHLCBar[];
  timeRange: [number, number];
  priceRange: [number, number];
  indicators: Record<string, (number | null)[]>;
  priceChangePercent: number;
  volatility: number;
  volumeProfile: number[];
  trendAngle: number;
  patternShape: number[];
  // Extended mathematical fingerprint
  candleSequence?: { bodySize: number; upperWick: number; lowerWick: number; direction: number; totalRange: number; bodyRatio: number }[];
  normOpen?: number[];
  normHigh?: number[];
  normLow?: number[];
  patternHeightRatio?: number;
  indicatorMath?: Record<string, {
    slope: number;
    curvature: number;
    positionRelativeToPrice: string;
    normalizedValues: number[];
    crossesPrice: number;
  }>;
}

// ============================================================================
// Playground Mode Types
// ============================================================================

export type AppMode = 'building' | 'playground' | 'simulation';

export type PositionSide = 'long' | 'short';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'pending' | 'filled' | 'cancelled';
export type ExitReason = 'manual' | 'tp' | 'sl' | 'liquidation';

export interface DemoWallet {
  initialBalance: number;
  balance: number;
}

export interface Position {
  id: string;
  side: PositionSide;
  size: number;              // USD notional
  leverage: number;          // 1 — 20
  entryPrice: number;
  margin: number;            // size / leverage
  liquidationPrice: number;
  takeProfit?: number;
  stopLoss?: number;
  openedAtBarIdx: number;
  openedAtTime: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
}

export interface PerpOrder {
  id: string;
  type: OrderType;
  side: PositionSide;
  size: number;
  leverage: number;
  limitPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
  reduceOnly: boolean;
  status: OrderStatus;
  createdAtBarIdx: number;
}

export interface PlaygroundTrade {
  id: string;
  side: PositionSide;
  size: number;
  leverage: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  exitReason: ExitReason;
}

export interface PlaygroundReplay {
  isPlaying: boolean;
  speed: number;             // 0.5, 1, 2, 5, 10, 1000
  currentBarIndex: number;
  totalBars: number;
}

// ============================================================================
// Simulation Mode Types (Multi-Agent Debate)
// ============================================================================

export type AgentStatus = 'pending' | 'running' | 'done' | 'error';
export type TradeDecision = 'BUY' | 'SELL' | 'HOLD';

export interface EntityProfile {
  id: string;
  name: string;
  role: string;
  background: string;
  bias: string;
  personality: string;
  // Extended metadata (previously hidden)
  stance?: string;              // bull / bear / neutral / observer
  influence?: number;           // 0.5 - 3.0
  specialization?: string;      // technical / macro / fundamental / etc.
  tools?: string[];             // assigned tool names
}

export interface DiscussionMessage {
  id: string;
  round: number;
  entityId: string;
  entityName: string;
  entityRole: string;
  content: string;
  sentiment: number;
  pricePrediction?: number | null;
  agreedWith?: string[];
  disagreedWith?: string[];
  isChartSupport?: boolean;
  // Tool usage tracking — which tools this agent called in this message
  toolsUsed?: string[];
  toolResults?: Record<string, string>;
}

export interface SimulationSummary {
  consensusDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  keyArguments: string[];
  dissentingViews: string[];
  priceTargets: { low: number; mid: number; high: number };
  riskFactors: string[];
  recommendation: { action: string; entry?: number; stop?: number; target?: number; position_size_pct?: number };
  convictionShifts?: string[];
}

export interface IntelBriefing {
  executiveSummary?: string;
  bullCase?: string[];
  bearCase?: string[];
  keyEvents?: string[];
  sentimentReading?: string;
  dataPoints?: string[];
  rawFindings?: {
    recentNews?: string;
    marketAnalysis?: string;
    regulatory?: string;
    technicalIndicators?: string;
    keyLevels?: string;
  };
}

export interface CrossExamResult {
  entityId: string;
  entityName: string;
  entityRole: string;
  question: string;
  response: string;
  convictionChange: 'unchanged' | 'strengthened' | 'weakened' | 'reversed';
  newSentiment?: number | null;
}

export interface MarketContext {
  marketRegime?: string;
  keyPriceLevels?: {
    strongResistance?: number[];
    strongSupport?: number[];
    recentPivot?: string | number;
  };
  technicalSignals?: string[];
  volumeAnalysis?: string;
  keyThemes?: string[];
  riskEvents?: string[];
}

export interface AgentResearchFinding {
  iteration: number;
  query: string;
  reasoning: string;
  tool: string;
  result: string;
}

export interface ConvergenceDataPoint {
  round: number;
  sentiment: number;
}

export interface RunEvent {
  /** ISO-ish local timestamp from the backend (e.g. "2026-04-17T15:23:45"). */
  timestamp: string;
  /** info | warn | error */
  level: 'info' | 'warn' | 'error';
  /** stage1 / stage1.5 / stage2 / stage3 / stage4 / stage5 / complete. */
  stage: string;
  /** Human-readable description of what happened. */
  message: string;
}

export interface SimulationDebate {
  id: string;
  datasetId: string;
  symbol: string;
  assetClass: string;
  assetName: string;
  entities: EntityProfile[];
  thread: DiscussionMessage[];
  currentRound: number;
  totalRounds: number;
  summary: SimulationSummary | null;
  status: 'idle' | 'classifying' | 'generating_entities' | 'discussing' | 'summarizing' | 'complete' | 'error';
  error?: string;
  // Pipeline-rich data
  intelBriefing?: IntelBriefing;
  crossExamResults?: CrossExamResult[];
  marketContext?: MarketContext;
  dataFeeds?: Record<string, string>;                       // general/technical/volume/quant/macro/structure
  agentResearch?: Record<string, AgentResearchFinding[]>;   // entityId → findings
  convergenceTimeline?: ConvergenceDataPoint[];
  // Errors / timeouts / warnings emitted by the backend pipeline. Rendered
  // as a prominent banner in Run Stats so the user can see what went wrong
  // without opening server logs.
  events?: RunEvent[];
}
