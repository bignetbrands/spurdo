"use client";

import { useState, useCallback, useEffect, useRef } from "react";

// ============================================================
// LORA PANEL
// ============================================================
// Two-section UI:
//   1. TRAIN — drop a zip, set steps + notes, kick off training
//      • Submits to /api/admin/lora/train
//      • Polls /api/admin/lora/status/[jobId] every 10s
//      • Shows progress + auto-adds to registry on success
//   2. REGISTRY — list trained LoRAs from /api/admin/lora/registry
//      • Set Active (clears env-var fallback path on next gen)
//      • Delete
//      • Edit notes
// ============================================================

type LogFn = (msg: string, type?: "info" | "success" | "error" | "warn") => void;

interface LoraEntry {
  id: string;
  url: string;
  trainedAt: string;
  notes?: string;
  trainingSetFilename?: string;
  trainingSteps?: number;
  active: boolean;
}

interface ActiveJob {
  id: string;
  requestId: string;
  status: "submitting" | "queued" | "in_progress" | "completed" | "failed";
  submittedAt: string;
  completedAt?: string;
  trainingSteps: number;
  notes?: string;
  trainingSetFilename?: string;
  loraUrl?: string;
  error?: string;
}

interface Props {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  addLog: LogFn;
}

export function LoraPanel({ authedFetch, addLog }: Props) {
  const [registry, setRegistry] = useState<LoraEntry[]>([]);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loadingRegistry, setLoadingRegistry] = useState(false);

  // Training form state
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [steps, setSteps] = useState(1000);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRegistry = useCallback(async () => {
    setLoadingRegistry(true);
    try {
      const res = await authedFetch("/api/admin/lora/registry");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { registry: LoraEntry[]; activeUrl: string | null };
      setRegistry(data.registry);
      setActiveUrl(data.activeUrl);
    } catch (err) {
      addLog(`registry fetch failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setLoadingRegistry(false);
    }
  }, [authedFetch, addLog]);

  // Initial registry fetch on mount
  useEffect(() => {
    fetchRegistry();
  }, [fetchRegistry]);

  // ── Polling for active training job ──
  const stopPolling = useCallback(() => {
    if (pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const res = await authedFetch(`/api/admin/lora/status/${jobId}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { ok: boolean; job: ActiveJob };
          if (!data.ok || !data.job) return;
          setActiveJob(data.job);
          if (data.job.status === "completed") {
            addLog(`LoRA training complete — added to registry`, "success");
            stopPolling();
            await fetchRegistry();
          } else if (data.job.status === "failed") {
            addLog(`LoRA training failed: ${data.job.error || "unknown error"}`, "error");
            stopPolling();
          }
        } catch (err) {
          addLog(`status poll failed: ${err instanceof Error ? err.message : err}`, "warn");
        }
      };
      // Poll immediately then every 10s
      tick();
      pollInterval.current = setInterval(tick, 10_000);
    },
    [authedFetch, addLog, fetchRegistry, stopPolling]
  );

  // Cleanup polling on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Submit training ──
  const submitTraining = useCallback(async () => {
    if (!zipFile) {
      addLog("pick a .zip file first", "warn");
      return;
    }
    setSubmitting(true);
    addLog(`uploading ${zipFile.name} (${(zipFile.size / 1024 / 1024).toFixed(2)} MB)…`);
    try {
      const form = new FormData();
      form.append("zip", zipFile);
      form.append("steps", String(steps));
      if (notes.trim()) form.append("notes", notes.trim());

      const res = await authedFetch("/api/admin/lora/train", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        addLog(`training submit failed: ${data.error || res.status}`, "error");
        setSubmitting(false);
        return;
      }

      addLog(`training job submitted — id ${data.jobId}, polling for progress`, "success");

      const initialJob: ActiveJob = {
        id: data.jobId,
        requestId: data.requestId,
        status: "queued",
        submittedAt: new Date().toISOString(),
        trainingSteps: steps,
        notes: notes.trim() || undefined,
        trainingSetFilename: zipFile.name,
      };
      setActiveJob(initialJob);
      startPolling(data.jobId);

      // Reset form fields
      setZipFile(null);
      setNotes("");
    } catch (err) {
      addLog(`training submit error: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setSubmitting(false);
    }
  }, [zipFile, steps, notes, authedFetch, addLog, startPolling]);

  // ── Registry actions ──
  const setActive = useCallback(
    async (loraId: string) => {
      try {
        const res = await authedFetch("/api/admin/lora/registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_active", loraId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
        addLog(`LoRA set active`, "success");
        await fetchRegistry();
      } catch (err) {
        addLog(`set active failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    },
    [authedFetch, addLog, fetchRegistry]
  );

  const clearActive = useCallback(async () => {
    try {
      const res = await authedFetch("/api/admin/lora/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_active" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog(`active LoRA cleared (image-gen falls back to env / base FLUX)`, "warn");
      await fetchRegistry();
    } catch (err) {
      addLog(`clear active failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }, [authedFetch, addLog, fetchRegistry]);

  const deleteEntry = useCallback(
    async (loraId: string) => {
      if (!confirm("Delete this LoRA from the registry? (The actual file on Fal stays — this just removes the entry here.)")) return;
      try {
        const res = await authedFetch("/api/admin/lora/registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", loraId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        addLog(`LoRA removed from registry`, "info");
        await fetchRegistry();
      } catch (err) {
        addLog(`delete failed: ${err instanceof Error ? err.message : err}`, "error");
      }
    },
    [authedFetch, addLog, fetchRegistry]
  );

  // ── Render ──
  const isTraining =
    activeJob && (activeJob.status === "queued" || activeJob.status === "in_progress" || activeJob.status === "submitting");

  return (
    <section style={S.card}>
      <h2 style={S.h2}>🧠 LORA TRAINING</h2>
      <p style={S.hint}>
        train a Spurdo identity adapter on Fal. drop a zip of 10-20 on-canon images. takes ~10-15 min. trained LoRAs go to the registry below — click set active to use one.
      </p>

      {/* TRAIN FORM */}
      <div style={S.form}>
        <label style={S.label}>
          training set (.zip)
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setZipFile(e.target.files?.[0] || null)}
            disabled={submitting || !!isTraining}
            style={S.fileInput}
          />
          {zipFile && (
            <div style={S.hint}>
              {zipFile.name} · {(zipFile.size / 1024 / 1024).toFixed(2)} MB
            </div>
          )}
        </label>

        <div style={S.formRow}>
          <label style={S.label}>
            steps
            <input
              type="number"
              min={100}
              max={5000}
              step={100}
              value={steps}
              onChange={(e) => setSteps(parseInt(e.target.value, 10) || 1000)}
              disabled={submitting || !!isTraining}
              style={S.input}
            />
          </label>
          <label style={{ ...S.label, flex: 1 }}>
            notes (optional)
            <input
              type="text"
              placeholder="e.g. v1 — 15 hand-curated images"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting || !!isTraining}
              style={S.input}
            />
          </label>
        </div>

        <button
          onClick={submitTraining}
          disabled={!zipFile || submitting || !!isTraining}
          style={S.btnPrimary}
        >
          {submitting ? "🌀 uploading…" : isTraining ? "training in progress…" : "🚀 start training"}
        </button>
      </div>

      {/* ACTIVE JOB STATUS */}
      {activeJob && (
        <div style={S.jobBox}>
          <div style={S.jobHeader}>
            <strong>job {activeJob.id}</strong>
            <span style={{ ...S.jobStatus, color: statusColor(activeJob.status) }}>
              {activeJob.status.toUpperCase()}
            </span>
          </div>
          <div style={S.jobMeta}>
            submitted: {new Date(activeJob.submittedAt).toLocaleString()}
            {activeJob.completedAt && ` · completed: ${new Date(activeJob.completedAt).toLocaleString()}`}
            {` · steps: ${activeJob.trainingSteps}`}
            {activeJob.trainingSetFilename && ` · ${activeJob.trainingSetFilename}`}
          </div>
          {activeJob.notes && <div style={S.jobMeta}>notes: {activeJob.notes}</div>}
          {activeJob.error && <div style={{ ...S.jobMeta, color: "#c92020" }}>error: {activeJob.error}</div>}
          {activeJob.loraUrl && (
            <div style={S.jobMeta}>
              <a href={activeJob.loraUrl} target="_blank" rel="noopener noreferrer" style={S.link}>
                LoRA file →
              </a>
            </div>
          )}
        </div>
      )}

      {/* REGISTRY */}
      <div style={S.registrySection}>
        <div style={S.cardHeader}>
          <h3 style={S.h3}>registry</h3>
          <button onClick={fetchRegistry} disabled={loadingRegistry} style={S.btnGhost}>
            {loadingRegistry ? "…" : "↻"}
          </button>
        </div>

        {activeUrl && (
          <div style={S.activeBanner}>
            <span>active: {activeUrl.slice(0, 60)}…</span>
            <button onClick={clearActive} style={S.btnGhost}>
              clear
            </button>
          </div>
        )}

        {registry.length === 0 ? (
          <div style={S.empty}>no trained LoRAs yet. submit a training job above.</div>
        ) : (
          <div style={S.regList}>
            {registry.map((entry) => (
              <div key={entry.id} style={{ ...S.regEntry, ...(entry.active ? S.regEntryActive : {}) }}>
                <div style={S.regEntryHeader}>
                  <strong>{entry.notes || "(no notes)"}</strong>
                  {entry.active && <span style={S.activeBadge}>ACTIVE</span>}
                </div>
                <div style={S.regEntryMeta}>
                  trained {new Date(entry.trainedAt).toLocaleString()}
                  {entry.trainingSteps && ` · ${entry.trainingSteps} steps`}
                  {entry.trainingSetFilename && ` · ${entry.trainingSetFilename}`}
                </div>
                <div style={S.regEntryActions}>
                  {!entry.active && (
                    <button onClick={() => setActive(entry.id)} style={S.btnSmall}>
                      set active
                    </button>
                  )}
                  <a href={entry.url} target="_blank" rel="noopener noreferrer" style={S.btnSmallLink}>
                    file →
                  </a>
                  <button onClick={() => deleteEntry(entry.id)} style={{ ...S.btnSmall, ...S.btnSmallDanger }}>
                    delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function statusColor(s: ActiveJob["status"]): string {
  if (s === "completed") return "#0a8c3a";
  if (s === "failed") return "#c92020";
  if (s === "in_progress") return "#a06800";
  return "#444";
}

const S: Record<string, React.CSSProperties> = {
  card: { background: "#fffbea", border: "3px solid #1a1a1a", boxShadow: "4px 4px 0 #1a1a1a", padding: 20, marginBottom: 16 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  h2: { fontSize: 16, margin: 0, letterSpacing: 1 },
  h3: { fontSize: 13, margin: 0, letterSpacing: 0.5, textTransform: "uppercase", color: "#5a3820" },
  hint: { fontSize: 12, color: "#5a3820", margin: "8px 0 14px", fontStyle: "italic" },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  formRow: { display: "flex", gap: 12 },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", fontWeight: 700 },
  fileInput: { padding: 8, border: "2px dashed #1a1a1a", background: "#fff", fontFamily: "monospace", fontSize: 12, cursor: "pointer" },
  input: { padding: "8px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "monospace", fontSize: 13 },
  btnPrimary: { padding: "12px 18px", border: "3px solid #1a1a1a", background: "#ffe066", fontFamily: "inherit", fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 #1a1a1a" },
  btnGhost: { padding: "4px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 12, cursor: "pointer" },
  btnSmall: { padding: "5px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 11, cursor: "pointer", textTransform: "lowercase" },
  btnSmallDanger: { background: "#ffd5d5" },
  btnSmallLink: { padding: "5px 10px", border: "2px solid #1a1a1a", background: "#e8f0e8", fontFamily: "inherit", fontSize: 11, textDecoration: "none", color: "#1a1a1a", textTransform: "lowercase" },
  jobBox: { padding: 12, background: "#f8f0d5", border: "2px solid #1a1a1a", marginTop: 16 },
  jobHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "monospace", fontSize: 13, marginBottom: 6 },
  jobStatus: { fontFamily: "monospace", fontSize: 11, fontWeight: 700 },
  jobMeta: { fontFamily: "monospace", fontSize: 11, color: "#5a3820", marginTop: 4 },
  link: { color: "#1a1a1a", textDecoration: "underline" },
  registrySection: { marginTop: 24, paddingTop: 16, borderTop: "2px dashed #1a1a1a" },
  activeBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: 10, background: "#e3f2d8", border: "2px solid #0a8c3a", marginBottom: 12, fontFamily: "monospace", fontSize: 11, gap: 8, flexWrap: "wrap" },
  empty: { fontStyle: "italic", color: "#888", padding: 12, textAlign: "center" },
  regList: { display: "flex", flexDirection: "column", gap: 8 },
  regEntry: { padding: 12, background: "#f8f0d5", border: "2px solid #1a1a1a" },
  regEntryActive: { borderColor: "#0a8c3a", background: "#f0f8ea", borderWidth: 3 },
  regEntryHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: 4 },
  activeBadge: { fontFamily: "monospace", fontSize: 10, padding: "2px 8px", background: "#0a8c3a", color: "#fff", borderRadius: 0 },
  regEntryMeta: { fontFamily: "monospace", fontSize: 11, color: "#5a3820", marginBottom: 8 },
  regEntryActions: { display: "flex", gap: 6, flexWrap: "wrap" },
};
