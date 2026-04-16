"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useStore } from "@/store/useStore";
import { PineScriptPanel } from "./PineScriptPanel";
import { PortfolioAnalysis } from "./PortfolioAnalysis";
import { TradeList } from "./TradeList";
import { PositionsTab } from "./playground/PositionsTab";
import { OrdersTab } from "./playground/OrdersTab";
import { TradeHistoryTab } from "./playground/TradeHistoryTab";
import { WalletTab } from "./playground/WalletTab";
import { DAGGraphTab } from "./tabs/DAGGraphTab";
import { PersonalitiesTab } from "./tabs/PersonalitiesTab";
import { DebateThreadTab } from "./tabs/DebateThreadTab";
import { RunStatsTab } from "./tabs/RunStatsTab";

/**
 * Bottom-panel component registry.
 *
 * Each skill's SKILL.md declares `output_tabs`, where each tab specifies
 * a `component` string. That string is looked up here. To add a new tab
 * component, import it and add an entry to this map, then reference it
 * from a skill's frontmatter.
 */
export const BOTTOM_PANEL_COMPONENTS: Record<string, React.ComponentType> = {
  PatternContent: () => <PatternContent />,
  PortfolioAnalysis,
  TradeList,
  PineScriptPanel,
  DAGGraphTab,
  PersonalitiesTab,
  DebateThreadTab,
  RunStatsTab,
};

const PLAYGROUND_TABS = ["Positions", "Open Orders", "Trade History", "Wallet"];

interface TabDef {
  id: string;
  label: string;
  component: string;
}

/**
 * Aggregate output_tabs from all active skills, deduping by id. Preserves
 * the order the skills were activated in, with tabs from the first skill
 * appearing first.
 */
function computeSkillTabs(
  skills: ReturnType<typeof useStore.getState>["skills"],
  activeSkillIds: Set<string>
): TabDef[] {
  const seen = new Set<string>();
  const result: TabDef[] = [];
  for (const id of activeSkillIds) {
    const skill = skills.find((s) => s.id === id);
    if (!skill) continue;
    for (const tab of skill.output_tabs || []) {
      if (seen.has(tab.id)) continue;
      seen.add(tab.id);
      result.push(tab);
    }
  }
  return result;
}

export function BottomPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(256);
  const [activeTab, setActiveTab] = useState(0);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);
  const appMode = useStore((s) => s.appMode);
  const skills = useStore((s) => s.skills);
  const activeSkillIds = useStore((s) => s.activeSkillIds);
  const poppedOutTabs = useStore((s) => s.poppedOutTabs);
  const popOutTab = useStore((s) => s.popOutTab);

  // Dynamic skill-contributed tabs for building mode
  const skillTabs = React.useMemo(
    () => computeSkillTabs(skills, activeSkillIds),
    [skills, activeSkillIds]
  );

  // Labels to render on the tab bar (string[] for playground,
  // TabDef[] for building mode — simulation tabs come from the skill now)
  const isBuilding = appMode === "building";
  const tabLabels =
    appMode === "playground"
      ? PLAYGROUND_TABS
      : skillTabs.map((t) => t.label);

  // Reset active tab when mode or skill set changes to avoid out-of-range index
  useEffect(() => {
    setActiveTab(0);
  }, [appMode, activeSkillIds]);

  // Allow tool executor to activate a tab by id
  const pendingBottomPanelTab = useStore((s) => (s as unknown as Record<string, unknown>).pendingBottomPanelTab as string | undefined);
  useEffect(() => {
    if (!pendingBottomPanelTab || !isBuilding) return;
    const idx = skillTabs.findIndex((t) => t.id === pendingBottomPanelTab);
    if (idx >= 0) {
      setActiveTab(idx);
      setCollapsed(false);
      useStore.setState({ pendingBottomPanelTab: undefined } as Record<string, unknown>);
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
  }, [pendingBottomPanelTab, isBuilding, skillTabs]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartH.current = height;

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const dy = dragStartY.current - ev.clientY;
      const newH = Math.max(100, Math.min(600, dragStartH.current + dy));
      setHeight(newH);
      window.dispatchEvent(new Event("resize"));
    };
    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [height]);

  return (
    <div
      className="flex flex-col shrink-0"
      style={{ height: collapsed ? 32 : height, borderTop: "1px solid var(--border)", background: "var(--surface)" }}
    >
      {/* Resize handle */}
      {!collapsed && (
        <div
          onMouseDown={onResizeStart}
          className="h-1 cursor-ns-resize hover:bg-[var(--accent)] transition-colors shrink-0"
          style={{ marginTop: -2 }}
        />
      )}
      {/* Tab bar + collapse toggle */}
      <div className="flex h-8 shrink-0 items-center px-1" style={{ borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-2)" }}>
        {tabLabels.length === 0 && isBuilding && (
          <span className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
            No skill selected — add one from the chatbox to see output tabs
          </span>
        )}
        {tabLabels.map((tab, i) => {
          const skillTab = isBuilding ? skillTabs[i] : undefined;
          const isPopped = skillTab ? poppedOutTabs.has(skillTab.id) : false;
          if (isPopped) return null; // Hide tabs that are popped out as mosaic tiles
          return (
            <div key={tab} className="flex items-center">
              <button
                onClick={() => {
                  setActiveTab(i);
                  if (collapsed) {
                    setCollapsed(false);
                    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
                  }
                }}
                className={`px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  activeTab === i && !collapsed
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {tab}
              </button>
              {/* Pop-out button — available for skill tabs in building mode */}
              {skillTab && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    popOutTab(skillTab.id, skillTab.component, skillTab.label);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:!opacity-100 transition-opacity"
                  style={{ color: "var(--text-muted)" }}
                  title={`Pop out ${skillTab.label}`}
                >
                  <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M17 7H7M17 7V17" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}

        <div className="flex-1" />

        {/* Collapse / expand */}
        <button
          onClick={() => {
            setCollapsed(!collapsed);
            // Trigger resize so the chart recalculates its dimensions
            requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        >
          <svg
            className={`h-3.5 w-3.5 transition-transform ${collapsed ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 overflow-auto">
          {appMode === "playground" ? (
            activeTab === 0 ? <PositionsTab /> :
            activeTab === 1 ? <OrdersTab /> :
            activeTab === 2 ? <TradeHistoryTab /> :
            activeTab === 3 ? <WalletTab /> : null
          ) : (
            (() => {
              const tab = skillTabs[activeTab];
              if (!tab) return null;
              const Cmp = BOTTOM_PANEL_COMPONENTS[tab.component];
              if (!Cmp) {
                return (
                  <div className="p-3 text-xs" style={{ color: "var(--text-tertiary)" }}>
                    Unknown tab component: <code>{tab.component}</code>.
                    Register it in <code>BOTTOM_PANEL_COMPONENTS</code>.
                  </div>
                );
              }
              return <Cmp />;
            })()
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Simulation Debate Log ─── */

function SimulationDebateLog() {
  const debate = useStore((s) => s.currentDebate);
  const history = useStore((s) => s.debateHistory);

  if (!debate && history.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>
        Run a committee debate to see the log
      </div>
    );
  }

  // Deduplicate: current debate might already be in history
  const all = debate
    ? [debate, ...history.filter((h) => h.id !== debate.id)]
    : history;

  return (
    <div className="overflow-auto h-full p-3 space-y-2">
      {all.map((d) => {
        const sum = d.summary;
        const dir = sum?.consensusDirection;
        const dirColor = dir === "BULLISH" ? "#00d68f" : dir === "BEARISH" ? "#ff4d4d" : "var(--text-tertiary)";
        return (
          <div
            key={d.id}
            className="rounded-md p-2"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
          >
            <div className="flex items-center gap-2 text-[10px]">
              <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{d.assetName || d.symbol}</span>
              <span style={{ color: "var(--text-muted)" }}>{d.entities.length} entities, {d.thread.length} msgs</span>
              {sum && (
                <span className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase" style={{ background: `${dirColor}22`, color: dirColor }}>
                  {dir} {Math.round(sum.confidence * 100)}%
                </span>
              )}
              <span className="ml-auto text-[8px]" style={{ color: "var(--text-muted)" }}>
                {d.status}
              </span>
            </div>
            {sum?.keyArguments?.[0] && (
              <p className="mt-1 text-[9px] leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
                {sum.keyArguments[0]}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Backtest ─── */

function BacktestContent({
  tab,
  results,
  expandedTrade,
  setExpandedTrade,
}: {
  tab: number;
  results: ReturnType<typeof useStore.getState>["backtestResults"];
  expandedTrade: string | null;
  setExpandedTrade: (id: string | null) => void;
}) {
  if (!results) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--text-tertiary)]">
        Run a backtest to see results
      </div>
    );
  }

  if (tab === 1) {
    // Report tab
    const metrics = [
      { label: "Total Trades", value: results.totalTrades },
      { label: "Win Rate", value: `${(results.winRate * 100).toFixed(1)}%` },
      { label: "Profit Factor", value: results.profitFactor.toFixed(2) },
      { label: "Sharpe Ratio", value: results.sharpeRatio.toFixed(2) },
      {
        label: "Max Drawdown",
        value: `${(results.maxDrawdown * 100).toFixed(1)}%`,
        negative: true,
      },
      {
        label: "Total Return",
        value: `${(results.totalReturn * 100).toFixed(1)}%`,
        positive: results.totalReturn > 0,
      },
      {
        label: "Annualized Return",
        value: `${(results.annualizedReturn * 100).toFixed(1)}%`,
        positive: results.annualizedReturn > 0,
      },
    ];

    return (
      <div className="p-3">
        <div className="grid grid-cols-4 gap-2">
          {metrics.map((m) => (
            <div key={m.label} className="rounded border border-[var(--border-subtle)] p-2">
              <div className="text-[10px] text-[var(--text-tertiary)] uppercase">{m.label}</div>
              <div
                className={`text-sm font-semibold ${
                  "positive" in m && m.positive
                    ? "text-emerald-600"
                    : "negative" in m && m.negative
                      ? "text-red-500"
                      : "text-[var(--text-primary)]"
                }`}
              >
                {m.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Trade History tab (default)
  return (
    <div className="p-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase text-[var(--text-tertiary)]">
            <th className="py-1.5 pr-3 font-semibold">Entry Time</th>
            <th className="py-1.5 pr-3 font-semibold">Exit Time</th>
            <th className="py-1.5 pr-3 font-semibold">Side</th>
            <th className="py-1.5 pr-3 font-semibold">Entry</th>
            <th className="py-1.5 pr-3 font-semibold">Exit</th>
            <th className="py-1.5 pr-3 font-semibold">Qty</th>
            <th className="py-1.5 pr-3 text-right font-semibold">PnL</th>
            <th className="py-1.5 text-right font-semibold">PnL %</th>
          </tr>
        </thead>
        <tbody>
          {results.trades.map((trade) => (
            <React.Fragment key={trade.id}>
              <tr
                onClick={() =>
                  setExpandedTrade(expandedTrade === trade.id ? null : trade.id)
                }
                className="cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--surface-2)]"
              >
                <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{trade.entryTime}</td>
                <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{trade.exitTime}</td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      trade.direction === "long"
                        ? "bg-emerald-50 text-emerald-600"
                        : "bg-red-50 text-red-500"
                    }`}
                  >
                    {trade.direction.toUpperCase()}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-[var(--text-primary)] font-medium">
                  {trade.entryPrice.toFixed(2)}
                </td>
                <td className="py-1.5 pr-3 text-[var(--text-primary)] font-medium">
                  {trade.exitPrice.toFixed(2)}
                </td>
                <td className="py-1.5 pr-3 text-[var(--text-secondary)]">
                  {trade.quantity}
                </td>
                <td
                  className={`py-1.5 pr-3 text-right font-semibold ${
                    trade.pnl >= 0 ? "text-emerald-600" : "text-red-500"
                  }`}
                >
                  {trade.pnl >= 0 ? "+" : ""}
                  {trade.pnl.toFixed(2)}
                </td>
                <td
                  className={`py-1.5 text-right ${
                    trade.pnlPercent >= 0 ? "text-emerald-600" : "text-red-500"
                  }`}
                >
                  {trade.pnlPercent >= 0 ? "+" : ""}
                  {trade.pnlPercent.toFixed(2)}%
                </td>
              </tr>
              {expandedTrade === trade.id && trade.reason && (
                <tr key={`${trade.id}-detail`}>
                  <td colSpan={8} className="bg-[var(--surface-2)] px-3 py-2 text-[var(--text-secondary)]">
                    <span className="text-[var(--text-tertiary)]">Reason:</span> {trade.reason}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      {results.trades.length === 0 && (
        <div className="py-6 text-center text-xs text-[var(--text-tertiary)]">No trades recorded</div>
      )}
    </div>
  );
}

/* ─── Pattern Analysis ─── */

function PatternContent() {
  const matches = useStore((s) => s.patternMatches);
  const setChartFocus = useStore((s) => s.setChartFocus);
  const chartData = useStore((s) => s.chartData);
  const lastResult = useStore((s) => s.lastScriptResult);

  if (matches.length === 0 && !lastResult?.ran) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--text-tertiary)]">
        Run pattern detection to see analysis
      </div>
    );
  }

  if (matches.length === 0 && lastResult?.ran) {
    return (
      <div className="p-3">
        <div className="grid grid-cols-4 gap-2 mb-3">
          <div className="rounded border border-[var(--border-subtle)] p-2">
            <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Total</div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">0</div>
          </div>
          <div className="rounded border border-[var(--border-subtle)] p-2">
            <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Bullish</div>
            <div className="text-sm font-semibold" style={{ color: "var(--success)" }}>0</div>
          </div>
          <div className="rounded border border-[var(--border-subtle)] p-2">
            <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Bearish</div>
            <div className="text-sm font-semibold" style={{ color: "var(--danger)" }}>0</div>
          </div>
          <div className="rounded border border-[var(--border-subtle)] p-2">
            <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Status</div>
            <div className="text-sm font-semibold" style={{ color: lastResult.error ? "var(--danger)" : "var(--text-tertiary)" }}>
              {lastResult.error ? "Error" : "No Match"}
            </div>
          </div>
        </div>
        <p className="text-xs text-center" style={{ color: "var(--text-tertiary)" }}>
          {lastResult.error
            ? `Script error: ${lastResult.error}`
            : "Script executed but found no matching patterns. Try selecting a different pattern area or lowering the threshold."}
        </p>
      </div>
    );
  }

  const handleRowClick = (m: (typeof matches)[0]) => {
    const startT = typeof m.startTime === "string" ? Number(m.startTime) : (m.startTime as number);
    const endT = typeof m.endTime === "string" ? Number(m.endTime) : (m.endTime as number);
    const duration = Math.max(endT - startT, 1); // guard against zero-length matches

    // Padding strategy: derive from the chart's actual bar interval so the
    // viewport is sane for ANY timeframe (1m, 1h, 1D). A hardcoded 5-day
    // floor (the previous behaviour) made intraday matches look like the
    // chart had jumped somewhere completely different.
    //
    //   - At least 25 bars of context on each side  (≈ 50-bar window)
    //   - Or half the pattern duration on each side, whichever is larger
    //
    // Result: short patterns get a roomy ~50-bar view; long patterns are
    // shown at 2× their own duration, never more.
    const n = chartData.length;
    let avgBarInterval = 0;
    if (n >= 2) {
      const t0 = Number(chartData[0].time);
      const tN = Number(chartData[n - 1].time);
      avgBarInterval = (tN - t0) / (n - 1);
    }
    const minBarsPad = avgBarInterval > 0 ? avgBarInterval * 25 : duration * 0.5;
    const pad = Math.max(duration * 0.5, minBarsPad);
    setChartFocus({ startTime: startT - pad, endTime: endT + pad });
  };

  const bullish = matches.filter((m) => m.direction === "bullish").length;
  const bearish = matches.filter((m) => m.direction === "bearish").length;
  const neutral = matches.filter((m) => m.direction === "neutral").length;
  const avgConfidence = matches.reduce((s, m) => s + m.confidence, 0) / matches.length;

  return (
    <div className="p-3">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <div className="rounded border border-[var(--border-subtle)] p-2">
          <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Total</div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">{matches.length}</div>
        </div>
        <div className="rounded border border-[var(--border-subtle)] p-2">
          <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Bullish</div>
          <div className="text-sm font-semibold text-emerald-600">{bullish}</div>
        </div>
        <div className="rounded border border-[var(--border-subtle)] p-2">
          <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Bearish</div>
          <div className="text-sm font-semibold text-red-500">{bearish}</div>
        </div>
        <div className="rounded border border-[var(--border-subtle)] p-2">
          <div className="text-[10px] text-[var(--text-tertiary)] uppercase">Avg Confidence</div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">{(avgConfidence * 100).toFixed(1)}%</div>
        </div>
      </div>

      {/* Match list */}
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase text-[var(--text-tertiary)]">
            <th className="py-1.5 pr-3 font-semibold">Pattern</th>
            <th className="py-1.5 pr-3 font-semibold">Direction</th>
            <th className="py-1.5 pr-3 font-semibold">Start</th>
            <th className="py-1.5 pr-3 font-semibold">End</th>
            <th className="py-1.5 text-right font-semibold">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {matches.map((m) => (
            <tr
              key={m.id}
              onClick={() => handleRowClick(m)}
              className="border-b border-[var(--border-subtle)] hover:bg-blue-50/50 cursor-pointer transition-colors"
            >
              <td className="py-1.5 pr-3 font-medium text-[var(--text-primary)]">{m.name}</td>
              <td className="py-1.5 pr-3">
                <span
                  className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    m.direction === "bullish"
                      ? "bg-emerald-50 text-emerald-600"
                      : m.direction === "bearish"
                        ? "bg-red-50 text-red-500"
                        : "bg-slate-100 text-[var(--text-secondary)]"
                  }`}
                >
                  {m.direction.toUpperCase()}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{m.startTime}</td>
              <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{m.endTime}</td>
              <td className="py-1.5 text-right text-[var(--text-primary)]">{(m.confidence * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Strategy Report ─── */

function StrategyContent() {
  const analysisResults = useStore((s) => s.analysisResults);

  if (!analysisResults) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--text-tertiary)]">
        Run strategy analysis to see report
      </div>
    );
  }

  return (
    <div className="p-3">
      {analysisResults.summary && (
        <p className="text-xs text-[var(--text-secondary)] mb-3">{analysisResults.summary}</p>
      )}

      {analysisResults.metrics && (
        <div className="grid grid-cols-4 gap-2 mb-3">
          {Object.entries(analysisResults.metrics).map(([key, val]) => (
            <div key={key} className="rounded border border-[var(--border-subtle)] p-2">
              <div className="text-[10px] text-[var(--text-tertiary)] uppercase">{key.replace(/_/g, " ")}</div>
              <div className="text-sm font-semibold text-[var(--text-primary)]">{val}</div>
            </div>
          ))}
        </div>
      )}

      {analysisResults.signals && analysisResults.signals.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase text-[var(--text-tertiary)]">
              <th className="py-1.5 pr-3 font-semibold">Time</th>
              <th className="py-1.5 pr-3 font-semibold">Signal</th>
              <th className="py-1.5 text-right font-semibold">Price</th>
            </tr>
          </thead>
          <tbody>
            {analysisResults.signals.map((s, i) => (
              <tr key={i} className="border-b border-[var(--border-subtle)] hover:bg-[var(--surface-2)]">
                <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{s.time}</td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      s.type === "buy"
                        ? "bg-emerald-50 text-emerald-600"
                        : "bg-red-50 text-red-500"
                    }`}
                  >
                    {s.type.toUpperCase()}
                  </span>
                </td>
                <td className="py-1.5 text-right text-[var(--text-primary)] font-medium">{s.price.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
