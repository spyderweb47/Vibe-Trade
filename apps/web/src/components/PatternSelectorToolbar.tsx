"use client";

import type { DrawingPhase } from "@/lib/chart-primitives/patternSelectorTypes";

interface Props {
  drawingPhase: DrawingPhase;
  hasSelection: boolean;
  onSendToAgent: () => void;
  onClear: () => void;
}

const phaseText: Record<DrawingPhase, string> = {
  idle: "",
  trigger: "Drag to select pattern area",
  trade: "Now drag to mark the trade zone",
};

export function PatternSelectorToolbar({
  drawingPhase,
  hasSelection,
  onSendToAgent,
  onClear,
}: Props) {
  // Only show during drawing or after selection
  if (drawingPhase === "idle" && !hasSelection) return null;

  return (
    <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
      {drawingPhase !== "idle" && (
        <div className="rounded bg-blue-50/90 border border-blue-200 px-2.5 py-1 text-[10px] font-medium text-blue-600 shadow-sm backdrop-blur-sm">
          {phaseText[drawingPhase]}
        </div>
      )}

      {hasSelection && drawingPhase === "idle" && (
        <>
          <button
            onClick={onSendToAgent}
            className="rounded bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-slate-800 shadow-sm"
          >
            Send to Agent
          </button>
          <button
            onClick={onClear}
            className="rounded bg-white/90 border border-slate-200 px-2.5 py-1 text-[10px] font-semibold text-slate-400 hover:text-red-500 shadow-sm backdrop-blur-sm"
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}
