import type { Time } from "lightweight-charts";

export type DrawingType = "trendline" | "long_position" | "short_position" | "pattern_select";

export interface AnchorPoint {
  time: Time;
  price: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  /** Trendline: [start, end]. Position: [entry, tp, sl] stored as prices. */
  points: AnchorPoint[];
  /** For position tools: entry, tp, sl prices */
  entry?: number;
  tp?: number;
  sl?: number;
  /** Time range for position box width */
  timeStart?: Time;
  timeEnd?: Time;
  selected: boolean;
}

export type DrawingPhase = "idle" | "placing_first" | "placing_second" | "done";
