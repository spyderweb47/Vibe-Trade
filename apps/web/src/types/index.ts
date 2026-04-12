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

export interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
  image?: string; // data URL for snapshot images
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

export type AgentRole = string; // Dynamic — generated by Architect agent
export type AgentStatus = 'pending' | 'running' | 'done' | 'error';
export type TradeDecision = 'BUY' | 'SELL' | 'HOLD';

export interface AgentResult {
  role: AgentRole;
  label: string;
  status: AgentStatus;
  argument: string;
  keyPoints: string[];
  sentiment: number;
  signals: string[];
}

export interface SimulationDecision {
  decision: TradeDecision;
  confidence: number;
  reasoning: string;
  suggestedEntry?: number;
  suggestedStop?: number;
  suggestedTarget?: number;
  positionSizePct?: number;
}

export interface SimulationDebate {
  id: string;
  datasetId: string;
  symbol: string;
  barsAnalyzed: number;
  startedAt: string;
  completedAt?: string;
  agents: Record<AgentRole, AgentResult>;
  decision: SimulationDecision | null;
  status: 'idle' | 'running' | 'complete' | 'error';
  error?: string;
}
