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
 * Independent chart tile. Reads from the global store for the main chart,
 * and subscribes to dashboardParams for parameter linking. When the user
 * changes the dataset, the dashboardParams.ticker updates and all linked
 * widgets (metrics, other charts) react.
 */
export function ChartTile({ tileId, onClose }: Props) {
  const chartData = useStore((s) => s.chartData);
  const patternMatches = useStore((s) => s.patternMatches);
  const appMode = useStore((s) => s.appMode);
  const activeDataset = useStore((s) => s.activeDataset);
  const datasets = useStore((s) => s.datasets);
  const setDashboardParam = useStore((s) => s.setDashboardParam);

  // Build label from active dataset
  const ds = datasets.find((d) => d.id === activeDataset);
  const label = ds?.name || "Chart";

  // When this chart loads data, update dashboardParams so linked widgets sync
  const lastBar = chartData.length > 0 ? chartData[chartData.length - 1] : null;

  return (
    <TileWrapper
      label={label}
      onClose={onClose}
      lastUpdated={lastBar ? lastBar.time * 1000 : null}
      onRefresh={() => {
        // Trigger a re-render by touching dashboardParams
        if (ds?.name) setDashboardParam("ticker", ds.name);
      }}
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
