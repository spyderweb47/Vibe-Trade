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
}

export interface SimulationState {
  isRunning: boolean;
  speed: number;
  currentBar: number;
  totalBars: number;
  currentPnl: number;
  openPositions: number;
  completedTrades: Trade[];
}

export interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
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
}
