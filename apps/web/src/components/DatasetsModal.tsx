"use client";

import { useStore } from "@/store/useStore";
import { FileUpload } from "./FileUpload";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DatasetsModal({ open, onClose }: Props) {
  const datasets = useStore((s) => s.datasets);
  const activeDataset = useStore((s) => s.activeDataset);
  const setActiveDataset = useStore((s) => s.setActiveDataset);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl shadow-2xl flex flex-col max-h-[80vh]"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
            Datasets
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-tertiary)" }}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Upload */}
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-muted)" }}>
              Upload CSV
            </div>
            <FileUpload />
          </div>

          {/* Divider */}
          <div className="h-px" style={{ background: "var(--border)" }} />

          {/* List */}
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--text-muted)" }}>
              Loaded Datasets ({datasets.length})
            </div>
            {datasets.length === 0 ? (
              <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                No datasets loaded yet. Upload a CSV above to get started.
              </p>
            ) : (
              <ul className="space-y-1">
                {datasets.map((ds) => (
                  <li key={ds.id}>
                    <button
                      onClick={() => {
                        setActiveDataset(ds.id);
                        onClose();
                      }}
                      className="w-full rounded px-3 py-2 text-left transition-colors"
                      style={{
                        background: activeDataset === ds.id ? "var(--surface-2)" : "transparent",
                        border: `1px solid ${activeDataset === ds.id ? "var(--accent)" : "var(--border-subtle)"}`,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-[11px] truncate" style={{ color: "var(--text-primary)" }}>
                            {ds.name}
                          </div>
                          <div className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                            {ds.metadata.rows.toLocaleString()} bars
                            {ds.metadata.nativeTimeframe && ` • ${ds.metadata.nativeTimeframe}`}
                          </div>
                        </div>
                        {activeDataset === ds.id && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase"
                            style={{ background: "var(--accent)", color: "#000" }}
                          >
                            Active
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
