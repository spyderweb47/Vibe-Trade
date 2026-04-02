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
import { PatternHighlightPrimitive, setTriggerRatio } from "@/lib/chart-primitives/PatternHighlightPrimitive";
import { PineDrawingsPrimitive } from "@/lib/chart-primitives/PineDrawingsPrimitive";
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
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const patternPrimitiveRef = useRef<PatternSelectorPrimitive | null>(null);
  const drawingPrimitiveRef = useRef<DrawingToolsPrimitive | null>(null);
  const highlightPrimitiveRef = useRef<PatternHighlightPrimitive | null>(null);
  const pineDrawingsRef = useRef<PineDrawingsPrimitive | null>(null);

  const darkMode = useStore((s) => s.darkMode);
  const indicators = useStore((s) => s.indicators);
  const setCapturedPattern = useStore((s) => s.setCapturedPattern);
  const chartFocus = useStore((s) => s.chartFocus);
  const setChartFocus = useStore((s) => s.setChartFocus);
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

    // Pine Script drawings primitive
    const pineDrawingsPrimitive = new PineDrawingsPrimitive();
    series.attachPrimitive(pineDrawingsPrimitive);
    pineDrawingsRef.current = pineDrawingsPrimitive;

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
      series.detachPrimitive(pineDrawingsPrimitive);
      patternPrimitiveRef.current = null;
      pineDrawingsRef.current = null;
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
    if (!seriesRef.current || data.length === 0) return;

    const candleData: CandlestickData<Time>[] = data.map((bar) => ({
      time: bar.time as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));

    seriesRef.current.setData(candleData);

    // Set volume data
    if (volumeSeriesRef.current) {
      const volumeData = data.map((bar) => ({
        time: bar.time as Time,
        value: bar.volume ?? 0,
        color: bar.close >= bar.open ? "rgba(38,166,154,0.2)" : "rgba(239,83,80,0.2)",
      }));
      volumeSeriesRef.current.setData(volumeData);
    }

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

        if (ind.custom && (ind as any)._precomputed) {
          // Pine Script indicator — use pre-computed values
          const values = (ind as any)._precomputed as (number | null)[];
          if (Array.isArray(values) && values.length > 0) {
            addLine(values);
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
          // Pine Script indicator — re-run with PineTS
          import("@/lib/pine/runPineScript").then(({ runPineScript }) => {
            const pineCode = ind.script!.slice(8); // strip __PINE__ prefix
            runPineScript(pineCode, data).then((result) => {
              if (result.plotNames.length > 0) {
                const firstPlot = result.plots[result.plotNames[0]];
                if (firstPlot) addLine(firstPlot);
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
  }, [indicators, data]);

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

    const p = patternPrimitiveRef.current;
    const triggerBars = p?.triggerBox
      ? data.filter(b => (b.time as number) >= (p.triggerBox!.startTime as number) && (b.time as number) <= (p.triggerBox!.endTime as number))
      : [];
    const tradeBars = p?.tradeBox
      ? data.filter(b => (b.time as number) > (p.tradeBox!.startTime as number) && (b.time as number) <= (p.tradeBox!.endTime as number))
      : [];
    const triggerLen = triggerBars.length || Math.round(bars.length * 0.6);
    const tradeLen = tradeBars.length || (bars.length - triggerLen);

    const activeInds = useStore.getState().indicators;
    const fingerprint = extractFingerprint(bars, data, activeInds, triggerLen);
    setCapturedPattern(fingerprint);
    setTriggerRatio(triggerLen / bars.length);

    // ── BUILD MATHEMATICAL PROMPT ──
    // Sample shape to ~15 points
    const shape = fingerprint.patternShape;
    const step = Math.max(1, Math.floor(shape.length / 15));
    const sampled = shape.filter((_, i) => i % step === 0);
    const shapeStr = sampled.map(v => v.toFixed(2)).join(", ");

    // Candle structure summary
    const cs = fingerprint.candleSequence || [];
    const bullCount = cs.filter(c => c.direction > 0).length;
    const bearCount = cs.length - bullCount;
    const avgBody = cs.length > 0 ? cs.reduce((s, c) => s + c.bodySize, 0) / cs.length : 0;
    const avgWickRatio = cs.length > 0 ? cs.reduce((s, c) => s + c.bodyRatio, 0) / cs.length : 0;

    // Box geometry
    const triggerRatio = Math.round((fingerprint.triggerRatio || 0.6) * 100);
    const boxGeometry = [
      `Trigger: ${triggerRatio}% width, ${((fingerprint.triggerHeightRatio || 0) * 100).toFixed(1)}% height.`,
      `Trade: ${100 - triggerRatio}% width, ${((fingerprint.tradeHeightRatio || 0) * 100).toFixed(1)}% height.`,
      `Trade shifts ${fingerprint.heightShift! > 0 ? "up" : "down"} ${Math.abs((fingerprint.heightShift || 0) * 100).toFixed(1)}% from trigger center.`,
    ].join(" ");

    // Indicator math
    const indMath = Object.entries(fingerprint.indicatorMath || {})
      .map(([name, m]) => {
        return `${name}: ${m.positionRelativeToPrice} price, trigger slope=${m.triggerSlope}, trade slope=${m.tradeSlope}, curvature=${m.curvature}, crosses price ${m.crossesPrice}x`;
      })
      .join(". ");

    // Trend comparison
    const triggerDir = (fingerprint.triggerTrend || 0) > 0 ? "rising" : "falling";
    const tradeDir = (fingerprint.tradeTrend || 0) > 0 ? "rising" : "falling";

    const draft = [
      `Find this ${bars.length}-bar pattern (${triggerLen} trigger + ${tradeLen} trade bars, scale-free):`,
      ``,
      `SHAPE: [${shapeStr}] (${sampled.length} points, normalized 0-1)`,
      `STRUCTURE: ${bullCount} bull / ${bearCount} bear candles, avg body=${(avgBody * 100).toFixed(1)}%, avg body/range=${(avgWickRatio * 100).toFixed(0)}%`,
      `TRIGGER BOX: ${triggerRatio}% of pattern, height ${((fingerprint.triggerHeightRatio || 0) * 100).toFixed(1)}% of range, trend ${triggerDir}`,
      `TRADE BOX: ${100 - triggerRatio}% of pattern, height ${((fingerprint.tradeHeightRatio || 0) * 100).toFixed(1)}% of range, trend ${tradeDir}, shifts ${fingerprint.heightShift! > 0 ? "up" : "down"} ${Math.abs((fingerprint.heightShift || 0) * 100).toFixed(1)}%`,
      `OVERALL: ${fingerprint.trendAngle > 0 ? "up" : "down"} ${Math.abs(fingerprint.priceChangePercent).toFixed(1)}%, volatility ${fingerprint.volatility > 0.02 ? "high" : fingerprint.volatility > 0.01 ? "moderate" : "low"}`,
      indMath ? `INDICATORS: ${indMath}` : "",
      ``,
      `RULES: Sliding window of EXACTLY ${sampled.length} bars. Normalize each window's closes to 0-1 (min=0, max=1). Compute Pearson correlation with reference shape. Match if correlation > 0.55 (use 0.55 NOT higher). Do NOT add extra filters — only correlation. Set pattern_type to "${tradeDir}".`,
    ].filter(v => v !== undefined && v !== "").join("\n");

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
