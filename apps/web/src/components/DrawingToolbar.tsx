"use client";

import { useStore } from "@/store/useStore";
import type { DrawingType } from "@/lib/chart-primitives/drawingTypes";

const tools: { key: DrawingType | "pointer" | "delete"; label: string; icon: React.ReactNode }[] = [
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
  },
  {
    key: "pattern_select",
    label: "Pattern Select",
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="4 2" />
        <path d="M8 16l3-4 2 2 3-4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="18" cy="6" r="2.5" fill="#3b82f6" stroke="#3b82f6" />
      </svg>
    ),
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
    <div className="flex flex-col items-center gap-0.5 border-r border-slate-200 bg-white py-2 px-1">
      {tools.map((tool) => {
        if (tool.key === "delete") {
          return (
            <button
              key={tool.key}
              onClick={deleteSelectedDrawing}
              disabled={!hasSelected}
              className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                hasSelected
                  ? "text-red-400 hover:bg-red-50 hover:text-red-500"
                  : "text-slate-200 cursor-not-allowed"
              }`}
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

        return (
          <button
            key={tool.key}
            onClick={() =>
              setActiveDrawingTool(
                tool.key === "pointer" ? null : (tool.key as DrawingType)
              )
            }
            className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
              isActive
                ? "bg-slate-900 text-white"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            }`}
            title={tool.label}
          >
            {tool.icon}
          </button>
        );
      })}
    </div>
  );
}
