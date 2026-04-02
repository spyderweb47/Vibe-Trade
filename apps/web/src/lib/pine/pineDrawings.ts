/**
 * Extract and convert PineTS drawing objects (boxes, lines, labels)
 * into a format renderable by our chart primitive.
 */

import type { OHLCBar } from "@/types";

export interface PineBox {
  left: number;   // bar index or time
  top: number;    // price
  right: number;  // bar index or time
  bottom: number; // price
  borderColor: string;
  borderWidth: number;
  bgColor: string;
  text: string;
  textColor: string;
}

export interface PineLine {
  x1: number; // bar index
  y1: number; // price
  x2: number; // bar index
  y2: number; // price
  color: string;
  width: number;
  style: string; // "style_solid" | "style_dashed" | "style_dotted"
  extend: string;
}

export interface PineLabel {
  x: number;    // bar index
  y: number;    // price
  text: string;
  color: string;
  textColor: string;
  style: string;
  size: string;
}

export interface PineFill {
  plot1Name: string;
  plot2Name: string;
  color: string;
}

export interface PineDrawings {
  boxes: PineBox[];
  lines: PineLine[];
  labels: PineLabel[];
  fills: PineFill[];
}

/**
 * Extract drawing objects from PineTS context plots.
 * Drawing data is stored in the last entry of each __type__ plot data array.
 */
export function extractPineDrawings(plots: Record<string, any>): PineDrawings {
  const result: PineDrawings = { boxes: [], lines: [], labels: [], fills: [] };

  // Extract fill() references
  for (const [name, plotObj] of Object.entries(plots)) {
    const obj = plotObj as any;
    if (obj?.options?.style === "fill" && obj.options.plot1 && obj.options.plot2) {
      result.fills.push({
        plot1Name: obj.options.plot1,
        plot2Name: obj.options.plot2,
        color: obj.options.color || obj.data?.[0]?.options?.color || "rgba(33,150,243,0.1)",
      });
    }
  }

  // Extract boxes
  if (plots.__boxes__?.data) {
    const entries = plots.__boxes__.data;
    // Get the last bar's drawings (cumulative state)
    const last = entries[entries.length - 1];
    if (last?.value && Array.isArray(last.value)) {
      for (const b of last.value) {
        if (b._deleted) continue;
        result.boxes.push({
          left: b.left,
          top: b.top,
          right: b.right,
          bottom: b.bottom,
          borderColor: b.border_color || "transparent",
          borderWidth: b.border_width || 1,
          bgColor: b.bgcolor || "transparent",
          text: b.text || "",
          textColor: b.text_color || "#ffffff",
        });
      }
    }
  }

  // Extract lines
  if (plots.__lines__?.data) {
    const entries = plots.__lines__.data;
    const last = entries[entries.length - 1];
    if (last?.value && Array.isArray(last.value)) {
      for (const l of last.value) {
        if (l._deleted) continue;
        result.lines.push({
          x1: l.x1,
          y1: l.y1,
          x2: l.x2,
          y2: l.y2,
          color: l.color || "#ffffff",
          width: l.width || 1,
          style: l.style || "style_solid",
          extend: l.extend || "none",
        });
      }
    }
  }

  // Extract labels
  if (plots.__labels__?.data) {
    const entries = plots.__labels__.data;
    const last = entries[entries.length - 1];
    if (last?.value && Array.isArray(last.value)) {
      for (const lb of last.value) {
        if (lb._deleted) continue;
        result.labels.push({
          x: lb.x,
          y: lb.y,
          text: lb.text || "",
          color: lb.color || "transparent",
          textColor: lb.textcolor || "#ffffff",
          style: lb.style || "style_label_down",
          size: lb.size || "normal",
        });
      }
    }
  }

  return result;
}
