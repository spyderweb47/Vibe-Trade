"use client";

import { useStore } from "@/store/useStore";
import { Chart } from "./Chart";
import { DrawingToolbar } from "./DrawingToolbar";
import { TileWrapper } from "./TileWrapper";

interface Props {
  tileId: string;
  onClose?: () => void;
}

/**
 * Independent chart tile for the mosaic layout. Each ChartTile is a
 * self-contained chart instance with its own dataset/timeframe. The
 * DrawingToolbar is docked to the left edge.
 *
 * For the "main" chart tile (tileId === "chart-main"), it reads from
 * the global store state (chartData, patternMatches, etc.) for backward
 * compatibility. Additional chart tiles can be added to show different
 * datasets side-by-side.
 */
export function ChartTile({ tileId, onClose }: Props) {
  const chartData = useStore((s) => s.chartData);
  const patternMatches = useStore((s) => s.patternMatches);
  const appMode = useStore((s) => s.appMode);
  const activeDataset = useStore((s) => s.activeDataset);
  const datasets = useStore((s) => s.datasets);

  // Build the label from the active dataset
  const ds = datasets.find((d) => d.id === activeDataset);
  const label = ds?.name || "Chart";

  return (
    <TileWrapper
      label={label}
      onClose={tileId !== "chart-main" ? onClose : undefined}
    >
      <div className="flex h-full w-full">
        <DrawingToolbar />
        <div className="flex-1 min-h-0">
          <Chart
            data={chartData}
            patternMatches={appMode === "playground" ? [] : patternMatches}
          />
        </div>
      </div>
    </TileWrapper>
  );
}
