"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type ISeriesMarkersPluginApi,
  ColorType,
} from "lightweight-charts";
import type { OHLCBar, PatternMatch } from "@/types";
import { useStore } from "@/store/useStore";
import { calculateIndicatorLocal } from "@/lib/indicators";
import { executeIndicatorScript } from "@/lib/scriptExecutor";
import { extractFingerprint } from "@/lib/patternFingerprint";
import { PatternSelectorPrimitive } from "@/lib/chart-primitives/PatternSelectorPrimitive";
import { DrawingToolsPrimitive } from "@/lib/chart-primitives/DrawingToolsPrimitive";
import { PatternHighlightPrimitive } from "@/lib/chart-primitives/PatternHighlightPrimitive";
import { NewsMarkersPrimitive } from "@/lib/chart-primitives/NewsMarkersPrimitive";
import { PineDrawingsPrimitive } from "@/lib/chart-primitives/PineDrawingsPrimitive";
import { TradeBoxPrimitive } from "@/lib/chart-primitives/TradeBoxPrimitive";
import type { DrawingPhase } from "@/lib/chart-primitives/patternSelectorTypes";
import { PatternSelectorToolbar } from "./PatternSelectorToolbar";

interface ChartProps {
  data: OHLCBar[];
  patternMatches?: PatternMatch[];
  supportResistance?: { price: number; type: "support" | "resistance" }[];
  /**
   * When set, Chart reads focus from `chartFocusByDataset[datasetId]`
   * instead of the global `chartFocus`. Used by multi-chart Canvas so
   * clicking a pattern-match row only navigates the chart that owns
   * the match, not every chart on screen. Omit for single-chart usage
   * — Chart falls back to the global focus. */
  datasetId?: string | null;
}

const INDICATOR_COLORS: Record<string, string> = {
  SMA: "#f59e0b",
  EMA: "#8b5cf6",
  RSI: "#06b6d4",
  MACD: "#ec4899",
  "Bollinger Bands": "#6366f1",
  ATR: "#14b8a6",
  VWAP: "#f97316",
};

export function Chart({
  data,
  patternMatches = [],
  supportResistance = [],
  datasetId = null,
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const patternPrimitiveRef = useRef<PatternSelectorPrimitive | null>(null);
  const drawingPrimitiveRef = useRef<DrawingToolsPrimitive | null>(null);
  const highlightPrimitiveRef = useRef<PatternHighlightPrimitive | null>(null);
  const newsMarkersRef = useRef<NewsMarkersPrimitive | null>(null);
  const pineDrawingsRef = useRef<PineDrawingsPrimitive | null>(null);
  const tradeBoxRef = useRef<TradeBoxPrimitive | null>(null);
  const spacerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const prevDataLenRef = useRef<number>(0);
  const prevCursorRef = useRef<number>(-1);
  const playgroundInitializedRef = useRef<boolean>(false);

  const darkMode = useStore((s) => s.darkMode);
  const appModeTop = useStore((s) => s.appMode);
  const playgroundCursor = useStore((s) => s.playgroundReplay.currentBarIndex);
  const indicators = useStore((s) => s.indicators);
  const setCapturedPattern = useStore((s) => s.setCapturedPattern);
  const chartFocus = useStore((s) => s.chartFocus);
  const setChartFocus = useStore((s) => s.setChartFocus);
  const chartFocusByDataset = useStore((s) => s.chartFocusByDataset);
  const setChartFocusForDataset = useStore((s) => s.setChartFocusForDataset);
  // Resolve which focus this Chart instance should listen to. In the
  // multi-chart Canvas each ChartWindow passes its own datasetId so
  // navigations only apply to the right chart. When no datasetId is
  // passed (legacy single-chart mode) we fall back to global focus.
  const resolvedFocus = datasetId && chartFocusByDataset[datasetId]
    ? chartFocusByDataset[datasetId]
    : (!datasetId ? chartFocus : null);
  const activeDrawingTool = useStore((s) => s.activeDrawingTool);
  const setActiveDrawingTool = useStore((s) => s.setActiveDrawingTool);
  const datasets = useStore((s) => s.datasets);
  const activeDatasetId = useStore((s) => s.activeDataset);
  const activeDs = datasets.find((d) => d.id === activeDatasetId);
  const setDrawings = useStore((s) => s.setDrawings);
  const setChatInputDraft = useStore((s) => s.setChatInputDraft);
  const addMessage = useStore((s) => s.addMessage);

  const [drawingPhase, setDrawingPhase] = useState<DrawingPhase>("idle");
  const [hasSelection, setHasSelection] = useState(false);

  // Create chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: darkMode ? "#131722" : "#ffffff" },
        textColor: darkMode ? "#b2b5be" : "#6b7280",
        fontFamily: "'Chakra Petch', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: darkMode ? "#1e222d" : "#f0f0f3", style: 0 },
        horzLines: { color: darkMode ? "#1e222d" : "#f0f0f3", style: 0 },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: darkMode ? "#758696" : "#9ca3af", width: 1, style: 3, labelBackgroundColor: darkMode ? "#2a2e39" : "#374151" },
        horzLine: { color: darkMode ? "#758696" : "#9ca3af", width: 1, style: 3, labelBackgroundColor: darkMode ? "#2a2e39" : "#374151" },
      },
      timeScale: {
        borderColor: darkMode ? "#2a2e39" : "#e5e5ea",
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: false,
      },
      rightPriceScale: {
        borderColor: darkMode ? "#2a2e39" : "#e5e5ea",
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    // Volume histogram series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      borderVisible: false,
      visible: false,
    });
    volumeSeriesRef.current = volumeSeries;

    // Pattern selector primitive
    const primitive = new PatternSelectorPrimitive();
    primitive.setOnChange((pattern) => {
      setHasSelection(!!pattern);
      setDrawingPhase(primitive.drawingPhase);
    });
    series.attachPrimitive(primitive);
    patternPrimitiveRef.current = primitive;

    // Drawing tools primitive
    const drawPrimitive = new DrawingToolsPrimitive();
    drawPrimitive.setOnChange((drawings) => {
      useStore.getState().setDrawings(drawings);
    });
    series.attachPrimitive(drawPrimitive);
    drawingPrimitiveRef.current = drawPrimitive;

    // Pattern highlight boxes primitive
    const highlightPrimitive = new PatternHighlightPrimitive();
    series.attachPrimitive(highlightPrimitive);
    highlightPrimitiveRef.current = highlightPrimitive;

    // Historic news markers primitive — vertical dashed lines + colored
    // dots at each news event's timestamp, produced by the
    // historic_news skill.
    const newsMarkersPrimitive = new NewsMarkersPrimitive();
    series.attachPrimitive(newsMarkersPrimitive);
    newsMarkersRef.current = newsMarkersPrimitive;

    // Pine Script drawings primitive
    const pineDrawingsPrimitive = new PineDrawingsPrimitive();
    series.attachPrimitive(pineDrawingsPrimitive);
    pineDrawingsRef.current = pineDrawingsPrimitive;

    // Trade box primitive for strategy backtest trades
    const tradeBoxPrimitive = new TradeBoxPrimitive();
    series.attachPrimitive(tradeBoxPrimitive);
    tradeBoxRef.current = tradeBoxPrimitive;

    // Hidden spacer series — extends the time scale past the replay cursor so
    // drawings/trend lines can reach into the future. On its own hidden price
    // scale so it doesn't affect the main price auto-scale.
    const spacerSeries = chart.addSeries(LineSeries, {
      priceScaleId: "spacer-hidden",
      color: "rgba(0,0,0,0)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale("spacer-hidden").applyOptions({ visible: false });
    spacerSeriesRef.current = spacerSeries;

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);
    window.addEventListener("resize", handleResize);
    handleResize();

    // In playground mode, intercept fitContent-style resets (double-click on axis
    // triggers a view that spans all data including the spacer). Clamp back to
    // real candles when this happens.
    let lastRangeChangeByUser = false;
    const onLogicalRangeChange = (range: any) => {
      if (!range) return;
      const state = useStore.getState();
      if (state.appMode !== "playground") return;
      const cursor = state.playgroundReplay.currentBarIndex;
      const total = state.playgroundReplay.totalBars;
      if (total === 0) return;
      // Detect fitContent: range covers from ~0 to ~(total-1), much larger than cursor+buffer
      const covers_all_data = range.from <= 2 && range.to >= total - 5;
      if (covers_all_data && !lastRangeChangeByUser) {
        // User triggered a fit that included spacer bars — snap back to a
        // view centered around the cursor (where the current candle is forming).
        lastRangeChangeByUser = true;
        requestAnimationFrame(() => {
          const from = Math.max(0, cursor - 60);
          const to = Math.min(total - 1, cursor + 15);
          chart.timeScale().setVisibleLogicalRange({ from, to });
          lastRangeChangeByUser = false;
        });
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onLogicalRangeChange);

    // Mouse handlers — route based on active tool
    const el = containerRef.current;

    // Double-click anywhere on the chart in playground mode → snap view back
    // to the replay cursor (TradingView-style "go to current price" behavior).
    // Runs during capture phase to intercept before lightweight-charts fires
    // its own fitContent, then stops propagation.
    const onDoubleClick = (e: MouseEvent) => {
      const state = useStore.getState();
      if (state.appMode !== "playground") return;
      const cursor = state.playgroundReplay.currentBarIndex;
      const total = state.playgroundReplay.totalBars;
      if (total === 0) return;
      const from = Math.max(0, cursor - 60);
      const to = Math.min(total - 1, cursor + 15);
      // Use rAF so our set runs after lightweight-charts' default handler
      requestAnimationFrame(() => {
        chart.timeScale().setVisibleLogicalRange({ from, to });
      });
      // A second rAF to guarantee we win against any async snap lightweight-charts does
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chart.timeScale().setVisibleLogicalRange({ from, to });
        });
      });
    };
    el.addEventListener("dblclick", onDoubleClick);

    const onMouseDown = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const tool = useStore.getState().activeDrawingTool;

      if (tool === "pattern_select") {
        if (primitive.onMouseDown(x, y)) {
          e.preventDefault();
          e.stopPropagation();
          el.setPointerCapture(e.pointerId || 0);
        }
        return;
      }

      if (drawPrimitive.onMouseDown(x, y)) {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId || 0);
        return;
      }

      // Allow pattern selector selection/drag in idle
      if (primitive.onMouseDown(x, y)) {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId || 0);
      }
    };

    const onMouseMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const tool = useStore.getState().activeDrawingTool;

      if (tool === "pattern_select") {
        primitive.onMouseMove(x, y);
        return;
      }
      if (drawPrimitive.onMouseMove(x, y)) return;
      primitive.onMouseMove(x, y);
    };

    const onMouseUp = (e: PointerEvent) => {
      const tool = useStore.getState().activeDrawingTool;

      if (tool === "pattern_select") {
        if (primitive.onMouseUp()) {
          setDrawingPhase(primitive.drawingPhase);
          setHasSelection(!!primitive.patternBox);
          el.releasePointerCapture(e.pointerId || 0);
        }
        return;
      }
      if (drawPrimitive.onMouseUp()) {
        el.releasePointerCapture(e.pointerId || 0);
        return;
      }
      if (primitive.onMouseUp()) {
        setDrawingPhase(primitive.drawingPhase);
        setHasSelection(!!primitive.patternBox);
        el.releasePointerCapture(e.pointerId || 0);
      }
    };

    el.addEventListener("pointerdown", onMouseDown);
    el.addEventListener("pointermove", onMouseMove);
    el.addEventListener("pointerup", onMouseUp);

    return () => {
      el.removeEventListener("pointerdown", onMouseDown);
      el.removeEventListener("pointermove", onMouseMove);
      el.removeEventListener("pointerup", onMouseUp);
      ro.disconnect();
      window.removeEventListener("resize", handleResize);
      if (markersRef.current) {
        markersRef.current.detach();
        markersRef.current = null;
      }
      series.detachPrimitive(primitive);
      series.detachPrimitive(drawPrimitive);
      series.detachPrimitive(highlightPrimitive);
      series.detachPrimitive(pineDrawingsPrimitive);
      series.detachPrimitive(tradeBoxPrimitive);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onLogicalRangeChange);
      el.removeEventListener("dblclick", onDoubleClick);
      patternPrimitiveRef.current = null;
      pineDrawingsRef.current = null;
      tradeBoxRef.current = null;
      drawingPrimitiveRef.current = null;
      highlightPrimitiveRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      indicatorSeriesRef.current.clear();
    };
  }, [darkMode]);

  // Update data
  useEffect(() => {
    if (!seriesRef.current) return;

    // When data is empty (new conversation), clear the chart
    if (data.length === 0) {
      seriesRef.current.setData([]);
      if (volumeSeriesRef.current) volumeSeriesRef.current.setData([]);
      if (spacerSeriesRef.current) spacerSeriesRef.current.setData([]);
      return;
    }

    // Build candle data — in playground, only include bars up to cursor (real data).
    // Future bars are handled by the invisible spacer series (extends the time scale).
    const isPlayground = appModeTop === "playground";
    const candleCount = isPlayground ? Math.min(playgroundCursor + 1, data.length) : data.length;
    const candleData: CandlestickData<Time>[] = [];
    for (let i = 0; i < candleCount; i++) {
      const bar = data[i];
      // Defensive: skip undefined/malformed bars (sparse arrays, time-less rows)
      if (!bar || bar.time == null) continue;
      candleData.push({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    }

    // Detect replay tick: in playground, cursor advanced but data array is same length
    const prevCursor = prevCursorRef.current;
    const isReplayTick =
      isPlayground &&
      playgroundInitializedRef.current &&
      prevCursor >= 0 &&
      playgroundCursor > prevCursor &&
      playgroundCursor - prevCursor <= 5 &&
      data.length === prevDataLenRef.current;
    prevDataLenRef.current = data.length;
    prevCursorRef.current = playgroundCursor;

    if (isReplayTick) {
      // Append only newly-revealed bars via update() — viewport stays put
      // Bound the loop by data.length AND playgroundCursor (defensive against
      // a stale cursor that points past the current dataset length, which can
      // happen when switching to a smaller dataset)
      const upperBound = Math.min(playgroundCursor, data.length - 1);
      for (let i = prevCursor + 1; i <= upperBound; i++) {
        const bar = data[i];
        if (!bar || bar.time == null) continue;
        seriesRef.current.update({
          time: bar.time as Time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });
        if (volumeSeriesRef.current) {
          volumeSeriesRef.current.update({
            time: bar.time as Time,
            value: bar.volume ?? 0,
            color: bar.close >= bar.open ? "rgba(38,166,154,0.2)" : "rgba(239,83,80,0.2)",
          });
        }
      }
    } else {
      seriesRef.current.setData(candleData);
      if (volumeSeriesRef.current) {
        const volumeData: { time: Time; value: number; color: string }[] = [];
        for (let i = 0; i < candleCount; i++) {
          const bar = data[i];
          if (!bar || bar.time == null) continue;
          volumeData.push({
            time: bar.time as Time,
            value: bar.volume ?? 0,
            color: bar.close >= bar.open ? "rgba(38,166,154,0.2)" : "rgba(239,83,80,0.2)",
          });
        }
        volumeSeriesRef.current.setData(volumeData);
      }

      // Feed spacer series FIRST (extends time scale in playground mode)
      if (spacerSeriesRef.current) {
        if (isPlayground) {
          const spacerData: { time: Time; value: number }[] = [];
          const mid = data[Math.min(playgroundCursor, data.length - 1)]?.close ?? 100;
          for (let i = 0; i < data.length; i++) {
            const bar = data[i];
            if (!bar || bar.time == null) continue;
            spacerData.push({ time: bar.time as Time, value: mid });
          }
          spacerSeriesRef.current.setData(spacerData);
        } else {
          spacerSeriesRef.current.setData([]);
        }
      }

      if (isPlayground && !playgroundInitializedRef.current && data.length > 0) {
        // Center initial view around the cursor — show ~60 past bars + a bit of
        // future space to the right so the current candle has room to grow into.
        const ts = chartRef.current?.timeScale();
        if (ts) {
          const from = Math.max(0, playgroundCursor - 60);
          const to = Math.min(data.length - 1, playgroundCursor + 15);
          // setVisibleLogicalRange works on logical bar indices (matches our array)
          ts.setVisibleLogicalRange({ from, to });
        }
        playgroundInitializedRef.current = true;
      } else if (!isPlayground) {
        chartRef.current?.timeScale().fitContent();
      }
    }

    if (!markersRef.current && seriesRef.current) {
      markersRef.current = createSeriesMarkers(seriesRef.current, []);
    }
  }, [data, darkMode, appModeTop, playgroundCursor]);

  // Reset playground init flag when leaving playground mode
  useEffect(() => {
    if (appModeTop !== "playground") {
      playgroundInitializedRef.current = false;
      prevCursorRef.current = -1;
    }
  }, [appModeTop]);

  // Historic news markers — push store state into the primitive whenever
  // it changes so the chart visuals stay in sync with HistoricNewsTab.
  // Scope: only plot on the chart whose dataset matches the news set's
  // symbol. Otherwise a news set for AAPL would draw on an open MSFT
  // chart too, which is confusing. We compare case-insensitively and
  // fall back to "plot on every chart" when either side can't be
  // resolved (legacy single-chart usage without a datasetId).
  const newsEvents = useStore((s) => s.newsEvents);
  const selectedNewsEventId = useStore((s) => s.selectedNewsEventId);
  const newsEventsSymbol = useStore((s) => s.newsEventsSymbol);
  useEffect(() => {
    const nm = newsMarkersRef.current;
    if (!nm) return;
    if (newsEvents.length === 0 || data.length === 0) {
      nm.clear();
      return;
    }
    // Resolve this chart's symbol from its datasetId (multi-chart mode)
    // or the active dataset (single-chart mode).
    const ownDsId = datasetId ?? activeDatasetId;
    const ownDs = datasets.find((d) => d.id === ownDsId);
    const ownSymbol = String(ownDs?.metadata?.symbol || "").toUpperCase();
    const newsSymbol = String(newsEventsSymbol || "").toUpperCase();
    // When we can resolve BOTH sides and they disagree, this chart
    // belongs to a different asset — clear any previously-drawn markers
    // and skip this run.
    if (ownSymbol && newsSymbol && ownSymbol !== newsSymbol) {
      nm.clear();
      return;
    }
    nm.setEvents(newsEvents, data, selectedNewsEventId);
  }, [newsEvents, selectedNewsEventId, newsEventsSymbol, data, datasetId, activeDatasetId, datasets]);

  // Update pattern highlight boxes + auto-zoom to show matches
  useEffect(() => {
    const hp = highlightPrimitiveRef.current;
    if (!hp) return;

    if (patternMatches.length === 0 || data.length === 0) {
      hp.clear();
      if (markersRef.current) markersRef.current.setMarkers([]);
      return;
    }

    // Render as transparent highlight boxes
    hp.setMatches(patternMatches, data);

    // --- AUTO-ZOOM: fit the viewport around the matches so they're visible ---
    const chart = chartRef.current;
    if (chart) {
      // Collect all match times, snap to nearest bar time, compute span
      const chartTimes = data
        .filter((b) => b && b.time != null)
        .map((b) => b.time as number)
        .sort((a, b) => a - b);
      if (chartTimes.length > 0) {
        let minT = Infinity;
        let maxT = -Infinity;
        for (const m of patternMatches) {
          const s = typeof m.startTime === "string" ? Number(m.startTime) : (m.startTime as number);
          const e = typeof m.endTime === "string" ? Number(m.endTime) : (m.endTime as number);
          if (isFinite(s)) minT = Math.min(minT, s);
          if (isFinite(e)) maxT = Math.max(maxT, e);
        }

        if (isFinite(minT) && isFinite(maxT)) {
          // Find logical indices of these times in the data array
          const startIdx = chartTimes.findIndex((t) => t >= minT);
          let endIdx = chartTimes.findIndex((t) => t >= maxT);
          if (endIdx === -1) endIdx = chartTimes.length - 1;
          const safeStart = startIdx === -1 ? 0 : startIdx;

          // Add 25% padding on each side so matches aren't glued to edges
          const span = Math.max(endIdx - safeStart, 1);
          const pad = Math.max(Math.round(span * 0.25), 10);
          const fromLogical = Math.max(0, safeStart - pad);
          const toLogical = Math.min(chartTimes.length - 1, endIdx + pad);

          // Defer to next frame so the highlight primitive has painted first
          requestAnimationFrame(() => {
            try {
              chart.timeScale().setVisibleLogicalRange({
                from: fromLogical,
                to: toLogical,
              });
            } catch {
              // Fallback: fit all content
              chart.timeScale().fitContent();
            }
          });
        }
      }
    }

    // Also set small markers at start points for quick navigation
    if (markersRef.current) {
      // Defensive: filter out malformed bars before reading .time. A sparse
      // chartData (mid-update or stale switch) would otherwise throw "Cannot
      // read properties of undefined (reading 'time')" inside the snap loop.
      const chartTimes = data
        .filter((b) => b && b.time != null)
        .map((b) => b.time as number);

      // If there are no valid times to snap against, clear markers and bail
      if (chartTimes.length === 0) {
        markersRef.current.setMarkers([]);
        return;
      }

      const snapToChart = (raw: number): number => {
        let best = chartTimes[0], bestDist = Math.abs(raw - best);
        for (const t of chartTimes) {
          const d = Math.abs(raw - t);
          if (d < bestDist) { bestDist = d; best = t; }
        }
        return best;
      };

      const byTime = new Map<number, (typeof patternMatches)[0]>();
      for (const m of patternMatches) {
        if (!m || m.startTime == null) continue;
        const raw = typeof m.startTime === "string" ? Number(m.startTime) : m.startTime as number;
        if (!isFinite(raw)) continue;
        const snapped = snapToChart(raw);
        if (snapped == null || !isFinite(snapped)) continue;
        const existing = byTime.get(snapped);
        if (!existing || m.confidence > existing.confidence) byTime.set(snapped, m);
      }

      const markers = Array.from(byTime.entries())
        .sort(([a], [b]) => a - b)
        .map(([time, m]) => ({
          time: time as unknown as Time,
          position: "aboveBar" as const,
          color: m.direction === "bullish" ? "#00d68f" : m.direction === "bearish" ? "#ff4d4d" : "#ff6b00",
          shape: "circle" as const,
          text: "",
        }));

      markersRef.current.setMarkers(markers);
    }
  }, [patternMatches, data]);

  // Update S/R lines
  useEffect(() => {
    if (!seriesRef.current) return;

    supportResistance.forEach((level) => {
      seriesRef.current?.createPriceLine({
        price: level.price,
        color: level.type === "support" ? "#22c55e" : "#ef4444",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: level.type === "support" ? "S" : "R",
      });
    });
  }, [supportResistance]);

  // Handle indicator overlays (built-in + custom)
  useEffect(() => {
    if (!chartRef.current || data.length === 0) return;

    const chart = chartRef.current;
    const existingSeries = indicatorSeriesRef.current;

    indicators.forEach((ind) => {
      const key = ind.name;

      if (ind.active && !existingSeries.has(key)) {
        const parsedParams = Object.fromEntries(
          Object.entries(ind.params).map(([k, v]) => [
            k,
            typeof v === "string" ? (isNaN(Number(v)) ? v : Number(v)) : v,
          ])
        );

        const addLine = (values: (number | null)[]) => {
          if (!chartRef.current) return;
          const lineSeries = chartRef.current.addSeries(LineSeries, {
            color: ind.color || INDICATOR_COLORS[key] || "#8b5cf6",
            lineWidth: ind.custom ? 2 : 1,
            priceLineVisible: false,
            lastValueVisible: false,
          });

          const lineData: { time: Time; value: number }[] = [];
          const maxIdx = appModeTop === "playground" ? playgroundCursor : data.length - 1;
          for (let i = 0; i < values.length && i <= maxIdx && i < data.length; i++) {
            const v = values[i];
            const bar = data[i];
            if (v !== null && v !== undefined && bar && bar.time != null) {
              lineData.push({ time: bar.time as Time, value: v });
            }
          }

          lineSeries.setData(lineData);
          existingSeries.set(key, lineSeries);
        };

        if (ind.custom && (ind as any)._precomputed) {
          // Pine Script indicator with pre-computed values
          const values = (ind as any)._precomputed as (number | null)[];
          if (Array.isArray(values) && values.length > 0) {
            addLine(values);
          }
          // Also re-run PineTS to restore drawings if script exists
          if (ind.script?.startsWith("__PINE__")) {
            import("@/lib/pine/runPineScript").then(({ runPineScript }) => {
              const pineCode = ind.script!.slice(8);
              runPineScript(pineCode, data).then((result) => {
                const hasDrawings = result.drawings && (
                  result.drawings.boxes.length > 0 || result.drawings.lines.length > 0 ||
                  result.drawings.labels.length > 0 || (result.drawings.fills?.length || 0) > 0
                );
                if (hasDrawings || Object.keys(result.plots).length > 0) {
                  useStore.getState().setPineDrawings(result.drawings, result.plots);
                }
              }).catch(() => {});
            });
          }
        } else if (ind.custom && ind.script && !ind.script.startsWith("__PINE__")) {
          // Custom JS indicator — run script in Web Worker
          executeIndicatorScript(ind.script, data, parsedParams)
            .then((values) => {
              if (Array.isArray(values) && values.length > 0) {
                addLine(values);
              }
            })
            .catch((err) => {
              console.warn(`Custom indicator "${ind.name}" failed:`, err.message);
            });
        } else if (ind.custom && ind.script?.startsWith("__PINE__")) {
          // Pine Script indicator without precomputed — re-run fully
          import("@/lib/pine/runPineScript").then(({ runPineScript }) => {
            const pineCode = ind.script!.slice(8);
            runPineScript(pineCode, data).then((result) => {
              if (result.plotNames.length > 0) {
                const firstPlot = result.plots[result.plotNames[0]];
                if (firstPlot) addLine(firstPlot);
              }
              const hasDrawings = result.drawings && (
                result.drawings.boxes.length > 0 || result.drawings.lines.length > 0 ||
                result.drawings.labels.length > 0 || (result.drawings.fills?.length || 0) > 0
              );
              if (hasDrawings || Object.keys(result.plots).length > 0) {
                useStore.getState().setPineDrawings(result.drawings, result.plots);
              }
            }).catch(() => {});
          });
        } else {
          // Built-in indicator
          try {
            const values = calculateIndicatorLocal(data, ind.backendName, parsedParams);
            addLine(values);
          } catch {
            // Silently fail
          }
        }
      } else if (!ind.active && existingSeries.has(key)) {
        const series = existingSeries.get(key)!;
        chart.removeSeries(series);
        existingSeries.delete(key);
      }
    });

    // Clean up series for deleted indicators (no longer in the array)
    const activeKeys = new Set(indicators.map((ind) => ind.name));
    for (const [key, series] of existingSeries) {
      if (!activeKeys.has(key)) {
        chart.removeSeries(series);
        existingSeries.delete(key);
      }
    }
  }, [indicators, data, appModeTop, playgroundCursor]);

  const storeDrawings = useStore((s) => s.drawings);

  // Render Pine Script drawings
  const pineDrawings = useStore((s) => s.pineDrawings);
  const pineDrawingsPlotData = useStore((s) => s.pineDrawingsPlotData);
  useEffect(() => {
    const p = pineDrawingsRef.current;
    if (!p) return;
    if (pineDrawings && data.length > 0) {
      p.setDrawings(pineDrawings, data, pineDrawingsPlotData || undefined);
    } else {
      p.clear();
    }
  }, [pineDrawings, pineDrawingsPlotData, data]);

  // Sync active drawing tool from store to primitive
  useEffect(() => {
    const p = drawingPrimitiveRef.current;
    const ps = patternPrimitiveRef.current;
    if (!p || !ps) return;

    if (activeDrawingTool === "pattern_select") {
      // Activate pattern selector, deactivate drawing tools
      p.setActiveTool(null);
      ps.clear();
      ps.setDrawingPhase("pattern");
      setDrawingPhase("pattern");
      setHasSelection(false);
      chartRef.current?.applyOptions({
        crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      });
    } else {
      // Deactivate pattern selector if switching away
      if (drawingPhase !== "idle") {
        ps.clear();
        setDrawingPhase("idle");
        setHasSelection(false);
        chartRef.current?.applyOptions({
          crosshair: { vertLine: { visible: true }, horzLine: { visible: true } },
        });
      }
      p.setActiveTool(activeDrawingTool);
    }
  }, [activeDrawingTool]);

  // Sync drawings from store to primitive ONLY for external deletions
  const prevDrawingCountRef = useRef(0);
  useEffect(() => {
    const p = drawingPrimitiveRef.current;
    if (!p) return;
    // Only push store→primitive when a drawing was deleted externally
    // (store count dropped without the primitive initiating it)
    if (storeDrawings.length < prevDrawingCountRef.current && storeDrawings.length < p.drawings.length) {
      p.setDrawings(storeDrawings);
    }
    prevDrawingCountRef.current = storeDrawings.length;
  }, [storeDrawings]);

  // Zoom chart to focused time range (from clicking a pattern row).
  // Per-dataset focus wins over global focus — see resolvedFocus above.
  useEffect(() => {
    if (!resolvedFocus || !chartRef.current) return;
    const ts = chartRef.current.timeScale();
    ts.setVisibleRange({
      from: resolvedFocus.startTime as unknown as Time,
      to: resolvedFocus.endTime as unknown as Time,
    });
    // Clear whichever slot we read from so clicking the same row again works
    if (datasetId) {
      setChartFocusForDataset(datasetId, null);
    } else {
      setChartFocus(null);
    }
  }, [resolvedFocus, setChartFocus, setChartFocusForDataset, datasetId]);

  // Render trade position boxes from strategy backtest
  const plottedTrades = useStore((s) => s.plottedTrades);
  const highlightedTradeId = useStore((s) => s.highlightedTradeId);
  const appMode = useStore((s) => s.appMode);
  const positions = useStore((s) => s.positions);
  const replayCursor = useStore((s) => s.playgroundReplay.currentBarIndex);
  useEffect(() => {
    const prim = tradeBoxRef.current;
    if (!prim) return;

    // In playground mode, feed open positions as live trade boxes that
    // grow with the replay cursor (not the end of the full dataset).
    if (appMode === "playground") {
      if (positions.length === 0 || data.length === 0) {
        prim.clear();
        return;
      }
      // Use the bar at the replay cursor as "now" — that's the last revealed
      // candle. The exit price/time should track this so the box extends from
      // entry to the current forming candle, growing on every tick.
      const cursorIdx = Math.max(0, Math.min(replayCursor, data.length - 1));
      const cursorBar = data[cursorIdx];
      const currentPrice = cursorBar.close;
      const currentTime = typeof cursorBar.time === "string" ? Number(cursorBar.time) : cursorBar.time;

      const asTrades = positions.map((p) => ({
        id: p.id,
        entryTime: String(p.openedAtTime),
        exitTime: String(currentTime),
        entryPrice: p.entryPrice,
        exitPrice: currentPrice,
        direction: p.side,
        quantity: p.size,
        // Recompute live PnL from the cursor price (positions store has
        // pre-tick values that may be stale during the same render frame).
        pnl: p.side === "long"
          ? (currentPrice - p.entryPrice) * (p.size / p.entryPrice)
          : (p.entryPrice - currentPrice) * (p.size / p.entryPrice),
        pnlPercent: p.side === "long"
          ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
          : ((p.entryPrice - currentPrice) / p.entryPrice) * 100,
      }));
      prim.setTrades(asTrades as any, data);
      return;
    }

    if (plottedTrades.length === 0) {
      prim.clear();
      return;
    }

    prim.setTrades(plottedTrades, data);
  }, [plottedTrades, data, appMode, positions, replayCursor]);

  // Highlight a specific trade box when selected in TradeList
  useEffect(() => {
    const prim = tradeBoxRef.current;
    if (!prim) return;
    prim.setHighlighted(highlightedTradeId ?? null);
  }, [highlightedTradeId]);

  // --- Pattern Selector handlers ---

  // Get selected bars from the single pattern box
  const getSelectedBars = useCallback(() => {
    const p = patternPrimitiveRef.current;
    if (!p || !p.patternBox) return null;
    const pb = p.patternBox;
    const startT = pb.startTime as number;
    const endT = pb.endTime as number;
    const bars = data.filter(
      (b) => (b.time as number) >= startT && (b.time as number) <= endT
    );
    return bars.length > 0 ? bars : null;
  }, [data]);

  const handleClear = useCallback(() => {
    const p = patternPrimitiveRef.current;
    if (!p) return;
    p.clear();
    setDrawingPhase("idle");
    setHasSelection(false);
    setCapturedPattern(null);
    setActiveDrawingTool(null);
    chartRef.current?.applyOptions({
      crosshair: { vertLine: { visible: true }, horzLine: { visible: true } },
    });
  }, [setCapturedPattern, setActiveDrawingTool]);

  const handleSendToAgent = useCallback(() => {
    const bars = getSelectedBars();
    if (!bars || bars.length === 0) return;

    // Capture snapshot of the selection area (all canvas layers composited)
    let snapshotUrl: string | null = null;
    try {
      const container = containerRef.current;
      if (container) {
        const allCanvases = container.querySelectorAll("canvas");
        const prim = patternPrimitiveRef.current;
        const chart = chartRef.current;
        const series = seriesRef.current;
        if (prim?.patternBox && chart && series && allCanvases.length > 0) {
          const ts = chart.timeScale();
          const x1 = ts.timeToCoordinate(prim.patternBox.startTime);
          const x2 = ts.timeToCoordinate(prim.patternBox.endTime);
          const allPrices = bars.flatMap(b => [b.high, b.low]);
          const maxP = Math.max(...allPrices);
          const minP = Math.min(...allPrices);
          const y1 = series.priceToCoordinate(maxP * 1.02);
          const y2 = series.priceToCoordinate(minP * 0.98);

          if (x1 != null && x2 != null && y1 != null && y2 != null) {
            const dpr = window.devicePixelRatio || 1;
            // Source coords in the underlying canvas buffer (already DPR-scaled)
            const sx = Math.min(x1, x2) * dpr;
            const sy = Math.min(y1, y2) * dpr;
            const sw = Math.abs(x2 - x1) * dpr;
            const sh = Math.abs(y2 - y1) * dpr;

            if (sw > 10 && sh > 10) {
              // Guarantee at least ~2x CSS-pixel density in the exported image
              // so small selections don't blur when the chat renders them.
              // On DPR=2 devices the factor is 1 (we already have the pixels);
              // on DPR=1 we upscale the destination by 2x with high-quality
              // interpolation so the <img> has enough intrinsic pixels.
              const targetDpr = 2;
              const upscale = targetDpr / dpr > 1 ? targetDpr / dpr : 1;
              const dw = Math.round(sw * upscale);
              const dh = Math.round(sh * upscale);

              const tempCanvas = document.createElement("canvas");
              tempCanvas.width = dw;
              tempCanvas.height = dh;
              const ctx = tempCanvas.getContext("2d");
              if (ctx) {
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                // Composite all canvas layers (candles + primitives/overlays)
                for (const cvs of allCanvases) {
                  ctx.drawImage(cvs, sx, sy, sw, sh, 0, 0, dw, dh);
                }
                // PNG is lossless; drop the bogus quality arg (ignored for PNG)
                snapshotUrl = tempCanvas.toDataURL("image/png");
              }
            }
          }
        }
      }
    } catch {
      // Snapshot capture failed — continue without it
    }

    const activeInds = useStore.getState().indicators;
    const fingerprint = extractFingerprint(bars, data, activeInds);
    setCapturedPattern(fingerprint);

    // ── BUILD MATHEMATICAL PROMPT ──
    // Sample the normalized close shape for the LLM (scale-free)
    const step = Math.max(1, Math.floor(fingerprint.patternShape.length / 15));
    const sampled = fingerprint.patternShape.filter((_, i) => i % step === 0);
    const shapeStr = sampled.map(v => v.toFixed(2)).join(", ");

    // Candle structure summary
    const cs = fingerprint.candleSequence || [];
    const bullCount = cs.filter(c => c.direction > 0).length;
    const bearCount = cs.length - bullCount;
    const avgBody = cs.length > 0 ? cs.reduce((s, c) => s + c.bodySize, 0) / cs.length : 0;
    const avgWickRatio = cs.length > 0 ? cs.reduce((s, c) => s + c.bodyRatio, 0) / cs.length : 0;

    // Indicator math
    const indMath = Object.entries(fingerprint.indicatorMath || {})
      .map(([name, m]) => {
        return `${name}: ${m.positionRelativeToPrice} price, slope=${m.slope}, curvature=${m.curvature}, crosses price ${m.crossesPrice}x`;
      })
      .join(". ");

    // Overall direction
    const patternDir = fingerprint.trendAngle > 0 ? "rising" : "falling";
    const tradeDirection = fingerprint.priceChangePercent >= 0 ? "bullish" : "bearish";

    const draft = [
      `Find this ${bars.length}-bar pattern (scale-free):`,
      ``,
      `GOAL: Detect this pattern shape anywhere in the dataset.`,
      `OVERALL: ${patternDir} ${Math.abs(fingerprint.priceChangePercent).toFixed(1)}%, volatility ${fingerprint.volatility > 0.02 ? "high" : fingerprint.volatility > 0.01 ? "moderate" : "low"}`,
      ``,
      `SHAPE: [${shapeStr}] (${sampled.length} bars, normalized close 0-1)`,
      `STRUCTURE: ${bullCount} bull / ${bearCount} bear candles, avg body=${(avgBody * 100).toFixed(1)}%, avg body/range=${(avgWickRatio * 100).toFixed(0)}%`,
      indMath ? `INDICATORS: ${indMath}` : "",
      ``,
      `RULES: Sliding window of EXACTLY ${bars.length} bars. Normalize each window's closes to 0-1. Pearson correlation > 0.55 with the SHAPE above. For each match, set start_idx to window start and end_idx to window end. Set pattern_type to "${tradeDirection}".`,
    ].filter(v => v !== undefined && v !== "").join("\n");

    // Add snapshot image to chat if captured
    if (snapshotUrl) {
      addMessage({ role: "user", content: "Pattern selection snapshot:", image: snapshotUrl });
    }

    setChatInputDraft(draft);

    chartRef.current?.applyOptions({
      crosshair: { vertLine: { visible: true }, horzLine: { visible: true } },
    });
  }, [data, getSelectedBars, setCapturedPattern, setChatInputDraft]);

  // Re-enable crosshair when selection completes
  useEffect(() => {
    if (drawingPhase === "idle" && hasSelection) {
      chartRef.current?.applyOptions({
        crosshair: { vertLine: { visible: true }, horzLine: { visible: true } },
      });
    }
  }, [drawingPhase, hasSelection]);

  return (
    <div className="relative h-full w-full" style={{ background: "var(--bg)" }}>
      <div ref={containerRef} className="absolute inset-0" />

      {data.length > 0 && (activeDrawingTool === "pattern_select" || hasSelection) && (
        <PatternSelectorToolbar
          drawingPhase={drawingPhase}
          hasSelection={hasSelection}
          onSendToAgent={handleSendToAgent}
          onClear={handleClear}
        />
      )}

      {/* Dataset info overlay — top-left of chart */}
      {data.length > 0 && activeDs && (
        <div className="absolute top-2 left-2 z-10 pointer-events-none opacity-50">
          <div className="text-[11px] font-semibold text-slate-600 tracking-wide">
            {activeDs.name.replace(/\.csv$/i, "").toUpperCase()}
          </div>
          <div className="text-[10px] text-slate-400">
            {activeDs.metadata.chartTimeframe || activeDs.metadata.nativeTimeframe || "?"}
            {activeDs.metadata.chartTimeframe && activeDs.metadata.nativeTimeframe && activeDs.metadata.chartTimeframe !== activeDs.metadata.nativeTimeframe
              ? ` (native ${activeDs.metadata.nativeTimeframe})`
              : ""}
          </div>
          <div className="text-[10px] text-slate-400">
            {new Date(activeDs.metadata.startDate).toLocaleDateString()} — {new Date(activeDs.metadata.endDate).toLocaleDateString()}
          </div>
          <div className="text-[10px] text-slate-400">
            {activeDs.metadata.rows.toLocaleString()} bars
          </div>
        </div>
      )}

      {data.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-slate-400">Upload a CSV dataset to begin</p>
        </div>
      )}
    </div>
  );
}
