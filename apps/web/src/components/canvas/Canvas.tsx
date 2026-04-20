"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useStore } from "@/store/useStore";

// react-rnd touches `document` at module load, so the ChartWindow must
// be client-only. next/dynamic with ssr:false is the recommended escape
// hatch in the current App-Router Next build.
const ChartWindow = dynamic(
  () => import("./ChartWindow").then((m) => m.ChartWindow),
  { ssr: false },
);

/**
 * Canvas — the freeform workspace that replaces the single-chart slot
 * in the main content area. Hosts N `<ChartWindow>`s that can be
 * dragged, resized, and closed independently.
 *
 * Phase 1: renders every window in `useStore.chartWindows`. The store
 * auto-spawns a window on the first `addDataset` so behaviour matches
 * the pre-refactor app when there's exactly one chart.
 *
 * Phase 2 will add an "Add Chart" button + drag-from-sidebar to spawn
 * additional windows.
 */
export function Canvas() {
  const windows = useStore((s) => s.chartWindows);
  const focusedId = useStore((s) => s.focusedWindowId);
  const addChartWindow = useStore((s) => s.addChartWindow);
  const activeDataset = useStore((s) => s.activeDataset);

  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  // Track container size so windows spawned with zero dimensions can
  // fill the canvas initially, and react-rnd's bounds="parent" has
  // meaningful limits.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One-shot: if there's data loaded but no chart window (e.g. the
  // conversation was hydrated mid-session before windows existed),
  // spawn one so the user sees the chart instead of a blank canvas.
  useEffect(() => {
    if (windows.length === 0 && activeDataset) {
      addChartWindow(activeDataset);
    }
  }, [windows.length, activeDataset, addChartWindow]);

  const hasWindows = windows.length > 0;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      style={{
        background: "var(--bg)",
        // Subtle dotted grid so the workspace feels like a canvas,
        // not a blank page.
        backgroundImage:
          "radial-gradient(circle, var(--border) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      {!hasWindows && <CanvasEmptyState />}

      {hasWindows &&
        windows.map((w) => (
          <ChartWindow
            key={w.id}
            window={w}
            focused={w.id === focusedId}
            canvasBounds={bounds}
          />
        ))}
    </div>
  );
}

function CanvasEmptyState() {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center pointer-events-none"
      style={{ color: "var(--text-muted)" }}
    >
      <svg
        className="h-10 w-10"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.4}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18" />
      </svg>
      <div className="text-[12px] font-bold uppercase tracking-wider">
        Empty canvas
      </div>
      <div className="max-w-[360px] text-[10px] leading-relaxed">
        Ask the AI in the chat to fetch data — a chart window opens here for
        each fetch. Drag the title bar to move a window, drag any corner to
        resize, click the × to close. Fetch more tickers to add more charts.
      </div>
    </div>
  );
}
