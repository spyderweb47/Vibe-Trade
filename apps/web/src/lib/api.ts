import type {
  OHLCBar,
  PatternMatch,
  BacktestResult,
} from '@/types';

// In dev mode (npm run dev), NEXT_PUBLIC_API_URL points to the separate
// FastAPI backend process (e.g. http://localhost:8001). In production /
// static-export mode (vibe-trade serve), the frontend and API are served
// from the SAME origin, so we use '' (relative URLs like /skills, /chat).
const BASE_URL = process.env.NEXT_PUBLIC_API_URL || '';

async function request<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    // Backend uses HTTPException(detail=...). For the debate endpoint the
    // detail is a structured object { error, message, events? }; for older
    // endpoints it's a plain string. Try to parse JSON first so the user
    // gets the friendly `message` plus any accumulated events, and fall
    // back to the raw text if parsing fails.
    const raw = await res.text();
    let friendly = raw;
    let events: unknown[] | undefined;
    try {
      const parsed = JSON.parse(raw) as { detail?: unknown };
      const detail = parsed.detail;
      if (typeof detail === "string") {
        friendly = detail;
      } else if (detail && typeof detail === "object") {
        const d = detail as { message?: unknown; error?: unknown; events?: unknown };
        friendly = String(d.message || d.error || raw);
        if (Array.isArray(d.events)) events = d.events;
      }
    } catch {
      // not JSON — keep raw text
    }
    const err = new Error(`API error ${res.status}: ${friendly}`);
    if (events) (err as Error & { events?: unknown[] }).events = events;
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  return res.json();
}

// Sync dataset to backend (lazy — only when pattern/backtest features need it)
export async function syncDatasetToBackend(
  datasetId: string,
  rawData: OHLCBar[],
  metadata: { rows: number; startDate: string; endDate: string; filename: string }
): Promise<void> {
  await request('/sync-dataset', {
    method: 'POST',
    body: JSON.stringify({ dataset_id: datasetId, data: rawData, metadata }),
  });
}

// ─── Skill system ──────────────────────────────────────────────────────────

/**
 * A tool call emitted by a skill handler. The frontend tool registry
 * (`apps/web/src/lib/toolRegistry.ts`) executes these in order, enforcing
 * the skill's declared tool allowlist.
 */
export interface ToolCall {
  tool: string;
  value?: unknown;
  target?: string;
  data?: unknown;
}

export interface SkillMetadata {
  id: string;
  name: string;
  tagline: string;
  description: string;
  version: string;
  author: string;
  category: string;
  icon: string;
  color: string;
  tools: string[];
  output_tabs: { id: string; label: string; component: string }[];
  store_slots: string[];
  input_hints: { placeholder: string; supports_fingerprint: boolean };
}

/**
 * Fetch all skills registered by the backend SkillRegistry.
 * The frontend uses this to render the skill chip row + bottom-panel tabs
 * entirely from server metadata — no hard-coded skill lists on either side.
 */
export async function listSkills(): Promise<SkillMetadata[]> {
  return request('/skills');
}

export interface ToolDef {
  id: string;
  name: string;
  category: string;
  description: string;
  input_schema: Record<string, unknown>;
  arg_style: "value" | "object";
}

/**
 * Fetch the full tool catalog. Skills declare tool ids from this catalog in
 * their SKILL.md; the frontend tool registry uses the catalog as a lookup
 * for display names and argument shapes.
 */
export async function listTools(): Promise<ToolDef[]> {
  return request('/tools');
}

// ─── Planner ──────────────────────────────────────────────────────────────

export interface PlanStep {
  skill: string;
  message: string;
  rationale: string;
  context: Record<string, unknown>;
}

export interface PlanResult {
  steps: PlanStep[];
  is_multi_step: boolean;
}

/**
 * Ask the backend to decompose a message into an execution plan WITHOUT
 * running it. The frontend uses the returned plan to orchestrate execution
 * step-by-step, capturing real script results between steps.
 *
 * @param availableSkills — if provided and non-empty, restricts the planner
 *   to ONLY these skill ids. Honors the user's explicit chip selection so
 *   the planner can't emit steps for skills the user deselected.
 */
export async function getPlan(
  message: string,
  context?: Record<string, unknown>,
  availableSkills?: string[],
): Promise<PlanResult> {
  return request('/plan', {
    method: 'POST',
    body: JSON.stringify({
      message,
      context: context || {},
      available_skills: availableSkills || [],
    }),
  });
}

// ─── Market data fetching ─────────────────────────────────────────────────

export interface FetchedDataset {
  symbol: string;
  source: string;       // e.g. "yfinance" or "ccxt:binance"
  interval: string;     // native timeframe ("1h", "1d", ...)
  bars: OHLCBar[];
  metadata: {
    rows: number;
    startDate: string;
    endDate: string;
    symbol: string;
    nativeTimeframe: string;
  };
}

export interface FetchMarketDataParams {
  symbol: string;
  source?: 'auto' | 'yfinance' | 'ccxt';
  interval?: string;     // 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1mo
  limit?: number;        // approximate bar count (max 5000)
  exchange?: string;     // ccxt exchange (binance, coinbase, kraken, okx, ...)
}

/**
 * Fetch historical OHLCV bars from yfinance (stocks/ETFs) or ccxt (crypto).
 * No API key required — both providers serve public data freely. Auto-detects
 * the right provider from the symbol shape if `source === 'auto'`.
 */
export async function fetchMarketData(params: FetchMarketDataParams): Promise<FetchedDataset> {
  return request('/fetch-data', {
    method: 'POST',
    body: JSON.stringify({
      symbol: params.symbol,
      source: params.source || 'auto',
      interval: params.interval || '1d',
      limit: params.limit ?? 1000,
      exchange: params.exchange || 'binance',
    }),
  });
}

// ─── Chat ──────────────────────────────────────────────────────────────────

export interface ChatResponse {
  reply: string;
  script?: string | null;
  script_type?: "pattern" | "indicator" | "strategy" | null;
  data?: Record<string, unknown> | null;
  tool_calls?: ToolCall[];
}

export async function sendChat(
  message: string,
  mode: string,
  context?: Record<string, unknown>
): Promise<ChatResponse> {
  return request('/chat', {
    method: 'POST',
    body: JSON.stringify({ message, mode, context: context || {} }),
  });
}

// Social simulation debate
export interface DebateEntity {
  id: string;
  name: string;
  role: string;
  background: string;
  bias: string;
  personality: string;
}

export interface DebateMessage {
  id: string;
  round: number;
  entity_id: string;
  entity_name: string;
  entity_role: string;
  content: string;
  sentiment: number;
  price_prediction?: number | null;
  agreed_with: string[];
  disagreed_with: string[];
  is_chart_support: boolean;
}

export interface DebateSummary {
  consensus_direction: string;
  confidence: number;
  key_arguments: string[];
  dissenting_views: string[];
  price_targets: { low: number; mid: number; high: number };
  risk_factors: string[];
  recommendation: Record<string, unknown>;
}

export interface DebateResult {
  debate_id: string;
  asset_info: { asset_class: string; asset_name: string; description: string; price_drivers: string[] };
  entities: DebateEntity[];
  thread: DebateMessage[];
  total_rounds: number;
  summary: DebateSummary;
  bars_analyzed: number;
  symbol: string;
}

export async function runSimulationDebate(
  datasetId: string,
  barsCount: number = 100,
  context: string = '',
): Promise<DebateResult> {
  return request('/debate', {
    method: 'POST',
    body: JSON.stringify({ dataset_id: datasetId, bars_count: barsCount, context }),
  });
}

// ─── Error Handler Agent — fix a broken pattern/strategy script ──────────
//
// Called automatically when the Web Worker throws while running a
// generated script. The backend ErrorHandlerAgent diagnoses the error
// + returns a fixed version; the caller re-runs with the fix and
// shows the outcome in the trace UI.
//
// Response shape: `fixed_script` is empty and `error` is non-null
// when the fixer itself failed (LLM unavailable, parse error, etc.).
// Callers should check `error` before using `fixed_script`.

export interface FixScriptResponse {
  fixed_script: string;
  explanation: string;
  confidence: number;
  changes: string[];
  error: string | null;
}

export async function fixScript(params: {
  script: string;
  error: string;
  intent?: string;
  script_type?: 'pattern' | 'strategy' | 'indicator';
}): Promise<FixScriptResponse> {
  return request<FixScriptResponse>('/fix-script', {
    method: 'POST',
    body: JSON.stringify({
      script: params.script,
      error: params.error,
      intent: params.intent || '',
      script_type: params.script_type || 'pattern',
    }),
  });
}

// ─── Agent Interview ───────────────────────────────────────────────────

export interface InterviewRequest {
  agent_id: string;
  agent_name: string;
  agent_role: string;
  agent_background?: string;
  agent_bias?: string;
  agent_personality?: string;
  asset_name?: string;
  asset_class?: string;
  previous_positions?: string[];
  question: string;
  interview_history?: Array<{ role: string; content: string }>;
}

export interface InterviewResponse {
  agent_id: string;
  response: string;
  sentiment: number;
}

/** Ask a debate agent a follow-up question after the debate completes. */
export async function interviewAgent(params: InterviewRequest): Promise<InterviewResponse> {
  return request('/interview', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Check if LLM is available
export async function getChatStatus(): Promise<{ llm_available: boolean; mode: string }> {
  return request('/chat/status');
}

// Generate pattern detection code from description
export async function generatePattern(
  description: string,
  datasetId?: string
): Promise<{ code: string; explanation: string }> {
  return request('/generate-pattern', {
    method: 'POST',
    body: JSON.stringify({ hypothesis: description, dataset_id: datasetId }),
  });
}

// Run pattern detection on dataset
export async function runPattern(
  code: string,
  datasetId: string
): Promise<{ matches: PatternMatch[] }> {
  return request('/run-pattern', {
    method: 'POST',
    body: JSON.stringify({ script: code, dataset_id: datasetId }),
  });
}

// Generate trading strategy from description
export async function generateStrategy(
  description: string,
  datasetId?: string
): Promise<{ code: string; explanation: string }> {
  return request('/generate-strategy', {
    method: 'POST',
    body: JSON.stringify({ pattern_script: description, intent: description, dataset_id: datasetId }),
  });
}

// Run backtest
export async function runBacktest(
  strategyCode: string,
  datasetId: string,
  params?: Record<string, unknown>
): Promise<BacktestResult> {
  return request('/run-backtest', {
    method: 'POST',
    body: JSON.stringify({
      strategy: { script: strategyCode },
      dataset_id: datasetId,
      params,
    }),
  });
}

// Analyze dataset
export async function analyze(
  datasetId: string,
  analyses: string[]
): Promise<{ dataset_id: string; results: Record<string, unknown> }> {
  return request('/analyze', {
    method: 'POST',
    body: JSON.stringify({ dataset_id: datasetId, analyses }),
  });
}
