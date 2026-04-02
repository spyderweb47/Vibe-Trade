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
    <>
      {/* Drawing phase instructions — top left */}
      {drawingPhase !== "idle" && (
        <div className="absolute top-2 left-2 z-10">
          <div className="rounded px-2.5 py-1 text-[10px] font-medium shadow-sm backdrop-blur-sm"
            style={{ background: "rgba(41,98,255,0.15)", color: "#2962ff", border: "1px solid rgba(41,98,255,0.3)" }}>
            {phaseText[drawingPhase]}
          </div>
        </div>
      )}

      {/* Action buttons — top right */}
      {hasSelection && drawingPhase === "idle" && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5">
          <button
            onClick={onSendToAgent}
            className="rounded px-2.5 py-1 text-[10px] font-semibold text-white shadow-sm"
            style={{ background: "var(--accent)" }}
          >
            Send to Agent
          </button>
          <button
            onClick={onClear}
            className="rounded px-2.5 py-1 text-[10px] font-semibold shadow-sm backdrop-blur-sm"
            style={{ background: "var(--surface-2)", color: "var(--text-tertiary)", border: "1px solid var(--border)" }}
          >
            Clear
          </button>
        </div>
      )}
    </>
  );
}
