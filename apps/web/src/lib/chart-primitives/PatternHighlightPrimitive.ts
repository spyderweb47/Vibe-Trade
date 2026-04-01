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
import type { PatternMatch, OHLCBar } from "@/types";

interface HighlightBox {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  splitX: number;
  label: string;
  confidence: number;
  direction: "bullish" | "bearish" | "neutral";
}

const TRIGGER_FILL = "rgba(59, 130, 246, 0.07)";
const TRIGGER_BORDER = "rgba(59, 130, 246, 0.35)";
const TRADE_BULLISH_FILL = "rgba(34, 197, 94, 0.10)";
const TRADE_BULLISH_BORDER = "rgba(34, 197, 94, 0.45)";
const TRADE_BEARISH_FILL = "rgba(239, 68, 68, 0.10)";
const TRADE_BEARISH_BORDER = "rgba(239, 68, 68, 0.45)";
const TRADE_NEUTRAL_FILL = "rgba(99, 102, 241, 0.10)";
const TRADE_NEUTRAL_BORDER = "rgba(99, 102, 241, 0.45)";

class HighlightRenderer implements IPrimitivePaneRenderer {
  private _boxes: HighlightBox[] = [];

  update(boxes: HighlightBox[]) { this._boxes = boxes; }

  drawBackground(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const box of this._boxes) {
        const x1 = Math.min(box.x1, box.x2);
        const x2 = Math.max(box.x1, box.x2);
        const y1 = Math.min(box.y1, box.y2);
        const y2 = Math.max(box.y1, box.y2);
        const w = x2 - x1;
        const h = y2 - y1;
        if (w < 4 || h < 4) continue;

        const splitX = Math.max(x1 + 2, Math.min(box.splitX, x2 - 2));
        const triggerW = splitX - x1;
        const tradeW = x2 - splitX;
        const dir = box.direction;

        // === TRIGGER ZONE (left — blue) ===
        ctx.fillStyle = TRIGGER_FILL;
        ctx.fillRect(x1, y1, triggerW, h);
        ctx.strokeStyle = TRIGGER_BORDER;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.strokeRect(x1, y1, triggerW, h);

        // === TRADE ZONE (right — colored) ===
        ctx.fillStyle = dir === "bullish" ? TRADE_BULLISH_FILL
          : dir === "bearish" ? TRADE_BEARISH_FILL : TRADE_NEUTRAL_FILL;
        ctx.fillRect(splitX, y1, tradeW, h);
        ctx.strokeStyle = dir === "bullish" ? TRADE_BULLISH_BORDER
          : dir === "bearish" ? TRADE_BEARISH_BORDER : TRADE_NEUTRAL_BORDER;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(splitX, y1, tradeW, h);

        // === SPLIT LINE (dashed) ===
        ctx.strokeStyle = "rgba(100, 116, 139, 0.5)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(splitX, y1);
        ctx.lineTo(splitX, y2);
        ctx.stroke();
        ctx.setLineDash([]);

        // === CONNECTOR ARROW at split point ===
        const midY = (y1 + y2) / 2;
        ctx.fillStyle = "rgba(100, 116, 139, 0.6)";
        ctx.beginPath();
        ctx.moveTo(splitX - 4, midY - 5);
        ctx.lineTo(splitX + 4, midY);
        ctx.lineTo(splitX - 4, midY + 5);
        ctx.closePath();
        ctx.fill();

        // === LABELS ===
        ctx.font = "bold 8px 'Chakra Petch', sans-serif";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";

        // Trigger label (top-left of trigger zone)
        if (triggerW > 35) {
          ctx.fillStyle = TRIGGER_BORDER;
          ctx.fillText("TRIGGER", x1 + 3, y1 + 3);
        }

        // Trade label with confidence (top-left of trade zone)
        const tradeBorderColor = dir === "bullish" ? TRADE_BULLISH_BORDER
          : dir === "bearish" ? TRADE_BEARISH_BORDER : TRADE_NEUTRAL_BORDER;
        if (tradeW > 25) {
          ctx.fillStyle = tradeBorderColor;
          const pct = Math.round(box.confidence * 100);
          ctx.fillText(`TRADE ${pct}%`, splitX + 3, y1 + 3);
        }

        // Direction arrow at bottom of trade zone
        ctx.font = "bold 10px 'Chakra Petch', sans-serif";
        ctx.textBaseline = "bottom";
        ctx.textAlign = "right";
        ctx.fillStyle = tradeBorderColor;
        const arrow = dir === "bullish" ? "\u25B2" : dir === "bearish" ? "\u25BC" : "\u25C6";
        ctx.fillText(arrow, x2 - 3, y2 - 3);

        // Entry/Exit markers on split line
        ctx.font = "bold 7px 'Chakra Petch', sans-serif";
        ctx.fillStyle = "rgba(100, 116, 139, 0.7)";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("ENTRY", splitX, y1 - 2);
        ctx.textBaseline = "top";
        ctx.fillText("EXIT", x2, y2 + 2);
      }
    });
  }

  draw(): void {}
}

class HighlightPaneView implements IPrimitivePaneView {
  _renderer = new HighlightRenderer();
  update(boxes: HighlightBox[]) { this._renderer.update(boxes); }
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return this._renderer; }
}

let _triggerRatio = 0.6;
export function setTriggerRatio(ratio: number) {
  _triggerRatio = Math.max(0.1, Math.min(0.9, ratio));
}

export class PatternHighlightPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<"Candlestick"> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _paneView = new HighlightPaneView();
  private _matches: PatternMatch[] = [];
  private _data: OHLCBar[] = [];

  attached(param: SeriesAttachedParameter<Time, "Candlestick">) {
    this._chart = param.chart as IChartApi;
    this._series = param.series as ISeriesApi<"Candlestick">;
    this._requestUpdate = param.requestUpdate;
  }

  detached() { this._chart = null; this._series = null; this._requestUpdate = null; }

  setMatches(matches: PatternMatch[], data: OHLCBar[]) {
    this._matches = matches;
    this._data = data;
    this.updateAllViews();
    this._requestUpdate?.();
  }

  clear() {
    this._matches = [];
    this._paneView.update([]);
    this._requestUpdate?.();
  }

  updateAllViews() {
    if (!this._chart || !this._series || this._data.length === 0) {
      this._paneView.update([]);
      return;
    }

    const ts = this._chart.timeScale();
    const series = this._series;
    const boxes: HighlightBox[] = [];

    for (const m of this._matches) {
      const startT = typeof m.startTime === "string" ? Number(m.startTime) : (m.startTime as unknown as number);
      const endT = typeof m.endTime === "string" ? Number(m.endTime) : (m.endTime as unknown as number);

      let minPrice = Infinity, maxPrice = -Infinity, barCount = 0;
      for (const bar of this._data) {
        const t = bar.time as number;
        if (t >= startT && t <= endT) {
          if (bar.low < minPrice) minPrice = bar.low;
          if (bar.high > maxPrice) maxPrice = bar.high;
          barCount++;
        }
      }
      if (minPrice === Infinity || barCount < 2) continue;

      const pad = (maxPrice - minPrice) * 0.08;
      minPrice -= pad;
      maxPrice += pad;

      const snap = (raw: number): Time | null => {
        let best: number | null = null, bestD = Infinity;
        for (const bar of this._data) {
          const d = Math.abs((bar.time as number) - raw);
          if (d < bestD) { bestD = d; best = bar.time as number; }
        }
        return best as unknown as Time;
      };

      const t1 = snap(startT);
      const t2 = snap(endT);
      if (!t1 || !t2) continue;

      const x1 = ts.timeToCoordinate(t1);
      const x2 = ts.timeToCoordinate(t2);
      const y1 = series.priceToCoordinate(maxPrice);
      const y2 = series.priceToCoordinate(minPrice);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;

      const splitX = x1 + (x2 - x1) * _triggerRatio;

      boxes.push({ x1, x2, y1, y2, splitX, label: m.name, confidence: m.confidence, direction: m.direction });
    }

    this._paneView.update(boxes);
  }

  paneViews(): readonly IPrimitivePaneView[] { return [this._paneView]; }
}
