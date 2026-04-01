import type { OHLCBar, PatternMatch } from "@/types";

interface MatchResult {
  startIdx: number;
  endIdx: number;
  startTime: number;
  endTime: number;
  similarity: number;
}

/**
 * Find patterns in `allData` that are similar to the reference `patternShape`.
 *
 * Uses a sliding window with Pearson correlation on normalized price shapes.
 * Combines shape similarity (60%), volume profile similarity (20%), and
 * trend direction match (20%).
 */
export function findSimilarPatterns(
  referenceShape: number[],
  referenceVolume: number[],
  referenceTrend: number,
  allData: OHLCBar[],
  referenceTimeRange: [number, number],
  minSimilarity = 0.7,
  maxResults = 50
): PatternMatch[] {
  const windowLen = referenceShape.length;
  if (windowLen < 3 || allData.length < windowLen) return [];

  const refStart = referenceTimeRange[0];
  const refEnd = referenceTimeRange[1];

  const results: MatchResult[] = [];

  for (let i = 0; i <= allData.length - windowLen; i++) {
    const windowStart = allData[i].time as number;
    const windowEnd = allData[i + windowLen - 1].time as number;

    // Skip if this window overlaps with the reference
    if (windowStart <= refEnd && windowEnd >= refStart) continue;

    // Extract window closes and normalize to 0-1
    const closes: number[] = [];
    const volumes: number[] = [];
    for (let j = 0; j < windowLen; j++) {
      closes.push(allData[i + j].close);
      volumes.push(allData[i + j].volume ?? 0);
    }

    const minP = Math.min(...closes);
    const maxP = Math.max(...closes);
    const range = maxP - minP;
    if (range === 0) continue;

    const windowShape = closes.map((c) => (c - minP) / range);

    // Shape similarity via Pearson correlation
    const shapeSim = pearsonCorrelation(referenceShape, windowShape);
    if (shapeSim < minSimilarity * 0.5) continue; // early exit

    // Volume similarity
    const maxVol = Math.max(...volumes, 1);
    const windowVol = volumes.map((v) => v / maxVol);
    const volSim = Math.max(0, pearsonCorrelation(referenceVolume, windowVol));

    // Trend direction match
    const windowTrend = closes[closes.length - 1] - closes[0];
    const trendMatch = Math.sign(windowTrend) === Math.sign(referenceTrend) ? 1 : 0;

    // Weighted score
    const score = shapeSim * 0.6 + volSim * 0.2 + trendMatch * 0.2;

    if (score >= minSimilarity) {
      results.push({
        startIdx: i,
        endIdx: i + windowLen - 1,
        startTime: windowStart,
        endTime: windowEnd,
        similarity: Math.round(score * 1000) / 1000,
      });
    }
  }

  // Sort by similarity descending, take top N
  results.sort((a, b) => b.similarity - a.similarity);
  const top = results.slice(0, maxResults);

  // Convert to PatternMatch format
  return top.map((r) => ({
    id: crypto.randomUUID(),
    name: `Similar (${(r.similarity * 100).toFixed(0)}%)`,
    startIndex: r.startIdx,
    endIndex: r.endIdx,
    startTime: String(r.startTime),
    endTime: String(r.endTime),
    direction: "neutral" as const,
    confidence: r.similarity,
  }));
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  if (n !== b.length || n < 2) return 0;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }

  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}
