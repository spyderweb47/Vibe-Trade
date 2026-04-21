"use client";

import { useMemo } from "react";
import { useStore } from "@/store/useStore";
import type { NewsEvent, NewsCategory } from "@/types";

/**
 * Bottom-panel tab rendered by the `historic_news` skill.
 *
 * Layout: two columns.
 *   Left  — timeline list of every event for the current asset, newest
 *            first. Clicking a row selects the event (drives the chart
 *            marker highlight) and zooms the chart to that event's time.
 *   Right — detail view of the currently-selected event: full headline,
 *            summary, direction/impact/category badges, source link.
 *
 * Visual cues mirror the chart primitive: same category glyphs, same
 * direction colors (bullish green / bearish red / neutral orange). So a
 * user scanning the list can match a row to its dot on the chart.
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

export function HistoricNewsTab() {
  const newsEvents = useStore((s) => s.newsEvents);
  const newsEventsSymbol = useStore((s) => s.newsEventsSymbol);
  const selectedNewsEventId = useStore((s) => s.selectedNewsEventId);
  const setSelectedNewsEventId = useStore((s) => s.setSelectedNewsEventId);
  const datasets = useStore((s) => s.datasets);
  const chartWindows = useStore((s) => s.chartWindows);
  const focusedWindowId = useStore((s) => s.focusedWindowId);
  const datasetChartData = useStore((s) => s.datasetChartData);
  const setChartFocus = useStore((s) => s.setChartFocus);
  const setChartFocusForDataset = useStore((s) => s.setChartFocusForDataset);

  // Sort newest first; keep stable when timestamps tie
  const sorted = useMemo(() => {
    return [...newsEvents].sort((a, b) => b.timestamp - a.timestamp);
  }, [newsEvents]);

  const selected = useMemo(
    () => sorted.find((e) => e.id === selectedNewsEventId) ?? sorted[0] ?? null,
    [sorted, selectedNewsEventId]
  );

  if (sorted.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>
        Run the <span className="mx-1 font-mono" style={{ color: "var(--accent)" }}>historic news</span> skill to see price-moving events for this asset
      </div>
    );
  }

  // Pick the right dataset to zoom. Prefer the focused window's
  // dataset, else the first chart window's dataset, else look up by
  // symbol from the datasets list. Without a dataset id, fall back to
  // the global chartFocus so the zoom at least works on a single chart.
  const resolveDatasetId = (): string | null => {
    const focusedWin = chartWindows.find((w) => w.id === focusedWindowId);
    if (focusedWin?.datasetId) return focusedWin.datasetId;
    if (chartWindows[0]?.datasetId) return chartWindows[0].datasetId;
    if (newsEventsSymbol) {
      const ds = datasets.find(
        (d) => String(d.metadata?.symbol || "").toUpperCase() === newsEventsSymbol.toUpperCase()
      );
      if (ds) return ds.id;
    }
    return null;
  };

  const handleRowClick = (ev: NewsEvent) => {
    setSelectedNewsEventId(ev.id);
    const dsid = resolveDatasetId();
    // Pick a padding window that fits the dataset's own bar spacing so
    // the zoom looks sensible on any timeframe. Default to +/- 7 days
    // when we can't measure the bars.
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

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Timeline list (left) ─────────────────────────────────── */}
      <div
        className="flex h-full min-w-[280px] max-w-[420px] flex-1 flex-col overflow-y-auto"
        style={{ borderRight: "1px solid var(--border)" }}
      >
        <div
          className="sticky top-0 z-10 flex items-center justify-between px-3 py-2"
          style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border-subtle)" }}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
            {newsEventsSymbol === "*"
              ? `All charts — ${sorted.length} events`
              : newsEventsSymbol
                ? `${newsEventsSymbol} — ${sorted.length} events`
                : `${sorted.length} events`}
          </span>
          <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
            newest first
          </span>
        </div>

        <ul className="flex-1">
          {sorted.map((ev) => {
            const dir = DIR_COLOR[ev.direction];
            const active = ev.id === selected?.id;
            const glyph = CATEGORY_GLYPH[ev.category] ?? "●";
            return (
              <li key={ev.id}>
                <button
                  onClick={() => handleRowClick(ev)}
                  className="w-full px-3 py-2 text-left transition-colors"
                  style={{
                    background: active ? "var(--surface-2)" : "transparent",
                    borderBottom: "1px solid var(--border-subtle)",
                    borderLeft: `3px solid ${active ? dir.solid : "transparent"}`,
                  }}
                >
                  <div className="flex items-start gap-2">
                    {/* Glyph dot mirrors chart marker */}
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
                        style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
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
      </div>

      {/* ── Article detail (right) ────────────────────────────────── */}
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
