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
  trainedForStack?: "flux-photoreal" | "sdxl-stylized";
  artStyle?: "photorealistic" | "mspaint";
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
  trainingEndpoint?: string;
  trainedForStack?: "flux-photoreal" | "sdxl-stylized";
  artStyle?: "photorealistic" | "mspaint";
}

interface Props {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  addLog: LogFn;
  adminSecret: string;
}

export function LoraPanel({ authedFetch, addLog, adminSecret }: Props) {
  const [registry, setRegistry] = useState<LoraEntry[]>([]);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [loadingRegistry, setLoadingRegistry] = useState(false);

  // Training form state
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [steps, setSteps] = useState(1000);
  const [notes, setNotes] = useState("");
  const [artStyle, setArtStyle] = useState<"photorealistic" | "mspaint">("photorealistic");
  const [submitting, setSubmitting] = useState(false);
  // Upload pre-trained LoRA file (e.g. downloaded from Replicate)
  const [trainedFile, setTrainedFile] = useState<File | null>(null);
  const [uploadingTrained, setUploadingTrained] = useState(false);
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [dragActive, setDragActive] = useState(false);
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
    if (imageFiles.length === 0) {
      addLog("pick some images first :D", "warn");
      return;
    }
    if (imageFiles.length < 5) {
      addLog(`need at least 5 images for a useful LoRA (you have ${imageFiles.length})`, "warn");
      return;
    }
    const totalMB = imageFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
    setSubmitting(true);
    addLog(`uploading ${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"} (${totalMB.toFixed(1)} MB total)…`);
    try {
      const form = new FormData();
      for (const f of imageFiles) form.append("images", f);
      form.append("steps", String(steps));
      form.append("artStyle", artStyle);
      if (notes.trim()) form.append("notes", notes.trim());

      const res = await authedFetch("/api/admin/lora/train", { method: "POST", body: form });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        addLog(`training submit failed: ${data.error || res.status}`, "error");
        setSubmitting(false);
        return;
      }

      addLog(
        `training job submitted (${artStyle}) — id ${data.jobId}, polling for progress`,
        "success"
      );

      const initialJob: ActiveJob = {
        id: data.jobId,
        requestId: data.requestId,
        status: "queued",
        submittedAt: new Date().toISOString(),
        trainingSteps: steps,
        notes: notes.trim() || undefined,
        trainingSetFilename: `${imageFiles.length} images`,
        artStyle,
      };
      setActiveJob(initialJob);
      startPolling(data.jobId);

      // Reset form fields
      setImageFiles([]);
      setNotes("");
    } catch (err) {
      addLog(`training submit error: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setSubmitting(false);
    }
  }, [imageFiles, steps, notes, artStyle, authedFetch, addLog, startPolling]);

  const uploadTrainedLora = useCallback(async () => {
    if (!trainedFile) {
      addLog("pick a trained LoRA file first (.tar or .safetensors)", "warn");
      return;
    }
    setUploadingTrained(true);
    const sizeMB = (trainedFile.size / 1024 / 1024).toFixed(1);
    addLog(`uploading ${trainedFile.name} (${sizeMB} MB) directly to storage…`, "info");
    try {
      // Direct browser → Vercel Blob upload, bypasses 4.5MB serverless limit.
      // The `upload()` helper hits our /upload-token endpoint to get a signed
      // token, then PUTs the file directly to Blob.
      const { upload } = await import("@vercel/blob/client");
      const blob = await upload(`loras/${trainedFile.name}`, trainedFile, {
        access: "public",
        handleUploadUrl: `/api/admin/lora/upload-token?secret=${encodeURIComponent(adminSecret)}`,
        multipart: true, // splits large files into chunks for parallel upload
      });
      addLog(`upload complete, registering…`, "info");

      // Now tell the server to register (and extract from .tar if needed)
      const res = await authedFetch("/api/admin/lora/register-uploaded", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          originalFilename: trainedFile.name,
          notes: notes.trim() || undefined,
          trainedForStack: artStyle === "mspaint" ? "sdxl-stylized" : "flux-photoreal",
          artStyle,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        addLog(`register failed: ${data.error || res.status}`, "error");
        return;
      }
      const extractedNote = data.extracted ? " (extracted from .tar)" : "";
      addLog(
        `registered LoRA ${data.entry.id}${extractedNote} — set active in registry below.`,
        "success"
      );
      setTrainedFile(null);
      setNotes("");
      await fetchRegistry();
    } catch (err) {
      addLog(`upload error: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setUploadingTrained(false);
    }
  }, [trainedFile, artStyle, notes, adminSecret, authedFetch, addLog, fetchRegistry]);

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
        train an identity LoRA on Fal. the project&apos;s active gen stack determines which Fal endpoint runs (FLUX vs SDXL). drop 10-20 on-canon images, training takes ~10-15 min. trained LoRAs auto-add to the registry — click set active to use one.
      </p>

      {/* TRAIN FORM */}
      <div style={S.form}>
        {/* ART STYLE PICKER — controls training params per style */}
        <label style={S.label}>art style</label>
        <div style={S.artStyleRow}>
          <button
            type="button"
            onClick={() => setArtStyle("photorealistic")}
            disabled={submitting || !!isTraining}
            style={{
              ...S.artStyleBtn,
              ...(artStyle === "photorealistic" ? S.artStyleBtnActive : {}),
            }}
          >
            <div style={S.artStyleBtnTitle}>📸 photorealistic</div>
            <div style={S.artStyleBtnSub}>
              clean illustration, polished cartoons, real-looking subjects.
              <br />
              <code>is_style=false</code> · default training
            </div>
          </button>
          <button
            type="button"
            onClick={() => setArtStyle("mspaint")}
            disabled={submitting || !!isTraining}
            style={{
              ...S.artStyleBtn,
              ...(artStyle === "mspaint" ? S.artStyleBtnActive : {}),
            }}
          >
            <div style={S.artStyleBtnTitle}>🎨 ms paint / stylized</div>
            <div style={S.artStyleBtnSub}>
              amateur drawings, doodles, deliberately-crude art.
              <br />
              <code>is_style=true</code> · 1400+ steps · stronger style bias
            </div>
          </button>
        </div>
        {artStyle === "mspaint" && (
          <div style={S.calloutAmber}>
            <strong>⚠ honest caveat:</strong> FLUX is photoreal-first. <code>is_style=true</code> pushes
            the trainer toward style preservation, but FLUX&apos;s base distribution still pulls output
            toward polish. Bank (memedepot) remains the most reliable on-canon image source for fully
            amateur styles. Use this for &quot;better than nothing on novel scenes&quot; — not as a bank replacement.
          </div>
        )}

        <label style={S.label}>training images (10-20 recommended)</label>
        <div style={S.calloutBlue}>
          <strong>💡 for character LoRAs:</strong> variety beats quantity. Include a mix of:
          <ul style={S.tipList}>
            <li><strong>full-body shots</strong> — so the model learns body proportions (not just face)</li>
            <li><strong>various crops</strong> — head-only, half-body, full-body</li>
            <li><strong>various poses</strong> — standing, sitting, side view, action</li>
            <li><strong>various backgrounds</strong> — so the LoRA doesn&apos;t bake in one solid color</li>
          </ul>
          if your output has the right head but a weird body, your training set was head-heavy.
        </div>
        <div
          style={{ ...S.dropzone, ...(dragActive ? S.dropzoneActive : {}) }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            const dropped = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
            if (dropped.length > 0) {
              setImageFiles((prev) => [...prev, ...dropped].slice(0, 30));
            }
          }}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            id="lora-image-input"
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              if (picked.length > 0) {
                setImageFiles((prev) => [...prev, ...picked].slice(0, 30));
              }
              // Reset so the same file can be re-picked after removal
              e.target.value = "";
            }}
            disabled={submitting || !!isTraining}
            style={{ display: "none" }}
          />
          <label htmlFor="lora-image-input" style={S.dropzoneLabel}>
            <div style={S.dropzoneText}>
              {imageFiles.length === 0 ? (
                <>
                  <strong>click to pick</strong> or <strong>drop images here</strong>
                  <div style={S.dropzoneHint}>png · jpg · webp · up to 30 files · 100 MB total</div>
                </>
              ) : (
                <>
                  <strong>{imageFiles.length} image{imageFiles.length === 1 ? "" : "s"} ready</strong>
                  <div style={S.dropzoneHint}>
                    {(imageFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB total · click to add more
                  </div>
                </>
              )}
            </div>
          </label>
        </div>

        {imageFiles.length > 0 && (
          <div style={S.thumbGrid}>
            {imageFiles.map((f, i) => (
              <ImageThumb
                key={`${f.name}-${i}`}
                file={f}
                onRemove={() => setImageFiles((prev) => prev.filter((_, idx) => idx !== i))}
                disabled={submitting || !!isTraining}
              />
            ))}
          </div>
        )}

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
          disabled={imageFiles.length === 0 || submitting || !!isTraining}
          style={S.btnPrimary}
        >
          {submitting ? "🌀 uploading…" : isTraining ? "training in progress…" : `🚀 train on ${imageFiles.length || "?"} image${imageFiles.length === 1 ? "" : "s"}`}
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

      {/* UPLOAD ALREADY-TRAINED LoRA — for files trained elsewhere */}
      <div style={S.uploadTrainedSection}>
        <h3 style={S.h3}>upload trained LoRA</h3>
        <p style={S.subtle}>
          already have a trained LoRA file (.tar or .safetensors)? upload it here.
          uses the art style you picked above.
        </p>
        <input
          type="file"
          accept=".safetensors,.tar,.bin"
          onChange={(e) => setTrainedFile(e.target.files?.[0] || null)}
          disabled={uploadingTrained}
          style={S.input}
        />
        {trainedFile && (
          <p style={S.subtle}>
            <strong>{trainedFile.name}</strong> · {(trainedFile.size / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
        <button
          onClick={uploadTrainedLora}
          disabled={uploadingTrained || !trainedFile}
          style={S.btnPrimary}
        >
          {uploadingTrained ? "uploading…" : "upload to registry"}
        </button>
      </div>

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
                  {entry.artStyle && (
                    <span
                      style={{
                        ...S.stackBadge,
                        background: entry.artStyle === "mspaint" ? "#ffe6e6" : "#e6f4ff",
                        color: entry.artStyle === "mspaint" ? "#aa3333" : "#3355aa",
                      }}
                    >
                      {entry.artStyle === "mspaint" ? "🎨 ms paint" : "📸 photoreal"}
                    </span>
                  )}
                  {entry.trainedForStack && (
                    <span
                      style={{
                        ...S.stackBadge,
                        background: entry.trainedForStack === "sdxl-stylized" ? "#e8f4ff" : "#fff5d5",
                        color: entry.trainedForStack === "sdxl-stylized" ? "#1a5a8c" : "#a06800",
                      }}
                    >
                      {entry.trainedForStack}
                    </span>
                  )}
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

function ImageThumb({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <div style={S.thumb}>
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} style={S.thumbImg} />
      )}
      <div style={S.thumbName} title={file.name}>
        {file.name.length > 20 ? file.name.slice(0, 17) + "…" : file.name}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        style={S.thumbRemove}
        aria-label={`Remove ${file.name}`}
      >
        ✕
      </button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  card: { background: "#fffbea", border: "3px solid #1a1a1a", boxShadow: "4px 4px 0 #1a1a1a", padding: 20, marginBottom: 16 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  h2: { fontSize: 16, margin: 0, letterSpacing: 1 },
  h3: { fontSize: 13, margin: 0, letterSpacing: 0.5, textTransform: "uppercase", color: "#5a3820" },
  hint: { fontSize: 12, color: "#5a3820", margin: "8px 0 14px", fontStyle: "italic" },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  formRow: { display: "flex", gap: 12 },
  artStyleRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 },
  artStyleBtn: {
    padding: 12,
    background: "#fff",
    border: "2px solid #1a1a1a",
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
    transition: "all 0.1s",
  },
  artStyleBtnActive: {
    background: "#fff3b0",
    borderColor: "#a06800",
    boxShadow: "2px 2px 0 #a06800",
  },
  artStyleBtnTitle: { fontSize: 14, fontWeight: 700, marginBottom: 4 },
  artStyleBtnSub: { fontSize: 11, color: "#5a3820", lineHeight: 1.4, fontFamily: "monospace" },
  calloutAmber: {
    padding: 10,
    background: "#fff5d5",
    border: "2px solid #a06800",
    color: "#5a3820",
    fontSize: 12,
    marginBottom: 8,
    lineHeight: 1.5,
  },
  calloutBlue: {
    padding: 10,
    background: "#e8f4ff",
    border: "2px solid #1a5a8c",
    color: "#1a3a5c",
    fontSize: 12,
    marginBottom: 8,
    lineHeight: 1.5,
  },
  tipList: { margin: "6px 0 6px 18px", padding: 0 },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", fontWeight: 700 },
  fileInput: { padding: 8, border: "2px dashed #1a1a1a", background: "#fff", fontFamily: "monospace", fontSize: 12, cursor: "pointer" },
  dropzone: {
    border: "3px dashed #1a1a1a",
    background: "#fffbea",
    padding: 24,
    textAlign: "center",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
  },
  dropzoneActive: { background: "#fff3b0", borderColor: "#a06800", borderStyle: "solid" },
  dropzoneLabel: { display: "block", cursor: "pointer", width: "100%" },
  dropzoneText: { fontSize: 14, color: "#1a1a1a" },
  dropzoneHint: { fontSize: 11, color: "#5a3820", marginTop: 6, fontFamily: "monospace", fontStyle: "italic" },
  thumbGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginTop: 4 },
  thumb: { position: "relative", border: "2px solid #1a1a1a", background: "#fff", padding: 4, display: "flex", flexDirection: "column", gap: 4 },
  thumbImg: { width: "100%", height: 100, objectFit: "cover", display: "block" },
  thumbName: { fontFamily: "monospace", fontSize: 10, color: "#5a3820", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  thumbRemove: { position: "absolute", top: -8, right: -8, width: 22, height: 22, padding: 0, borderRadius: "50%", border: "2px solid #1a1a1a", background: "#e94b3c", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", boxShadow: "1px 1px 0 #1a1a1a" },
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
  uploadTrainedSection: { marginTop: 24, paddingTop: 16, borderTop: "2px dashed #1a1a1a" },
  activeBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: 10, background: "#e3f2d8", border: "2px solid #0a8c3a", marginBottom: 12, fontFamily: "monospace", fontSize: 11, gap: 8, flexWrap: "wrap" },
  empty: { fontStyle: "italic", color: "#888", padding: 12, textAlign: "center" },
  regList: { display: "flex", flexDirection: "column", gap: 8 },
  regEntry: { padding: 12, background: "#f8f0d5", border: "2px solid #1a1a1a" },
  regEntryActive: { borderColor: "#0a8c3a", background: "#f0f8ea", borderWidth: 3 },
  regEntryHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: 4 },
  activeBadge: { fontFamily: "monospace", fontSize: 10, padding: "2px 8px", background: "#0a8c3a", color: "#fff", borderRadius: 0 },
  stackBadge: { fontFamily: "monospace", fontSize: 9, padding: "2px 6px", border: "1px solid currentColor", marginLeft: 6 },
  regEntryMeta: { fontFamily: "monospace", fontSize: 11, color: "#5a3820", marginBottom: 8 },
  regEntryActions: { display: "flex", gap: 6, flexWrap: "wrap" },
};
