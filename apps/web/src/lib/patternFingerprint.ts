import type { OHLCBar, IndicatorConfig, CapturedPatternData } from "@/types";
import { calculateIndicatorLocal } from "@/lib/indicators";

/**
 * Extract a comprehensive mathematical fingerprint from trigger + trade boxes.
 *
 * Captures:
 * 1. Candlestick sequence — body/wick ratios, direction, relative sizes
 * 2. Box dimensions — trigger/trade width ratio, height ratio, coordinates as ratios
 * 3. Indicator mathematical behavior — slope, curvature, relative position to price
 * 4. Correlation between price action and indicator overlays
 */
export function extractFingerprint(
  bars: OHLCBar[],
  allData: OHLCBar[],
  activeIndicators: IndicatorConfig[],
  triggerBarCount?: number,
): CapturedPatternData {
  const n = bars.length;
  const triggerLen = triggerBarCount || Math.round(n * 0.6);
  const tradeLen = n - triggerLen;

  // ── 1. CANDLESTICK SEQUENCE ──
  // Normalized OHLC relative to range — scale-independent
  const closes = bars.map((b) => b.close);
  const opens = bars.map((b) => b.open);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume ?? 0);

  const globalHigh = Math.max(...highs);
  const globalLow = Math.min(...lows);
  const priceRange = globalHigh - globalLow || 1;

  // Normalized shape (0-1 for each OHLC component)
  const normClose = closes.map((c) => (c - globalLow) / priceRange);
  const normOpen = opens.map((o) => (o - globalLow) / priceRange);
  const normHigh = highs.map((h) => (h - globalLow) / priceRange);
  const normLow = lows.map((l) => (l - globalLow) / priceRange);

  // Per-candle characteristics (scale-free)
  const candleSequence = bars.map((b) => {
    const bodySize = Math.abs(b.close - b.open) / priceRange;
    const upperWick = (b.high - Math.max(b.open, b.close)) / priceRange;
    const lowerWick = (Math.min(b.open, b.close) - b.low) / priceRange;
    const direction = b.close >= b.open ? 1 : -1;
    const totalRange = (b.high - b.low) / priceRange;
    const bodyRatio = totalRange > 0 ? (Math.abs(b.close - b.open)) / (b.high - b.low) : 0;
    return { bodySize, upperWick, lowerWick, direction, totalRange, bodyRatio };
  });

  // ── 2. BOX DIMENSIONS (ratios) ──
  const triggerBars = bars.slice(0, triggerLen);
  const tradeBars = bars.slice(triggerLen);

  const triggerHigh = Math.max(...triggerBars.map(b => b.high));
  const triggerLow = Math.min(...triggerBars.map(b => b.low));
  const tradeHigh = tradeBars.length > 0 ? Math.max(...tradeBars.map(b => b.high)) : triggerHigh;
  const tradeLow = tradeBars.length > 0 ? Math.min(...tradeBars.map(b => b.low)) : triggerLow;

  const triggerHeightRatio = (triggerHigh - triggerLow) / priceRange;
  const tradeHeightRatio = (tradeHigh - tradeLow) / priceRange;
  const widthRatio = triggerLen / n; // trigger width as fraction of total
  const heightShift = ((tradeHigh + tradeLow) / 2 - (triggerHigh + triggerLow) / 2) / priceRange; // vertical shift from trigger center to trade center

  // ── 3. MATHEMATICAL INDICATORS ──
  const startTime = bars[0].time as number;
  const endTime = bars[bars.length - 1].time as number;
  const startIdx = allData.findIndex((b) => (b.time as number) >= startTime);
  const endIdx = allData.findIndex((b) => (b.time as number) > endTime);
  const actualEnd = endIdx === -1 ? allData.length : endIdx;
  const warmupStart = Math.max(0, startIdx - 100);
  const contextBars = allData.slice(warmupStart, actualEnd);
  const offsetInContext = startIdx - warmupStart;

  const indicators: Record<string, (number | null)[]> = {};
  const indicatorMath: Record<string, {
    slope: number;
    curvature: number;
    positionRelativeToPrice: string;
    normalizedValues: number[];
    crossesPrice: number;
    triggerSlope: number;
    tradeSlope: number;
  }> = {};

  for (const ind of activeIndicators) {
    if (!ind.active) continue;
    // For custom indicators with precomputed values, use those directly
    if (ind.custom && (ind as any)._precomputed) {
      const precomp = (ind as any)._precomputed as (number | null)[];
      // Slice to selected range
      const sliced = precomp.slice(startIdx, startIdx + n);
      indicators[ind.name] = sliced;
      // Compute math for precomputed too
      const valid = sliced.filter((v): v is number => v !== null);
      if (valid.length >= 2) {
        const indMin = Math.min(...valid);
        const indMax = Math.max(...valid);
        const indRange = indMax - indMin || 1;
        const normalized = valid.map(v => (v - indMin) / indRange);
        const slope = linearRegressionSlope(valid);
        const normalizedSlope = slope / (indRange / valid.length || 1);
        let curvatureSum = 0;
        for (let i = 1; i < valid.length - 1; i++) curvatureSum += valid[i + 1] - 2 * valid[i] + valid[i - 1];
        const curvature = valid.length > 2 ? curvatureSum / (valid.length - 2) / indRange : 0;
        const avgInd = valid.reduce((s, v) => s + v, 0) / valid.length;
        const avgPrice = closes.reduce((s, c) => s + c, 0) / closes.length;
        let crosses = 0;
        for (let ci = 1; ci < Math.min(valid.length, closes.length); ci++) {
          if ((valid[ci - 1] > closes[ci - 1]) !== (valid[ci] > closes[ci])) crosses++;
        }
        const triggerVals = valid.slice(0, Math.min(triggerLen, valid.length));
        const tradeVals = valid.slice(triggerLen);
        indicatorMath[ind.name] = {
          slope: round4(normalizedSlope), curvature: round4(curvature),
          positionRelativeToPrice: avgInd > avgPrice ? "above" : "below",
          normalizedValues: normalized, crossesPrice: crosses,
          triggerSlope: round4(triggerVals.length >= 2 ? linearRegressionSlope(triggerVals) / (indRange / triggerVals.length || 1) : 0),
          tradeSlope: round4(tradeVals.length >= 2 ? linearRegressionSlope(tradeVals) / (indRange / tradeVals.length || 1) : 0),
        };
      }
      continue;
    }
    // Skip custom scripts without precomputed data
    if (ind.custom && ind.script) continue;
    try {
      const parsedParams = Object.fromEntries(
        Object.entries(ind.params).map(([k, v]) => [
          k,
          typeof v === "string" ? (isNaN(Number(v)) ? v : Number(v)) : v,
        ])
      );
      const fullValues = calculateIndicatorLocal(contextBars, ind.backendName, parsedParams);
      const sliced = fullValues.slice(offsetInContext, offsetInContext + n);
      indicators[ind.name] = sliced;

      // Mathematical analysis of indicator
      const valid = sliced.filter((v): v is number => v !== null);
      if (valid.length >= 2) {
        // Normalize indicator values to 0-1 relative to price range
        const indMin = Math.min(...valid);
        const indMax = Math.max(...valid);
        const indRange = indMax - indMin || 1;
        const normalized = valid.map(v => (v - indMin) / indRange);

        // Slope (linear regression)
        const slope = linearRegressionSlope(valid);
        const normalizedSlope = slope / (indRange / valid.length || 1);

        // Curvature (second derivative approximation)
        let curvatureSum = 0;
        for (let i = 1; i < valid.length - 1; i++) {
          curvatureSum += valid[i + 1] - 2 * valid[i] + valid[i - 1];
        }
        const curvature = valid.length > 2 ? curvatureSum / (valid.length - 2) / indRange : 0;

        // Position relative to price
        const avgInd = valid.reduce((s, v) => s + v, 0) / valid.length;
        const avgPrice = closes.reduce((s, c) => s + c, 0) / closes.length;
        const positionRelativeToPrice = avgInd > avgPrice ? "above" : avgInd < avgPrice ? "below" : "at";

        // Price-indicator crossings
        let crosses = 0;
        for (let i = 1; i < Math.min(valid.length, closes.length); i++) {
          const prevAbove = valid[i - 1] > closes[i - 1];
          const currAbove = valid[i] > closes[i];
          if (prevAbove !== currAbove) crosses++;
        }

        // Separate trigger/trade slopes
        const triggerVals = valid.slice(0, Math.min(triggerLen, valid.length));
        const tradeVals = valid.slice(triggerLen);
        const triggerSlope = triggerVals.length >= 2 ? linearRegressionSlope(triggerVals) / (indRange / triggerVals.length || 1) : 0;
        const tradeSlope = tradeVals.length >= 2 ? linearRegressionSlope(tradeVals) / (indRange / tradeVals.length || 1) : 0;

        indicatorMath[ind.name] = {
          slope: round4(normalizedSlope),
          curvature: round4(curvature),
          positionRelativeToPrice,
          normalizedValues: normalized,
          crossesPrice: crosses,
          triggerSlope: round4(triggerSlope),
          tradeSlope: round4(tradeSlope),
        };
      }
    } catch { /* skip */ }
  }

  // ── 4. OVERALL METRICS ──
  const trendAngle = linearRegressionSlope(closes);
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    if (closes[i - 1] !== 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const volatility = stdDev(returns);
  const maxVol = Math.max(...volumes, 1);
  const volumeProfile = volumes.map((v) => v / maxVol);
  const priceChangePercent = closes.length >= 2 && closes[0] !== 0
    ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : 0;

  // Trigger-specific and trade-specific trends
  const triggerCloses = closes.slice(0, triggerLen);
  const tradeCloses = closes.slice(triggerLen);
  const triggerTrend = triggerCloses.length >= 2 ? linearRegressionSlope(triggerCloses) : 0;
  const tradeTrend = tradeCloses.length >= 2 ? linearRegressionSlope(tradeCloses) : 0;

  return {
    bars,
    timeRange: [startTime, endTime],
    priceRange: [globalLow, globalHigh],
    indicators,
    priceChangePercent: round4(priceChangePercent),
    volatility: round4(volatility),
    volumeProfile,
    trendAngle: round4(trendAngle),
    patternShape: normClose,
    // Extended data
    candleSequence,
    normOpen,
    normHigh,
    normLow,
    triggerRatio: widthRatio,
    triggerHeightRatio: round4(triggerHeightRatio),
    tradeHeightRatio: round4(tradeHeightRatio),
    heightShift: round4(heightShift),
    triggerTrend: round4(triggerTrend),
    tradeTrend: round4(tradeTrend),
    indicatorMath,
  };
}

function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += values[i]; sumXY += i * values[i]; sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

function round4(v: number): number { return Math.round(v * 10000) / 10000; }
