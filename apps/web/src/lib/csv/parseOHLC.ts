import Papa from "papaparse";
import type { OHLCBar } from "@/types";

const COLUMN_ALIASES: Record<string, string[]> = {
  time: ["time", "timestamp", "unix_timestamp", "date", "datetime", "t", "open time", "open_time", "opentime"],
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  close: ["close", "c"],
  volume: ["volume", "vol", "v", "volume_usd", "volume_btc", "quote asset volume"],
};

export interface ParseResult {
  data: OHLCBar[];
  metadata: {
    rows: number;
    startDate: string;
    endDate: string;
  };
}

function normalizeColumns(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();

  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const header of headers) {
      const lower = header.trim().toLowerCase();
      if (aliases.includes(lower) && !used.has(canonical)) {
        map[header] = canonical;
        used.add(canonical);
        break;
      }
    }
  }

  const required = ["time", "open", "high", "low", "close"];
  const missing = required.filter((r) => !used.has(r));
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(", ")}`);
  }

  return map;
}

function parseTimestamp(value: string | number): number {
  if (typeof value === "number" || /^\d+\.?\d*$/.test(String(value))) {
    const num = Number(value);
    // Heuristic: > 1e12 means milliseconds
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }

  const ms = Date.parse(String(value));
  if (!isNaN(ms)) return Math.floor(ms / 1000);

  throw new Error(`Cannot parse timestamp: ${value}`);
}

export function parseOHLC(csvText: string): ParseResult {
  // Strip BOM if present
  const text = csvText.charCodeAt(0) === 0xFEFF ? csvText.slice(1) : csvText;

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimiter: ",", // Force comma — most OHLC CSVs use commas
  });

  // Only throw if truly no data was parsed (ignore delimiter warnings)
  if (parsed.data.length === 0) {
    const errMsg = parsed.errors.length > 0 ? parsed.errors[0].message : "No data rows found";
    throw new Error(`CSV parse error: ${errMsg}`);
  }

  if (parsed.data.length === 0) {
    throw new Error("CSV is empty");
  }

  const colMap = normalizeColumns(parsed.meta.fields || []);

  const bars: OHLCBar[] = [];

  for (const row of parsed.data) {
    const timeRaw = row[Object.keys(colMap).find((k) => colMap[k] === "time")!];
    const openRaw = row[Object.keys(colMap).find((k) => colMap[k] === "open")!];
    const highRaw = row[Object.keys(colMap).find((k) => colMap[k] === "high")!];
    const lowRaw = row[Object.keys(colMap).find((k) => colMap[k] === "low")!];
    const closeRaw = row[Object.keys(colMap).find((k) => colMap[k] === "close")!];
    const volKey = Object.keys(colMap).find((k) => colMap[k] === "volume");
    const volRaw = volKey ? row[volKey] : "0";

    const open = parseFloat(openRaw);
    const high = parseFloat(highRaw);
    const low = parseFloat(lowRaw);
    const close = parseFloat(closeRaw);
    const volume = parseFloat(volRaw) || 0;

    // Skip invalid rows
    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
    if (open < 0 || high < 0 || low < 0 || close < 0 || volume < 0) continue;

    let time: number;
    try {
      time = parseTimestamp(timeRaw);
    } catch {
      continue;
    }

    bars.push({ time, open, high, low, close, volume });
  }

  if (bars.length === 0) {
    throw new Error("No valid OHLC rows found");
  }

  // Sort by time ascending
  bars.sort((a, b) => (a.time as number) - (b.time as number));

  const startDate = new Date((bars[0].time as number) * 1000).toISOString();
  const endDate = new Date((bars[bars.length - 1].time as number) * 1000).toISOString();

  return {
    data: bars,
    metadata: {
      rows: bars.length,
      startDate,
      endDate,
    },
  };
}
