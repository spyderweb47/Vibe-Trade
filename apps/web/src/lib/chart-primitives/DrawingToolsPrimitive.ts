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
const TRENDLINE_COLOR = "#6366f1";
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
  entryY?: number;
  tpY?: number;
  slY?: number;
  x1?: number;
  x2?: number;
  entry?: number;
  tp?: number;
  sl?: number;
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

    // Entry line
    ctx.strokeStyle = d.selected ? "#2563eb" : LONG_ENTRY_COLOR;
    ctx.lineWidth = d.selected ? 2 : 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, entryY);
    ctx.lineTo(x1 + w, entryY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Entry label
    ctx.fillStyle = LONG_ENTRY_COLOR;
    ctx.font = "bold 10px 'Chakra Petch', sans-serif";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText(isLong ? "LONG" : "SHORT", x1 + 4, entryY - 4);
    if (d.entry != null) {
      ctx.textBaseline = "top";
      ctx.fillText(`$${d.entry.toFixed(0)}`, x1 + 4, entryY + 4);
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
    ctx.strokeStyle = p.type === "trendline" ? TRENDLINE_COLOR : LONG_ENTRY_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(p.x1, p.y1);
    ctx.lineTo(p.x2, p.y2);
    ctx.stroke();
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
    if (this._phase === "placing_second" && this._anchor1 && this._activeTool === "trendline") {
      const x1 = this._timeToX(this._anchor1.time);
      const y1 = this._priceToY(this._anchor1.price);
      if (x1 != null && y1 != null) {
        preview = { x1, y1, x2: this._previewX, y2: this._previewY, type: "trendline" };
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
    // Placing first anchor (trendline)
    if (this._phase === "placing_first" && this._activeTool === "trendline") {
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

    // Placing second anchor (trendline completion)
    if (this._phase === "placing_second" && this._activeTool === "trendline" && this._anchor1) {
      const time = this._xToTime(x);
      const price = this._yToPrice(y);
      if (time && price != null) {
        const drawing: Drawing = {
          id: crypto.randomUUID(),
          type: "trendline",
          points: [this._anchor1, { time, price }],
          selected: false,
        };
        this._drawings.push(drawing);
        // Stay in placing_first so user can draw another trendline
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
    // Preview line for trendline
    if (this._phase === "placing_second" && this._activeTool === "trendline") {
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

      if (drawing.type === "trendline") {
        if (this._dragging.type === "anchor" && this._dragging.anchorIdx >= 0) {
          const time = this._xToTime(x);
          const price = this._yToPrice(y);
          if (time != null && price != null) {
            drawing.points[this._dragging.anchorIdx] = { time, price };
          }
        } else {
          // Body drag — shift all points by logical delta
          drawing.points = this._dragOrigPoints.map(p => ({
            time: ((p.time as number) + dTime) as unknown as Time,
            price: p.price + dPrice,
          }));
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
