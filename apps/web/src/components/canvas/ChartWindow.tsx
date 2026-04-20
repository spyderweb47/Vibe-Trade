"use client";

import { useMemo, useCallback } from "react";
import { Rnd } from "react-rnd";
import { useStore } from "@/store/useStore";
import { Chart } from "@/components/Chart";
import type { ChartWindow as ChartWindowType } from "@/types";

interface Props {
  window: ChartWindowType;
  focused: boolean;
  canvasBounds: { width: number; height: number };
}

/**
 * One floating chart window on the Canvas. Draggable by its title bar,
 * resizable from any corner or edge, and closeable via the X button in
 * the top-right corner. Clicking anywhere on the window focuses it
 * (which in turn syncs `activeDataset` for legacy skill compatibility).
 *
 * Rendering:
 *   - If the window has a valid `datasetId` that's loaded, we render a
 *     full `<Chart>` inside it — each window gets its own lightweight-
 *     charts instance, so N windows can show N different tickers in
 *     parallel.
 *   - If `datasetId` is null or the data isn't loaded, we show an empty-
 *     state placeholder with a hint to load data via chat.
 */
export function ChartWindow({ window: w, focused, canvasBounds }: Props) {
  const datasets = useStore((s) => s.datasets);
  const datasetChartData = useStore((s) => s.datasetChartData);
  const patternMatches = useStore((s) => s.patternMatches);
  const appMode = useStore((s) => s.appMode);
  const focusChartWindow = useStore((s) => s.focusChartWindow);
  const removeChartWindow = useStore((s) => s.removeChartWindow);
  const updateChartWindow = useStore((s) => s.updateChartWindow);

  const ds = useMemo(
    () => (w.datasetId ? datasets.find((d) => d.id === w.datasetId) : undefined),
    [datasets, w.datasetId],
  );
  const data = useMemo(
    () => (w.datasetId ? datasetChartData[w.datasetId] || [] : []),
    [datasetChartData, w.datasetId],
  );

  // Drag + resize handlers — persist position/size to the store so
  // layouts survive focus changes, re-renders, and conversation
  // snapshotting.
  const onDragStop = useCallback(
    (_e: unknown, d: { x: number; y: number }) => {
      updateChartWindow(w.id, { x: d.x, y: d.y });
    },
    [updateChartWindow, w.id],
  );

  const onResizeStop = useCallback(
    (
      _e: unknown,
      _dir: unknown,
      ref: HTMLElement,
      _delta: unknown,
      position: { x: number; y: number },
    ) => {
      updateChartWindow(w.id, {
        width: ref.offsetWidth,
        height: ref.offsetHeight,
        x: position.x,
        y: position.y,
      });
      // lightweight-charts needs a resize event to recompute its
      // internal canvas dimensions after the container resizes.
      globalThis.dispatchEvent(new Event("resize"));
    },
    [updateChartWindow, w.id],
  );

  const onFocus = useCallback(() => {
    if (!focused) focusChartWindow(w.id);
  }, [focused, focusChartWindow, w.id]);

  const onClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeChartWindow(w.id);
    },
    [removeChartWindow, w.id],
  );

  // If the window has no size yet (first spawn before Canvas measured
  // itself), fill ~80% of the canvas.
  const effectiveWidth = w.width > 0 ? w.width : Math.max(600, canvasBounds.width * 0.8);
  const effectiveHeight = w.height > 0 ? w.height : Math.max(400, canvasBounds.height * 0.7);

  const title = w.title || ds?.metadata?.symbol || ds?.name || "Empty chart";

  return (
    <Rnd
      size={{ width: effectiveWidth, height: effectiveHeight }}
      position={{ x: w.x, y: w.y }}
      minWidth={360}
      minHeight={240}
      bounds="parent"
      dragHandleClassName="chart-window-drag-handle"
      onDragStop={onDragStop}
      onResizeStop={onResizeStop}
      onMouseDown={onFocus}
      style={{ zIndex: w.zIndex }}
      enableResizing={{
        top: true, right: true, bottom: true, left: true,
        topRight: true, bottomRight: true, bottomLeft: true, topLeft: true,
      }}
    >
      <div
        className="flex h-full w-full flex-col rounded-lg overflow-hidden"
        style={{
          background: "var(--surface)",
          border: focused
            ? "1.5px solid var(--accent)"
            : "1px solid var(--border)",
          boxShadow: focused
            ? "0 8px 24px rgba(0, 0, 0, 0.35)"
            : "0 2px 8px rgba(0, 0, 0, 0.15)",
        }}
      >
        {/* Title bar — drag handle */}
        <div
          className="chart-window-drag-handle flex items-center gap-2 px-3 py-1.5 shrink-0 select-none cursor-move"
          style={{
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div
            className="h-2 w-2 rounded-full shrink-0"
            style={{
              background: focused ? "var(--accent)" : "var(--text-muted)",
            }}
          />
          <span
            className="text-[11px] font-bold uppercase tracking-wider"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </span>
          {ds?.metadata?.chartTimeframe && (
            <span
              className="text-[9px] uppercase"
              style={{ color: "var(--text-muted)" }}
            >
              {ds.metadata.chartTimeframe}
            </span>
          )}
          {data.length > 0 && (
            <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
              {data.length} bars
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto flex h-5 w-5 items-center justify-center rounded transition-colors"
            style={{
              color: "var(--text-muted)",
            }}
            title="Close chart"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(239, 68, 68, 0.18)";
              e.currentTarget.style.color = "#ef4444";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Chart body */}
        <div className="flex-1 min-h-0 relative">
          {w.datasetId && data.length > 0 ? (
            <Chart
              data={data}
              patternMatches={appMode === "playground" ? [] : patternMatches}
            />
          ) : (
            <EmptyChartState hasDatasetId={!!w.datasetId} />
          )}
        </div>
      </div>
    </Rnd>
  );
}

function EmptyChartState({ hasDatasetId }: { hasDatasetId: boolean }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
      style={{ background: "var(--bg)", color: "var(--text-muted)" }}
    >
      <svg
        className="h-8 w-8"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18" />
      </svg>
      <div className="text-[11px] font-bold uppercase tracking-wider">
        {hasDatasetId ? "Dataset not loaded" : "No data"}
      </div>
      <div className="text-[10px] max-w-[260px] leading-relaxed">
        {hasDatasetId
          ? "The dataset assigned to this chart isn't available in the current session."
          : "Ask the AI to fetch data, for example: \"load AAPL 1d last 2 years\". The data will appear here."}
      </div>
    </div>
  );
}
