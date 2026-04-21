import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  Time,
  IChartApi,
  ISeriesApi,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { NewsEvent, OHLCBar } from "@/types";

/**
 * Renders Historic News events on the chart as vertical dashed lines +
 * colored dots. Hover tooltip is rendered by the surrounding Chart.tsx
 * via mouse-move handlers; this primitive is purely visual.
 *
 * Used by the `historic_news` skill — newsEvents land in the store,
 * Chart.tsx passes them to this primitive, each event renders at its
 * `timestamp` (unix seconds). Color + height reflect `direction` and
 * `impact`. The currently-selected event (from HistoricNewsTab)
 * renders with a larger ring + solid border to draw the eye.
 */

interface NewsMarker {
  id: string;
  x: number;       // pixel x at the event's timestamp
  color: string;
  borderColor: string;
  height: number;  // px — taller = higher impact
  selected: boolean;
  glyph: string;   // single character representing category
}

const CATEGORY_GLYPH: Record<string, string> = {
  earnings:     "$",
  regulatory:   "§",
  macro:        "M",
  product:      "★",
  sentiment:    "◉",
  geopolitical: "⚑",
  technical:    "T",
};

const DIR_COLOR: Record<string, { fill: string; border: string }> = {
  bullish: { fill: "rgba(34, 197, 94, 0.85)",  border: "#22c55e" },
  bearish: { fill: "rgba(239, 68, 68, 0.85)",  border: "#ef4444" },
  neutral: { fill: "rgba(255, 107, 0, 0.85)",  border: "#ff6b00" },
};

const IMPACT_HEIGHT: Record<string, number> = {
  high:   1.0,   // full chart height
  medium: 0.65,
  low:    0.4,
};

class NewsRenderer implements IPrimitivePaneRenderer {
  private _markers: NewsMarker[] = [];
  private _chartHeight = 0;

  update(markers: NewsMarker[], chartHeight: number) {
    this._markers = markers;
    this._chartHeight = chartHeight;
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const fullH = mediaSize.height || this._chartHeight || 400;
      for (const m of this._markers) {
        if (!isFinite(m.x) || m.x < -20) continue;
        const lineH = fullH * m.height;
        const lineY1 = fullH - lineH;
        // Vertical dashed line
        ctx.strokeStyle = m.borderColor;
        ctx.lineWidth = m.selected ? 1.5 : 1;
        ctx.setLineDash(m.selected ? [] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(m.x, lineY1);
        ctx.lineTo(m.x, fullH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  }

  draw(target: CanvasRenderingTarget2D): void {
    // Dots + glyphs render in the FOREGROUND so they're not hidden
    // behind candles.
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const fullH = mediaSize.height || this._chartHeight || 400;
      for (const m of this._markers) {
        if (!isFinite(m.x) || m.x < -20) continue;
        const topY = fullH * (1 - m.height);
        const cy = Math.max(10, topY - 4);
        const r = m.selected ? 8 : 6;

        // Filled circle
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(m.x, cy, r, 0, Math.PI * 2);
        ctx.fill();

        // White stroke for contrast against candles
        ctx.strokeStyle = m.selected ? "#ffffff" : "rgba(255,255,255,0.7)";
        ctx.lineWidth = m.selected ? 2 : 1.5;
        ctx.stroke();

        // Category glyph centered in dot
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${m.selected ? 10 : 9}px 'Inter', sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(m.glyph, m.x, cy + 0.5);
      }
    });
  }
}

class NewsPaneView implements IPrimitivePaneView {
  _renderer = new NewsRenderer();
  update(markers: NewsMarker[], chartHeight: number) {
    this._renderer.update(markers, chartHeight);
  }
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer { return this._renderer; }
}

export class NewsMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<"Candlestick"> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _paneView = new NewsPaneView();
  private _events: NewsEvent[] = [];
  private _data: OHLCBar[] = [];
  private _selectedId: string | null = null;

  attached(param: SeriesAttachedParameter<Time, "Candlestick">) {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<"Candlestick">;
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  setEvents(events: NewsEvent[], data: OHLCBar[], selectedId: string | null) {
    this._events = events;
    this._data = data;
    this._selectedId = selectedId;
    this.updateAllViews();
    this._requestUpdate?.();
  }

  clear() {
    this._events = [];
    this._selectedId = null;
    this._paneView.update([], 0);
    this._requestUpdate?.();
  }

  updateAllViews() {
    if (!this._chart || !this._series) {
      this._paneView.update([], 0);
      return;
    }
    const ts = this._chart.timeScale();
    const markers: NewsMarker[] = [];

    for (const ev of this._events) {
      // Snap event timestamp to the nearest bar so the marker lines up
      // with candles (news timestamps often don't match bar open times).
      let bestTime: number | null = null;
      let bestDelta = Infinity;
      for (const bar of this._data) {
        const bt = bar.time as number;
        const delta = Math.abs(bt - ev.timestamp);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestTime = bt;
        }
      }
      if (bestTime == null) continue;
      const x = ts.timeToCoordinate(bestTime as unknown as Time);
      if (x == null) continue;

      const dir = DIR_COLOR[ev.direction] || DIR_COLOR.neutral;
      markers.push({
        id: ev.id,
        x,
        color: dir.fill,
        borderColor: dir.border,
        height: IMPACT_HEIGHT[ev.impact] ?? 0.65,
        selected: ev.id === this._selectedId,
        glyph: CATEGORY_GLYPH[ev.category] || "●",
      });
    }

    const chartEl = this._chart ? (this._chart as unknown as { chartElement?: () => HTMLElement }).chartElement?.() : null;
    const h = chartEl?.clientHeight ?? 400;
    this._paneView.update(markers, h);
  }

  paneViews(): readonly IPrimitivePaneView[] { return [this._paneView]; }
}
