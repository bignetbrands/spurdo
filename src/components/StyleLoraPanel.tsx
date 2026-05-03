"use client";

import { useState, useEffect, useCallback } from "react";

// ============================================================
// STYLE LORA PANEL
// ============================================================
// View + manage the runtime style LoRA override list. Style LoRAs
// shape the visual aesthetic (MS Paint, doodle, sketch, etc.) and
// stack on top of the identity LoRA.
//
// Visible only when the project's gen stack supports style LoRAs
// (currently: sdxl-stylized).
//
// Operators can:
//   - See what's active right now + whether it's runtime or config
//   - Add a new style LoRA (URL, scale, optional trigger word)
//   - Remove an entry
//   - Clear runtime override (revert to config defaults)
// ============================================================

type LogFn = (msg: string, type?: "info" | "success" | "error" | "warn") => void;

interface StackedLora {
  url: string;
  role: "style" | "identity";
  scale?: number;
  label?: string;
  triggerWord?: string;
}

interface StyleLoraResponse {
  ok: boolean;
  active: StackedLora[];
  source: "runtime" | "config";
  hasRuntimeOverride: boolean;
  configDefaults: StackedLora[];
  stackSupportsStyle: boolean;
  genStack: string;
  error?: string;
}

interface Props {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  addLog: LogFn;
}

export function StyleLoraPanel({ authedFetch, addLog }: Props) {
  const [data, setData] = useState<StyleLoraResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add-form state
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newTriggerWord, setNewTriggerWord] = useState("");
  const [newScale, setNewScale] = useState(0.9);
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/admin/style-loras");
      const body = (await res.json()) as StyleLoraResponse;
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`);
        return;
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const saveOverride = useCallback(
    async (loras: StackedLora[]) => {
      setSubmitting(true);
      try {
        const res = await authedFetch("/api/admin/style-loras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ loras }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          addLog(`style LoRA save failed: ${body.error || res.status}`, "error");
          return;
        }
        addLog(`style LoRAs updated (${loras.length} active, runtime override)`, "success");
        await fetchData();
      } catch (err) {
        addLog(`style LoRA save error: ${err instanceof Error ? err.message : err}`, "error");
      } finally {
        setSubmitting(false);
      }
    },
    [authedFetch, addLog, fetchData]
  );

  const addLora = useCallback(async () => {
    if (!newUrl.trim()) {
      addLog("URL required", "warn");
      return;
    }
    if (!/^https?:\/\//.test(newUrl.trim())) {
      addLog("URL must start with https://", "warn");
      return;
    }
    const current = data?.active ?? [];
    const next: StackedLora[] = [
      ...current,
      {
        url: newUrl.trim(),
        role: "style",
        scale: newScale,
        label: newLabel.trim() || undefined,
        triggerWord: newTriggerWord.trim() || undefined,
      },
    ];
    await saveOverride(next);
    setNewUrl("");
    setNewLabel("");
    setNewTriggerWord("");
    setNewScale(0.9);
    setShowAddForm(false);
  }, [newUrl, newLabel, newTriggerWord, newScale, data, saveOverride, addLog]);

  const removeLora = useCallback(
    async (idx: number) => {
      const current = data?.active ?? [];
      const next = current.filter((_, i) => i !== idx);
      await saveOverride(next);
    },
    [data, saveOverride]
  );

  const clearOverride = useCallback(async () => {
    if (!confirm("clear runtime override? this reverts to config defaults.")) return;
    setSubmitting(true);
    try {
      const res = await authedFetch("/api/admin/style-loras", { method: "DELETE" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        addLog(`clear failed: ${body.error || res.status}`, "error");
        return;
      }
      addLog(`runtime override cleared, using config defaults`, "success");
      await fetchData();
    } catch (err) {
      addLog(`clear error: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setSubmitting(false);
    }
  }, [authedFetch, addLog, fetchData]);

  // Hide panel entirely if the active stack doesn't support style LoRAs
  if (data && !data.stackSupportsStyle) {
    return null;
  }

  return (
    <section style={S.card}>
      <div style={S.cardHeader}>
        <h2 style={S.h2}>🎨 STYLE LORAS</h2>
        <button onClick={fetchData} disabled={loading} style={S.btnGhost}>
          {loading ? "…" : "↻ refresh"}
        </button>
      </div>
      <p style={S.hint}>
        style LoRAs define the visual aesthetic (MS Paint, doodle, sketch). they stack on top of the identity LoRA at inference. add a new one by URL, or clear runtime override to revert to config defaults.
      </p>

      {error && (
        <div style={S.errorBox}>
          <strong>error:</strong> {error}
        </div>
      )}

      {data && (
        <>
          <div style={S.summaryRow}>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>active count</div>
              <div style={{ ...S.summaryValue, color: data.active.length > 0 ? "#0a8c3a" : "#a06800" }}>
                {data.active.length}
              </div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>source</div>
              <div style={{ ...S.summaryValue, fontSize: 13 }}>
                {data.source === "runtime" ? (
                  <span style={{ color: "#1a5a8c" }}>runtime override</span>
                ) : (
                  <span style={{ color: "#5a3820" }}>config defaults</span>
                )}
              </div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>gen stack</div>
              <div style={{ ...S.summaryValue, fontSize: 12, fontFamily: "monospace" }}>{data.genStack}</div>
            </div>
          </div>

          {data.active.length === 0 ? (
            <div style={S.empty}>
              no style LoRAs configured. without one, output will be base SDXL (illustrated/anime default).
            </div>
          ) : (
            <div style={S.loraList}>
              {data.active.map((l, i) => (
                <div key={`${l.url}-${i}`} style={S.loraEntry}>
                  <div style={S.loraEntryHeader}>
                    <strong>{l.label || `style #${i + 1}`}</strong>
                    {l.triggerWord && <span style={S.triggerBadge}>trigger: {l.triggerWord}</span>}
                    <span style={S.scaleBadge}>×{l.scale ?? 0.9}</span>
                  </div>
                  <div style={S.loraUrl} title={l.url}>
                    {l.url.length > 80 ? l.url.slice(0, 80) + "…" : l.url}
                  </div>
                  {data.source === "runtime" && (
                    <div style={S.loraActions}>
                      <button
                        onClick={() => removeLora(i)}
                        disabled={submitting}
                        style={{ ...S.btnSmall, ...S.btnSmallDanger }}
                      >
                        remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={S.controlRow}>
            {!showAddForm ? (
              <button onClick={() => setShowAddForm(true)} style={S.btnPrimary} disabled={submitting}>
                + add style LoRA
              </button>
            ) : (
              <div style={S.addForm}>
                <label style={S.formLabel}>
                  URL (.safetensors)
                  <input
                    type="url"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://huggingface.co/.../file.safetensors"
                    style={S.input}
                    disabled={submitting}
                  />
                </label>
                <label style={S.formLabel}>
                  label (optional)
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. ms-paint"
                    style={S.input}
                    disabled={submitting}
                  />
                </label>
                <label style={S.formLabel}>
                  trigger word (optional)
                  <input
                    type="text"
                    value={newTriggerWord}
                    onChange={(e) => setNewTriggerWord(e.target.value)}
                    placeholder="e.g. MSPaint"
                    style={S.input}
                    disabled={submitting}
                  />
                </label>
                <label style={S.formLabel}>
                  scale: <strong>{newScale.toFixed(1)}</strong>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={newScale}
                    onChange={(e) => setNewScale(parseFloat(e.target.value))}
                    disabled={submitting}
                    style={{ width: "100%" }}
                  />
                </label>
                <div style={S.formActions}>
                  <button onClick={addLora} disabled={submitting || !newUrl.trim()} style={S.btnPrimary}>
                    {submitting ? "…" : "add"}
                  </button>
                  <button onClick={() => setShowAddForm(false)} disabled={submitting} style={S.btnGhost}>
                    cancel
                  </button>
                </div>
              </div>
            )}

            {data.hasRuntimeOverride && (
              <button onClick={clearOverride} disabled={submitting} style={S.btnSecondary}>
                ↺ revert to config defaults
              </button>
            )}
          </div>

          {data.source === "runtime" && data.configDefaults.length > 0 && (
            <div style={S.configBox}>
              <div style={S.envBoxTitle}>config defaults (currently overridden)</div>
              {data.configDefaults.map((l, i) => (
                <div key={i} style={S.configItem}>
                  • {l.label || "unlabeled"} · {l.url.length > 60 ? l.url.slice(0, 60) + "…" : l.url}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const S: Record<string, React.CSSProperties> = {
  card: { background: "#fffbea", border: "3px solid #1a1a1a", boxShadow: "4px 4px 0 #1a1a1a", padding: 20, marginBottom: 16 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  h2: { fontSize: 16, margin: 0, letterSpacing: 1 },
  hint: { fontSize: 12, color: "#5a3820", margin: "8px 0 14px", fontStyle: "italic" },
  errorBox: { padding: 12, background: "#ffeaea", border: "2px solid #c92020", color: "#c92020", marginBottom: 12, fontSize: 13 },
  summaryRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 },
  summaryItem: { padding: 10, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  summaryLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", marginBottom: 4 },
  summaryValue: { fontSize: 18, fontWeight: 700 },
  empty: { fontStyle: "italic", color: "#888", padding: 12, textAlign: "center", background: "#f8f0d5", border: "2px dashed #1a1a1a", marginBottom: 12 },
  loraList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 },
  loraEntry: { padding: 10, border: "2px solid #1a1a1a", background: "#fff" },
  loraEntryHeader: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 6 },
  triggerBadge: { fontFamily: "monospace", fontSize: 10, padding: "2px 6px", background: "#e8f4ff", border: "1px solid #1a5a8c", color: "#1a5a8c" },
  scaleBadge: { fontFamily: "monospace", fontSize: 10, padding: "2px 6px", background: "#f5e9c9", border: "1px solid #1a1a1a" },
  loraUrl: { fontFamily: "monospace", fontSize: 10, color: "#5a3820", wordBreak: "break-all", marginBottom: 6 },
  loraActions: { display: "flex", gap: 6 },
  controlRow: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 },
  btnPrimary: { padding: "8px 14px", border: "2px solid #1a1a1a", background: "#fff083", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "2px 2px 0 #1a1a1a" },
  btnGhost: { padding: "4px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 12, cursor: "pointer" },
  btnSecondary: { padding: "6px 12px", border: "2px solid #1a1a1a", background: "#f5e9c9", fontFamily: "inherit", fontSize: 12, cursor: "pointer" },
  btnSmall: { padding: "3px 8px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 11, cursor: "pointer" },
  btnSmallDanger: { background: "#ffeaea", color: "#c92020" },
  addForm: { padding: 12, border: "2px dashed #1a1a1a", background: "#f8f0d5", display: "flex", flexDirection: "column", gap: 8 },
  formLabel: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#5a3820", textTransform: "uppercase", letterSpacing: 0.5 },
  input: { padding: 6, border: "2px solid #1a1a1a", fontFamily: "monospace", fontSize: 12 },
  formActions: { display: "flex", gap: 8, marginTop: 4 },
  configBox: { padding: 10, background: "#f8f0d5", border: "2px solid #5a3820" },
  envBoxTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, color: "#5a3820" },
  configItem: { fontFamily: "monospace", fontSize: 11, color: "#5a3820", marginBottom: 4 },
};
