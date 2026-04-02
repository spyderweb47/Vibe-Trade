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
import type { OHLCBar } from "@/types";
import type { PineDrawings, PineBox, PineLine, PineLabel, PineFill } from "@/lib/pine/pineDrawings";

class PineDrawingsRenderer implements IPrimitivePaneRenderer {
  private _boxes: { x1: number; y1: number; x2: number; y2: number; bgColor: string; borderColor: string; borderWidth: number; text: string; textColor: string }[] = [];
  private _lines: { x1: number; y1: number; x2: number; y2: number; color: string; width: number; dashed: boolean }[] = [];
  private _labels: { x: number; y: number; text: string; color: string; textColor: string; above: boolean }[] = [];
  private _fills: { points1: { x: number; y: number }[]; points2: { x: number; y: number }[]; color: string }[] = [];

  update(
    boxes: typeof this._boxes,
    lines: typeof this._lines,
    labels: typeof this._labels,
    fills: typeof this._fills,
  ) {
    this._boxes = boxes;
    this._lines = lines;
    this._labels = labels;
    this._fills = fills;
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      // Draw fills (between two plot lines)
      for (const f of this._fills) {
        if (f.points1.length < 2 || f.points2.length < 2) continue;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        // Trace forward along plot1
        ctx.moveTo(f.points1[0].x, f.points1[0].y);
        for (let i = 1; i < f.points1.length; i++) {
          ctx.lineTo(f.points1[i].x, f.points1[i].y);
        }
        // Trace backward along plot2
        for (let i = f.points2.length - 1; i >= 0; i--) {
          ctx.lineTo(f.points2[i].x, f.points2[i].y);
        }
        ctx.closePath();
        ctx.fill();
      }

      // Draw boxes (behind everything)
      for (const b of this._boxes) {
        const x = Math.min(b.x1, b.x2);
        const y = Math.min(b.y1, b.y2);
        const w = Math.abs(b.x2 - b.x1);
        const h = Math.abs(b.y2 - b.y1);
        if (w < 1 || h < 1) continue;

        // Fill
        ctx.fillStyle = b.bgColor;
        ctx.fillRect(x, y, w, h);

        // Border
        if (b.borderColor !== "transparent" && b.borderWidth > 0) {
          ctx.strokeStyle = b.borderColor;
          ctx.lineWidth = b.borderWidth;
          ctx.setLineDash([]);
          ctx.strokeRect(x, y, w, h);
        }

        // Text
        if (b.text) {
          ctx.fillStyle = b.textColor;
          ctx.font = "11px 'Chakra Petch', sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(b.text, x + w / 2, y + h / 2);
        }
      }
    });
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      // Draw lines
      for (const l of this._lines) {
        ctx.strokeStyle = l.color;
        ctx.lineWidth = l.width;
        ctx.setLineDash(l.dashed ? [5, 3] : []);
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Draw labels
      for (const lb of this._labels) {
        const padding = 4;
        ctx.font = "10px 'Chakra Petch', sans-serif";
        const metrics = ctx.measureText(lb.text);
        const textW = metrics.width + padding * 2;
        const textH = 16;

        // Background bubble
        const bx = lb.x - textW / 2;
        const by = lb.above ? lb.y - textH - 4 : lb.y + 4;

        ctx.fillStyle = lb.color;
        ctx.beginPath();
        ctx.roundRect(bx, by, textW, textH, 3);
        ctx.fill();

        // Arrow
        ctx.beginPath();
        if (lb.above) {
          ctx.moveTo(lb.x - 4, by + textH);
          ctx.lineTo(lb.x, by + textH + 4);
          ctx.lineTo(lb.x + 4, by + textH);
        } else {
          ctx.moveTo(lb.x - 4, by);
          ctx.lineTo(lb.x, by - 4);
          ctx.lineTo(lb.x + 4, by);
        }
        ctx.fill();

        // Text
        ctx.fillStyle = lb.textColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lb.text, lb.x, by + textH / 2);
      }
    });
  }
}

class PineDrawingsPaneView implements IPrimitivePaneView {
  _renderer = new PineDrawingsRenderer();

  update(
    boxes: Parameters<PineDrawingsRenderer["update"]>[0],
    lines: Parameters<PineDrawingsRenderer["update"]>[1],
    labels: Parameters<PineDrawingsRenderer["update"]>[2],
    fills: Parameters<PineDrawingsRenderer["update"]>[3],
  ) {
    this._renderer.update(boxes, lines, labels, fills);
  }

  zOrder(): "normal" { return "normal"; }
  renderer(): IPrimitivePaneRenderer { return this._renderer; }
}

export class PineDrawingsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<"Candlestick"> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _paneView = new PineDrawingsPaneView();

  private _drawings: PineDrawings = { boxes: [], lines: [], labels: [], fills: [] };
  private _data: OHLCBar[] = [];
  private _plotData: Record<string, (number | null)[]> = {};

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

  setDrawings(drawings: PineDrawings, data: OHLCBar[], plotData?: Record<string, (number | null)[]>) {
    this._drawings = drawings;
    this._data = data;
    this._plotData = plotData || {};
    this.updateAllViews();
    this._requestUpdate?.();
  }

  clear() {
    this._drawings = { boxes: [], lines: [], labels: [], fills: [] };
    this._plotData = {};
    this._paneView.update([], [], [], []);
    this._requestUpdate?.();
  }

  /** Convert bar_index to time, handling negative indices */
  private _barIdxToTime(idx: number): Time | null {
    if (this._data.length === 0) return null;
    // PineTS bar_index is 0-based from start of data
    const clampedIdx = Math.max(0, Math.min(idx, this._data.length - 1));
    return this._data[clampedIdx].time as Time;
  }

  private _timeToX(t: Time): number | null {
    return this._chart?.timeScale().timeToCoordinate(t) ?? null;
  }

  private _priceToY(p: number): number | null {
    return this._series?.priceToCoordinate(p) ?? null;
  }

  private _barIdxToX(idx: number): number | null {
    const t = this._barIdxToTime(idx);
    if (!t) return null;
    return this._timeToX(t);
  }

  updateAllViews() {
    if (!this._chart || !this._series || this._data.length === 0) {
      this._paneView.update([], [], [], []);
      return;
    }

    // Convert boxes
    const pixelBoxes = this._drawings.boxes.map(b => {
      const x1 = this._barIdxToX(b.left);
      const x2 = this._barIdxToX(b.right);
      const y1 = this._priceToY(b.top);
      const y2 = this._priceToY(b.bottom);
      if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
      return { x1, y1, x2, y2, bgColor: b.bgColor, borderColor: b.borderColor, borderWidth: b.borderWidth, text: b.text, textColor: b.textColor };
    }).filter(Boolean) as any[];

    // Convert lines
    const pixelLines = this._drawings.lines.map(l => {
      let x1: number | null, y1: number | null, x2: number | null, y2: number | null;

      x1 = this._barIdxToX(l.x1);
      y1 = l.y1 != null ? this._priceToY(l.y1) : null;
      x2 = this._barIdxToX(l.x2);
      y2 = l.y2 != null ? this._priceToY(l.y2) : null;

      if (x1 == null || y1 == null || x2 == null || y2 == null) return null;

      // Handle extend
      if (l.extend === "both" || l.extend === "left" || l.extend === "right") {
        // For extended lines, stretch to canvas edges
        // Simplified: just extend by 5000px
        if (l.extend === "both" || l.extend === "left") x1 -= 5000;
        if (l.extend === "both" || l.extend === "right") x2 += 5000;
        // For vertical lines where y1 === y2 (horizontal extend)
        if (l.y1 === l.y2) {
          y1 -= 5000;
          y2 += 5000;
        }
      }

      const dashed = l.style === "style_dashed" || l.style === "style_dotted";
      return { x1, y1, x2, y2, color: l.color, width: l.width, dashed };
    }).filter(Boolean) as any[];

    // Convert labels
    const pixelLabels = this._drawings.labels.map(lb => {
      const x = this._barIdxToX(lb.x);
      const y = this._priceToY(lb.y);
      if (x == null || y == null) return null;
      const above = lb.style.includes("down"); // label_down = appears above the point
      return { x, y, text: lb.text, color: lb.color, textColor: lb.textColor, above };
    }).filter(Boolean) as any[];

    // Convert fills — map plot1/plot2 values to pixel coordinates
    const pixelFills = (this._drawings.fills || []).map(f => {
      const vals1 = this._plotData[f.plot1Name];
      const vals2 = this._plotData[f.plot2Name];
      if (!vals1 || !vals2) return null;

      const points1: { x: number; y: number }[] = [];
      const points2: { x: number; y: number }[] = [];

      for (let i = 0; i < this._data.length; i++) {
        const v1 = vals1[i];
        const v2 = vals2[i];
        if (v1 == null || v2 == null) continue;

        const x = this._barIdxToX(i);
        const y1 = this._priceToY(v1);
        const y2 = this._priceToY(v2);
        if (x == null || y1 == null || y2 == null) continue;

        points1.push({ x, y: y1 });
        points2.push({ x, y: y2 });
      }

      return { points1, points2, color: f.color };
    }).filter(Boolean) as any[];

    this._paneView.update(pixelBoxes, pixelLines, pixelLabels, pixelFills);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }
}
