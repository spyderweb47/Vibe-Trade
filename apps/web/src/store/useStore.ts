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
  Conversation,
} from '@/types';
import type { Drawing, DrawingType } from '@/lib/chart-primitives/drawingTypes';
import { resampleToTimeframe } from '@/lib/csv/resampleOHLC';
import type { SkillMetadata } from '@/lib/api';

// ─── Conversations persistence ────────────────────────────────────────────
// Conversations are saved to localStorage so they survive page reloads.
// The persistence layer is intentionally explicit (not Zustand persist
// middleware) so we control exactly when snapshots are taken and what's
// included — playground/simulation slices stay live-only.

const CONV_STORAGE_KEY = 'vibe-trade.conversations.v1';
const CONV_ACTIVE_KEY = 'vibe-trade.conversations.activeId.v1';

function loadPersistedConversations(): { conversations: Conversation[]; activeId: string | null } {
  if (typeof window === 'undefined') return { conversations: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(CONV_STORAGE_KEY);
    const conversations = raw ? (JSON.parse(raw) as Conversation[]) : [];
    const activeId = window.localStorage.getItem(CONV_ACTIVE_KEY);
    return { conversations, activeId };
  } catch {
    return { conversations: [], activeId: null };
  }
}

function savePersistedConversations(conversations: Conversation[], activeId: string | null) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(conversations));
    if (activeId) {
      window.localStorage.setItem(CONV_ACTIVE_KEY, activeId);
    } else {
      window.localStorage.removeItem(CONV_ACTIVE_KEY);
    }
  } catch {
    // Quota exceeded or disabled — silently degrade
  }
}

function makeNewConversation(): Conversation {
  const now = Date.now();
  return {
    id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `c_${now}_${Math.random().toString(36).slice(2)}`,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    appMode: 'building',
    patternMessages: [],
    strategyMessages: [],
    currentScript: '',
    patternMatches: [],
    strategyConfig: null,
    backtestResults: null,
    activeDataset: null,
    activeSkillIds: [],
    // Session isolation defaults
    chartData: [],
    datasets: [],
    datasetChartData: {},
    selectedTimeframe: null,
    currentDebate: null,
    drawings: [],
  };
}

/**
 * Snapshot the current live store state into the active conversation entry.
 * Returns the updated conversations array, or null if there's no active id.
 * Side effect: persists the result to localStorage.
 *
 * Called from setters that change per-conversation state (addMessage,
 * setCurrentScript, setBacktestResults, setPatternMatches, setStrategyConfig,
 * setAppMode) so the conversations array always reflects the latest work.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _snapshotLiveStateInto(state: any, activeId: string | null): Conversation[] | null {
  if (!activeId) return null;
  const idx = state.conversations.findIndex((c: Conversation) => c.id === activeId);
  if (idx === -1) return null;
  const prev = state.conversations[idx];
  // Auto-derive a title from the first user message if still "New chat"
  let title = prev.title;
  if ((title === 'New chat' || !title) && state.patternMessages.length > 0) {
    const firstUser = state.patternMessages.find((m: Message) => m.role === 'user');
    if (firstUser) title = firstUser.content.slice(0, 60);
  }
  if ((title === 'New chat' || !title) && state.strategyMessages.length > 0) {
    const firstUser = state.strategyMessages.find((m: Message) => m.role === 'user');
    if (firstUser) title = firstUser.content.slice(0, 60);
  }
  const updated: Conversation = {
    ...prev,
    title,
    updatedAt: Date.now(),
    appMode: state.appMode,
    patternMessages: state.patternMessages,
    strategyMessages: state.strategyMessages,
    currentScript: state.currentScript || '',
    patternMatches: state.patternMatches,
    strategyConfig: state.strategyConfig,
    backtestResults: state.backtestResults,
    activeDataset: state.activeDataset,
    activeSkillIds: Array.from(state.activeSkillIds || []),
    // Session isolation — capture chart, datasets, debate, drawings
    chartData: state.chartData || [],
    datasets: (state.datasets || []).map((d: { id: string; name: string; metadata: Record<string, unknown> }) => ({
      id: d.id, name: d.name, metadata: d.metadata,
    })),
    datasetChartData: state.datasetChartData || {},
    selectedTimeframe: state.selectedTimeframe ?? null,
    currentDebate: state.currentDebate ?? null,
    drawings: state.drawings || [],
  };
  const conversations = [...state.conversations];
  conversations[idx] = updated;
  // Re-sort by updatedAt desc so most recent floats to top
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  savePersistedConversations(conversations, activeId);
  return conversations;
}

// Mode is the id of a skill (or one of the legacy non-skill modes). Kept
// as a loose string so the skill registry can introduce new ids without
// forcing a type update here.
export type Mode = string;

interface AnalysisResults {
  summary?: string;
  metrics?: Record<string, number | string>;
  signals?: { time: string; type: string; price: number }[];
}

interface AppState {
  // ─── Conversations (persisted) ────────────────────────────────────────
  // Stored conversation threads. The currently-loaded one's per-conversation
  // state (messages, currentScript, results, etc.) is mirrored into the live
  // store fields below. Switching/creating a conversation snapshots the
  // current live state into the previous conversation before swapping.
  conversations: Conversation[];
  activeConversationId: string | null;
  loadingConversationIds: Set<string>;
  setConversationLoading: (id: string, loading: boolean) => void;
  addMessageToConversation: (conversationId: string, message: Omit<Message, 'id' | 'timestamp'>) => string;
  hydrateConversations: () => void;
  createConversation: () => string;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;

  // Mode (derived from activeSkillIds — kept for backward compat)
  activeMode: Mode;
  setMode: (mode: Mode) => void;

  // Skill system — dynamic registry fetched from the backend at startup
  skills: SkillMetadata[];
  activeSkillIds: Set<string>;
  skillsLoaded: boolean;
  loadSkills: () => Promise<void>;
  setActiveSkills: (ids: Set<string>) => void;

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
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => string;
  updateMessage: (id: string, patch: Partial<Omit<Message, 'id'>>) => void;

  // Backtest
  backtestResults: BacktestResult | null;
  setBacktestResults: (results: BacktestResult | null) => void;

  // Current script being edited (lifted from RightSidebar so it can be
  // persisted as part of the conversation snapshot)
  currentScript: string;
  setCurrentScript: (script: string) => void;

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

  // ===== Agent Detail Panel — expand + interview =====
  expandedAgentId: string | null;
  setExpandedAgentId: (id: string | null) => void;

  // Per-agent interview history: agentId → array of { role, content, timestamp }
  agentInterviews: Record<string, Array<{ role: 'user' | 'agent'; content: string; timestamp: number }>>;
  addAgentInterviewMessage: (agentId: string, msg: { role: 'user' | 'agent'; content: string }) => void;
  clearAgentInterview: (agentId: string) => void;

  // Loading state for interview requests
  agentInterviewLoading: Set<string>;
  setAgentInterviewLoading: (agentId: string, loading: boolean) => void;
}

export const useStore = create<AppState>((set, get) => ({
  // ─── Conversations (persisted) ──────────────────────────────────────
  conversations: [],
  activeConversationId: null,
  loadingConversationIds: new Set(),

  setConversationLoading: (id, loading) => set((state) => {
    const next = new Set(state.loadingConversationIds);
    if (loading) next.add(id); else next.delete(id);
    return { loadingConversationIds: next };
  }),

  // Add a message to a specific conversation — even if the user has
  // switched away. If the conversation is currently active, the live
  // message arrays are updated normally. If it's a background conversation,
  // the message is written directly into the persisted snapshot.
  addMessageToConversation: (conversationId, msg) => {
    const state = get();
    const fullMsg: Message = {
      ...msg,
      id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `m_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
    };

    if (conversationId === state.activeConversationId) {
      // Active conversation — update live state normally
      return state.addMessage(msg);
    }

    // Background conversation — write directly into the snapshot
    const idx = state.conversations.findIndex((c) => c.id === conversationId);
    if (idx === -1) return fullMsg.id;
    const conv = state.conversations[idx];
    const updatedConv = {
      ...conv,
      patternMessages: [...(conv.patternMessages || []), fullMsg],
      updatedAt: Date.now(),
    };
    // Auto-derive title from first user message
    if ((updatedConv.title === 'New chat' || !updatedConv.title) && fullMsg.role === 'user') {
      updatedConv.title = fullMsg.content.slice(0, 60);
    }
    const conversations = [...state.conversations];
    conversations[idx] = updatedConv;
    set({ conversations });
    savePersistedConversations(conversations, state.activeConversationId);
    return fullMsg.id;
  },

  hydrateConversations: () => {
    const { conversations, activeId } = loadPersistedConversations();
    if (conversations.length === 0) {
      // First run — create a fresh conversation so the UI has something to show
      const fresh = makeNewConversation();
      set({ conversations: [fresh], activeConversationId: fresh.id });
      savePersistedConversations([fresh], fresh.id);
      return;
    }
    // Find the active (or default to most recent) and load its snapshot
    const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
    set({
      conversations,
      activeConversationId: active.id,
      patternMessages: active.patternMessages || [],
      strategyMessages: active.strategyMessages || [],
      messages: (active.appMode === 'building'
        ? (active.activeSkillIds.includes('strategy') && !active.activeSkillIds.includes('pattern')
            ? active.strategyMessages
            : active.patternMessages)
        : active.patternMessages) || [],
      appMode: active.appMode,
      strategyConfig: active.strategyConfig,
      backtestResults: active.backtestResults,
      patternMatches: active.patternMatches || [],
      activeDataset: active.activeDataset,
      activeSkillIds: new Set(active.activeSkillIds || []),
      activeMode: active.activeSkillIds?.[0] || 'general',
    });
    savePersistedConversations(conversations, active.id);
  },

  createConversation: () => {
    const state = get();
    // Snapshot current live state into the active conversation first
    const snapped = _snapshotLiveStateInto(state, state.activeConversationId);
    const fresh = makeNewConversation();
    const next = snapped ? [fresh, ...snapped] : [fresh, ...state.conversations];
    set({
      conversations: next,
      activeConversationId: fresh.id,
      // Reset live state to fresh defaults — completely clean session
      patternMessages: [],
      strategyMessages: [],
      messages: [],
      currentScript: '',
      patternMatches: [],
      strategyConfig: null,
      backtestResults: null,
      activeSkillIds: new Set(),
      activeMode: 'general',
      // Session isolation — fresh chart, datasets, debate, drawings
      chartData: [],
      activeDataset: null,
      datasets: [] as never,
      datasetChartData: {} as never,
      datasetRawData: {} as never,
      syncedDatasets: new Set() as never,
      selectedTimeframe: null,
      currentDebate: null as never,
      drawings: [] as never,
    });
    savePersistedConversations(next, fresh.id);
    return fresh.id;
  },

  switchConversation: (id) => {
    const state = get();
    if (id === state.activeConversationId) return;
    const target = state.conversations.find((c) => c.id === id);
    if (!target) return;
    // Snapshot current live state into the active conversation first
    const snapped = _snapshotLiveStateInto(state, state.activeConversationId);
    const conversations = snapped ?? state.conversations;
    set({
      conversations,
      activeConversationId: id,
      patternMessages: target.patternMessages || [],
      strategyMessages: target.strategyMessages || [],
      messages: target.activeSkillIds?.[0] === 'strategy' ? (target.strategyMessages || []) : (target.patternMessages || []),
      currentScript: target.currentScript || '',
      patternMatches: target.patternMatches || [],
      strategyConfig: target.strategyConfig,
      backtestResults: target.backtestResults,
      activeDataset: target.activeDataset,
      activeSkillIds: new Set(target.activeSkillIds || []),
      activeMode: target.activeSkillIds?.[0] || 'general',
      appMode: target.appMode,
      // Session isolation — restore chart, datasets, debate, drawings
      chartData: target.chartData || [],
      datasets: (target.datasets || []) as never,
      datasetChartData: (target.datasetChartData || {}) as never,
      selectedTimeframe: target.selectedTimeframe ?? null,
      currentDebate: (target.currentDebate ?? null) as never,
      drawings: (target.drawings || []) as never,
    });
    savePersistedConversations(conversations, id);
  },

  deleteConversation: (id) => {
    const state = get();
    const remaining = state.conversations.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      // Always keep at least one — create a fresh empty conversation
      const fresh = makeNewConversation();
      set({
        conversations: [fresh],
        activeConversationId: fresh.id,
        patternMessages: [],
        strategyMessages: [],
        messages: [],
        currentScript: '',
        patternMatches: [],
        strategyConfig: null,
        backtestResults: null,
        activeSkillIds: new Set(['pattern']),
        activeMode: 'pattern',
      });
      savePersistedConversations([fresh], fresh.id);
      return;
    }
    if (id === state.activeConversationId) {
      // Switch to the most recent remaining conversation
      const next = remaining[0];
      set({
        conversations: remaining,
        activeConversationId: next.id,
        patternMessages: next.patternMessages || [],
        strategyMessages: next.strategyMessages || [],
        messages: next.patternMessages || [],
        currentScript: next.currentScript || '',
        patternMatches: next.patternMatches || [],
        strategyConfig: next.strategyConfig,
        backtestResults: next.backtestResults,
        activeDataset: next.activeDataset,
        activeSkillIds: new Set(next.activeSkillIds || ['pattern']),
        activeMode: next.activeSkillIds?.[0] || 'pattern',
        appMode: next.appMode,
      });
      savePersistedConversations(remaining, next.id);
    } else {
      set({ conversations: remaining });
      savePersistedConversations(remaining, state.activeConversationId);
    }
  },

  renameConversation: (id, title) => {
    const state = get();
    const conversations = state.conversations.map((c) =>
      c.id === id ? { ...c, title: title.trim() || c.title, updatedAt: Date.now() } : c
    );
    set({ conversations });
    savePersistedConversations(conversations, state.activeConversationId);
  },

  // Mode
  activeMode: 'pattern',
  setMode: (mode) => set((state) => {
    const next = new Set(state.activeSkillIds);
    next.clear();
    next.add(mode);
    return {
      activeMode: mode,
      activeSkillIds: next,
      messages: mode === 'strategy' ? state.strategyMessages : state.patternMessages,
    };
  }),

  // Skill system
  skills: [],
  activeSkillIds: new Set(['pattern']),
  skillsLoaded: false,
  loadSkills: async () => {
    try {
      const { listSkills } = await import('@/lib/api');
      const skills = await listSkills();
      set({ skills, skillsLoaded: true });
      // eslint-disable-next-line no-console
      console.log(`[store] loaded ${skills.length} skills:`, skills.map(s => s.id));
    } catch (err) {
      console.warn('[store] failed to load skills:', err);
      set({ skillsLoaded: true });
    }
  },
  setActiveSkills: (ids) => set((state) => {
    // Empty set is allowed: the chat falls through to the backend's general
    // handler (no skill dispatch, no tool_calls, just free-form LLM chat).
    const primary = Array.from(ids)[0] || 'general';
    return {
      activeSkillIds: ids,
      activeMode: primary,
      messages: primary === 'strategy' ? state.strategyMessages : state.patternMessages,
    };
  }),

  // Datasets
  datasets: [],
  activeDataset: null,
  datasetChartData: {},
  datasetRawData: {},
  syncedDatasets: new Set(),
  addDataset: (dataset, chartData, rawData) => {
    set((state) => ({
      datasets: [...state.datasets, dataset],
      datasetChartData: { ...state.datasetChartData, [dataset.id]: chartData },
      datasetRawData: { ...state.datasetRawData, [dataset.id]: rawData },
      activeDataset: dataset.id,
      chartData,
    }));
    // Snapshot so chart data persists across conversation switches
    const s = get();
    const snapped = _snapshotLiveStateInto(s, s.activeConversationId);
    if (snapped) set({ conversations: snapped });
  },
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
  addMessage: (message) => {
    const newId = crypto.randomUUID();
    set((state) => {
      const newMsg = { ...message, id: newId, timestamp: new Date().toISOString() };
      const isStrategy = state.activeMode === 'strategy';
      const patternMessages = isStrategy ? state.patternMessages : [...state.patternMessages, newMsg];
      const strategyMessages = isStrategy ? [...state.strategyMessages, newMsg] : state.strategyMessages;
      const messages = isStrategy ? strategyMessages : patternMessages;
      const next = { ...state, patternMessages, strategyMessages, messages };
      const conversations = _snapshotLiveStateInto(next, state.activeConversationId);
      return conversations
        ? { patternMessages, strategyMessages, messages, conversations }
        : { patternMessages, strategyMessages, messages };
    });
    return newId;
  },
  updateMessage: (id, patch) =>
    set((state) => {
      const apply = (msgs: Message[]) => msgs.map((m) => (m.id === id ? { ...m, ...patch } : m));
      const patternMessages = apply(state.patternMessages);
      const strategyMessages = apply(state.strategyMessages);
      const isStrategy = state.activeMode === 'strategy';
      const messages = isStrategy ? strategyMessages : patternMessages;
      const next = { ...state, patternMessages, strategyMessages, messages };
      const conversations = _snapshotLiveStateInto(next, state.activeConversationId);
      return conversations
        ? { patternMessages, strategyMessages, messages, conversations }
        : { patternMessages, strategyMessages, messages };
    }),

  // Backtest
  backtestResults: null,
  setBacktestResults: (results) => set((state) => {
    const next = { ...state, backtestResults: results };
    const conversations = _snapshotLiveStateInto(next, state.activeConversationId);
    return conversations ? { backtestResults: results, conversations } : { backtestResults: results };
  }),

  // Current script (lifted from RightSidebar for persistence)
  currentScript: '',
  setCurrentScript: (script) => set((state) => {
    const next = { ...state, currentScript: script };
    const conversations = _snapshotLiveStateInto(next, state.activeConversationId);
    return conversations ? { currentScript: script, conversations } : { currentScript: script };
  }),

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
  setPatternMatches: (matches) => set((state) => {
    const next = { ...state, patternMatches: matches };
    const conversations = _snapshotLiveStateInto(next, state.activeConversationId);
    return conversations ? { patternMatches: matches, conversations } : { patternMatches: matches };
  }),
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
  setStrategyConfig: (config) => set((state) => {
    const next = { ...state, strategyConfig: config };
    const conversations = _snapshotLiveStateInto(next, state.activeConversationId);
    return conversations ? { strategyConfig: config, conversations } : { strategyConfig: config };
  }),

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
      // Snapshot the appMode change into the active conversation so it sticks
      const merged = { ...s, ...next };
      const conversations = _snapshotLiveStateInto(merged, s.activeConversationId);
      if (conversations) next.conversations = conversations;
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

    // Auto-sync dataset to backend if not already synced
    if (!state.syncedDatasets.has(activeId)) {
      try {
        const rawData = state.datasetRawData[activeId] || state.datasetChartData[activeId];
        if (rawData && rawData.length > 0) {
          const { syncDatasetToBackend } = await import("@/lib/api");
          await syncDatasetToBackend(activeId, rawData, {
            rows: rawData.length,
            startDate: ds?.metadata?.startDate || "",
            endDate: ds?.metadata?.endDate || "",
            filename: ds?.name || "dataset",
          });
          state.markSynced(activeId);
        }
      } catch (syncErr) {
        console.warn("Dataset sync failed:", syncErr);
        // Continue anyway — the debate endpoint will return 404 if sync truly failed
      }
    }

    const initial: import("@/types").SimulationDebate = {
      id: debateId,
      datasetId: activeId,
      symbol,
      assetClass: "",
      assetName: symbol,
      entities: [],
      thread: [],
      currentRound: 0,
      totalRounds: 5,
      summary: null,
      status: "classifying",
    };

    set({ currentDebate: initial, simulationLoading: true });

    try {
      const { runSimulationDebate } = await import("@/lib/api");
      const report = useStore.getState().simulationReport;

      // The entire pipeline (classify → generate entities → 8 rounds of debate → summary)
      // runs as one API call and takes ~60-120 seconds. Show a progress message.
      set((s) => ({ currentDebate: s.currentDebate ? { ...s.currentDebate, status: "discussing" as const } : null }));

      const resp = await runSimulationDebate(activeId, 500, report);

      // Update: show entities
      const assetInfo = resp.asset_info || {};
      set((s) => ({
        currentDebate: s.currentDebate ? {
          ...s.currentDebate,
          status: "generating_entities" as const,
          assetClass: assetInfo.asset_class || "",
          assetName: assetInfo.asset_name || symbol,
          entities: resp.entities.map((e) => ({
            id: e.id, name: e.name, role: e.role,
            background: e.background, bias: e.bias, personality: e.personality,
          })),
        } : null,
      }));
      await new Promise((r) => setTimeout(r, 400));

      // Stream thread messages round by round
      const totalRounds = resp.total_rounds || 5;
      for (let round = 1; round <= totalRounds; round++) {
        const roundMsgs = resp.thread.filter((m) => m.round === round);
        if (roundMsgs.length === 0) continue;

        set((s) => ({
          currentDebate: s.currentDebate ? { ...s.currentDebate, status: "discussing" as const, currentRound: round } : null,
        }));

        // Reveal each message in the round with a small delay
        for (const msg of roundMsgs) {
          set((s) => ({
            currentDebate: s.currentDebate ? {
              ...s.currentDebate,
              thread: [...s.currentDebate.thread, {
                id: msg.id,
                round: msg.round,
                entityId: msg.entity_id,
                entityName: msg.entity_name,
                entityRole: msg.entity_role,
                content: msg.content,
                sentiment: msg.sentiment,
                pricePrediction: msg.price_prediction,
                agreedWith: msg.agreed_with || [],
                disagreedWith: msg.disagreed_with || [],
                isChartSupport: msg.is_chart_support || false,
              }],
            } : null,
          }));
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      // Summarizing
      set((s) => ({
        currentDebate: s.currentDebate ? { ...s.currentDebate, status: "summarizing" as const } : null,
      }));
      await new Promise((r) => setTimeout(r, 300));

      // Final state
      const sum = resp.summary;
      set((s) => ({
        currentDebate: s.currentDebate ? {
          ...s.currentDebate,
          status: "complete" as const,
          summary: {
            consensusDirection: (sum.consensus_direction || "NEUTRAL") as import("@/types").SimulationSummary["consensusDirection"],
            confidence: sum.confidence || 0.5,
            keyArguments: sum.key_arguments || [],
            dissentingViews: sum.dissenting_views || [],
            priceTargets: sum.price_targets || { low: 0, mid: 0, high: 0 },
            riskFactors: sum.risk_factors || [],
            recommendation: {
              action: (sum.recommendation as any)?.action || "HOLD",
              entry: (sum.recommendation as any)?.entry,
              stop: (sum.recommendation as any)?.stop,
              target: (sum.recommendation as any)?.target,
              position_size_pct: (sum.recommendation as any)?.position_size_pct,
            },
          },
          totalRounds: resp.total_rounds,
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

  setCurrentDebate: (d) => {
    set({ currentDebate: d });
    // Snapshot so debate data persists across conversation switches
    const s = get();
    const snapped = _snapshotLiveStateInto(s, s.activeConversationId);
    if (snapped) set({ conversations: snapped });
  },
  resetSimulation: () => set({ currentDebate: null, simulationLoading: false }),

  // ===== Agent Detail Panel =====
  expandedAgentId: null,
  setExpandedAgentId: (id) => set({ expandedAgentId: id }),

  agentInterviews: {},
  addAgentInterviewMessage: (agentId, msg) => set((s) => ({
    agentInterviews: {
      ...s.agentInterviews,
      [agentId]: [...(s.agentInterviews[agentId] || []), { ...msg, timestamp: Date.now() }],
    },
  })),
  clearAgentInterview: (agentId) => set((s) => {
    const { [agentId]: _removed, ...rest } = s.agentInterviews;
    return { agentInterviews: rest };
  }),

  agentInterviewLoading: new Set(),
  setAgentInterviewLoading: (agentId, loading) => set((s) => {
    const next = new Set(s.agentInterviewLoading);
    if (loading) next.add(agentId); else next.delete(agentId);
    return { agentInterviewLoading: next };
  }),
}));

