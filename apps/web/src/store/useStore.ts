import { create } from 'zustand';
import type {
  OHLCBar,
  Dataset,
  PatternMatch,
  Script,
  Message,
  BacktestResult,
  IndicatorConfig,
  CapturedPatternData,
} from '@/types';
import type { Drawing, DrawingType } from '@/lib/chart-primitives/drawingTypes';
import { resampleToTimeframe } from '@/lib/csv/resampleOHLC';

export type Mode = 'pattern' | 'strategy';

interface AnalysisResults {
  summary?: string;
  metrics?: Record<string, number | string>;
  signals?: { time: string; type: string; price: number }[];
}

interface AppState {
  // Mode
  activeMode: Mode;
  setMode: (mode: Mode) => void;

  // Datasets
  datasets: Dataset[];
  activeDataset: string | null;
  datasetChartData: Record<string, OHLCBar[]>;
  datasetRawData: Record<string, OHLCBar[]>;
  syncedDatasets: Set<string>;
  addDataset: (dataset: Dataset, chartData: OHLCBar[], rawData: OHLCBar[]) => void;
  markSynced: (id: string) => void;
  setActiveDataset: (id: string | null) => void;

  // Scripts
  scripts: Script[];
  addScript: (script: Script) => void;
  removeScript: (id: string) => void;

  // Messages (per-mode)
  patternMessages: Message[];
  strategyMessages: Message[];
  messages: Message[]; // derived from active mode
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void;

  // Backtest
  backtestResults: BacktestResult | null;
  setBacktestResults: (results: BacktestResult | null) => void;

  // Indicators
  indicators: IndicatorConfig[];
  toggleIndicator: (name: string) => void;
  updateIndicatorParams: (name: string, params: Record<string, number | string>) => void;
  removeIndicator: (name: string) => void;
  addCustomIndicator: (ind: IndicatorConfig) => void;

  // Chart data (derived from activeDataset)
  chartData: OHLCBar[];
  selectedTimeframe: string | null; // null = auto (fit to 6000 bars)
  setSelectedTimeframe: (tf: string | null) => void;

  // Pattern matches
  patternMatches: PatternMatch[];
  lastScriptResult: { ran: boolean; error?: string } | null;
  setPatternMatches: (matches: PatternMatch[]) => void;
  setLastScriptResult: (result: { ran: boolean; error?: string } | null) => void;

  // Analysis
  analysisResults: AnalysisResults | null;
  setAnalysisResults: (results: AnalysisResults | null) => void;

  // Pattern Selector
  patternSelectorActive: boolean;
  setPatternSelectorActive: (active: boolean) => void;
  capturedPattern: CapturedPatternData | null;
  setCapturedPattern: (data: CapturedPatternData | null) => void;

  // Pine drawings
  pineDrawings: any | null;
  pineDrawingsPlotData: Record<string, (number | null)[]> | null;
  setPineDrawings: (drawings: any | null, plotData?: Record<string, (number | null)[]>) => void;

  // Theme
  darkMode: boolean;
  toggleDarkMode: () => void;

  // Chat input prefill
  chatInputDraft: string;
  setChatInputDraft: (text: string) => void;

  // Strategy config
  strategyConfig: import('@/types').StrategyConfig | null;
  setStrategyConfig: (config: import('@/types').StrategyConfig | null) => void;

  // Trade plotting on chart
  plottedTrades: import('@/types').Trade[];
  setPlottedTrades: (trades: import('@/types').Trade[]) => void;
  highlightedTradeId: string | null;
  setHighlightedTradeId: (id: string | null) => void;

  // Chart focus — zoom to a specific time range
  chartFocus: { startTime: number; endTime: number } | null;
  setChartFocus: (focus: { startTime: number; endTime: number } | null) => void;

  // Drawing tools
  activeDrawingTool: DrawingType | null;
  setActiveDrawingTool: (tool: DrawingType | null) => void;
  drawings: Drawing[];
  setDrawings: (drawings: Drawing[]) => void;
  deleteSelectedDrawing: () => void;

  // ===== Playground Mode =====
  appMode: import('@/types').AppMode;
  setAppMode: (mode: import('@/types').AppMode) => void;

  playgroundReplay: import('@/types').PlaygroundReplay;
  setReplayPlaying: (playing: boolean) => void;
  setReplaySpeed: (speed: number) => void;
  setReplayBarIndex: (idx: number) => void;
  setReplayTotalBars: (total: number) => void;
  resetReplay: () => void;

  demoWallet: import('@/types').DemoWallet;
  resetWallet: (amount?: number) => void;
  adjustWalletBalance: (delta: number) => void;

  positions: import('@/types').Position[];
  setPositions: (positions: import('@/types').Position[]) => void;
  addPosition: (position: import('@/types').Position) => void;
  updatePosition: (id: string, patch: Partial<import('@/types').Position>) => void;
  removePosition: (id: string) => void;

  perpOrders: import('@/types').PerpOrder[];
  setPerpOrders: (orders: import('@/types').PerpOrder[]) => void;
  addPerpOrder: (order: import('@/types').PerpOrder) => void;
  cancelPerpOrder: (id: string) => void;
  removePerpOrder: (id: string) => void;

  closedTrades: import('@/types').PlaygroundTrade[];
  addClosedTrade: (trade: import('@/types').PlaygroundTrade) => void;
  clearClosedTrades: () => void;

  walletEquityHistory: { barIdx: number; equity: number }[];
  pushWalletEquity: (barIdx: number, equity: number) => void;
  clearWalletEquityHistory: () => void;

  // ===== Simulation Mode (Multi-Agent Debate) =====
  currentDebate: import('@/types').SimulationDebate | null;
  debateHistory: import('@/types').SimulationDebate[];
  simulationLoading: boolean;
  simulationReport: string;
  setSimulationReport: (text: string) => void;
  runDebate: () => Promise<void>;
  setCurrentDebate: (d: import('@/types').SimulationDebate | null) => void;
  resetSimulation: () => void;
}

export const useStore = create<AppState>((set) => ({
  // Mode
  activeMode: 'pattern',
  setMode: (mode) => set((state) => ({
    activeMode: mode,
    messages: mode === 'strategy' ? state.strategyMessages : state.patternMessages,
  })),

  // Datasets
  datasets: [],
  activeDataset: null,
  datasetChartData: {},
  datasetRawData: {},
  syncedDatasets: new Set(),
  addDataset: (dataset, chartData, rawData) =>
    set((state) => ({
      datasets: [...state.datasets, dataset],
      datasetChartData: { ...state.datasetChartData, [dataset.id]: chartData },
      datasetRawData: { ...state.datasetRawData, [dataset.id]: rawData },
      activeDataset: dataset.id,
      chartData,
    })),
  markSynced: (id) =>
    set((state) => ({
      syncedDatasets: new Set([...state.syncedDatasets, id]),
    })),
  setActiveDataset: (id) =>
    set((state) => ({
      activeDataset: id,
      chartData: id ? state.datasetChartData[id] || [] : [],
      patternMatches: [],
    })),

  // Scripts
  scripts: [],
  addScript: (script) =>
    set((state) => ({ scripts: [...state.scripts, script] })),
  removeScript: (id) =>
    set((state) => ({ scripts: state.scripts.filter((s) => s.id !== id) })),

  // Messages
  patternMessages: [],
  strategyMessages: [],
  messages: [],
  addMessage: (message) =>
    set((state) => {
      const newMsg = { ...message, id: crypto.randomUUID(), timestamp: new Date().toISOString() };
      const isStrategy = state.activeMode === 'strategy';
      const patternMessages = isStrategy ? state.patternMessages : [...state.patternMessages, newMsg];
      const strategyMessages = isStrategy ? [...state.strategyMessages, newMsg] : state.strategyMessages;
      return {
        patternMessages,
        strategyMessages,
        messages: isStrategy ? strategyMessages : patternMessages,
      };
    }),

  // Backtest
  backtestResults: null,
  setBacktestResults: (results) => set({ backtestResults: results }),

  // Indicators — params must match backend __init__ signatures exactly
  indicators: [
    { name: 'SMA', backendName: 'sma', active: false, params: { period: '20' } },
    { name: 'EMA', backendName: 'ema', active: false, params: { period: '20' } },
    { name: 'RSI', backendName: 'rsi', active: false, params: { period: '14' } },
    { name: 'MACD', backendName: 'macd', active: false, params: { fast_period: '12', slow_period: '26', signal_period: '9' } },
    { name: 'Bollinger Bands', backendName: 'bollinger', active: false, params: { period: '20', num_std: '2' } },
    { name: 'ATR', backendName: 'atr', active: false, params: { period: '14' } },
    { name: 'VWAP', backendName: 'vwap', active: false, params: { reset_period: '1D' } },
  ] as IndicatorConfig[],
  toggleIndicator: (name) =>
    set((state) => {
      const target = state.indicators.find((i) => i.name === name);
      const isPine = target?.script?.startsWith("__PINE__") || (target as any)?._precomputed;
      const turningOff = target?.active;
      return {
        indicators: state.indicators.map((ind) =>
          ind.name === name ? { ...ind, active: !ind.active } : ind
        ),
        // Clear Pine drawings when a Pine indicator is toggled off
        ...(isPine && turningOff ? { pineDrawings: null, pineDrawingsPlotData: null } : {}),
      };
    }),
  updateIndicatorParams: (name, params) =>
    set((state) => ({
      indicators: state.indicators.map((ind) =>
        ind.name === name ? { ...ind, params, active: false } : ind
      ),
    })),
  removeIndicator: (name) =>
    set((state) => {
      const target = state.indicators.find((i) => i.name === name);
      const isPine = target?.script?.startsWith("__PINE__") || (target as any)?._precomputed;
      return {
        indicators: state.indicators.filter((ind) => ind.name !== name),
        // Clear Pine drawings when a Pine indicator is removed
        ...(isPine ? { pineDrawings: null, pineDrawingsPlotData: null } : {}),
      };
    }),
  addCustomIndicator: (ind) =>
    set((state) => {
      // Prevent duplicates — replace if same name exists
      const filtered = state.indicators.filter((i) => i.name !== ind.name);
      return { indicators: [...filtered, ind] };
    }),

  // Chart data
  chartData: [],
  selectedTimeframe: null,
  setSelectedTimeframe: (tf) =>
    set((state) => {
      const id = state.activeDataset;
      if (!id) return {};
      const raw = state.datasetRawData[id];
      if (!raw || raw.length === 0) return {};
      if (tf === null) {
        // Auto mode — use the pre-resampled chart data
        return { selectedTimeframe: null, chartData: state.datasetChartData[id] || [] };
      }
      const resampled = resampleToTimeframe(raw, tf);
      return { selectedTimeframe: tf, chartData: resampled };
    }),

  // Pattern matches
  patternMatches: [],
  lastScriptResult: null,
  setPatternMatches: (matches) => set({ patternMatches: matches }),
  setLastScriptResult: (result) => set({ lastScriptResult: result }),

  // Analysis
  analysisResults: null,
  setAnalysisResults: (results) => set({ analysisResults: results }),

  // Pattern Selector
  patternSelectorActive: false,
  setPatternSelectorActive: (active) => set({ patternSelectorActive: active }),
  capturedPattern: null,
  setCapturedPattern: (data) => set({ capturedPattern: data }),

  // Pine drawings
  pineDrawings: null,
  pineDrawingsPlotData: null,
  setPineDrawings: (drawings, plotData) => set({ pineDrawings: drawings, pineDrawingsPlotData: plotData || null }),

  // Theme
  darkMode: true,
  toggleDarkMode: () =>
    set((state) => {
      const next = !state.darkMode;
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', next);
        // Force lightweight-charts to update with new theme (requires chart recreate)
      }
      return { darkMode: next };
    }),

  // Chat input prefill
  chatInputDraft: '',
  setChatInputDraft: (text) => set({ chatInputDraft: text }),

  // Strategy config
  strategyConfig: null,
  setStrategyConfig: (config) => set({ strategyConfig: config }),

  // Trade plotting
  plottedTrades: [],
  setPlottedTrades: (trades) => set({ plottedTrades: trades }),
  highlightedTradeId: null,
  setHighlightedTradeId: (id) => set({ highlightedTradeId: id }),

  // Chart focus
  chartFocus: null,
  setChartFocus: (focus) => set({ chartFocus: focus }),

  // Drawing tools
  activeDrawingTool: null,
  setActiveDrawingTool: (tool) => set({ activeDrawingTool: tool }),
  drawings: [],
  setDrawings: (drawings) => set({ drawings }),
  deleteSelectedDrawing: () =>
    set((state) => ({
      drawings: state.drawings.filter((d) => !d.selected),
    })),

  // ===== Playground Mode =====
  appMode: 'building',
  setAppMode: (mode) =>
    set((s) => {
      const next: Partial<typeof s> = { appMode: mode };
      // When entering playground with no cursor set, start with some initial context
      if (mode === "playground" && s.playgroundReplay.currentBarIndex === 0) {
        const activeId = s.activeDataset;
        const data = activeId ? s.datasetChartData[activeId] : null;
        const len = data?.length ?? 0;
        if (len > 0) {
          const initialCursor = Math.min(Math.floor(len * 0.3), len - 1);
          next.playgroundReplay = { ...s.playgroundReplay, currentBarIndex: initialCursor, totalBars: len };
        }
      }
      return next as any;
    }),

  playgroundReplay: { isPlaying: false, speed: 1, currentBarIndex: 0, totalBars: 0 },
  setReplayPlaying: (playing) =>
    set((s) => ({ playgroundReplay: { ...s.playgroundReplay, isPlaying: playing } })),
  setReplaySpeed: (speed) =>
    set((s) => ({ playgroundReplay: { ...s.playgroundReplay, speed } })),
  setReplayBarIndex: (idx) =>
    set((s) => ({ playgroundReplay: { ...s.playgroundReplay, currentBarIndex: idx } })),
  setReplayTotalBars: (total) =>
    set((s) => ({
      playgroundReplay: {
        ...s.playgroundReplay,
        totalBars: total,
        currentBarIndex: Math.min(s.playgroundReplay.currentBarIndex, Math.max(0, total - 1)),
      },
    })),
  resetReplay: () =>
    set((s) => ({
      playgroundReplay: { ...s.playgroundReplay, currentBarIndex: 0, isPlaying: false },
    })),

  demoWallet: { initialBalance: 10000, balance: 10000 },
  resetWallet: (amount) =>
    set({
      demoWallet: { initialBalance: amount ?? 10000, balance: amount ?? 10000 },
      positions: [],
      perpOrders: [],
      closedTrades: [],
      walletEquityHistory: [],
    }),
  adjustWalletBalance: (delta) =>
    set((s) => ({ demoWallet: { ...s.demoWallet, balance: s.demoWallet.balance + delta } })),

  positions: [],
  setPositions: (positions) => set({ positions }),
  addPosition: (position) => set((s) => ({ positions: [...s.positions, position] })),
  updatePosition: (id, patch) =>
    set((s) => ({ positions: s.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
  removePosition: (id) => set((s) => ({ positions: s.positions.filter((p) => p.id !== id) })),

  perpOrders: [],
  setPerpOrders: (orders) => set({ perpOrders: orders }),
  addPerpOrder: (order) => set((s) => ({ perpOrders: [...s.perpOrders, order] })),
  cancelPerpOrder: (id) =>
    set((s) => ({
      perpOrders: s.perpOrders.map((o) => (o.id === id ? { ...o, status: 'cancelled' as const } : o)),
    })),
  removePerpOrder: (id) => set((s) => ({ perpOrders: s.perpOrders.filter((o) => o.id !== id) })),

  closedTrades: [],
  addClosedTrade: (trade) => set((s) => ({ closedTrades: [...s.closedTrades, trade] })),
  clearClosedTrades: () => set({ closedTrades: [] }),

  walletEquityHistory: [],
  pushWalletEquity: (barIdx, equity) =>
    set((s) => ({ walletEquityHistory: [...s.walletEquityHistory, { barIdx, equity }] })),
  clearWalletEquityHistory: () => set({ walletEquityHistory: [] }),

  // ===== Simulation Mode (Multi-Agent Debate) =====
  currentDebate: null,
  debateHistory: [],
  simulationLoading: false,
  simulationReport: "",
  setSimulationReport: (text) => set({ simulationReport: text }),

  runDebate: async () => {
    const state = useStore.getState();
    const activeId = state.activeDataset;
    if (!activeId || state.simulationLoading) return;

    const ds = state.datasets.find((d) => d.id === activeId);
    const symbol = ds?.metadata?.symbol || "Unknown";
    const debateId = crypto.randomUUID();

    // Start with an empty shell — agents will be populated from the API response
    const initial: import("@/types").SimulationDebate = {
      id: debateId,
      datasetId: activeId,
      symbol,
      barsAnalyzed: 0,
      startedAt: new Date().toISOString(),
      agents: {} as Record<string, import("@/types").AgentResult>,
      decision: null,
      status: "running",
    };

    set({ currentDebate: initial, simulationLoading: true });

    try {
      const { runSimulationDebate } = await import("@/lib/api");
      const report = useStore.getState().simulationReport;
      const resp = await runSimulationDebate(activeId, 100, report);

      // Get dynamic agent roles from response (excluding 'decision' key)
      const roles = Object.keys(resp.agents);

      // Initialize all agents as pending on the DAG
      const pendingAgents: Record<string, import("@/types").AgentResult> = {};
      for (const role of roles) {
        pendingAgents[role] = {
          role,
          label: resp.agents[role].label,
          status: "pending",
          argument: "",
          keyPoints: [],
          sentiment: 0,
          signals: [],
        };
      }
      set((s) => ({
        currentDebate: s.currentDebate ? { ...s.currentDebate, agents: pendingAgents } : null,
      }));

      // Stagger reveals for DAG animation effect
      for (const role of roles) {
        // Mark running
        set((s) => ({
          currentDebate: s.currentDebate ? {
            ...s.currentDebate,
            agents: { ...s.currentDebate.agents, [role]: { ...s.currentDebate.agents[role], status: "running" as const } },
          } : null,
        }));
        await new Promise((r) => setTimeout(r, 300));

        // Mark done with real data
        const agentData = resp.agents[role];
        set((s) => ({
          currentDebate: s.currentDebate ? {
            ...s.currentDebate,
            agents: {
              ...s.currentDebate.agents,
              [role]: {
                role,
                label: agentData.label,
                status: "done" as const,
                argument: agentData.argument,
                keyPoints: agentData.key_points,
                sentiment: agentData.sentiment,
                signals: agentData.signals,
              },
            },
          } : null,
        }));
        await new Promise((r) => setTimeout(r, 200));
      }

      // Set final decision
      set((s) => ({
        currentDebate: s.currentDebate ? {
          ...s.currentDebate,
          decision: {
            decision: resp.decision.decision as import("@/types").TradeDecision,
            confidence: resp.decision.confidence,
            reasoning: resp.decision.reasoning,
            suggestedEntry: resp.decision.suggested_entry,
            suggestedStop: resp.decision.suggested_stop,
            suggestedTarget: resp.decision.suggested_target,
            positionSizePct: resp.decision.position_size_pct,
          },
          status: "complete",
          completedAt: new Date().toISOString(),
          barsAnalyzed: resp.bars_analyzed,
        } : null,
        debateHistory: s.currentDebate
          ? [{ ...s.currentDebate, status: "complete" as const }, ...s.debateHistory].slice(0, 20)
          : s.debateHistory,
        simulationLoading: false,
      }));
    } catch (err) {
      set((s) => ({
        currentDebate: s.currentDebate ? { ...s.currentDebate, status: "error", error: String(err) } : null,
        simulationLoading: false,
      }));
    }
  },

  setCurrentDebate: (d) => set({ currentDebate: d }),
  resetSimulation: () => set({ currentDebate: null, simulationLoading: false }),
}));

