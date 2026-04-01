"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
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
import { PatternHighlightPrimitive, setTriggerRatio } from "@/lib/chart-primitives/PatternHighlightPrimitive";
import type { DrawingPhase } from "@/lib/chart-primitives/patternSelectorTypes";
import { PatternSelectorToolbar } from "./PatternSelectorToolbar";

interface ChartProps {
  data: OHLCBar[];
  patternMatches?: PatternMatch[];
  supportResistance?: { price: number; type: "support" | "resistance" }[];
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
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const patternPrimitiveRef = useRef<PatternSelectorPrimitive | null>(null);
  const drawingPrimitiveRef = useRef<DrawingToolsPrimitive | null>(null);
  const highlightPrimitiveRef = useRef<PatternHighlightPrimitive | null>(null);

  const indicators = useStore((s) => s.indicators);
  const setCapturedPattern = useStore((s) => s.setCapturedPattern);
  const chartFocus = useStore((s) => s.chartFocus);
  const setChartFocus = useStore((s) => s.setChartFocus);
  const activeDrawingTool = useStore((s) => s.activeDrawingTool);
  const setActiveDrawingTool = useStore((s) => s.setActiveDrawingTool);
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
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#64748b",
        fontFamily: "'Chakra Petch', sans-serif",
      },
      grid: {
        vertLines: { color: "#f1f5f9" },
        horzLines: { color: "#f1f5f9" },
      },
      crosshair: {
        vertLine: { color: "#94a3b8", labelBackgroundColor: "#475569" },
        horzLine: { color: "#94a3b8", labelBackgroundColor: "#475569" },
      },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: true,
      },
      rightPriceScale: {
        borderColor: "#e2e8f0",
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    // Pattern selector primitive
    const primitive = new PatternSelectorPrimitive();
    primitive.setOnChange((trigger, trade) => {
      setHasSelection(!!(trigger && trade));
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

    // Mouse handlers — route based on active tool
    const el = containerRef.current;

    const onMouseDown = (e: MouseEvent) => {
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

    const onMouseMove = (e: MouseEvent) => {
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

    const onMouseUp = (e: MouseEvent) => {
      const tool = useStore.getState().activeDrawingTool;

      if (tool === "pattern_select") {
        if (primitive.onMouseUp()) {
          setDrawingPhase(primitive.drawingPhase);
          setHasSelection(!!(primitive.triggerBox && primitive.tradeBox));
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
        setHasSelection(!!(primitive.triggerBox && primitive.tradeBox));
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
      patternPrimitiveRef.current = null;
      drawingPrimitiveRef.current = null;
      highlightPrimitiveRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      indicatorSeriesRef.current.clear();
    };
  }, []);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;

    const candleData: CandlestickData<Time>[] = data.map((bar) => ({
      time: bar.time as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));

    seriesRef.current.setData(candleData);
    chartRef.current?.timeScale().fitContent();

    if (!markersRef.current && seriesRef.current) {
      markersRef.current = createSeriesMarkers(seriesRef.current, []);
    }
  }, [data]);

  // Update pattern highlight boxes
  useEffect(() => {
    const hp = highlightPrimitiveRef.current;
    if (!hp) return;

    if (patternMatches.length === 0 || data.length === 0) {
      hp.clear();
      // Also clear markers
      if (markersRef.current) markersRef.current.setMarkers([]);
      return;
    }

    // Render as transparent highlight boxes
    hp.setMatches(patternMatches, data);

    // Also set small markers at start points for quick navigation
    if (markersRef.current) {
      const chartTimes = data.map((b) => b.time as number);
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
        const raw = typeof m.startTime === "string" ? Number(m.startTime) : m.startTime as number;
        const snapped = snapToChart(raw);
        const existing = byTime.get(snapped);
        if (!existing || m.confidence > existing.confidence) byTime.set(snapped, m);
      }

      const markers = Array.from(byTime.entries())
        .sort(([a], [b]) => a - b)
        .map(([time, m]) => ({
          time: time as unknown as Time,
          position: "aboveBar" as const,
          color: m.direction === "bullish" ? "#22c55e" : m.direction === "bearish" ? "#ef4444" : "#6366f1",
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
          for (let i = 0; i < values.length && i < data.length; i++) {
            const v = values[i];
            if (v !== null && v !== undefined && data[i]) {
              lineData.push({ time: data[i].time as Time, value: v });
            }
          }

          lineSeries.setData(lineData);
          existingSeries.set(key, lineSeries);
        };

        if (ind.custom && ind.script) {
          // Custom indicator — run script in Web Worker
          executeIndicatorScript(ind.script, data, parsedParams)
            .then(addLine)
            .catch(() => {}); // silently fail
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
  }, [indicators, data]);

  const storeDrawings = useStore((s) => s.drawings);

  // Sync active drawing tool from store to primitive
  useEffect(() => {
    const p = drawingPrimitiveRef.current;
    const ps = patternPrimitiveRef.current;
    if (!p || !ps) return;

    if (activeDrawingTool === "pattern_select") {
      // Activate pattern selector, deactivate drawing tools
      p.setActiveTool(null);
      ps.clear();
      ps.setDrawingPhase("trigger");
      setDrawingPhase("trigger");
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

  // Zoom chart to focused time range (from clicking a pattern row)
  useEffect(() => {
    if (!chartFocus || !chartRef.current) return;
    const ts = chartRef.current.timeScale();
    ts.setVisibleRange({
      from: chartFocus.startTime as unknown as Time,
      to: chartFocus.endTime as unknown as Time,
    });
    // Clear the focus so clicking the same row again works
    setChartFocus(null);
  }, [chartFocus, setChartFocus]);

  // --- Pattern Selector handlers ---

  // Get selected bars from BOTH trigger and trade boxes
  const getSelectedBars = useCallback(() => {
    const p = patternPrimitiveRef.current;
    if (!p || !p.triggerBox) return null;
    const tb = p.triggerBox;
    const tr = p.tradeBox;
    const startT = tb.startTime as number;
    const endT = tr ? (tr.endTime as number) : (tb.endTime as number);
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

    const activeInds = useStore.getState().indicators;
    const fingerprint = extractFingerprint(bars, data, activeInds);
    setCapturedPattern(fingerprint);

    // Build a scale-free pattern template — NO absolute prices
    // Normalize shape to ~15 sample points
    const shape = fingerprint.patternShape;
    const sampleCount = Math.min(15, shape.length);
    const step = Math.max(1, Math.floor(shape.length / sampleCount));
    const sampled = [];
    for (let i = 0; i < shape.length; i += step) sampled.push(shape[i]);
    const shapeStr = sampled.map(v => v.toFixed(2)).join(", ");

    // Compute normalized volume profile (also ~15 points)
    const volSampled = [];
    for (let i = 0; i < fingerprint.volumeProfile.length; i += step) {
      volSampled.push(fingerprint.volumeProfile[i]);
    }
    const volStr = volSampled.map(v => v.toFixed(2)).join(", ");

    // Describe relative indicator behavior (rising/falling/flat), not values
    const indBehavior = Object.entries(fingerprint.indicators)
      .map(([name, vals]) => {
        const valid = vals.filter((v): v is number => v !== null);
        if (valid.length < 2) return null;
        const first = valid[0], last = valid[valid.length - 1];
        const mid = valid[Math.floor(valid.length / 2)];
        let behavior = "flat";
        const change = (last - first) / (Math.abs(first) || 1);
        if (change > 0.02) behavior = "rising";
        else if (change < -0.02) behavior = "falling";
        // Check for crossover patterns
        if (first < mid && mid > last) behavior = "peaked";
        if (first > mid && mid < last) behavior = "dipped";
        return `${name}: ${behavior}`;
      })
      .filter(Boolean)
      .join(", ");

    // Find where trigger ends and trade begins (relative position)
    const p = patternPrimitiveRef.current;
    const triggerLen = p?.triggerBox
      ? data.filter(b => (b.time as number) >= (p.triggerBox!.startTime as number) && (b.time as number) <= (p.triggerBox!.endTime as number)).length
      : bars.length;
    const triggerRatio = Math.round((triggerLen / bars.length) * 100);

    // Set the trigger/trade split ratio for highlight rendering
    setTriggerRatio(triggerLen / bars.length);

    const windowSize = sampled.length;
    const draft = [
      `Detect this pattern template (scale-independent, works at any price level).`,
      `The reference shape has exactly ${windowSize} points: [${shapeStr}].`,
      `First ${triggerRatio}% is setup, last ${100 - triggerRatio}% is the move.`,
      `Trend: ${fingerprint.trendAngle > 0 ? "upward" : "downward"}.`,
      indBehavior ? `Indicator context: ${indBehavior}.` : "",
      `RULES: Use a sliding window of EXACTLY ${windowSize} bars (same as the pattern length). For each window, normalize the ${windowSize} closes to 0-1 (min=0, max=1). Compute Pearson correlation between the normalized window and the reference pattern array. If correlation > 0.65, add to results. The pattern array and the window MUST be the same length (${windowSize}). Do NOT use a different window size. Set pattern_type to the trend direction.`,
    ].filter(Boolean).join(" ");

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
    <div className="relative h-full w-full rounded-lg border border-slate-200 bg-white">
      <div ref={containerRef} className="absolute inset-0" />

      {data.length > 0 && (activeDrawingTool === "pattern_select" || hasSelection) && (
        <PatternSelectorToolbar
          drawingPhase={drawingPhase}
          hasSelection={hasSelection}
          onSendToAgent={handleSendToAgent}
          onClear={handleClear}
        />
      )}

      {data.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-slate-400">Upload a CSV dataset to begin</p>
        </div>
      )}
    </div>
  );
}
