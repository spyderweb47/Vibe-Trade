"use client";

import { useCallback } from "react";
import { Mosaic, MosaicWindow, type MosaicNode } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";

import { useStore } from "@/store/useStore";
import { ChartTile } from "./ChartTile";
import { TileWrapper } from "./TileWrapper";
import { BOTTOM_PANEL_COMPONENTS } from "./BottomPanel";

/**
 * The main mosaic layout container. Replaces the fixed center content
 * area with a Bloomberg Terminal-style tiling window manager.
 *
 * Default layout: single chart tile on top (70%) + bottom panel (30%).
 * Users can drag dividers to resize, and pop out bottom-panel tabs as
 * independent mosaic tiles.
 */
export function MosaicContainer() {
  const layout = useStore((s) => s.mosaicLayout) as MosaicNode<string> | null;
  const setLayout = useStore((s) => s.setMosaicLayout);
  const tileRegistry = useStore((s) => s.tileRegistry);
  const removeTile = useStore((s) => s.removeTile);
  const dockTab = useStore((s) => s.dockTab);
  const poppedOutTabs = useStore((s) => s.poppedOutTabs);

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
          <MosaicWindow<string> path={path} title="">
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
              {DAGCmp ? <DAGCmp /> : <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>DAG component not found</div>}
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
    [tileRegistry, removeTile, dockTab, poppedOutTabs],
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
