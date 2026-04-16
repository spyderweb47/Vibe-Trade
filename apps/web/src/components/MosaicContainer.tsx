"use client";

import { useCallback, useState } from "react";
import { Mosaic, MosaicWindow, type MosaicNode } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";

import { useStore } from "@/store/useStore";
import { ChartTile } from "./ChartTile";
import { TileWrapper } from "./TileWrapper";
import { MetricWidget, BUILT_IN_METRICS } from "./MetricWidget";
import { BOTTOM_PANEL_COMPONENTS } from "./BottomPanel";

/**
 * "Add Widget" dropdown — lets users add new tiles to the mosaic.
 * Available widget types: metric KPIs, extra charts, popped-out tabs.
 */
function AddWidgetMenu() {
  const [open, setOpen] = useState(false);
  const addTile = useStore((s) => s.addTile);
  const setMosaicLayout = useStore((s) => s.setMosaicLayout);
  const mosaicLayout = useStore((s) => s.mosaicLayout);

  const addWidget = (type: Parameters<typeof addTile>[0]) => {
    const id = addTile(type);
    // Insert the new tile to the right of the current layout
    setMosaicLayout(
      mosaicLayout
        ? { direction: "row", first: mosaicLayout, second: id, splitPercentage: 75 }
        : id,
    );
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors hover:bg-[var(--surface-2)]"
        style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Widget
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-7 z-50 rounded-lg shadow-xl py-1"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)", minWidth: 180 }}
          >
            {/* Chart tile */}
            <button
              onClick={() => addWidget({ kind: "chart" })}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[10px] transition-colors hover:bg-[var(--surface)]"
              style={{ color: "var(--text-secondary)" }}
            >
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="var(--accent)" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              New Chart
            </button>

            {/* Separator */}
            <div className="mx-2 my-1 h-px" style={{ background: "var(--border)" }} />

            {/* Metric tiles */}
            <div className="px-3 py-1 text-[8px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              KPI Metrics
            </div>
            {Object.values(BUILT_IN_METRICS).map((m) => (
              <button
                key={m.id}
                onClick={() => addWidget({ kind: "metric", metricId: m.id, label: m.label })}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[10px] transition-colors hover:bg-[var(--surface)]"
                style={{ color: "var(--text-secondary)" }}
              >
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: "var(--accent)" }} />
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The main mosaic layout container. Bloomberg Terminal-style tiling
 * window manager for the center content area.
 */
export function MosaicContainer() {
  const layout = useStore((s) => s.mosaicLayout) as MosaicNode<string> | null;
  const setLayout = useStore((s) => s.setMosaicLayout);
  const tileRegistry = useStore((s) => s.tileRegistry);
  const removeTile = useStore((s) => s.removeTile);
  const dockTab = useStore((s) => s.dockTab);

  const onChange = useCallback(
    (newLayout: MosaicNode<string> | null) => {
      if (newLayout) setLayout(newLayout);
    },
    [setLayout],
  );

  const renderTile = useCallback(
    (tileId: string, path: number[]) => {
      const tile = tileRegistry[tileId];
      if (!tile) {
        return (
          <MosaicWindow<string> path={path} title="" toolbarControls={<></>}>
            <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
              Unknown tile
            </div>
          </MosaicWindow>
        );
      }

      let content: React.ReactNode;

      switch (tile.kind) {
        case "chart":
          content = (
            <ChartTile
              tileId={tileId}
              onClose={tileId !== "chart-main" ? () => removeTile(tileId) : undefined}
            />
          );
          break;

        case "metric":
          content = (
            <TileWrapper
              label={tile.label || "Metric"}
              onClose={() => removeTile(tileId)}
            >
              <MetricWidget metricId={tile.metricId || "price"} />
            </TileWrapper>
          );
          break;

        case "tab": {
          const Cmp = tile.component ? BOTTOM_PANEL_COMPONENTS[tile.component] : null;
          content = (
            <TileWrapper
              label={tile.label || tile.tabId || "Tab"}
              onDock={tile.tabId ? () => dockTab(tile.tabId!) : undefined}
              onClose={() => {
                if (tile.tabId) dockTab(tile.tabId);
                removeTile(tileId);
              }}
            >
              {Cmp ? <Cmp /> : (
                <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>
                  Component not found: {tile.component}
                </div>
              )}
            </TileWrapper>
          );
          break;
        }

        case "dag_graph": {
          const DAGCmp = BOTTOM_PANEL_COMPONENTS["DAGGraphTab"];
          content = (
            <TileWrapper label="DAG Graph" onClose={() => removeTile(tileId)}>
              {DAGCmp ? <DAGCmp /> : <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>DAG not found</div>}
            </TileWrapper>
          );
          break;
        }

        default:
          content = <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>Unknown tile kind</div>;
      }

      return (
        <MosaicWindow<string> path={path} title="" toolbarControls={<></>} draggable>
          {content}
        </MosaicWindow>
      );
    },
    [tileRegistry, removeTile, dockTab],
  );

  if (!layout) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--text-muted)" }}>
        No layout configured
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative">
      {/* Floating "+ Widget" button */}
      <div className="absolute top-1 right-1 z-10">
        <AddWidgetMenu />
      </div>

      <Mosaic<string>
        renderTile={renderTile}
        value={layout}
        onChange={onChange}
        className="mosaic-blueprint-theme"
        zeroStateView={
          <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
            Drag tiles to arrange your workspace
          </div>
        }
      />
    </div>
  );
}
