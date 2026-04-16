"use client";

import type { ReactNode } from "react";

interface Props {
  label: string;
  children: ReactNode;
  onClose?: () => void;
  onDock?: () => void;
  /** Extra content in the header (dataset picker, timeframe selector, etc.) */
  headerExtra?: ReactNode;
}

/**
 * Chrome wrapper for mosaic tiles — thin header with title, optional
 * controls, and content below. react-mosaic's default toolbar is hidden
 * via CSS; this replaces it with our themed version.
 */
export function TileWrapper({ label, children, onClose, onDock, headerExtra }: Props) {
  return (
    <div className="flex flex-col h-full w-full overflow-hidden" style={{ background: "var(--surface)" }}>
      {/* Header */}
      <div
        className="mosaic-drag-handle flex items-center gap-2 px-2 py-1 shrink-0 select-none cursor-grab active:cursor-grabbing"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
      >
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>

        {headerExtra && <div className="flex items-center gap-1">{headerExtra}</div>}

        <div className="ml-auto flex items-center gap-1">
          {onDock && (
            <button
              onClick={onDock}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--surface-2)]"
              title="Dock back to bottom panel"
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
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
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </div>
  );
}
