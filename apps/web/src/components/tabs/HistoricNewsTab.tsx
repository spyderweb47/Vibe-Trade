"use client";

import { useMemo } from "react";
import { useStore } from "@/store/useStore";
import type { NewsEvent, NewsCategory } from "@/types";

/**
 * Bottom-panel tab rendered by the `historic_news` skill.
 *
 * Layout:
 *   Top    — row of asset sub-tabs. One per symbol with news in the
 *            store. Clicking switches the active symbol. Each tab has
 *            a × button to remove that symbol's news entirely.
 *   Below  — two-column view for the active symbol:
 *              Left  timeline list (newest first)
 *              Right article detail for the selected event
 *
 * Multi-asset support: running `historic_news` for AAPL followed by
 * MSFT leaves BOTH tabs in the panel — fetching a second symbol no
 * longer wipes the first. A broadcast-mode fetch (plot on all charts)
 * lives under the special "*" tab labelled "All Charts".
 *
 * Visual cues mirror the chart primitive: same category glyphs, same
 * direction colors. So a row in the list matches the dot on the chart.
 */

const CATEGORY_GLYPH: Record<NewsCategory, string> = {
  earnings: "$",
  regulatory: "§",
  macro: "M",
  product: "★",
  sentiment: "◉",
  geopolitical: "⚑",
  technical: "T",
};

const CATEGORY_LABEL: Record<NewsCategory, string> = {
  earnings: "Earnings",
  regulatory: "Regulatory",
  macro: "Macro",
  product: "Product",
  sentiment: "Sentiment",
  geopolitical: "Geopolitical",
  technical: "Technical",
};

const DIR_COLOR: Record<NewsEvent["direction"], { bg: string; fg: string; solid: string }> = {
  bullish: { bg: "rgba(34, 197, 94, 0.12)",  fg: "#16a34a", solid: "#22c55e" },
  bearish: { bg: "rgba(239, 68, 68, 0.12)",  fg: "#dc2626", solid: "#ef4444" },
  neutral: { bg: "rgba(255, 107, 0, 0.12)",  fg: "#c2410c", solid: "#ff6b00" },
};

const IMPACT_LABEL: Record<NewsEvent["impact"], string> = {
  high: "High Impact",
  medium: "Medium Impact",
  low: "Low Impact",
};

function formatDate(unixSec: number): string {
  try {
    const d = new Date(unixSec * 1000);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(unixSec);
  }
}

function formatRelative(unixSec: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSec;
  const days = Math.floor(diff / 86400);
  if (days < 1) return "today";
  if (days < 2) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = (days / 365).toFixed(1);
  return `${years}y ago`;
}

function symbolLabel(symbol: string): string {
  return symbol === "*" ? "All Charts" : symbol;
}

export function HistoricNewsTab() {
  const newsEventsBySymbol = useStore((s) => s.newsEventsBySymbol);
  const activeNewsSymbol = useStore((s) => s.activeNewsSymbol);
  const selectedNewsEventIdBySymbol = useStore((s) => s.selectedNewsEventIdBySymbol);
  const setActiveNewsSymbol = useStore((s) => s.setActiveNewsSymbol);
  const setSelectedNewsEventId = useStore((s) => s.setSelectedNewsEventId);
  const clearNewsEvents = useStore((s) => s.clearNewsEvents);
  const datasets = useStore((s) => s.datasets);
  const chartWindows = useStore((s) => s.chartWindows);
  const focusedWindowId = useStore((s) => s.focusedWindowId);
  const datasetChartData = useStore((s) => s.datasetChartData);
  const setChartFocus = useStore((s) => s.setChartFocus);
  const setChartFocusForDataset = useStore((s) => s.setChartFocusForDataset);

  // Symbols available as sub-tabs, stable order — broadcast "*" first,
  // then the rest alphabetically. Keeps the tab bar from jumping around
  // when a new symbol is added.
  const symbols = useMemo(() => {
    const keys = Object.keys(newsEventsBySymbol || {});
    keys.sort((a, b) => {
      if (a === "*") return -1;
      if (b === "*") return 1;
      return a.localeCompare(b);
    });
    return keys;
  }, [newsEventsBySymbol]);

  // Default the active tab to the first one if nothing's selected or
  // the selected symbol was just cleared.
  const active = activeNewsSymbol && symbols.includes(activeNewsSymbol)
    ? activeNewsSymbol
    : (symbols[0] || null);

  const activeEvents = active ? (newsEventsBySymbol[active] || []) : [];
  const activeSelectedId = active ? (selectedNewsEventIdBySymbol[active] ?? null) : null;

  // Sort newest first; keep stable when timestamps tie
  const sorted = useMemo(() => {
    return [...activeEvents].sort((a, b) => b.timestamp - a.timestamp);
  }, [activeEvents]);

  const selected = useMemo(
    () => sorted.find((e) => e.id === activeSelectedId) ?? sorted[0] ?? null,
    [sorted, activeSelectedId]
  );

  // Empty state — no assets have news loaded yet
  if (symbols.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>
        Run the <span className="mx-1 font-mono" style={{ color: "var(--accent)" }}>historic news</span> skill to see price-moving events for your loaded assets
      </div>
    );
  }

  // Pick the right dataset to zoom — prefer a dataset matching the
  // active symbol, then focused window, then first window.
  const resolveDatasetId = (): string | null => {
    if (active && active !== "*") {
      const ds = datasets.find(
        (d) => String(d.metadata?.symbol || "").toUpperCase() === active.toUpperCase()
      );
      if (ds) return ds.id;
    }
    const focusedWin = chartWindows.find((w) => w.id === focusedWindowId);
    if (focusedWin?.datasetId) return focusedWin.datasetId;
    if (chartWindows[0]?.datasetId) return chartWindows[0].datasetId;
    return null;
  };

  const handleRowClick = (ev: NewsEvent) => {
    if (!active) return;
    setSelectedNewsEventId(active, ev.id);
    const dsid = resolveDatasetId();
    const bars = (dsid && datasetChartData[dsid]) || [];
    let avgBarInterval = 0;
    if (bars.length >= 2) {
      const t0 = Number(bars[0].time);
      const tN = Number(bars[bars.length - 1].time);
      avgBarInterval = (tN - t0) / (bars.length - 1);
    }
    const pad = avgBarInterval > 0 ? avgBarInterval * 20 : 7 * 86400;
    const focus = { startTime: ev.timestamp - pad, endTime: ev.timestamp + pad };
    if (dsid) setChartFocusForDataset(dsid, focus);
    else setChartFocus(focus);
  };

  const handleCloseTab = (e: React.MouseEvent, symbol: string) => {
    e.stopPropagation();
    clearNewsEvents(symbol);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Asset sub-tabs (top row) ──────────────────────────────── */}
      <div
        className="flex h-8 shrink-0 items-center gap-0 overflow-x-auto"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--border-subtle)" }}
      >
        {symbols.map((sym) => {
          const isActive = sym === active;
          const count = newsEventsBySymbol[sym]?.length || 0;
          return (
            <button
              key={sym}
              onClick={() => setActiveNewsSymbol(sym)}
              className="group relative flex h-full items-center gap-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider transition-colors"
              style={{
                color: isActive ? "var(--accent)" : "var(--text-tertiary)",
                background: isActive ? "var(--surface-2)" : "transparent",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              <span className={sym === "*" ? "italic" : ""}>
                {symbolLabel(sym)}
              </span>
              <span
                className="rounded px-1 py-[1px] text-[8px] font-mono"
                style={{
                  background: "var(--surface)",
                  color: "var(--text-muted)",
                }}
              >
                {count}
              </span>
              <span
                role="button"
                aria-label={`Remove ${symbolLabel(sym)} news`}
                onClick={(e) => handleCloseTab(e, sym)}
                className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-[12px] leading-none opacity-50 hover:bg-[var(--danger)] hover:text-white hover:opacity-100 transition-opacity"
                style={{ color: "var(--text-tertiary)" }}
                title={`Remove ${symbolLabel(sym)} news`}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Body (timeline + detail for active symbol) ────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Timeline (left) */}
        <div
          className="flex h-full min-w-[280px] max-w-[420px] flex-1 flex-col overflow-y-auto"
          style={{ borderRight: "1px solid var(--border)" }}
        >
          <div
            className="sticky top-0 z-10 flex items-center justify-between px-3 py-2"
            style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border-subtle)" }}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
              {active ? `${symbolLabel(active)} — ${sorted.length} events` : `${sorted.length} events`}
            </span>
            <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
              newest first
            </span>
          </div>

          {sorted.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              No events for {active ? symbolLabel(active) : "this asset"}.
            </div>
          ) : (
            <ul className="flex-1">
              {sorted.map((ev) => {
                const dir = DIR_COLOR[ev.direction];
                const isSelected = ev.id === selected?.id;
                const glyph = CATEGORY_GLYPH[ev.category] ?? "●";
                return (
                  <li key={ev.id}>
                    <button
                      onClick={() => handleRowClick(ev)}
                      className="w-full px-3 py-2 text-left transition-colors"
                      style={{
                        background: isSelected ? "var(--surface-2)" : "transparent",
                        borderBottom: "1px solid var(--border-subtle)",
                        borderLeft: `3px solid ${isSelected ? dir.solid : "transparent"}`,
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
                          style={{ background: dir.solid }}
                          title={CATEGORY_LABEL[ev.category]}
                        >
                          {glyph}
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                              {formatDate(ev.timestamp)}
                            </span>
                            <span className="text-[8px]" style={{ color: "var(--text-tertiary)" }}>
                              · {formatRelative(ev.timestamp)}
                            </span>
                            <span
                              className="rounded px-1 py-[1px] text-[8px] font-bold uppercase tracking-wider"
                              style={{ background: dir.bg, color: dir.fg }}
                            >
                              {ev.direction}
                            </span>
                            {ev.impact === "high" && (
                              <span
                                className="rounded px-1 py-[1px] text-[8px] font-bold uppercase"
                                style={{ background: "rgba(239,68,68,0.12)", color: "#dc2626" }}
                              >
                                H
                              </span>
                            )}
                          </div>
                          <div
                            className="mt-0.5 line-clamp-2 text-[11px] font-medium leading-tight"
                            style={{ color: isSelected ? "var(--text-primary)" : "var(--text-secondary)" }}
                          >
                            {ev.headline}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1 text-[9px]" style={{ color: "var(--text-muted)" }}>
                            <span className="truncate">{ev.source}</span>
                            {ev.price_impact_pct != null && (
                              <span style={{ color: ev.price_impact_pct > 0 ? "#16a34a" : ev.price_impact_pct < 0 ? "#dc2626" : "var(--text-muted)" }}>
                                · {ev.price_impact_pct > 0 ? "+" : ""}
                                {ev.price_impact_pct.toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Article detail (right) */}
        <div className="flex-1 overflow-y-auto p-4">
          {selected ? (
            <ArticleDetail event={selected} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>
              Select an event on the left
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Article detail view ──────────────────────────────────────────── */

function ArticleDetail({ event }: { event: NewsEvent }) {
  const dir = DIR_COLOR[event.direction];
  const glyph = CATEGORY_GLYPH[event.category] ?? "●";

  return (
    <article className="max-w-3xl mx-auto">
      {/* Badges row */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{ background: dir.bg, color: dir.fg }}
        >
          <span
            className="flex h-3 w-3 items-center justify-center rounded-full text-[7px] font-bold text-white"
            style={{ background: dir.solid }}
          >
            {glyph}
          </span>
          {CATEGORY_LABEL[event.category]}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: dir.bg, color: dir.fg }}
        >
          {event.direction}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
          style={{
            background: event.impact === "high" ? "rgba(239,68,68,0.12)" : event.impact === "medium" ? "rgba(245,158,11,0.12)" : "rgba(148,163,184,0.12)",
            color: event.impact === "high" ? "#dc2626" : event.impact === "medium" ? "#b45309" : "var(--text-muted)",
          }}
        >
          {IMPACT_LABEL[event.impact]}
        </span>
        {event.price_impact_pct != null && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-mono font-semibold"
            style={{
              background: event.price_impact_pct > 0 ? "rgba(34,197,94,0.12)" : event.price_impact_pct < 0 ? "rgba(239,68,68,0.12)" : "var(--surface-2)",
              color: event.price_impact_pct > 0 ? "#16a34a" : event.price_impact_pct < 0 ? "#dc2626" : "var(--text-muted)",
            }}
          >
            Price {event.price_impact_pct > 0 ? "+" : ""}{event.price_impact_pct.toFixed(1)}%
          </span>
        )}
      </div>

      {/* Headline */}
      <h2 className="text-lg font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
        {event.headline}
      </h2>

      {/* Meta line */}
      <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
        <span className="font-semibold">{event.source}</span>
        <span>·</span>
        <span>{formatDate(event.timestamp)}</span>
        <span>·</span>
        <span>{formatRelative(event.timestamp)}</span>
      </div>

      {/* Summary */}
      <div
        className="mt-4 whitespace-pre-wrap text-[12px] leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {event.summary}
      </div>

      {/* External link */}
      {event.url && (
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors"
          style={{
            background: "var(--accent)",
            color: "white",
          }}
        >
          Read original article
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      )}
    </article>
  );
}
