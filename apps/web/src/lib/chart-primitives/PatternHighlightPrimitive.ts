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
import type { PatternMatch, OHLCBar, PatternDrawing } from "@/types";

interface HighlightBox {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  label: string;
  confidence: number;
  direction: "bullish" | "bearish" | "neutral";
  /** Per-match drawing primitives resolved to pixel coordinates. */
  drawings?: ResolvedDrawing[];
}

/** A drawing with every (idx, price) pair converted to (x, y) pixel. */
type ResolvedDrawing =
  | {
      kind: "trendline";
      x1: number; y1: number; x2: number; y2: number;
      color: string; dashed: boolean; label?: string;
    }
  | {
      kind: "horizontal_line";
      x1: number; x2: number; y: number;
      color: string; dashed: boolean; label?: string;
    }
  | {
      kind: "point";
      x: number; y: number; color: string; label?: string;
    }
  | {
      kind: "label";
      x: number; y: number; text: string; color: string;
    }
  | {
      kind: "fibonacci";
      x1: number; x2: number; y1: number; y2: number;
      levels: number[];
    };

const BULLISH_FILL = "rgba(34, 197, 94, 0.10)";
const BULLISH_BORDER = "rgba(34, 197, 94, 0.55)";
const BEARISH_FILL = "rgba(239, 68, 68, 0.10)";
const BEARISH_BORDER = "rgba(239, 68, 68, 0.55)";
const NEUTRAL_FILL = "rgba(255, 107, 0, 0.10)";
const NEUTRAL_BORDER = "rgba(255, 107, 0, 0.55)";

const FIB_LEVELS_DEFAULT = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS: Record<string, string> = {
  "0":     "#787b86",
  "0.236": "#ff4d4d",
  "0.382": "#ffb020",
  "0.5":   "#00d68f",
  "0.618": "#00bcd4",
  "0.786": "#ff6b00",
  "1":     "#787b86",
};

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

        const dir = box.direction;
        const fill = dir === "bullish" ? BULLISH_FILL : dir === "bearish" ? BEARISH_FILL : NEUTRAL_FILL;
        const border = dir === "bullish" ? BULLISH_BORDER : dir === "bearish" ? BEARISH_BORDER : NEUTRAL_BORDER;

        // Single pattern box
        ctx.fillStyle = fill;
        ctx.fillRect(x1, y1, w, h);
        ctx.strokeStyle = border;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.strokeRect(x1, y1, w, h);

        // Label with confidence
        ctx.font = "bold 9px 'Inter', sans-serif";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.fillStyle = border;
        const pct = Math.round(box.confidence * 100);
        if (w > 40) {
          ctx.fillText(`PATTERN ${pct}%`, x1 + 4, y1 + 4);
        }

        // Direction arrow at bottom-right
        ctx.font = "bold 11px 'Inter', sans-serif";
        ctx.textBaseline = "bottom";
        ctx.textAlign = "right";
        const arrow = dir === "bullish" ? "\u25B2" : dir === "bearish" ? "\u25BC" : "\u25C6";
        ctx.fillText(arrow, x2 - 4, y2 - 4);

        // ─── Per-match drawings (on top of the box) ──────────────
        if (box.drawings && box.drawings.length > 0) {
          this._drawAnnotations(ctx, box.drawings, border);
        }
      }
    });
  }

  private _drawAnnotations(
    ctx: CanvasRenderingContext2D,
    drawings: ResolvedDrawing[],
    defaultColor: string,
  ): void {
    for (const d of drawings) {
      if (d.kind === "trendline") {
        ctx.strokeStyle = d.color || defaultColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(d.dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(d.x1, d.y1);
        ctx.lineTo(d.x2, d.y2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (d.label) {
          ctx.font = "bold 9px 'Inter', sans-serif";
          ctx.textBaseline = "bottom";
          ctx.textAlign = "center";
          ctx.fillStyle = d.color || defaultColor;
          ctx.fillText(d.label, (d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2 - 3);
        }
      } else if (d.kind === "horizontal_line") {
        ctx.strokeStyle = d.color || defaultColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(d.dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(d.x1, d.y);
        ctx.lineTo(d.x2, d.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (d.label) {
          ctx.font = "bold 9px 'Inter', sans-serif";
          ctx.textBaseline = "bottom";
          ctx.textAlign = "left";
          ctx.fillStyle = d.color || defaultColor;
          ctx.fillText(d.label, d.x1 + 4, d.y - 3);
        }
      } else if (d.kind === "point") {
        const color = d.color || defaultColor;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (d.label) {
          ctx.font = "bold 10px 'Inter', sans-serif";
          ctx.textBaseline = "bottom";
          ctx.textAlign = "center";
          ctx.fillStyle = color;
          // Draw a tiny text shadow for readability over candles
          ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
          ctx.lineWidth = 3;
          ctx.strokeText(d.label, d.x, d.y - 8);
          ctx.fillText(d.label, d.x, d.y - 8);
        }
      } else if (d.kind === "label") {
        ctx.font = "bold 10px 'Inter', sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillStyle = d.color || defaultColor;
        // Shadow for readability
        ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
        ctx.lineWidth = 3;
        ctx.strokeText(d.text, d.x + 4, d.y);
        ctx.fillText(d.text, d.x + 4, d.y);
      } else if (d.kind === "fibonacci") {
        const levels = d.levels.length > 0 ? d.levels : FIB_LEVELS_DEFAULT;
        const minY = Math.min(d.y1, d.y2);
        const maxY = Math.max(d.y1, d.y2);
        const height = maxY - minY;
        const x1 = Math.min(d.x1, d.x2);
        const x2 = Math.max(d.x1, d.x2);
        ctx.lineWidth = 1;
        for (const level of levels) {
          const y = minY + height * level;
          const key = String(level);
          const color = FIB_COLORS[key] || defaultColor;
          ctx.strokeStyle = color;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "9px 'Inter', sans-serif";
          ctx.textBaseline = "middle";
          ctx.textAlign = "right";
          ctx.fillStyle = color;
          ctx.fillText(`${(level * 100).toFixed(1)}%`, x1 - 2, y);
        }
      }
    }
  }

  draw(): void {}
}

class HighlightPaneView implements IPrimitivePaneView {
  _renderer = new HighlightRenderer();
  update(boxes: HighlightBox[]) { this._renderer.update(boxes); }
  zOrder(): "bottom" { return "bottom"; }
  renderer(): IPrimitivePaneRenderer { return this._renderer; }
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
      // Allow single-bar patterns (hammer, doji, engulfing)
      if (minPrice === Infinity || barCount < 1) continue;

      // Pad the price box so the label doesn't collide with wicks; at least
      // 0.2% of mid-price when the bar range is near zero (identical OHLC)
      const midPrice = (maxPrice + minPrice) / 2;
      const rawSpan = maxPrice - minPrice;
      const pad = Math.max(rawSpan * 0.12, Math.abs(midPrice) * 0.002);
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

      // Resolve per-match drawings from (idx, price) → (x, y) pixels.
      // Bad / out-of-range drawings are dropped silently so a
      // partially-broken match still renders its box + valid drawings.
      const resolvedDrawings = this._resolveDrawings(
        m.drawings, this._data, ts, series, m.startIndex, m.endIndex, x1, x2,
      );

      boxes.push({
        x1, x2, y1, y2,
        label: m.name,
        confidence: m.confidence,
        direction: m.direction,
        drawings: resolvedDrawings,
      });
    }

    this._paneView.update(boxes);
  }

  /**
   * Convert (idx, price) coords in each PatternDrawing into the
   * pixel-space ResolvedDrawing the renderer consumes. Returns
   * undefined when `input` is empty so the renderer can skip the
   * annotations loop entirely.
   */
  private _resolveDrawings(
    input: PatternDrawing[] | undefined,
    data: OHLCBar[],
    ts: ReturnType<IChartApi["timeScale"]>,
    series: ISeriesApi<"Candlestick">,
    boxStartIdx: number,
    boxEndIdx: number,
    boxX1: number,
    boxX2: number,
  ): ResolvedDrawing[] | undefined {
    if (!input || input.length === 0) return undefined;

    // Helper: idx → pixel x. Out-of-range → null.
    const idxToX = (idx: number): number | null => {
      if (idx < 0 || idx >= data.length) return null;
      const t = data[idx].time as unknown as Time;
      const x = ts.timeToCoordinate(t);
      return x ?? null;
    };

    const priceToY = (price: number): number | null => {
      const y = series.priceToCoordinate(price);
      return y ?? null;
    };

    const out: ResolvedDrawing[] = [];
    for (const d of input) {
      try {
        if (d.type === "trendline" && Array.isArray(d.points) && d.points.length >= 2) {
          const x1 = idxToX(d.points[0].idx);
          const y1 = priceToY(d.points[0].price);
          const x2 = idxToX(d.points[1].idx);
          const y2 = priceToY(d.points[1].price);
          if (x1 != null && y1 != null && x2 != null && y2 != null) {
            out.push({
              kind: "trendline", x1, y1, x2, y2,
              color: d.color || "",
              dashed: !!d.dashed,
              label: d.label,
            });
          }
        } else if (d.type === "horizontal_line" && typeof d.price === "number") {
          const y = priceToY(d.price);
          // Default span to the bounding box if no explicit idx range
          const sIdx = d.start_idx ?? boxStartIdx;
          const eIdx = d.end_idx ?? boxEndIdx;
          const x1 = idxToX(sIdx) ?? boxX1;
          const x2 = idxToX(eIdx) ?? boxX2;
          if (y != null) {
            out.push({
              kind: "horizontal_line",
              x1, x2, y,
              color: d.color || "",
              dashed: !!d.dashed,
              label: d.label,
            });
          }
        } else if (d.type === "point" && typeof d.idx === "number" && typeof d.price === "number") {
          const x = idxToX(d.idx);
          const y = priceToY(d.price);
          if (x != null && y != null) {
            out.push({
              kind: "point", x, y,
              color: d.color || "",
              label: d.label,
            });
          }
        } else if (d.type === "label" && typeof d.idx === "number" && typeof d.price === "number" && typeof d.text === "string") {
          const x = idxToX(d.idx);
          const y = priceToY(d.price);
          if (x != null && y != null) {
            out.push({
              kind: "label", x, y, text: d.text,
              color: d.color || "",
            });
          }
        } else if (d.type === "fibonacci" && Array.isArray(d.points) && d.points.length >= 2) {
          const x1 = idxToX(d.points[0].idx);
          const y1 = priceToY(d.points[0].price);
          const x2 = idxToX(d.points[1].idx);
          const y2 = priceToY(d.points[1].price);
          if (x1 != null && y1 != null && x2 != null && y2 != null) {
            out.push({
              kind: "fibonacci", x1, y1, x2, y2,
              levels: Array.isArray(d.levels) ? d.levels : [],
            });
          }
        }
      } catch {
        // Malformed individual drawing — silently drop, keep going
      }
    }
    return out.length > 0 ? out : undefined;
  }

  paneViews(): readonly IPrimitivePaneView[] { return [this._paneView]; }
}
