"use client";

import { useState, useCallback } from "react";
import Papa from "papaparse";
import { useStore } from "@/store/useStore";
import { resampleOHLC } from "@/lib/csv/resampleOHLC";
import type { OHLCBar } from "@/types";

const COLUMN_ALIASES: Record<string, string[]> = {
  time: ["time", "timestamp", "unix_timestamp", "date", "datetime", "t", "open time", "open_time", "opentime"],
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  close: ["close", "c"],
  volume: ["volume", "vol", "v", "volume_usd", "volume_btc", "quote asset volume"],
};

function normalizeHeaders(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const header of headers) {
      if (aliases.includes(header.trim().toLowerCase()) && !used.has(canonical)) {
        map[header] = canonical;
        used.add(canonical);
        break;
      }
    }
  }
  return map;
}

function parseTimestamp(value: string | number): number {
  if (typeof value === "number" || /^\d+\.?\d*$/.test(String(value))) {
    const num = Number(value);
    return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  const ms = Date.parse(String(value));
  if (!isNaN(ms)) return Math.floor(ms / 1000);
  return NaN;
}

/**
 * Stream-parse a CSV file using PapaParse. Handles files of any size
 * by reading row-by-row without loading the entire file into memory.
 */
function streamParseCSV(file: File): Promise<OHLCBar[]> {
  return new Promise((resolve, reject) => {
    const bars: OHLCBar[] = [];
    let colMap: Record<string, string> | null = null;
    let timeKey = "", openKey = "", highKey = "", lowKey = "", closeKey = "", volKey = "";

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      delimiter: ",",
      step: (row: Papa.ParseStepResult<Record<string, string>>) => {
        // On first row, resolve column mapping
        if (!colMap && row.meta.fields) {
          colMap = normalizeHeaders(row.meta.fields);
          const required = ["time", "open", "high", "low", "close"];
          const found = new Set(Object.values(colMap));
          const missing = required.filter(r => !found.has(r));
          if (missing.length > 0) {
            reject(new Error(`Missing required columns: ${missing.join(", ")}. Found: ${row.meta.fields.join(", ")}`));
            return;
          }
          // Cache key lookups
          for (const [orig, canon] of Object.entries(colMap)) {
            if (canon === "time") timeKey = orig;
            if (canon === "open") openKey = orig;
            if (canon === "high") highKey = orig;
            if (canon === "low") lowKey = orig;
            if (canon === "close") closeKey = orig;
            if (canon === "volume") volKey = orig;
          }
        }

        const d = row.data;
        const open = parseFloat(d[openKey]);
        const high = parseFloat(d[highKey]);
        const low = parseFloat(d[lowKey]);
        const close = parseFloat(d[closeKey]);
        const volume = volKey ? (parseFloat(d[volKey]) || 0) : 0;
        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return;
        if (open < 0 || high < 0 || low < 0 || close < 0) return;

        const time = parseTimestamp(d[timeKey]);
        if (isNaN(time)) return;

        bars.push({ time, open, high, low, close, volume });
      },
      complete: () => {
        if (bars.length === 0) {
          reject(new Error("No valid OHLC rows found in CSV"));
          return;
        }
        // Sort by time
        bars.sort((a, b) => (a.time as number) - (b.time as number));
        resolve(bars);
      },
      error: (err: Error) => {
        reject(new Error(`CSV parse error: ${err.message}`));
      },
    });
  });
}

export function FileUpload() {
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const addDataset = useStore((s) => s.addDataset);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".csv")) {
        setError("Please upload a CSV file");
        return;
      }

      setProcessing(true);
      setError(null);
      const sizeMB = (file.size / 1024 / 1024).toFixed(0);
      setProgress(`Reading ${sizeMB}MB...`);

      try {
        const rawData = await streamParseCSV(file);
        setProgress(`Parsed ${rawData.length.toLocaleString()} bars, resampling...`);

        const chartData = resampleOHLC(rawData);

        const startDate = new Date((rawData[0].time as number) * 1000).toISOString();
        const endDate = new Date((rawData[rawData.length - 1].time as number) * 1000).toISOString();

        const dataset = {
          id: crypto.randomUUID(),
          name: file.name,
          metadata: {
            rows: rawData.length,
            startDate,
            endDate,
          },
        };

        addDataset(dataset, chartData, rawData);
        setProgress("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Processing failed");
      } finally {
        setProcessing(false);
      }
    },
    [addDataset]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`rounded border-2 border-dashed p-4 text-center text-xs transition-colors ${
        dragging
          ? "border-slate-400 bg-slate-50"
          : "border-slate-200 hover:border-slate-300"
      }`}
    >
      {processing ? (
        <p className="text-slate-400">{progress || "Processing..."}</p>
      ) : (
        <>
          <p className="text-slate-400 mb-1">Drop CSV here or</p>
          <label className="cursor-pointer text-slate-600 font-medium hover:text-slate-900 underline underline-offset-2">
            browse
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleChange}
            />
          </label>
        </>
      )}
      {error && <p className="mt-1 text-red-500">{error}</p>}
    </div>
  );
}
