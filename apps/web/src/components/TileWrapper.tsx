"use client";

import { type ReactNode, useState, useCallback } from "react";

interface Props {
  label: string;
  children: ReactNode;
  onClose?: () => void;
  onDock?: () => void;
  /** Extra content in the header (dataset picker, timeframe selector, etc.) */
  headerExtra?: ReactNode;
  /** Timestamp of last data refresh */
  lastUpdated?: number | null;
  /** Called when user clicks refresh */
  onRefresh?: () => void;
  /** Called when user clicks export — receives format */
  onExport?: (format: "csv" | "json" | "clipboard") => void;
  /** If true, show a view toggle between content and raw data */
  showViewToggle?: boolean;
  /** Alternate view content (e.g. raw data table) */
  altView?: ReactNode;
  altViewLabel?: string;
}

/**
 * Widget header chrome for mosaic tiles. OpenBB-inspired standardized
 * header with: title, refresh indicator, export dropdown, view toggle,
 * dock/close buttons. All controls are optional — simple tiles can pass
 * just label + children.
 */
export function TileWrapper({
  label,
  children,
  onClose,
  onDock,
  headerExtra,
  lastUpdated,
  onRefresh,
  onExport,
  showViewToggle,
  altView,
  altViewLabel = "Data",
}: Props) {
  const [showAlt, setShowAlt] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const timeAgo = useCallback(() => {
    if (!lastUpdated) return null;
    const s = Math.floor((Date.now() - lastUpdated) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }, [lastUpdated]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden" style={{ background: "var(--surface)" }}>
      {/* Header */}
      <div
        className="mosaic-drag-handle flex items-center gap-1.5 px-2 py-1 shrink-0 select-none cursor-grab active:cursor-grabbing"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
      >
        {/* Title */}
        <span className="text-[9px] font-bold uppercase tracking-wider shrink-0" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>

        {/* Last updated timestamp */}
        {lastUpdated && (
          <span className="text-[8px] shrink-0" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
            {timeAgo()}
          </span>
        )}

        {headerExtra && <div className="flex items-center gap-1">{headerExtra}</div>}

        <div className="ml-auto flex items-center gap-0.5">
          {/* View toggle */}
          {showViewToggle && altView && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAlt(!showAlt); }}
              className="flex h-5 items-center gap-1 rounded px-1.5 transition-colors hover:bg-[var(--surface-2)]"
              title={showAlt ? "Show content" : `Show ${altViewLabel}`}
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {showAlt ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                )}
              </svg>
              <span className="text-[8px] font-semibold uppercase">{showAlt ? "Chart" : altViewLabel}</span>
            </button>
          )}

          {/* Refresh */}
          {onRefresh && (
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
              title="Refresh"
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}

          {/* Export dropdown */}
          {onExport && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setExportOpen(!exportOpen); }}
                className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
                title="Export"
                style={{ color: "var(--text-muted)" }}
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              {exportOpen && (
                <div
                  className="absolute right-0 top-6 z-50 rounded-lg shadow-xl py-1"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border)", minWidth: 100 }}
                  onClick={() => setExportOpen(false)}
                >
                  {(["csv", "json", "clipboard"] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={(e) => { e.stopPropagation(); onExport(fmt); setExportOpen(false); }}
                      className="w-full px-3 py-1.5 text-left text-[10px] transition-colors hover:bg-[var(--surface)]"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {fmt === "clipboard" ? "Copy to clipboard" : fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Dock */}
          {onDock && (
            <button
              onClick={(e) => { e.stopPropagation(); onDock(); }}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
              title="Dock back to bottom panel"
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}

          {/* Close */}
          {onClose && (
            <button
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
              title="Close tile"
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {showViewToggle && showAlt && altView ? altView : children}
      </div>
    </div>
  );
}
