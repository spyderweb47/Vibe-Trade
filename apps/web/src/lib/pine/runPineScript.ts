import { PineTS } from "pinets";
import { LocalProvider } from "./localProvider";
import { extractPineDrawings } from "./pineDrawings";
import type { PineDrawings } from "./pineDrawings";
import type { OHLCBar } from "@/types";

export interface PineResult {
  /** Plot values keyed by plot name. Each is an array of (number | null) aligned to input bars */
  plots: Record<string, (number | null)[]>;
  /** Names of all plots in order */
  plotNames: string[];
  /** Drawing objects (boxes, lines, labels) from the Pine Script */
  drawings: PineDrawings;
  /** Errors if any */
  error?: string;
}

// Internal plot names used by PineTS for drawing objects — not actual indicator plots
const INTERNAL_PLOTS = new Set([
  "__labels__",
  "__lines__",
  "__boxes__",
  "__linefills__",
  "__polylines__",
  "__tables__",
]);

/**
 * Execute a Pine Script against local OHLC data using PineTS.
 *
 * Returns plot values that can be rendered as indicator lines on the chart.
 */
export async function runPineScript(
  pineCode: string,
  data: OHLCBar[],
  symbol = "LOCAL",
  timeframe = "D"
): Promise<PineResult> {
  if (!data || data.length === 0) {
    return { plots: {}, plotNames: [], drawings: { boxes: [], lines: [], labels: [], fills: [] }, error: "No data provided" };
  }

  try {
    // Create provider with our local data
    const provider = new LocalProvider();
    provider.loadData(data, symbol, timeframe);

    // Create PineTS instance with the local provider
    const pine = new PineTS(provider, symbol, timeframe, data.length);

    // Run the Pine Script — returns a Context object
    const ctx = await pine.run(pineCode);

    // Extract plot data and plotshape markers from Context
    const plots: Record<string, (number | null)[]> = {};
    const plotNames: string[] = [];
    const shapeLabels: PineDrawings["labels"] = [];
    const dynamicLines: PineDrawings["lines"] = [];

    if (ctx && ctx.plots) {
      for (const [name, plotObj] of Object.entries(ctx.plots)) {
        // Skip internal drawing plots
        if (INTERNAL_PLOTS.has(name)) continue;

        const obj = plotObj as any;
        if (!obj?.data || !Array.isArray(obj.data)) continue;

        const opts = obj.options || {};

        // plotshape / plotchar — extract as label markers
        if (opts.style === "shape" || opts.style === "char") {
          const shapeType = opts.shape || "shape_circle";
          const isAbove = shapeType.includes("down") || shapeType.includes("triangledown");
          const color = opts.color || "#ffffff";
          const textColor = opts.textcolor || "#ffffff";
          const text = opts.text || "";

          for (let i = 0; i < obj.data.length; i++) {
            const d = obj.data[i];
            if (d.value === null || d.value === undefined) continue;
            const val = Number(d.value);
            if (isNaN(val)) continue;

            shapeLabels.push({
              x: i, // bar index
              y: val,
              text: text,
              color: color,
              textColor: textColor,
              style: isAbove ? "style_label_down" : "style_label_up",
              size: opts.size || "small",
            });
          }
          continue;
        }

        // Skip fill() plots — they reference other plots, not data
        if (opts.style === "fill") continue;

        // Check if plot has dynamic (per-bar) colors
        const colors = new Set<string>();
        for (const d of obj.data) {
          if (d.options?.color) colors.add(d.options.color);
          if (colors.size > 1) break;
        }

        const hasDynamicColor = colors.size > 1;

        if (hasDynamicColor) {
          // Dynamic color plot — render as colored line segments in drawings
          // Still add to plots for fill references
          plotNames.push(name);
          plots[name] = obj.data.map((d: any) =>
            d.value === null || d.value === undefined || (typeof d.value === "number" && isNaN(d.value))
              ? null : Number(d.value)
          );

          // Create per-bar line segments with correct colors
          const lineWidth = opts.linewidth || 2;

          for (let i = 1; i < obj.data.length; i++) {
            const prev = obj.data[i - 1];
            const curr = obj.data[i];
            const prevVal = prev.value;
            const currVal = curr.value;

            if (prevVal == null || currVal == null || isNaN(Number(prevVal)) || isNaN(Number(currVal))) continue;

            const col = curr.options?.color || prev.options?.color || "#ffffff";
            dynamicLines.push({
              x1: i - 1, y1: Number(prevVal),
              x2: i, y2: Number(currVal),
              color: col, width: lineWidth,
              style: "style_solid", extend: "none",
            });
          }
        } else {
          // Static color plot — regular line series
          plotNames.push(name);
          plots[name] = obj.data.map((d: any) =>
            d.value === null || d.value === undefined || (typeof d.value === "number" && isNaN(d.value))
              ? null
              : Number(d.value)
          );
        }
      }
    }

    // Extract drawing objects (boxes, lines, labels from drawing APIs)
    const drawings = ctx?.plots ? extractPineDrawings(ctx.plots) : { boxes: [], lines: [], labels: [], fills: [] };

    // Merge plotshape labels and dynamic-color lines into drawings
    drawings.labels.push(...shapeLabels);
    drawings.lines.push(...dynamicLines);

    return { plots, plotNames, drawings };
  } catch (err) {
    return {
      plots: {},
      plotNames: [],
      drawings: { boxes: [], lines: [], labels: [], fills: [] },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

