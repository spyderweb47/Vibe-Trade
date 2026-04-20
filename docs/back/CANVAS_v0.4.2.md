# Canvas — multi-chart workspace

> **Baseline**: commit `653a51d`. Phase 3 feature; added after the
> initial single-chart release.
>
> This doc covers: what the Canvas is, how chart windows work, how it
> integrates with skills, per-dataset feature state, and what's
> deferred to Phase 4.

## 1. What it is

The main content area of the app (between the left sidebar and the
right sidebar, above the bottom panel) is no longer a single fixed
chart. It's a **freeform workspace** that hosts N floating chart
windows. Each window:

- Shows one dataset
- Can be dragged by its title bar
- Can be resized from any corner or edge
- Has an × button to close
- Raises its z-index on focus
- Is spawned automatically by the chat (`fetch BTC 1d` → new window)

Multiple windows can show different tickers simultaneously; skills
know about all of them via `dataset_ids` in context.

## 2. File layout

```
apps/web/src/components/canvas/
├── Canvas.tsx             # Container, hosts N ChartWindows
└── ChartWindow.tsx        # Single window — drag/resize/close chrome

apps/web/src/components/
├── Chart.tsx              # Unchanged lightweight-charts renderer
│                          # (accepts `datasetId` prop for focus routing)
└── DrawingToolbar.tsx     # Unchanged — still global

apps/web/src/store/useStore.ts
├── chartWindows: ChartWindow[]      # state slice
├── focusedWindowId: string | null
├── addChartWindow / removeChartWindow / updateChartWindow
├── focusChartWindow / setChartWindowDataset
├── patternMatchesByDataset          # per-dataset feature state
├── chartFocusByDataset              # per-dataset navigation
└── setPatternMatchesForDataset / setChartFocusForDataset

apps/web/src/types/index.ts
└── ChartWindow interface
```

## 3. The ChartWindow type

```typescript
interface ChartWindow {
  id: string;                       // uuid, stable
  datasetId: string | null;         // which dataset (null = placeholder)
  x: number;                        // px from canvas top-left
  y: number;
  width: number;                    // px
  height: number;
  zIndex: number;                   // stacking order — most recently focused = highest
  title?: string;                   // optional override; defaults to symbol
}
```

All coordinates are in pixels, relative to the Canvas container's
top-left corner. react-rnd's `bounds="parent"` clamps drag/resize to
the container.

## 4. Rendering

**`Canvas.tsx`** (simplified):
```tsx
const windows = useStore(s => s.chartWindows);
const focusedId = useStore(s => s.focusedWindowId);

return (
  <div ref={containerRef} className="relative h-full w-full overflow-hidden"
       style={{ backgroundImage: "radial-gradient(..., dotted grid)" }}>
    {windows.length === 0 && <CanvasEmptyState />}
    {windows.map(w => (
      <ChartWindow key={w.id} window={w} focused={w.id === focusedId} canvasBounds={bounds} />
    ))}
  </div>
);
```

**`ChartWindow.tsx`** wraps `Chart.tsx` in `react-rnd`:
```tsx
<Rnd
  size={{ width, height }}
  position={{ x: w.x, y: w.y }}
  minWidth={360} minHeight={240}
  bounds="parent"
  dragHandleClassName="chart-window-drag-handle"
  onDragStop={(e, d) => updateChartWindow(w.id, {x: d.x, y: d.y})}
  onResizeStop={(...) => updateChartWindow(w.id, {width, height, x, y})}
  onMouseDown={() => focusChartWindow(w.id)}
  style={{ zIndex: w.zIndex }}
>
  <div className="flex h-full w-full flex-col rounded-lg">
    {/* Title bar = drag handle */}
    <div className="chart-window-drag-handle ...">
      <span>{title}</span>
      <span>{timeframe}</span>
      <span>{bars} bars</span>
      <button onClick={onClose}>×</button>
    </div>
    {/* Chart body */}
    <Chart data={bars} patternMatches={matches} datasetId={w.datasetId} />
  </div>
</Rnd>
```

`ChartWindow` is `dynamic()`-imported with `ssr: false` because
react-rnd touches `document` at module import.

## 5. Spawning windows

**Only path**: the chat. Typing `fetch BTC 1d` → data_fetcher skill →
`addDataset` → auto-spawn window. There is intentionally no "+ Add
chart" UI button.

**Sizing logic** in `addDataset`:
- First window: 560×360 at (20, 20)
- Subsequent: inherit previous window's size (so if user resized a
  prev window to be bigger, new ones match), cascaded `+32/+32` from
  the previous window's position (capped at 400/300 so they don't
  march off-screen)

**Deduplication**: if a dataset already has a window, fetching it
again refocuses the existing window instead of creating a duplicate.

## 6. Focus model

- `focusedWindowId` — which window the keyboard + skill outputs target
- `activeDataset` = `chartWindows.find(w => w.id === focusedWindowId).datasetId`
  (kept in sync by every canvas action that changes focus)
- On focus: z-index bumped to top of the stack
- On close: focus transfers to the next-highest-z remaining window

Legacy code that reads `activeDataset` still works — it's now just a
derived property of the focus state.

## 7. Per-dataset feature state

Two things that used to be global are now per-dataset, driven by
user feedback:

### Pattern matches
- `patternMatches: PatternMatch[]` (legacy global, kept as fallback)
- `patternMatchesByDataset: Record<datasetId, PatternMatch[]>`
- Each `ChartWindow` reads `patternMatchesByDataset[w.datasetId]` for
  its chart overlays. Falls back to global `patternMatches` if the map
  has nothing for this dataset AND this is the focused window.

### Chart focus (zoom)
- `chartFocus: {startTime, endTime} | null` (legacy global)
- `chartFocusByDataset: Record<datasetId, Focus | null>`
- `Chart.tsx` accepts a `datasetId` prop. When set, reads focus from
  `chartFocusByDataset[datasetId]`. When unset (legacy), falls back to
  global `chartFocus`.
- Clicking a pattern-match row in the bottom panel → `setChartFocusForDataset(owner_id, focus)`
  → only the chart that owns that match zooms; siblings stay put.

## 8. Multi-chart skill behavior

### What every skill sees
Every skill invocation (via planner or direct chat) gets
`context.dataset_ids = all canvas window datasetIds`. The frontend
populates this in two places:

1. **`planExecutor.ts`** — before every step:
   ```typescript
   const currentDatasetIds = collectDatasetIds();
   if (currentDatasetIds.length > 0) {
     accumulatedContext.dataset_ids = currentDatasetIds;
   }
   ```

2. **`RightSidebar.tsx`** direct `sendChat` (fallback path for empty plans):
   ```typescript
   const canvasDatasetIds = useStore.getState().chartWindows
     .map(w => w.datasetId).filter(Boolean);
   await sendChat(text, activeMode, {
     dataset_id: activeDataset,
     dataset_ids: canvasDatasetIds,
     ...
   });
   ```

### Skill-specific handling

| Skill | Multi-chart behavior |
|---|---|
| `data_fetcher` | Always spawns a new window per fetch; doesn't read `dataset_ids` |
| `pattern` | Generated script runs against EVERY window; matches stored per-dataset; bottom panel merges for display |
| `strategy` | Focused chart only (Phase 3.5 will add cross-asset backtest) |
| `swarm_intelligence` | Portfolio mode — focused chart is primary, others injected as context in `report_text` |

### Example: Swarm portfolio
1. Canvas has BTC (fetched first, now unfocused) + CL=F (fetched second, focused)
2. User types "run swarm intelligence"
3. `dataset_ids = [btc_id, cl_id]` from canvas order
4. Swarm processor **promotes focused to index 0** → `[cl_id, btc_id]`
5. Primary = CL=F (drives Stage 1 analysis + Stage 3 main debate)
6. BTC is summarised via `format_ohlc_summary` and appended to
   `report_text` as "## Portfolio context"
7. Agents reference BTC in their arguments naturally
8. Reply: "portfolio debate on CL=F with 1 sibling asset: BTC"

## 9. Persistence

Canvas state lives in the per-conversation snapshot
(`Conversation.chartWindows` + `Conversation.focusedWindowId`). Every
mutation (`addChartWindow`, `removeChartWindow`, `updateChartWindow`,
`focusChartWindow`, `setChartWindowDataset`) calls
`_snapshotLiveStateInto` after `set()`.

Result:
- Conversation A has BTC + ETH + SOL arranged in some layout
- Switch to Conversation B → canvas shows B's layout (may be empty)
- Switch back to A → **exact layout restored** (positions, sizes,
  focus, z-order)
- Refresh browser → layout survives (localStorage)

## 10. Timeframe handling

The `TimeframeSelector` component (at the top of the center column)
acts on the **focused window's dataset**. Clicking "2h" resamples the
focused dataset's data into `datasetChartData[id]` — the slot each
`ChartWindow` reads. Other windows keep their previous timeframe.

Auto mode re-derives the "fit to ~6000 bars" default from
`datasetRawData[id]` using `resampleOHLC()`, restoring the native
view.

Global `chartData` is kept in sync for skill processors that still
read it.

## 11. Empty states

- **Zero windows**: shows "Empty canvas" placeholder with a hint
  pointing at the chat
- **Window with `datasetId: null`**: shows "No data" sub-placeholder
  inside the window frame
- **Window whose `datasetId` points to a dataset that doesn't exist
  in this conversation** (can happen after a mis-restore): shows
  "Dataset not loaded" placeholder

## 12. Known gaps (Phase 4 work)

### Per-window independent state
Currently **global across all windows**:
- Drawings (trend lines, fibs, rectangles, long/short boxes)
- Indicators (SMA, RSI, MACD, Bollinger, ATR, VWAP)
- Selected timeframe (acts on focused only, but there's no per-window TF toolbar)
- Pine script drawings

Target: each ChartWindow owns its own drawing set, indicator list,
and timeframe selector inside its title bar.

### Skill-spawned windows
Currently only `data_fetcher` spawns windows. Future: a swarm
recommendation could spawn a new window with the recommended entry/SL/TP
pre-drawn; a pattern match could open a new window zoomed to the match.

### Drag-from-sidebar
The left sidebar lists datasets. Future: drag one onto the canvas →
spawns a window with that dataset. Right now you can only re-focus an
existing window by clicking it.

### Window-level toolbar
Currently there's one global `DrawingToolbar` on the left of the
center column. Target: each window gets its own mini-toolbar so a user
can be drawing on BTC while another window stays untouched.

### Per-window pattern/strategy re-runs
Right-click a window → "Re-run pattern detection here" would scope
just that window.

### Snapping / keyboard shortcuts
Future: `Cmd+1..9` to focus window N, `Cmd+W` to close, snap-to-grid,
"tile all", "stack all".

### Per-window pattern match persistence
`patternMatchesByDataset` is currently NOT included in the conversation
snapshot — only the legacy global `patternMatches` is. After a
conversation switch, per-window match highlighting is lost; needs a
re-run to restore. Low-impact (the matches themselves are cheap to
recompute).

## 13. Integration points to be aware of

When refactoring anything that touches the old "single chart" model:

- **Don't read `chartData` directly** for rendering — use
  `datasetChartData[datasetId]`
- **Don't read `patternMatches` directly** for rendering — use
  `patternMatchesByDataset[datasetId]` with fallback
- **Don't call `setChartFocus`** from a match-click handler — use
  `setChartFocusForDataset(owner_id, focus)`
- **Do continue reading `activeDataset`** — it's maintained in sync
  with the focused window's dataset for legacy skill compatibility
- **Do emit `chart.set_timeframe`** from skills — it routes through
  `setSelectedTimeframe` which already handles per-dataset resampling
