"use client";

import { useStore } from "@/store/useStore";
import type { DrawingType } from "@/lib/chart-primitives/drawingTypes";

const tools: { key: DrawingType | "pointer" | "delete"; label: string; icon: React.ReactNode; separator?: boolean; hero?: boolean }[] = [
  {
    key: "pointer",
    label: "Select",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" strokeLinejoin="round" />
        <path d="M13 13l6 6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "pattern_select",
    label: "Pattern Select — drag on chart to detect patterns",
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <rect x="2" y="2" width="20" height="20" rx="3" strokeDasharray="4 2" />
        <path d="M7 16l3.5-5 2.5 2.5 4-5.5" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
        <circle cx="19" cy="5" r="3" fill="#ff6b00" stroke="#ff6b00" />
      </svg>
    ),
    separator: true,
    hero: true,
  },
  {
    key: "trendline",
    label: "Trendline",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <line x1="4" y1="20" x2="20" y2="4" strokeLinecap="round" />
        <circle cx="4" cy="20" r="1.5" fill="currentColor" />
        <circle cx="20" cy="4" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "horizontal_line",
    label: "Horizontal Line",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <line x1="2" y1="12" x2="22" y2="12" strokeLinecap="round" strokeDasharray="4 2" />
        <circle cx="12" cy="12" r="1.5" fill="#f59e0b" stroke="#f59e0b" />
      </svg>
    ),
  },
  {
    key: "vertical_line",
    label: "Vertical Line",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <line x1="12" y1="2" x2="12" y2="22" strokeLinecap="round" strokeDasharray="4 2" />
        <circle cx="12" cy="12" r="1.5" fill="#8b5cf6" stroke="#8b5cf6" />
      </svg>
    ),
    separator: true,
  },
  {
    key: "rectangle",
    label: "Rectangle",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <rect x="4" y="6" width="16" height="12" rx="1" fill="rgba(255,107,0,0.15)" stroke="#ff6b00" />
      </svg>
    ),
  },
  {
    key: "fibonacci",
    label: "Fibonacci Retracement",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" strokeWidth={1.5}>
        <line x1="3" y1="4" x2="21" y2="4" stroke="#787b86" />
        <line x1="3" y1="8" x2="21" y2="8" stroke="#f44336" strokeDasharray="3 2" />
        <line x1="3" y1="11" x2="21" y2="11" stroke="#4caf50" strokeDasharray="3 2" />
        <line x1="3" y1="14.5" x2="21" y2="14.5" stroke="#00bcd4" strokeDasharray="3 2" />
        <line x1="3" y1="17" x2="21" y2="17" stroke="#ff6b00" strokeDasharray="3 2" />
        <line x1="3" y1="20" x2="21" y2="20" stroke="#787b86" />
      </svg>
    ),
    separator: true,
  },
  {
    key: "long_position",
    label: "Long Position",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="4" y="4" width="16" height="7" rx="1" stroke="#22c55e" fill="rgba(34,197,94,0.15)" />
        <rect x="4" y="13" width="16" height="7" rx="1" stroke="#ef4444" fill="rgba(239,68,68,0.15)" />
        <line x1="4" y1="11.5" x2="20" y2="11.5" strokeDasharray="3 2" stroke="#3b82f6" />
      </svg>
    ),
  },
  {
    key: "short_position",
    label: "Short Position",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="4" y="4" width="16" height="7" rx="1" stroke="#ef4444" fill="rgba(239,68,68,0.15)" />
        <rect x="4" y="13" width="16" height="7" rx="1" stroke="#22c55e" fill="rgba(34,197,94,0.15)" />
        <line x1="4" y1="11.5" x2="20" y2="11.5" strokeDasharray="3 2" stroke="#3b82f6" />
      </svg>
    ),
    separator: true,
  },
  {
    key: "delete",
    label: "Delete Selected",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function DrawingToolbar() {
  const activeDrawingTool = useStore((s) => s.activeDrawingTool);
  const setActiveDrawingTool = useStore((s) => s.setActiveDrawingTool);
  const deleteSelectedDrawing = useStore((s) => s.deleteSelectedDrawing);
  const drawings = useStore((s) => s.drawings);
  const hasSelected = drawings.some((d) => d.selected);

  return (
    <div className="flex flex-col items-center gap-0.5 py-2 px-1" style={{ borderRight: "1px solid var(--border)", background: "var(--surface)" }}>
      {tools.map((tool) => {
        if (tool.key === "delete") {
          return (
            <button
              key={tool.key}
              onClick={deleteSelectedDrawing}
              disabled={!hasSelected}
              className="flex h-8 w-8 items-center justify-center rounded transition-colors"
              style={{ color: hasSelected ? "var(--danger)" : "var(--text-muted)" }}
              title={tool.label}
            >
              {tool.icon}
            </button>
          );
        }

        const isActive =
          tool.key === "pointer"
            ? activeDrawingTool === null
            : activeDrawingTool === tool.key;

        // Hero tool — Pattern Selector gets a slightly larger button
        // and a subtle idle tint so users can find it, but NO glow /
        // pulsing animation once selected (too distracting).
        if (tool.hero) {
          return (
            <div key={tool.key}>
              <button
                onClick={() => setActiveDrawingTool(tool.key as DrawingType)}
                className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors"
                style={{
                  background: isActive ? "var(--accent)" : "rgba(255, 107, 0, 0.08)",
                  color: isActive ? "#fff" : "#ff6b00",
                }}
                title={tool.label}
              >
                {tool.icon}
              </button>
              {tool.separator && (
                <div className="mx-1.5 my-1 h-px" style={{ background: "var(--border-subtle)" }} />
              )}
            </div>
          );
        }

        return (
          <div key={tool.key}>
            <button
              onClick={() =>
                setActiveDrawingTool(
                  tool.key === "pointer" ? null : (tool.key as DrawingType)
                )
              }
              className="flex h-8 w-8 items-center justify-center rounded transition-colors"
              style={{
                background: isActive ? "var(--accent)" : "transparent",
                color: isActive ? "#fff" : "var(--text-tertiary)",
              }}
              title={tool.label}
            >
              {tool.icon}
            </button>
            {tool.separator && (
              <div className="mx-1.5 my-0.5 h-px" style={{ background: "var(--border-subtle)" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
