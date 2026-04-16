"use client";

import { useStore } from "@/store/useStore";

/**
 * Single KPI metric tile — shows a big number with label, change
 * indicator, and optional sparkline-style trend. Designed for mosaic
 * layout as a small tile filling dashboard gaps.
 *
 * Usage in tile registry: { kind: 'metric', metricId: 'price' }
 */

export interface MetricConfig {
  id: string;
  label: string;
  getValue: () => { value: string; change?: string; changePercent?: string; direction?: "up" | "down" | "flat" };
}

// ─── Built-in metrics ──────────────────────────────────────────────────

function getLastPrice(): { value: string; change?: string; changePercent?: string; direction?: "up" | "down" | "flat" } {
  const data = useStore.getState().chartData;
  if (!data || data.length < 2) return { value: "—", direction: "flat" };
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const price = last.close;
  const diff = price - prev.close;
  const pct = (diff / prev.close) * 100;
  return {
    value: price >= 1000 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toFixed(4)}`,
    change: `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}`,
    changePercent: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
    direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
  };
}

function getDayRange(): { value: string; direction?: "up" | "down" | "flat" } {
  const data = useStore.getState().chartData;
  if (!data || data.length === 0) return { value: "—" };
  const last = data[data.length - 1];
  return { value: `${last.low.toFixed(2)} — ${last.high.toFixed(2)}`, direction: "flat" };
}

function getVolume(): { value: string; direction?: "up" | "down" | "flat" } {
  const data = useStore.getState().chartData;
  if (!data || data.length < 2) return { value: "—" };
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const vol = last.volume || 0;
  const prevVol = prev.volume || 1;
  const fmt = vol >= 1e9 ? `${(vol / 1e9).toFixed(1)}B` : vol >= 1e6 ? `${(vol / 1e6).toFixed(1)}M` : vol >= 1e3 ? `${(vol / 1e3).toFixed(1)}K` : String(vol);
  return { value: fmt, direction: vol > prevVol ? "up" : vol < prevVol ? "down" : "flat" };
}

function getBarCount(): { value: string; direction?: "up" | "down" | "flat" } {
  const data = useStore.getState().chartData;
  return { value: String(data?.length || 0), direction: "flat" };
}

function getBacktestPnl(): { value: string; change?: string; changePercent?: string; direction?: "up" | "down" | "flat" } {
  const bt = useStore.getState().backtestResults;
  if (!bt) return { value: "—", direction: "flat" };
  const ret = (bt.totalReturn * 100);
  return {
    value: `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`,
    changePercent: `${bt.totalTrades} trades`,
    direction: ret > 0 ? "up" : ret < 0 ? "down" : "flat",
  };
}

function getWinRate(): { value: string; direction?: "up" | "down" | "flat" } {
  const bt = useStore.getState().backtestResults;
  if (!bt) return { value: "—", direction: "flat" };
  const wr = bt.winRate * 100;
  return { value: `${wr.toFixed(1)}%`, direction: wr >= 50 ? "up" : "down" };
}

function getSwarmConsensus(): { value: string; change?: string; direction?: "up" | "down" | "flat" } {
  const debate = useStore.getState().currentDebate;
  if (!debate?.summary) return { value: "—", direction: "flat" };
  const dir = debate.summary.consensusDirection;
  return {
    value: dir,
    change: `${debate.summary.confidence}%`,
    direction: dir === "BULLISH" ? "up" : dir === "BEARISH" ? "down" : "flat",
  };
}

export const BUILT_IN_METRICS: Record<string, MetricConfig> = {
  price: { id: "price", label: "Last Price", getValue: getLastPrice },
  day_range: { id: "day_range", label: "Day Range", getValue: getDayRange },
  volume: { id: "volume", label: "Volume", getValue: getVolume },
  bars: { id: "bars", label: "Bars Loaded", getValue: getBarCount },
  backtest_pnl: { id: "backtest_pnl", label: "Backtest P/L", getValue: getBacktestPnl },
  win_rate: { id: "win_rate", label: "Win Rate", getValue: getWinRate },
  swarm_consensus: { id: "swarm_consensus", label: "Swarm Consensus", getValue: getSwarmConsensus },
};

// ─── Component ─────────────────────────────────────────────────────────

interface MetricWidgetProps {
  metricId: string;
}

export function MetricWidget({ metricId }: MetricWidgetProps) {
  const config = BUILT_IN_METRICS[metricId];

  // Subscribe to relevant store slices so the metric re-renders
  const chartData = useStore((s) => s.chartData);
  const backtestResults = useStore((s) => s.backtestResults);
  const currentDebate = useStore((s) => s.currentDebate);
  // Suppress unused warnings — these trigger re-renders
  void chartData; void backtestResults; void currentDebate;

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center p-3" style={{ color: "var(--text-muted)" }}>
        <span className="text-[10px]">Unknown metric: {metricId}</span>
      </div>
    );
  }

  const { value, change, changePercent, direction } = config.getValue();
  const color = direction === "up" ? "#22c55e" : direction === "down" ? "#ef4444" : "var(--text-secondary)";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "";

  return (
    <div className="flex flex-col justify-center h-full px-4 py-3">
      {/* Label */}
      <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {config.label}
      </div>

      {/* Big value */}
      <div className="mt-1 text-xl font-black tabular-nums leading-none" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>

      {/* Change line */}
      {(change || changePercent) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] font-semibold" style={{ color }}>
          {arrow && <span className="text-[9px]">{arrow}</span>}
          {change && <span>{change}</span>}
          {changePercent && <span style={{ opacity: 0.8 }}>{changePercent}</span>}
        </div>
      )}
    </div>
  );
}
