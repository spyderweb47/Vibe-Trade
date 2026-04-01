import type { OHLCBar, IndicatorConfig, CapturedPatternData } from "@/types";
import { calculateIndicatorLocal } from "@/lib/indicators";

/**
 * Extract a rich pattern fingerprint from a selected zone of bars.
 * Includes normalized price shape, indicator values, trend, volatility, volume profile.
 */
export function extractFingerprint(
  bars: OHLCBar[],
  allData: OHLCBar[],
  activeIndicators: IndicatorConfig[]
): CapturedPatternData {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume ?? 0);

  // Normalized price shape (0-1 scale)
  const minPrice = Math.min(...closes);
  const maxPrice = Math.max(...closes);
  const priceRange = maxPrice - minPrice || 1;
  const patternShape = closes.map((c) => (c - minPrice) / priceRange);

  // Trend angle via linear regression slope
  const trendAngle = linearRegressionSlope(closes);

  // Volatility: std dev of bar-to-bar returns
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    if (closes[i - 1] !== 0) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
  }
  const volatility = stdDev(returns);

  // Volume profile: normalized to 0-1
  const maxVol = Math.max(...volumes, 1);
  const volumeProfile = volumes.map((v) => v / maxVol);

  // Price change %
  const priceChangePercent =
    closes.length >= 2 && closes[0] !== 0
      ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100
      : 0;

  // Compute active indicator values for selected bars
  // We need enough context before the selected range for indicators to warm up,
  // so we find the position in allData and compute on a wider window
  const startTime = bars[0].time as number;
  const endTime = bars[bars.length - 1].time as number;
  const startIdx = allData.findIndex((b) => (b.time as number) >= startTime);
  const endIdx = allData.findIndex((b) => (b.time as number) > endTime);
  const actualEnd = endIdx === -1 ? allData.length : endIdx;

  // Use 50 extra bars before for indicator warmup
  const warmupStart = Math.max(0, startIdx - 50);
  const contextBars = allData.slice(warmupStart, actualEnd);
  const offsetInContext = startIdx - warmupStart;

  const indicators: Record<string, (number | null)[]> = {};
  for (const ind of activeIndicators) {
    if (!ind.active) continue;
    try {
      const parsedParams = Object.fromEntries(
        Object.entries(ind.params).map(([k, v]) => [
          k,
          typeof v === "string" ? (isNaN(Number(v)) ? v : Number(v)) : v,
        ])
      );
      const fullValues = ind.custom && ind.script
        ? [] // skip custom scripts in fingerprint for now
        : calculateIndicatorLocal(contextBars, ind.backendName, parsedParams);

      // Slice to only the selected range
      indicators[ind.name] = fullValues.slice(offsetInContext, offsetInContext + n);
    } catch {
      // skip failed indicators
    }
  }

  return {
    bars,
    timeRange: [startTime, endTime],
    priceRange: [minPrice, maxPrice],
    indicators,
    priceChangePercent: Math.round(priceChangePercent * 100) / 100,
    volatility: Math.round(volatility * 10000) / 10000,
    volumeProfile,
    trendAngle: Math.round(trendAngle * 10000) / 10000,
    patternShape,
  };
}

function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
