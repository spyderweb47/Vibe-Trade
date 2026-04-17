import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitiveHoveredItem,
  Time,
  IChartApi,
  ISeriesApi,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Drawing, DrawingType, AnchorPoint, DrawingPhase } from "./drawingTypes";

const ANCHOR_RADIUS = 4;
const HIT_TOLERANCE = 8;
const TRENDLINE_COLOR = "#ff6b00";
const HLINE_COLOR = "#ffb020";
const VLINE_COLOR = "#a855f7";
const RECT_COLOR = "rgba(255,107,0,0.12)";
const RECT_BORDER = "rgba(255,107,0,0.6)";
const FIB_COLOR = "#ffb020";
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_LEVEL_COLORS: Record<number, string> = {
  0: "#787b86", 0.236: "#ff4d4d", 0.382: "#ffb020", 0.5: "#00d68f",
  0.618: "#00bcd4", 0.786: "#ff6b00", 1: "#787b86",
};
const LONG_TP_COLOR = "rgba(34,197,94,0.15)";
const LONG_SL_COLOR = "rgba(239,68,68,0.15)";
const LONG_ENTRY_COLOR = "#3b82f6";
const TP_BORDER = "rgba(34,197,94,0.6)";
const SL_BORDER = "rgba(239,68,68,0.6)";
const POSITION_MIN_WIDTH = 80; // min pixel width for position box

interface PixelDrawing {
  id: string;
  type: DrawingType;
  px: number[];
  py: number[];
  selected: boolean;
  entryY?: number | null;
  tpY?: number | null;
  slY?: number | null;
  x1?: number | null;
  x2?: number | null;
  entry?: number;
  tp?: number;
  sl?: number;
  /** For horizontal line: the price and full chart width */
  hLineY?: number;
  hLinePrice?: number;
  chartWidth?: number;
  /** For vertical line: the x coord and full chart height */
  vLineX?: number;
  chartHeight?: number;
  /** For rectangle */
  rectX1?: number;
  rectY1?: number;
  rectX2?: number;
  rectY2?: number;
  /** Rectangle measurement data — raw prices + span so the renderer can
   *  show a standard "+2.35% / +$1,250 / 24 bars" label like every pro
   *  charting platform does. */
  rectPrice1?: number;
  rectPrice2?: number;
  rectBars?: number;
  /** For fibonacci */
  fibLevels?: { level: number; y: number; price: number }[];
  fibX1?: number;
  fibX2?: number;
}

class DrawingRenderer implements IPrimitivePaneRenderer {
  private _pixels: PixelDrawing[] = [];
  private _preview: { x1: number; y1: number; x2: number; y2: number; type: DrawingType } | null = null;

  update(pixels: PixelDrawing[], preview: typeof this._preview) {
    this._pixels = pixels;
    this._preview = preview;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const d of this._pixels) {
        if (d.type === "trendline") this._drawTrendline(ctx, d);
        else if (d.type === "horizontal_line") this._drawHorizontalLine(ctx, d);
        else if (d.type === "vertical_line") this._drawVerticalLine(ctx, d);
        else if (d.type === "rectangle") this._drawRectangle(ctx, d);
        else if (d.type === "fibonacci") this._drawFibonacci(ctx, d);
        else this._drawPosition(ctx, d);
      }
      if (this._preview) this._drawPreview(ctx, this._preview);
    });
  }

  private _drawTrendline(ctx: CanvasRenderingContext2D, d: PixelDrawing) {
    if (d.px.length < 2) return;
    ctx.strokeStyle = d.selected ? "#4f46e5" : TRENDLINE_COLOR;
    ctx.lineWidth = d.selected ? 2 : 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(d.px[0], d.py[0]);
    ctx.lineTo(d.px[1], d.py[1]);
    ctx.stroke();

    for (let i = 0; i < 2; i++) {
      ctx.fillStyle = d.selected ? "#4f46e5" : TRENDLINE_COLOR;
      ctx.beginPath();
      ctx.arc(d.px[i], d.py[i], d.selected ? 5 : ANCHOR_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      if (d.selected) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  private _drawHorizontalLine(ctx: CanvasRenderingContext2D, d: PixelDrawing) {
    if (d.hLineY == null || d.chartWidth == null) return;
    ctx.strokeStyle = d.selected ? "#d97706" : HLINE_COLOR;
    ctx.lineWidth = d.selected ? 2 : 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(0, d.hLineY);
    ctx.lineTo(d.chartWidth, d.hLineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Price label
    if (d.hLinePrice != null) {
      const label = `$${d.hLinePrice.toFixed(2)}`;
      ctx.font = "bold 10px 'Chakra Petch', sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = d.selected ? "#d97706" : HLINE_COLOR;
      ctx.fillRect(d.chartWidth - tw - 12, d.hLineY - 9, tw + 8, 18);
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(label, d.chartWidth - tw - 8, d.hLineY);
    }

    // Selection anchor
    if (d.selected) {
      ctx.fillStyle = HLINE_COLOR;
      ctx.beginPath();
      ctx.arc(40, d.hLineY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private _drawVerticalLine(ctx: CanvasRenderingContext2D, d: PixelDrawing) {
    if (d.vLineX == null || d.chartHeight == null) return;
    ctx.strokeStyle = d.selected ? "#7c3aed" : VLINE_COLOR;
    ctx.lineWidth = d.selected ? 2 : 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(d.vLineX, 0);
    ctx.lineTo(d.vLineX, d.chartHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    if (d.selected) {
      ctx.fillStyle = VLINE_COLOR;
      ctx.beginPath();
      ctx.arc(d.vLineX, 20, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private _drawRectangle(ctx: CanvasRenderingContext2D, d: PixelDrawing) {
    if (d.rectX1 == null || d.rectY1 == null || d.rectX2 == null || d.rectY2 == null) return;
    const x = Math.min(d.rectX1, d.rectX2);
    const y = Math.min(d.rectY1, d.rectY2);
    const w = Math.abs(d.rectX2 - d.rectX1);
    const h = Math.abs(d.rectY2 - d.rectY1);

    ctx.fillStyle = d.selected ? "rgba(255,107,0,0.2)" : RECT_COLOR;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = d.selected ? "#4f46e5" : RECT_BORDER;
    ctx.lineWidth = d.selected ? 2 : 1;
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);

    // Corner anchors when selected
    if (d.selected) {
      const corners = [[d.rectX1, d.rectY1], [d.rectX2, d.rectY1], [d.rectX1, d.rectY2], [d.rectX2, d.rectY2]];
      for (const [cx, cy] of corners) {
        ctx.fillStyle = RECT_BORDER;
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Measurement pill — industry-standard rectangle readout shown on every
    // pro charting platform. Displays percent change, absolute price delta,
    // and bar count. Anchored to the center of the box; drops below if the
    // box is too small to fit inside.
    if (d.rectPrice1 != null && d.rectPrice2 != null && w > 40 && h > 8) {
      const p1 = d.rectPrice1;
      const p2 = d.rectPrice2;
      const delta = p2 - p1;
      const pct = p1 !== 0 ? (delta / p1) * 100 : 0;
      const pctStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      const deltaStr = `${delta >= 0 ? "+" : ""}$${Math.abs(delta).toFixed(2)}`;
      const barsStr = d.rectBars != null ? ` · ${d.rectBars} bars` : "";
      const label = `${pctStr}  ${deltaStr}${barsStr}`;

      ctx.font = "bold 11px 'Chakra Petch', sans-serif";
      const textW = ctx.measureText(label).width;
      const padX = 6;
      const pillW = textW + padX * 2;
      const pillH = 18;

      // Pill positioning: centered inside if there's room, else above the box
      const cx = x + w / 2;
      const inside = h > pillH + 10;
      const pillY = inside ? y + h / 2 - pillH / 2 : y - pillH - 4;
      const pillX = cx - pillW / 2;

      // Background pill
      const bgColor = pct >= 0 ? "rgba(22, 163, 74, 0.9)" : "rgba(220, 38, 38, 0.9)";
      ctx.fillStyle = bgColor;
      this._roundRect(ctx, pillX, pillY, pillW, pillH, 4);
      ctx.fill();

      // Text
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, pillY + pillH / 2 + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  /** Rounded-rect helper — missing from old canvas APIs, polyfilled here. */
  private _roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  private _drawFibonacci(ctx: CanvasRenderingContext2D, d: PixelDrawing) {
    if (!d.fibLevels || d.fibLevels.length === 0 || d.fibX1 == null || d.fibX2 == null) return;
    const x1 = Math.min(d.fibX1, d.fibX2);
    const x2 = Math.max(d.fibX1, d.fibX2);
    const w = Math.max(x2 - x1, 100);

    for (const fl of d.fibLevels) {
      const color = FIB_LEVEL_COLORS[fl.level] || FIB_COLOR;
      // Fill band between this level and the next
      ctx.strokeStyle = d.selected && fl.level === 0.618 ? "#fff" : color;
      ctx.lineWidth = fl.level === 0.5 || fl.level === 0.618 ? 1.5 : 1;
      ctx.setLineDash(fl.level === 0 || fl.level === 1 ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, fl.y);
      ctx.lineTo(x1 + w, fl.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.font = "10px 'Chakra Petch', sans-serif";
      ctx.fillStyle = color;
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(`${(fl.level * 100).toFixed(1)}%  $${fl.price.toFixed(2)}`, x1 + 4, fl.y - 2);
    }

    // Fill zones between levels
    for (let i = 0; i < d.fibLevels.length - 1; i++) {
      const top = Math.min(d.fibLevels[i].y, d.fibLevels[i + 1].y);
      const bot = Math.max(d.fibLevels[i].y, d.fibLevels[i + 1].y);
      const level = d.fibLevels[i].level;
      const alpha = level >= 0.382 && level <= 0.618 ? 0.06 : 0.03;
      const color = FIB_LEVEL_COLORS[level] || FIB_COLOR;
      ctx.fillStyle = color.replace(")", `,${alpha})`).replace("rgb", "rgba");
      ctx.fillRect(x1, top, w, bot - top);
    }

    // Anchor points when selected
    if (d.selected && d.px.length >= 2) {
      for (let i = 0; i < 2; i++) {
        ctx.fillStyle = FIB_COLOR;
        ctx.beginPath();
        ctx.arc(d.px[i], d.py[i], 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  private _drawPosition(ctx: CanvasRenderingContext2D, d: PixelDrawing) {
    if (d.entryY == null || d.x1 == null || d.x2 == null) return;
    const x1 = Math.min(d.x1, d.x2);
    const w = Math.max(Math.abs(d.x2 - d.x1), POSITION_MIN_WIDTH);
    const entryY = d.entryY;
    const isLong = d.type === "long_position";

    // TP zone
    if (d.tpY != null) {
      const tpTop = Math.min(d.tpY, entryY);
      const tpH = Math.abs(d.tpY - entryY);
      ctx.fillStyle = LONG_TP_COLOR;
      ctx.fillRect(x1, tpTop, w, tpH);
      ctx.strokeStyle = TP_BORDER;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(x1, tpTop, w, tpH);

      // TP label with PnL %
      const tpPct = d.tp != null && d.entry != null && d.entry !== 0
        ? ((Math.abs(d.tp - d.entry) / d.entry) * 100).toFixed(1)
        : "0";
      ctx.fillStyle = TP_BORDER;
      ctx.font = "bold 10px 'Chakra Petch', sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(`TP +${tpPct}%`, x1 + 4, tpTop + tpH / 2);
      if (d.tp != null) {
        ctx.textAlign = "right";
        ctx.fillText(`$${d.tp.toFixed(0)}`, x1 + w - 4, tpTop + tpH / 2);
        ctx.textAlign = "left";
      }
    }

    // SL zone
    if (d.slY != null) {
      const slTop = Math.min(d.slY, entryY);
      const slH = Math.abs(d.slY - entryY);
      ctx.fillStyle = LONG_SL_COLOR;
      ctx.fillRect(x1, slTop, w, slH);
      ctx.strokeStyle = SL_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, slTop, w, slH);

      const slPct = d.sl != null && d.entry != null && d.entry !== 0
        ? ((Math.abs(d.sl - d.entry) / d.entry) * 100).toFixed(1)
        : "0";
      ctx.fillStyle = SL_BORDER;
      ctx.font = "bold 10px 'Chakra Petch', sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(`SL -${slPct}%`, x1 + 4, slTop + slH / 2);
      if (d.sl != null) {
        ctx.textAlign = "right";
        ctx.fillText(`$${d.sl.toFixed(0)}`, x1 + w - 4, slTop + slH / 2);
        ctx.textAlign = "left";
      }
    }

    // Entry line — color-coded by direction so LONG and SHORT are visually
    // distinct at a glance (green for long, red for short).
    const entryColor = isLong ? "#16a34a" : "#dc2626";
    ctx.strokeStyle = d.selected ? "#2563eb" : entryColor;
    ctx.lineWidth = d.selected ? 2 : 1.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, entryY);
    ctx.lineTo(x1 + w, entryY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Direction badge (LONG/SHORT pill at the left of the entry line) —
    // color-coded so you can't confuse the two.
    const badgeText = isLong ? "LONG" : "SHORT";
    ctx.font = "bold 9px 'Chakra Petch', sans-serif";
    const badgeW = ctx.measureText(badgeText).width + 10;
    const badgeH = 14;
    const badgeX = x1;
    const badgeY = entryY - badgeH / 2;
    ctx.fillStyle = entryColor;
    this._roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    // Entry price label (right after the direction badge)
    if (d.entry != null) {
      ctx.fillStyle = entryColor;
      ctx.font = "bold 10px 'Chakra Petch', sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(`$${d.entry.toFixed(0)}`, badgeX + badgeW + 5, entryY);
      ctx.textBaseline = "alphabetic";
    }

    // R:R ratio pill — prominently shown at the right of the entry line.
    // This is the #1 metric pro traders look at, and standard in every
    // pro trading platform. Computed purely from the TP/SL distances.
    if (d.tp != null && d.sl != null && d.entry != null) {
      const rewardDist = Math.abs(d.tp - d.entry);
      const riskDist = Math.abs(d.sl - d.entry);
      if (riskDist > 0) {
        const rr = rewardDist / riskDist;
        const rrText = `R:R 1:${rr.toFixed(2)}`;
        ctx.font = "bold 10px 'Chakra Petch', sans-serif";
        const rrW = ctx.measureText(rrText).width + 12;
        const rrH = 16;
        const rrX = x1 + w - rrW;
        const rrY = entryY - rrH / 2;
        // Green when R:R > 1 (favorable), amber when < 1 (risky), red when < 0.5
        const rrColor = rr >= 2 ? "#16a34a" : rr >= 1 ? "#ca8a04" : "#dc2626";
        ctx.fillStyle = rrColor;
        this._roundRect(ctx, rrX, rrY, rrW, rrH, 3);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(rrText, rrX + rrW / 2, rrY + rrH / 2 + 0.5);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
    }

    // Selection indicator
    if (d.selected) {
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      const top = Math.min(entryY, d.tpY ?? entryY, d.slY ?? entryY);
      const bot = Math.max(entryY, d.tpY ?? entryY, d.slY ?? entryY);
      ctx.strokeRect(x1 - 1, top - 1, w + 2, bot - top + 2);
      ctx.setLineDash([]);
    }
  }

  private _drawPreview(ctx: CanvasRenderingContext2D, p: NonNullable<typeof this._preview>) {
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);

    if (p.type === "horizontal_line") {
      ctx.strokeStyle = HLINE_COLOR;
      ctx.beginPath();
      ctx.moveTo(0, p.y1);
      ctx.lineTo(ctx.canvas.width, p.y1);
      ctx.stroke();
    } else if (p.type === "vertical_line") {
      ctx.strokeStyle = VLINE_COLOR;
      ctx.beginPath();
      ctx.moveTo(p.x1, 0);
      ctx.lineTo(p.x1, ctx.canvas.height);
      ctx.stroke();
    } else if (p.type === "rectangle") {
      ctx.strokeStyle = RECT_BORDER;
      ctx.fillStyle = RECT_COLOR;
      const x = Math.min(p.x1, p.x2);
      const y = Math.min(p.y1, p.y2);
      const w = Math.abs(p.x2 - p.x1);
      const h = Math.abs(p.y2 - p.y1);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else if (p.type === "fibonacci") {
      ctx.strokeStyle = FIB_COLOR;
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = p.type === "trendline" ? TRENDLINE_COLOR : LONG_ENTRY_COLOR;
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

class DrawingPaneView implements IPrimitivePaneView {
  _renderer = new DrawingRenderer();

  update(pixels: PixelDrawing[], preview: Parameters<DrawingRenderer["update"]>[1]) {
    this._renderer.update(pixels, preview);
  }

  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer { return this._renderer; }
}

export class DrawingToolsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<"Candlestick"> | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _paneView = new DrawingPaneView();

  private _drawings: Drawing[] = [];
  private _pixelCache: PixelDrawing[] = [];

  // Current tool & drawing state
  private _activeTool: DrawingType | null = null;
  private _phase: DrawingPhase = "idle";
  private _anchor1: AnchorPoint | null = null;
  private _previewX = 0;
  private _previewY = 0;

  // Drag state
  private _dragging: { drawingId: string; anchorIdx: number; type: string } | null = null;
  private _dragStartTime: number = 0;
  private _dragStartPrice: number = 0;
  private _dragOrigPoints: AnchorPoint[] = [];
  private _dragOrigEntry = 0;
  private _dragOrigTp = 0;
  private _dragOrigSl = 0;
  private _dragOrigTimeStart: number = 0;
  private _dragOrigTimeEnd: number = 0;

  // Callbacks
  private _onChange: ((drawings: Drawing[]) => void) | null = null;
  private _onPhaseChange: ((phase: DrawingPhase) => void) | null = null;

  setOnChange(fn: (drawings: Drawing[]) => void) { this._onChange = fn; }
  setOnPhaseChange(fn: (phase: DrawingPhase) => void) { this._onPhaseChange = fn; }

  /** Deep-clone drawings before notifying store so Zustand detects changes */
  private _notifyChange() {
    if (!this._onChange) return;
    this._onChange(this._drawings.map(d => ({
      ...d,
      points: d.points.map(p => ({ ...p })),
    })));
  }

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

  // --- Public API ---
  get drawings() { return this._drawings; }

  setDrawings(d: Drawing[]) {
    this._drawings = d;
    this.updateAllViews();
    this._requestUpdate?.();
  }

  setActiveTool(tool: DrawingType | null) {
    this._activeTool = tool;
    this._phase = tool ? "placing_first" : "idle";
    this._anchor1 = null;
    // Deselect all when switching tools
    this._drawings.forEach(d => d.selected = false);
    this._notifyChange();
    this._requestUpdate?.();
    this._onPhaseChange?.(this._phase);
  }

  deleteSelected() {
    this._drawings = this._drawings.filter(d => !d.selected);
    this._notifyChange();
    this.updateAllViews();
    this._requestUpdate?.();
  }

  // --- Coordinate helpers ---
  private _timeToX(t: Time): number | null {
    return this._chart?.timeScale().timeToCoordinate(t) ?? null;
  }
  private _priceToY(p: number): number | null {
    return this._series?.priceToCoordinate(p) ?? null;
  }
  private _xToTime(x: number): Time | null {
    return this._chart?.timeScale().coordinateToTime(x) ?? null;
  }
  private _yToPrice(y: number): number | null {
    return this._series?.coordinateToPrice(y) ?? null;
  }

  // --- Lifecycle ---
  updateAllViews() {
    this._pixelCache = this._drawings.map(d => this._drawingToPixels(d)).filter(Boolean) as PixelDrawing[];

    let preview: Parameters<DrawingPaneView["update"]>[1] = null;
    if (this._phase === "placing_second" && this._anchor1 && (this._activeTool === "trendline" || this._activeTool === "rectangle" || this._activeTool === "fibonacci")) {
      const x1 = this._timeToX(this._anchor1.time);
      const y1 = this._priceToY(this._anchor1.price);
      if (x1 != null && y1 != null) {
        preview = { x1, y1, x2: this._previewX, y2: this._previewY, type: this._activeTool };
      }
    }

    this._paneView.update(this._pixelCache, preview);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  private _drawingToPixels(d: Drawing): PixelDrawing | null {
    if (d.type === "trendline") {
      if (d.points.length < 2) return null;
      const px = d.points.map(p => this._timeToX(p.time));
      const py = d.points.map(p => this._priceToY(p.price));
      if (px.some(v => v == null) || py.some(v => v == null)) return null;
      return { id: d.id, type: d.type, px: px as number[], py: py as number[], selected: d.selected };
    }

    if (d.type === "horizontal_line") {
      if (d.points.length < 1) return null;
      const y = this._priceToY(d.points[0].price);
      if (y == null) return null;
      const chartWidth = this._chart?.timeScale().width() ?? 800;
      return { id: d.id, type: d.type, px: [], py: [], selected: d.selected, hLineY: y, hLinePrice: d.points[0].price, chartWidth };
    }

    if (d.type === "vertical_line") {
      if (d.points.length < 1) return null;
      const x = this._timeToX(d.points[0].time);
      if (x == null) return null;
      // Chart height from the series coordinate space
      const chartHeight = 2000; // large enough
      return { id: d.id, type: d.type, px: [], py: [], selected: d.selected, vLineX: x, chartHeight };
    }

    if (d.type === "rectangle") {
      if (d.points.length < 2) return null;
      const x1 = this._timeToX(d.points[0].time);
      const y1 = this._priceToY(d.points[0].price);
      const x2 = this._timeToX(d.points[1].time);
      const y2 = this._priceToY(d.points[1].price);
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
      // Compute bar count from the pixel span and the chart's bar spacing.
      // This is approximate but matches what users see visually.
      const barSpacing = this._chart?.timeScale().options().barSpacing ?? 6;
      const bars = Math.max(1, Math.round(Math.abs(x2 - x1) / barSpacing));
      return {
        id: d.id,
        type: d.type,
        px: [x1, x2],
        py: [y1, y2],
        selected: d.selected,
        rectX1: x1, rectY1: y1, rectX2: x2, rectY2: y2,
        rectPrice1: d.points[0].price,
        rectPrice2: d.points[1].price,
        rectBars: bars,
      };
    }

    if (d.type === "fibonacci") {
      if (d.points.length < 2) return null;
      const x1 = this._timeToX(d.points[0].time);
      const y1 = this._priceToY(d.points[0].price);
      const x2 = this._timeToX(d.points[1].time);
      const y2 = this._priceToY(d.points[1].price);
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
      const levels = (d.fibLevels || FIB_LEVELS).map(level => {
        const price = d.points[1].price + (d.points[0].price - d.points[1].price) * level;
        const ly = this._priceToY(price) ?? 0;
        return { level, y: ly, price };
      });
      return { id: d.id, type: d.type, px: [x1, x2], py: [y1, y2], selected: d.selected, fibLevels: levels, fibX1: x1, fibX2: x2 };
    }

    // Position tools
    if (d.entry == null || d.timeStart == null || d.timeEnd == null) return null;
    const x1 = this._timeToX(d.timeStart);
    const x2 = this._timeToX(d.timeEnd);
    const entryY = this._priceToY(d.entry);
    const tpY = d.tp != null ? this._priceToY(d.tp) : null;
    const slY = d.sl != null ? this._priceToY(d.sl) : null;
    if (x1 == null || x2 == null || entryY == null) return null;

    return {
      id: d.id, type: d.type, px: [], py: [], selected: d.selected,
      entryY, tpY, slY, x1, x2, entry: d.entry, tp: d.tp, sl: d.sl,
    };
  }

  // --- Hit Testing ---
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (this._phase !== "idle") return null;

    for (const pd of [...this._pixelCache].reverse()) {
      if (pd.type === "trendline") {
        for (let i = 0; i < pd.px.length; i++) {
          if (Math.hypot(x - pd.px[i], y - pd.py[i]) < HIT_TOLERANCE) {
            return { cursorStyle: "grab", externalId: `${pd.id}:anchor:${i}`, zOrder: "top" };
          }
        }
        if (pd.px.length >= 2 && this._distToLine(x, y, pd.px[0], pd.py[0], pd.px[1], pd.py[1]) < HIT_TOLERANCE) {
          return { cursorStyle: "move", externalId: `${pd.id}:body`, zOrder: "top" };
        }
      } else if (pd.type === "horizontal_line") {
        if (pd.hLineY != null && Math.abs(y - pd.hLineY) < HIT_TOLERANCE) {
          return { cursorStyle: "ns-resize", externalId: `${pd.id}:body`, zOrder: "top" };
        }
      } else if (pd.type === "vertical_line") {
        if (pd.vLineX != null && Math.abs(x - pd.vLineX) < HIT_TOLERANCE) {
          return { cursorStyle: "ew-resize", externalId: `${pd.id}:body`, zOrder: "top" };
        }
      } else if (pd.type === "rectangle") {
        if (pd.rectX1 != null && pd.rectY1 != null && pd.rectX2 != null && pd.rectY2 != null) {
          // Corner anchors
          const corners = [[pd.rectX1, pd.rectY1, 0], [pd.rectX2, pd.rectY1, 1], [pd.rectX1, pd.rectY2, 2], [pd.rectX2, pd.rectY2, 3]];
          for (const [cx, cy, idx] of corners) {
            if (Math.hypot(x - cx, y - cy) < HIT_TOLERANCE) {
              return { cursorStyle: "nwse-resize", externalId: `${pd.id}:anchor:${idx}`, zOrder: "top" };
            }
          }
          // Body
          const lx = Math.min(pd.rectX1, pd.rectX2), rx = Math.max(pd.rectX1, pd.rectX2);
          const ty = Math.min(pd.rectY1, pd.rectY2), by = Math.max(pd.rectY1, pd.rectY2);
          if (x >= lx && x <= rx && y >= ty && y <= by) {
            return { cursorStyle: "move", externalId: `${pd.id}:body`, zOrder: "top" };
          }
        }
      } else if (pd.type === "fibonacci") {
        // Anchor points
        for (let i = 0; i < pd.px.length; i++) {
          if (Math.hypot(x - pd.px[i], y - pd.py[i]) < HIT_TOLERANCE) {
            return { cursorStyle: "grab", externalId: `${pd.id}:anchor:${i}`, zOrder: "top" };
          }
        }
        // Level lines
        if (pd.fibLevels && pd.fibX1 != null && pd.fibX2 != null) {
          const lx = Math.min(pd.fibX1, pd.fibX2);
          const rx = Math.max(pd.fibX1, pd.fibX2);
          for (const fl of pd.fibLevels) {
            if (Math.abs(y - fl.y) < HIT_TOLERANCE && x >= lx - 20 && x <= rx + 20) {
              return { cursorStyle: "move", externalId: `${pd.id}:body`, zOrder: "top" };
            }
          }
        }
      } else {
        if (pd.entryY != null && pd.x1 != null && pd.x2 != null) {
          const lx = Math.min(pd.x1, pd.x2);
          const rx = lx + Math.max(Math.abs(pd.x2 - pd.x1), POSITION_MIN_WIDTH);

          // TP edge
          if (pd.tpY != null && Math.abs(y - pd.tpY) < HIT_TOLERANCE && x >= lx && x <= rx) {
            return { cursorStyle: "ns-resize", externalId: `${pd.id}:tp`, zOrder: "top" };
          }
          // SL edge
          if (pd.slY != null && Math.abs(y - pd.slY) < HIT_TOLERANCE && x >= lx && x <= rx) {
            return { cursorStyle: "ns-resize", externalId: `${pd.id}:sl`, zOrder: "top" };
          }
          // Entry line
          if (Math.abs(y - pd.entryY) < HIT_TOLERANCE && x >= lx && x <= rx) {
            return { cursorStyle: "ns-resize", externalId: `${pd.id}:entry`, zOrder: "top" };
          }
          // Body
          const top = Math.min(pd.entryY, pd.tpY ?? pd.entryY, pd.slY ?? pd.entryY);
          const bot = Math.max(pd.entryY, pd.tpY ?? pd.entryY, pd.slY ?? pd.entryY);
          if (x >= lx && x <= rx && y >= top - 2 && y <= bot + 2) {
            return { cursorStyle: "move", externalId: `${pd.id}:body`, zOrder: "top" };
          }
        }
      }
    }
    return null;
  }

  private _distToLine(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // --- Mouse Interaction ---
  onMouseDown(x: number, y: number): boolean {
    // Single-click tools: horizontal line, vertical line
    if (this._phase === "placing_first" && this._activeTool === "horizontal_line") {
      const price = this._yToPrice(y);
      const time = this._xToTime(x);
      if (price != null && time) {
        const drawing: Drawing = {
          id: crypto.randomUUID(),
          type: "horizontal_line",
          points: [{ time, price }],
          selected: false,
        };
        this._drawings.push(drawing);
        this._notifyChange();
        this.updateAllViews();
        this._requestUpdate?.();
      }
      return true;
    }

    if (this._phase === "placing_first" && this._activeTool === "vertical_line") {
      const time = this._xToTime(x);
      const price = this._yToPrice(y);
      if (time && price != null) {
        const drawing: Drawing = {
          id: crypto.randomUUID(),
          type: "vertical_line",
          points: [{ time, price }],
          selected: false,
        };
        this._drawings.push(drawing);
        this._notifyChange();
        this.updateAllViews();
        this._requestUpdate?.();
      }
      return true;
    }

    // Two-click tools: rectangle, fibonacci
    if (this._phase === "placing_first" && (this._activeTool === "trendline" || this._activeTool === "rectangle" || this._activeTool === "fibonacci")) {
      const time = this._xToTime(x);
      const price = this._yToPrice(y);
      if (time && price != null) {
        this._anchor1 = { time, price };
        this._previewX = x;
        this._previewY = y;
        this._phase = "placing_second";
        this._onPhaseChange?.(this._phase);
      }
      return true;
    }

    // Placing position tool — click sets entry, then drag sets TP/SL
    if (this._phase === "placing_first" && this._activeTool && this._activeTool !== "trendline") {
      const time = this._xToTime(x);
      const price = this._yToPrice(y);
      if (time && price != null) {
        const spread = price * 0.03;
        const isLong = this._activeTool === "long_position";
        // Estimate a reasonable time width (100 bars roughly)
        const timeShift = this._estimateTimeShift(200);

        const drawing: Drawing = {
          id: crypto.randomUUID(),
          type: this._activeTool,
          points: [],
          entry: price,
          tp: isLong ? price + spread : price - spread,
          sl: isLong ? price - spread : price + spread,
          timeStart: time,
          timeEnd: ((time as number) + Math.abs(timeShift)) as unknown as Time,
          selected: false,
        };
        this._drawings.push(drawing);
        this._phase = "placing_second";
        this._anchor1 = { time, price };
        this._onPhaseChange?.(this._phase);
        this.updateAllViews();
        this._requestUpdate?.();
      }
      return true;
    }

    // Placing second anchor (trendline, rectangle, fibonacci completion)
    if (this._phase === "placing_second" && (this._activeTool === "trendline" || this._activeTool === "rectangle" || this._activeTool === "fibonacci") && this._anchor1) {
      const time = this._xToTime(x);
      const price = this._yToPrice(y);
      if (time && price != null) {
        const drawing: Drawing = {
          id: crypto.randomUUID(),
          type: this._activeTool,
          points: [this._anchor1, { time, price }],
          selected: false,
          ...(this._activeTool === "fibonacci" ? { fibLevels: FIB_LEVELS } : {}),
        };
        this._drawings.push(drawing);
        this._phase = "placing_first";
        this._anchor1 = null;
        this._notifyChange();
        this._onPhaseChange?.(this._phase);
        this.updateAllViews();
        this._requestUpdate?.();
      }
      return true;
    }

    // Select / drag existing drawing (idle mode)
    if (this._phase === "idle") {
      const hit = this.hitTest(x, y);
      this._drawings.forEach(d => d.selected = false);

      if (hit) {
        const parts = hit.externalId.split(":");
        const drawingId = parts[0];
        const part = parts[1];
        const anchorIdx = parts[2] ? parseInt(parts[2]) : -1;
        const drawing = this._drawings.find(d => d.id === drawingId);
        if (drawing) {
          drawing.selected = true;
          this._dragging = { drawingId, anchorIdx, type: part };
          this._dragStartTime = (this._xToTime(x) as number) || 0;
          this._dragStartPrice = this._yToPrice(y) ?? 0;
          this._dragOrigPoints = drawing.points.map(p => ({ ...p }));
          this._dragOrigEntry = drawing.entry ?? 0;
          this._dragOrigTp = drawing.tp ?? 0;
          this._dragOrigSl = drawing.sl ?? 0;
          this._dragOrigTimeStart = (drawing.timeStart as number) || 0;
          this._dragOrigTimeEnd = (drawing.timeEnd as number) || 0;
        }
        this._notifyChange();
        this._requestUpdate?.();
        return true;
      }

      this._notifyChange();
      this._requestUpdate?.();
    }

    return false;
  }

  onMouseMove(x: number, y: number): boolean {
    // Preview for two-click tools
    if (this._phase === "placing_second" && (this._activeTool === "trendline" || this._activeTool === "rectangle" || this._activeTool === "fibonacci")) {
      this._previewX = x;
      this._previewY = y;
      this.updateAllViews();
      this._requestUpdate?.();
      return true;
    }

    // Position tool — adjust TP/SL while dragging
    if (this._phase === "placing_second" && this._activeTool && this._activeTool !== "trendline") {
      const price = this._yToPrice(y);
      const time = this._xToTime(x);
      if (price != null && time != null) {
        const drawing = this._drawings[this._drawings.length - 1];
        if (drawing && drawing.entry != null) {
          const isLong = drawing.type === "long_position";
          // Update TP or SL based on which side of entry the mouse is
          if (isLong) {
            if (price > drawing.entry) drawing.tp = price;
            else drawing.sl = price;
          } else {
            if (price < drawing.entry) drawing.tp = price;
            else drawing.sl = price;
          }
          // Extend time range
          if ((time as number) > (drawing.timeStart as number)) {
            drawing.timeEnd = time;
          }
          this.updateAllViews();
          this._requestUpdate?.();
        }
      }
      return true;
    }

    // Drag existing drawing
    if (this._dragging) {
      const drawing = this._drawings.find(d => d.id === this._dragging!.drawingId);
      if (!drawing) return false;

      // Convert current mouse position to logical coordinates
      const curTime = (this._xToTime(x) as number) || 0;
      const curPrice = this._yToPrice(y) ?? 0;
      const dTime = curTime - this._dragStartTime;
      const dPrice = curPrice - this._dragStartPrice;

      if (drawing.type === "trendline" || drawing.type === "rectangle" || drawing.type === "fibonacci") {
        if (this._dragging.type === "anchor" && this._dragging.anchorIdx >= 0) {
          const time = this._xToTime(x);
          const price = this._yToPrice(y);
          if (time != null && price != null) {
            // For rectangle corners, map anchor index to correct point
            if (drawing.type === "rectangle" && drawing.points.length >= 2) {
              const idx = this._dragging.anchorIdx;
              if (idx === 0) { drawing.points[0] = { time, price }; }
              else if (idx === 1) { drawing.points[1] = { ...drawing.points[1], time }; drawing.points[0] = { ...drawing.points[0], price }; }
              else if (idx === 2) { drawing.points[0] = { ...drawing.points[0], time }; drawing.points[1] = { ...drawing.points[1], price }; }
              else if (idx === 3) { drawing.points[1] = { time, price }; }
            } else {
              drawing.points[this._dragging.anchorIdx] = { time, price };
            }
          }
        } else {
          // Body drag — shift all points by logical delta
          drawing.points = this._dragOrigPoints.map(p => ({
            time: ((p.time as number) + dTime) as unknown as Time,
            price: p.price + dPrice,
          }));
        }
      } else if (drawing.type === "horizontal_line") {
        const price = this._yToPrice(y);
        if (price != null) {
          drawing.points[0] = { ...drawing.points[0], price };
        }
      } else if (drawing.type === "vertical_line") {
        const time = this._xToTime(x);
        if (time != null) {
          drawing.points[0] = { ...drawing.points[0], time };
        }
      } else {
        // Position tool drag
        const part = this._dragging.type;
        if (part === "body") {
          drawing.entry = this._dragOrigEntry + dPrice;
          drawing.tp = this._dragOrigTp + dPrice;
          drawing.sl = this._dragOrigSl + dPrice;
          drawing.timeStart = (this._dragOrigTimeStart + dTime) as unknown as Time;
          drawing.timeEnd = (this._dragOrigTimeEnd + dTime) as unknown as Time;
        } else if (part === "entry") {
          drawing.entry = this._dragOrigEntry + dPrice;
          drawing.tp = this._dragOrigTp + dPrice;
          drawing.sl = this._dragOrigSl + dPrice;
        } else if (part === "tp") {
          drawing.tp = this._dragOrigTp + dPrice;
        } else if (part === "sl") {
          drawing.sl = this._dragOrigSl + dPrice;
        }
      }

      this.updateAllViews();
      this._requestUpdate?.();
      return true;
    }

    return false;
  }

  onMouseUp(): boolean {
    // Finalize position tool — stay in placing_first for next one
    if (this._phase === "placing_second" && this._activeTool && this._activeTool !== "trendline") {
      this._phase = "placing_first";
      this._anchor1 = null;
      this._notifyChange();
      this._onPhaseChange?.(this._phase);
      this._requestUpdate?.();
      return true;
    }

    if (this._dragging) {
      this._dragging = null;
      this._notifyChange();
      return true;
    }
    return false;
  }

  private _estimatePricePerPixel(): number {
    if (!this._series) return 1;
    const p1 = this._series.coordinateToPrice(0);
    const p2 = this._series.coordinateToPrice(100);
    if (p1 == null || p2 == null) return 1;
    return Math.abs(p1 - p2) / 100;
  }

  private _estimateTimeShift(dx: number): number {
    if (!this._chart) return 0;
    const ts = this._chart.timeScale();
    const t1 = ts.coordinateToTime(0);
    const t2 = ts.coordinateToTime(100);
    if (!t1 || !t2) return 0;
    return (dx / 100) * ((t2 as number) - (t1 as number));
  }
}
