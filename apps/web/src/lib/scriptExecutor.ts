import type { OHLCBar, PatternMatch } from "@/types";

interface RawMatch {
  start_idx: number;
  end_idx: number;
  confidence: number;
  pattern_type: string;
}

/**
 * Helper library pre-injected at the top of every pattern script.
 *
 * The LLM keeps making transcription typos when asked to write these from
 * scratch (e.g. `sumB += a[i]` instead of `sumB += b[i]`), which silently
 * corrupts every correlation score. By providing them as globals, the LLM
 * just calls `pearson(...)` / `resampleTo(...)` and there's no way to fat-
 * finger them.
 *
 * Add new helpers here when you find new classes of LLM-typo bugs.
 */
const PATTERN_HELPERS = `
// ─── Pre-injected pattern helpers (do not redefine in your script) ────
function pearson(a, b) {
  const n = a.length;
  if (!b || b.length !== n || n < 2) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  return denA === 0 || denB === 0 ? 0 : num / Math.sqrt(denA * denB);
}

function resampleTo(arr, targetLen) {
  if (arr.length === targetLen) return arr.slice();
  const out = new Array(targetLen);
  if (targetLen === 1) { out[0] = arr[0]; return out; }
  const step = (arr.length - 1) / (targetLen - 1);
  for (let i = 0; i < targetLen; i++) {
    const srcIdx = i * step;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, arr.length - 1);
    const frac = srcIdx - lo;
    out[i] = arr[lo] * (1 - frac) + arr[hi] * frac;
  }
  return out;
}

function normalizeMinMax(arr) {
  const lo = Math.min(...arr);
  const hi = Math.max(...arr);
  if (hi === lo) return arr.map(() => 0.5);
  return arr.map(x => (x - lo) / (hi - lo));
}
// ─── End helpers ──────────────────────────────────────────────────────
`;

/**
 * Execute a JavaScript pattern detection script against OHLC data.
 *
 * The script receives `data` (OHLCBar[]) and must return an array of
 * { start_idx, end_idx, confidence, pattern_type } objects.
 *
 * Uses a Blob Worker to avoid CSP restrictions on eval/new Function.
 */
export async function executePatternScript(
  script: string,
  data: OHLCBar[]
): Promise<PatternMatch[]> {
  // Safety checks — only block network/file access. The script runs in an
  // isolated Web Worker with no DOM, so window/document refs are harmless (they're undefined).
  const blocked = ["import ", "require(", "fetch(", "XMLHttpRequest"];
  for (const token of blocked) {
    if (script.includes(token)) {
      throw new Error(`Script contains blocked token: "${token}"`);
    }
  }

  let body = script.trim();

  // Detect if the LLM wrapped the code in a function declaration and unwrap it.
  // Matches: `const detectPattern = (data) => { ... }`, `function detectPattern(data) { ... }`,
  // `const foo = function(data) { ... }`. Picks the LAST such definition (helpers come first).
  const arrowMatches = [...body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/g)];
  const funcMatches = [...body.matchAll(/function\s+(\w+)\s*\([^)]*\)/g)];
  const funcExprMatches = [...body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*function\s*\([^)]*\)/g)];

  const allFns = [...arrowMatches, ...funcMatches, ...funcExprMatches];
  const hasTopLevelResults =
    /^(?:const|let|var)\s+results\s*=/m.test(body) ||
    /^\s*results\s*=/m.test(body);
  const hasTopLevelCall = allFns.some((m) =>
    new RegExp(`(?<!function\\s+)(?<!=\\s*)\\b${m[1]}\\s*\\(\\s*data`).test(body)
  );

  if (allFns.length > 0 && !hasTopLevelResults && !hasTopLevelCall) {
    // Script is function-wrapped with no top-level call → append one to the
    // last-defined function (usually the main detector, after any helpers).
    const mainFn = allFns[allFns.length - 1][1];
    body += `\nreturn ${mainFn}(data);`;
  } else if (!body.includes("return results") && !body.includes("return ")) {
    body += "\nreturn results;";
  }

  // Strip any LLM-defined `pearson` / `resampleTo` / `normalizeMinMax` so
  // the pre-injected helpers (PATTERN_HELPERS) are the only definitions —
  // the LLM keeps making transcription typos in these helpers and silently
  // corrupting every score. We use a function-name regex that matches the
  // common patterns: `function name(...)` and `const name = (...) =>`.
  body = stripDuplicateHelpers(body, ["pearson", "resampleTo", "normalizeMinMax"]);

  // Prepend the pre-injected helper library so `pearson(...)` etc. are
  // available as globals inside the worker's `new Function(data, Math, ...)`.
  body = PATTERN_HELPERS + "\n" + body;

  // Execute in a blob-based web worker to bypass CSP
  const rawResults = await runInWorker(body, data);

  if (!Array.isArray(rawResults)) {
    throw new Error("Script must return an array of results");
  }

  // Convert raw matches to PatternMatch type
  return rawResults.map((m: RawMatch) => {
    const si = Math.max(0, Math.min(m.start_idx, data.length - 1));
    const ei = Math.max(0, Math.min(m.end_idx, data.length - 1));

    const ptype = m.pattern_type || "unknown";
    const lower = ptype.toLowerCase();
    let direction: "bullish" | "bearish" | "neutral" = "neutral";
    if (["bullish", "bottom", "breakout", "buy", "engulfing", "upward", "up", "long"].some((k) => lower.includes(k))) {
      direction = "bullish";
    } else if (["bearish", "top", "breakdown", "sell", "downward", "down", "short"].some((k) => lower.includes(k))) {
      direction = "bearish";
    }

    return {
      id: crypto.randomUUID(),
      name: ptype.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      startIndex: si,
      endIndex: ei,
      startTime: String(data[si].time),
      endTime: String(data[ei].time),
      direction,
      confidence: m.confidence,
    };
  });
}

/**
 * Execute a custom indicator script against OHLC data.
 *
 * The script receives `data` (OHLCBar[]) and `params` (Record<string, unknown>)
 * and must return an array of (number | null), one per bar.
 */
export async function executeIndicatorScript(
  script: string,
  data: OHLCBar[],
  params: Record<string, unknown>
): Promise<(number | null)[]> {
  let body = script.trim();

  // Detect if the LLM wrapped the code in a function declaration and unwrap it
  // e.g. "const myFn = (data, params) => { ... }" or "function myFn(data, params) { ... }"
  const arrowMatch = body.match(/const\s+(\w+)\s*=\s*\(data,?\s*params?\)\s*=>\s*\{/);
  const funcMatch = body.match(/function\s+(\w+)\s*\(data,?\s*params?\)\s*\{/);
  if (arrowMatch || funcMatch) {
    const fnName = (arrowMatch || funcMatch)![1];
    // Append a call to the function at the end
    if (!body.includes(`${fnName}(data`)) {
      body += `\nreturn ${fnName}(data, params);`;
    }
  }

  // Ensure there's a return statement
  if (!body.includes("return ")) {
    body += "\nreturn values;";
  }

  return new Promise((resolve, reject) => {
    // Pass script via postMessage to avoid template literal escaping issues
    const workerCode = `
      self.onmessage = function(e) {
        try {
          var data = e.data.data;
          var params = e.data.params;
          var script = e.data.script;
          var fn = new Function("data", "params", "Math", script);
          var result = fn(data, params, Math);
          self.postMessage({ ok: true, result: result });
        } catch (err) {
          self.postMessage({ ok: false, error: (err.message || String(err)) });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    const timeout = setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error("Indicator script timed out (30s)"));
    }, 30000);

    worker.onmessage = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (e.data.ok) {
        resolve(e.data.result);
      } else {
        reject(new Error(`Indicator script failed: ${e.data.error}`));
      }
    };

    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(`Worker error: ${e.message}`));
    };

    worker.postMessage({ data, params, script: body });
  });
}

/**
 * Remove any LLM-defined function declarations whose name is in `names`.
 * Handles both `function foo(...) { ... }` and `const foo = (...) => { ... }`
 * by walking braces to find the closing `}`. Defensive but minimal — we only
 * strip exact name matches so unrelated code is untouched.
 */
function stripDuplicateHelpers(source: string, names: string[]): string {
  let result = source;
  for (const name of names) {
    // function-declaration form
    const fnDeclRe = new RegExp(`function\\s+${name}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = fnDeclRe.exec(result)) !== null) {
      const start = match.index;
      // Walk forward to find the opening { after the parameter list
      let i = result.indexOf("{", start);
      if (i === -1) break;
      let depth = 1;
      i++;
      while (i < result.length && depth > 0) {
        if (result[i] === "{") depth++;
        else if (result[i] === "}") depth--;
        i++;
      }
      // Splice out [start, i)
      result = result.slice(0, start) + result.slice(i);
      fnDeclRe.lastIndex = start;
    }
    // const/let/var form: `const name = (...) => { ... }` or `const name = function (...) { ... }`
    const constDeclRe = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:function\\s*\\([^)]*\\)|\\([^)]*\\)\\s*=>)\\s*\\{`, "g");
    while ((match = constDeclRe.exec(result)) !== null) {
      const start = match.index;
      let i = result.indexOf("{", match.index + match[0].length - 1);
      if (i === -1) break;
      let depth = 1;
      i++;
      while (i < result.length && depth > 0) {
        if (result[i] === "{") depth++;
        else if (result[i] === "}") depth--;
        i++;
      }
      result = result.slice(0, start) + result.slice(i);
      constDeclRe.lastIndex = start;
    }
  }
  return result;
}

function explainScriptError(rawError: string): string {
  // Add helpful hints for common LLM-generated bugs.
  if (/confidence is not defined/i.test(rawError)) {
    return (
      `${rawError}\n\n` +
      `Hint: the script uses "{ confidence }" object shorthand somewhere ` +
      `where the variable isn't in scope. Ask the agent to "use explicit ` +
      `confidence: <varname> form everywhere instead of shorthand" and re-run.`
    );
  }
  if (/score is not defined/i.test(rawError)) {
    return (
      `${rawError}\n\n` +
      `Hint: the script references "score" outside the loop iteration that ` +
      `declared it. Ask the agent to "declare score at the top of the loop ` +
      `body and use confidence: score everywhere".`
    );
  }
  if (/Cannot read propert.* of undefined/i.test(rawError)) {
    return (
      `${rawError}\n\n` +
      `Hint: the script likely indexed past the end of the data array. ` +
      `Ask the agent to "add bounds checks before every data[i] access".`
    );
  }
  return rawError;
}

function runInWorker(scriptBody: string, data: OHLCBar[]): Promise<RawMatch[]> {
  return new Promise((resolve, reject) => {
    // Pass script via postMessage to avoid template literal escaping issues
    const workerCode = `
      self.onmessage = function(e) {
        try {
          var data = e.data.data;
          var script = e.data.script;
          var fn = new Function("data", "Math", script);
          var results = fn(data, Math);
          self.postMessage({ ok: true, results: results });
        } catch (err) {
          self.postMessage({ ok: false, error: (err.message || String(err)) });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    const timeout = setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error("Script execution timed out (30s)"));
    }, 30000);

    worker.onmessage = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(url);
      if (e.data.ok) {
        resolve(e.data.results);
      } else {
        reject(new Error(`Script execution failed: ${explainScriptError(e.data.error)}`));
      }
    };

    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error(`Worker error: ${e.message}`));
    };

    worker.postMessage({ data, script: scriptBody });
  });
}
