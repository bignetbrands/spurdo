"use client";

import { useState, useEffect, useCallback } from "react";
import { LoraPanel } from "@/components/LoraPanel";
import { BankPanel } from "@/components/BankPanel";
import { StyleLoraPanel } from "@/components/StyleLoraPanel";

// ============================================================
// SPURDO BOT — Mission Control Dashboard
// ============================================================
// M1: auth gate, status panel, kill switch
// M2: Compose panel — pick pillar, generate tweet + image
// M2.5: LoRA training UI — train, registry, set active
// M2.6: resilience — daily budget, retries, rate limits
// M3 (this commit): cron + scheduler + autonomous posting + post-now
// M4: mentions / reply queue (TBD)
// M5: tools, meme test, raid mode toggle (TBD)
// ============================================================

type LogEntry = { time: string; msg: string; type: "info" | "success" | "error" | "warn" };

interface StatusData {
  timestamp: string;
  killSwitch: boolean;
  config: {
    project: string;
    xHandle: string;
    pillarsCount: number;
    contractAddress: string;
    allowedImageProviders?: Array<"bank" | "custom" | "fal" | "openai">;
    genStack?: "flux-photoreal" | "sdxl-stylized" | "openai-only" | "bank-only";
    stackInfo?: {
      stack: string;
      styleLoraCount?: number;
      hasStyleLora?: boolean;
      defaultIdentityScale?: number;
      defaultLoraScale?: number;
    };
  };
  kvHealth: boolean;
  activeLora?: { url: string } | null;
  budget?: {
    images: { used: number; limit: number; remaining: number };
    tokens: { used: number; limit: number; remaining: number };
    date: string;
    overridden: boolean;
  } | null;
  envCheck: Record<string, boolean>;
}

interface PillarSummary {
  id: string;
  name: string;
  description: string;
  generateImage: boolean;
  model: string;
  dailyTarget: { min: number; max: number };
}

interface GenerateResponse {
  ok: boolean;
  tweet?: { text: string; pillar: string; model: string; tokensUsed: number; charCount: number };
  image?: { url: string; provider: string; promptSent?: string; elapsedMs: number };
  imageError?: string;
  totalElapsedMs?: number;
  error?: string;
  budgetExceeded?: { resource: string; used: number; limit: number };
}

interface ActivityData {
  today: {
    date: string;
    count: number;
    tweets: Array<{
      id: string;
      text: string;
      pillar: string;
      postedAt: string;
      url: string;
      hasImage: boolean;
      dryRun?: boolean;
    }>;
  };
  crons: {
    tweet: { lastSeen: string; agoMinutes: number } | null;
    replies: { lastSeen: string; agoMinutes: number } | null;
  };
}

interface ServerEvent {
  ts: string;
  type: "info" | "success" | "error" | "warn" | "post" | "skip" | "cron";
  msg: string;
  meta?: Record<string, unknown>;
}

export default function BotDashboard() {
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [pillars, setPillars] = useState<PillarSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  // Compose state
  const [selectedPillar, setSelectedPillar] = useState<string>("");
  const [includeImage, setIncludeImage] = useState(true);
  const [imageProvider, setImageProvider] = useState<"fal" | "openai" | "bank" | "custom">("bank");
  const [loraScale, setLoraScale] = useState(1.0);
  // ── CUSTOM IMAGE UPLOAD ──
  // When provider === "custom", operator picks an image file. We hold the
  // File in state + compute a preview URL via createObjectURL. On post-now,
  // we convert to base64 data URL and send via the existing imageUrl field
  // (lib/twitter.ts already handles data URLs).
  const [customImageFile, setCustomImageFile] = useState<File | null>(null);
  const [customImagePreview, setCustomImagePreview] = useState<string | null>(null);
  const [customDragActive, setCustomDragActive] = useState(false);
  const [composing, setComposing] = useState(false);
  const [composeResult, setComposeResult] = useState<GenerateResponse | null>(null);
  const [posting, setPosting] = useState(false);

  // Activity + server log state (M3)
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [serverEvents, setServerEvents] = useState<ServerEvent[]>([]);

  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLog((prev) => [{ time, msg, type }, ...prev].slice(0, 50));
  }, []);

  const authedFetch = useCallback(
    async (url: string, init?: RequestInit) => {
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          Authorization: `Bearer ${secret}`,
        },
      });
    },
    [secret]
  );

  const fetchStatus = useCallback(
    async (silent = false) => {
      setLoading(true);
      try {
        const res = await authedFetch("/api/admin/status");
        if (res.status === 401) {
          setAuthenticated(false);
          if (!silent) addLog("auth failed — check the password", "error");
          return;
        }
        const data = (await res.json()) as StatusData;
        setStatus(data);
        setAuthenticated(true);
        if (!silent) addLog("status refreshed", "success");
      } catch (err) {
        addLog(`status fetch failed: ${err instanceof Error ? err.message : err}`, "error");
      } finally {
        setLoading(false);
      }
    },
    [authedFetch, addLog]
  );

  const fetchPillars = useCallback(async () => {
    try {
      const res = await authedFetch("/api/admin/pillars");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pillars: PillarSummary[] };
      setPillars(data.pillars);
      if (data.pillars.length && !selectedPillar) setSelectedPillar(data.pillars[0].id);
    } catch (err) {
      addLog(`pillars fetch failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }, [authedFetch, addLog, selectedPillar]);

  const toggleKillSwitch = useCallback(async () => {
    if (!status) return;
    const next = !status.killSwitch;
    setLoading(true);
    try {
      const res = await authedFetch("/api/admin/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog(`kill switch ${next ? "ENABLED" : "DISABLED"}`, next ? "warn" : "success");
      await fetchStatus(true);
    } catch (err) {
      addLog(`toggle failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [status, authedFetch, addLog, fetchStatus]);

  const compose = useCallback(async () => {
    if (!selectedPillar) {
      addLog("pick a pillar first", "warn");
      return;
    }
    // Custom provider sanity check: must have a file picked before composing
    // (otherwise the preview would have no image and post-now would fail)
    if (includeImage && imageProvider === "custom" && !customImageFile) {
      addLog("pick an image file first (drop or click the upload box)", "warn");
      return;
    }
    setComposing(true);
    setComposeResult(null);
    const imageLabel = includeImage
      ? imageProvider === "custom"
        ? ` + custom image (${customImageFile?.name})`
        : ` + image (${imageProvider})`
      : "";
    addLog(`generating ${selectedPillar}${imageLabel}…`, "info");
    try {
      // For custom provider: tell the server to skip image gen entirely.
      // The server only returns tweet text; the image comes from the upload
      // we already have client-side. This saves an API call + skips budget.
      const serverShouldGenerateImage = includeImage && imageProvider !== "custom";

      const res = await authedFetch("/api/admin/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pillar: selectedPillar,
          generateImage: serverShouldGenerateImage,
          imageProvider: imageProvider === "custom" ? undefined : imageProvider,
          loraScale: imageProvider === "fal" ? loraScale : undefined,
        }),
      });
      const text = await res.text();
      let data: GenerateResponse;
      try {
        data = JSON.parse(text) as GenerateResponse;
      } catch {
        // Vercel returned an HTML error page (timeout, crash, etc) instead of JSON
        const snippet = text.slice(0, 120).replace(/\s+/g, " ").trim();
        addLog(`server returned non-JSON (HTTP ${res.status}): "${snippet}…"`, "error");
        addLog(`likely cause: function timeout (>120s) or Vercel gateway error`, "warn");
        return;
      }
      // For custom provider: graft the local image preview onto the response
      // so the rest of the UI (preview, post-now) treats it like any other image.
      if (data.ok && imageProvider === "custom" && customImageFile && customImagePreview) {
        data.image = {
          url: customImagePreview, // blob URL — only used for the local preview <img>
          provider: "custom",
          elapsedMs: 0,
        };
      }
      setComposeResult(data);
      if (!data.ok) {
        addLog(`generation failed: ${data.error}`, "error");
      } else {
        const took = data.totalElapsedMs ? ` in ${(data.totalElapsedMs / 1000).toFixed(1)}s` : "";
        addLog(`generated ${data.tweet?.charCount} chars${took}`, "success");
        if (data.imageError) addLog(`image gen failed: ${data.imageError}`, "warn");
      }
    } catch (err) {
      addLog(`compose error: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setComposing(false);
    }
  }, [selectedPillar, includeImage, imageProvider, loraScale, customImageFile, customImagePreview, authedFetch, addLog]);

  // ── M3: Activity + server log fetchers ──
  const fetchActivity = useCallback(async () => {
    try {
      const res = await authedFetch("/api/admin/activity");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ActivityData;
      setActivity(data);
    } catch (err) {
      addLog(`activity fetch failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }, [authedFetch, addLog]);

  const fetchServerEvents = useCallback(async () => {
    try {
      const res = await authedFetch("/api/admin/events?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { events: ServerEvent[] };
      setServerEvents(data.events);
    } catch (err) {
      addLog(`events fetch failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }, [authedFetch, addLog]);

  const postNow = useCallback(async () => {
    if (!composeResult?.tweet) return;
    if (!confirm(`Post this tweet live to @${status?.config.xHandle}?\n\n${composeResult.tweet.text}`)) return;
    setPosting(true);
    addLog(`posting to X…`, "info");
    try {
      // For custom-uploaded images: convert the picked File to a base64 data URL.
      // The server (twitter.ts) handles data URLs natively. Skipped for bank/fal/openai
      // which already returned a usable URL via /api/admin/generate.
      let imageUrlForPost: string | undefined = composeResult.image?.url;
      if (composeResult.image?.provider === "custom" && customImageFile) {
        try {
          imageUrlForPost = await fileToDataUrl(customImageFile);
          const sizeMB = (customImageFile.size / 1024 / 1024).toFixed(2);
          addLog(`encoding ${customImageFile.name} (${sizeMB} MB) for upload…`, "info");
        } catch (err) {
          addLog(`failed to read image file: ${err instanceof Error ? err.message : err}`, "error");
          return;
        }
      }

      const res = await authedFetch("/api/admin/post-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pillar: composeResult.tweet.pillar,
          text: composeResult.tweet.text,
          imageUrl: imageUrlForPost,
          imageProvider: composeResult.image?.provider,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        addLog(`post failed: ${data.error || res.status}`, "error");
        return;
      }
      addLog(
        `${data.dryRun ? "[DRY-RUN] " : ""}posted! ${data.url || data.tweetId}`,
        "success"
      );
      setComposeResult(null);
      setCustomImageFile(null); // clear the upload after successful post
      // Refresh data so the new post appears in ACTIVITY
      fetchActivity();
      fetchServerEvents();
    } catch (err) {
      addLog(`post error: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setPosting(false);
    }
  }, [composeResult, status, customImageFile, authedFetch, addLog, fetchActivity, fetchServerEvents]);

  // Auto-poll status + activity + events every 30s when authenticated
  useEffect(() => {
    if (!authenticated) return;
    fetchPillars();
    fetchActivity();
    fetchServerEvents();
    const id = setInterval(() => {
      fetchStatus(true);
      fetchActivity();
      fetchServerEvents();
    }, 30_000);
    return () => clearInterval(id);
  }, [authenticated, fetchStatus, fetchPillars, fetchActivity, fetchServerEvents]);

  // Custom image preview: create blob URL when file picked, revoke on change/unmount
  useEffect(() => {
    if (!customImageFile) {
      setCustomImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(customImageFile);
    setCustomImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [customImageFile]);

  // Clear custom image when provider switches away
  useEffect(() => {
    if (imageProvider !== "custom" && customImageFile) {
      setCustomImageFile(null);
    }
  }, [imageProvider, customImageFile]);

  // ────── AUTH GATE ──────
  if (!authenticated) {
    return (
      <div style={S.page}>
        <div style={S.authBox}>
          <pre style={S.authAscii}>{`
    ╔════════════════════════════╗
    ║                            ║
    ║   spurdo mission control   ║
    ║                            ║
    ╚════════════════════════════╝
`}</pre>
          <input
            type="password"
            placeholder="admin secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchStatus()}
            style={S.input}
            autoFocus
          />
          <button onClick={() => fetchStatus()} disabled={loading || !secret} style={S.btnPrimary}>
            {loading ? "..." : "authenticate"}
          </button>
          {log.length > 0 && (
            <div style={S.logPanel}>
              {log.map((l, i) => (
                <div key={i} style={{ ...S.logEntry, color: typeColor(l.type) }}>
                  <span style={S.logTime}>{l.time}</span> {l.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ────── DASHBOARD ──────
  const selectedPillarObj = pillars.find((p) => p.id === selectedPillar);

  return (
    <div style={S.page}>
      <div style={S.container}>
        <header style={S.header}>
          <h1 style={S.h1}>spurdo mission control :DDD</h1>
          <span style={S.headerMeta}>
            project: <b>{status?.config.project}</b> · @{status?.config.xHandle}
          </span>
        </header>

        {/* STATUS */}
        <section style={S.card}>
          <div style={S.cardHeader}>
            <h2 style={S.h2}>◈ STATUS</h2>
            <button onClick={() => fetchStatus()} style={S.btnGhost} disabled={loading}>
              {loading ? "..." : "↻ refresh"}
            </button>
          </div>
          {status && (
            <div style={S.statusGrid}>
              <Stat label="kill switch" value={status.killSwitch ? "ACTIVE — paused" : "off — running"} good={!status.killSwitch} />
              <Stat label="kv health" value={status.kvHealth ? "ok" : "FAIL"} good={status.kvHealth} />
              <Stat label="pillars loaded" value={String(status.config.pillarsCount)} good={status.config.pillarsCount > 0} />
              <Stat
                label="gen stack"
                value={status.config.genStack || "?"}
                good={status.config.genStack !== "bank-only"}
                small
              />
              <Stat label="active lora" value={status.activeLora ? "set" : "none"} good={!!status.activeLora} small={false} />
              <Stat label="ca" value={status.config.contractAddress} small />
            </div>
          )}
          {status?.config.stackInfo?.stack === "sdxl-stylized" && (
            <div style={S.budgetBox}>
              <div style={S.envBoxTitle}>sdxl-stylized stack details</div>
              <div style={{ fontSize: 12, color: "#5a3820", lineHeight: 1.6 }}>
                identity scale default: <strong>{status.config.stackInfo.defaultIdentityScale}</strong>
                {" · "}
                style LoRAs configured: <strong>{status.config.stackInfo.styleLoraCount}</strong>
                {" · "}
                {status.config.stackInfo.hasStyleLora ? (
                  <span style={{ color: "#0a8c3a" }}>style LoRA active ✓</span>
                ) : (
                  <span style={{ color: "#a06800" }}>no style LoRA — output will be base SDXL</span>
                )}
              </div>
              {!status.config.stackInfo.hasStyleLora && (
                <div style={S.hint}>
                  to fully activate this stack: source an MS-Paint style LoRA and add it to{" "}
                  <code>config/{status.config.project}/image-prompts.json → stackConfig.defaultStyleLoras</code>.
                  bank stays as the on-canon source either way.
                </div>
              )}
            </div>
          )}
          {status?.budget && (
            <div style={S.budgetBox}>
              <div style={S.envBoxTitle}>today&apos;s budget · {status.budget.date}{status.budget.overridden ? " · OVERRIDDEN" : ""}</div>
              <div style={S.budgetGrid}>
                <BudgetBar label="images" used={status.budget.images.used} limit={status.budget.images.limit} />
                <BudgetBar label="tokens" used={status.budget.tokens.used} limit={status.budget.tokens.limit} />
              </div>
            </div>
          )}
          {status && (
            <div style={S.envBox}>
              <div style={S.envBoxTitle}>env vars</div>
              <div style={S.envBoxGrid}>
                {Object.entries(status.envCheck).map(([k, v]) => (
                  <div key={k} style={{ ...S.envItem, color: v ? "#0a8c3a" : "#c92020" }}>
                    {v ? "✓" : "✗"} {k}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ACTIVITY — M3 */}
        <section style={S.card}>
          <div style={S.cardHeader}>
            <h2 style={S.h2}>📊 ACTIVITY</h2>
            <button onClick={fetchActivity} style={S.btnGhost}>↻ refresh</button>
          </div>
          {activity ? (
            <>
              <div style={S.activityHeader}>
                <strong>{activity.today.count}</strong> tweet{activity.today.count === 1 ? "" : "s"} today · {activity.today.date}
                <span style={S.cronStrip}>
                  {activity.crons.tweet
                    ? <>tweet cron seen <b>{activity.crons.tweet.agoMinutes}m</b> ago</>
                    : <span style={{ color: "#c92020" }}>tweet cron: never</span>}
                  {" · "}
                  {activity.crons.replies
                    ? <>replies cron seen <b>{activity.crons.replies.agoMinutes}m</b> ago</>
                    : <span style={{ color: "#c92020" }}>replies cron: never</span>}
                </span>
              </div>
              {activity.today.tweets.length === 0 ? (
                <div style={S.empty}>no tweets today yet</div>
              ) : (
                <div style={S.tweetList}>
                  {activity.today.tweets.map((t) => (
                    <div key={t.id} style={S.tweetRow}>
                      <div style={S.tweetRowText}>
                        {t.dryRun && <span style={S.dryRunBadge}>DRY-RUN</span>}
                        {t.hasImage && <span style={S.imgBadge}>🖼</span>}
                        {t.text}
                      </div>
                      <div style={S.tweetRowMeta}>
                        {t.pillar} · {new Date(t.postedAt).toLocaleTimeString("en-US", { hour12: false })}
                        {t.url && !t.dryRun && (
                          <> · <a href={t.url} target="_blank" rel="noopener noreferrer" style={S.link}>↗ view</a></>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={S.empty}>loading…</div>
          )}
        </section>

        {/* COMPOSE — M2 */}
        <section style={S.card}>
          <h2 style={S.h2}>✏ COMPOSE</h2>
          <p style={S.hint}>generate a tweet on demand. m2 doesnt post — just preview. m3 will wire posting.</p>

          <div style={S.composeForm}>
            <label style={S.label}>
              pillar
              <select
                value={selectedPillar}
                onChange={(e) => setSelectedPillar(e.target.value)}
                disabled={composing}
                style={S.select}
              >
                {pillars.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </select>
            </label>

            {selectedPillarObj && (
              <div style={S.pillarBlurb}>
                <em>{selectedPillarObj.description}</em>
              </div>
            )}

            <div style={S.composeOpts}>
              <label style={S.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={includeImage}
                  onChange={(e) => setIncludeImage(e.target.checked)}
                  disabled={composing}
                />
                generate image
              </label>

              <label style={S.label}>
                provider
                {(() => {
                  const allowed = status?.config.allowedImageProviders ?? ["bank", "fal", "openai", "custom"];
                  const current = allowed.includes(imageProvider) ? imageProvider : allowed[0];
                  // If state is out of sync with allowed list, correct it
                  if (current !== imageProvider && allowed.length > 0) {
                    setTimeout(() => setImageProvider(current as "fal" | "openai" | "bank" | "custom"), 0);
                  }
                  if (allowed.length === 1) {
                    return (
                      <div style={S.providerLocked}>
                        {labelForProvider(allowed[0])} <span style={S.providerLockedNote}>only option for this project</span>
                      </div>
                    );
                  }
                  return (
                    <select
                      value={current}
                      onChange={(e) => setImageProvider(e.target.value as "fal" | "openai" | "bank" | "custom")}
                      disabled={composing || !includeImage}
                      style={S.selectInline}
                    >
                      {allowed.map((p) => (
                        <option key={p} value={p}>
                          {labelForProvider(p)}
                        </option>
                      ))}
                    </select>
                  );
                })()}
              </label>
            </div>

            {includeImage && imageProvider === "fal" && (
              <label style={S.label}>
                lora strength: <span style={{ fontFamily: "monospace", fontSize: 13, color: "#1a1a1a" }}>{loraScale.toFixed(1)}</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={loraScale}
                  onChange={(e) => setLoraScale(parseFloat(e.target.value))}
                  disabled={composing}
                  style={{ width: "100%" }}
                />
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "#5a3820", display: "flex", justifyContent: "space-between" }}>
                  <span>0.5 = subtle</span><span>1.0 = default</span><span>1.5 = strong</span><span>2.0 = max</span>
                </div>
              </label>
            )}

            {includeImage && imageProvider === "custom" && (
              <div style={S.customUploadBlock}>
                <div style={S.envBoxTitle}>upload image</div>
                <div
                  style={{ ...S.dropzone, ...(customDragActive ? S.dropzoneActive : {}) }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setCustomDragActive(true);
                  }}
                  onDragLeave={() => setCustomDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setCustomDragActive(false);
                    const dropped = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
                    if (dropped) setCustomImageFile(dropped);
                  }}
                >
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    id="custom-image-input"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setCustomImageFile(f);
                      e.target.value = ""; // allow re-pick after remove
                    }}
                    disabled={composing}
                  />
                  <label htmlFor="custom-image-input" style={S.dropzoneLabel}>
                    {customImagePreview ? (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={customImagePreview} alt="upload preview" style={S.customPreviewImg} />
                        <div style={S.dropzoneHint}>
                          {customImageFile?.name} · {((customImageFile?.size || 0) / 1024 / 1024).toFixed(2)} MB · click to replace
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setCustomImageFile(null);
                          }}
                          style={S.btnSmall}
                        >
                          remove
                        </button>
                      </div>
                    ) : (
                      <div style={S.dropzoneText}>
                        <strong>click to pick</strong> or <strong>drop an image here</strong>
                        <div style={S.dropzoneHint}>png · jpg · webp · gif · max 5 MB</div>
                      </div>
                    )}
                  </label>
                </div>
              </div>
            )}

            <button
              onClick={compose}
              disabled={
                composing ||
                !selectedPillar ||
                (includeImage && imageProvider === "custom" && !customImageFile)
              }
              style={S.btnPrimary}
            >
              {composing
                ? "🌀 generatin..."
                : includeImage && imageProvider === "custom" && !customImageFile
                ? "✨ pick an image first"
                : "✨ generate"}
            </button>
          </div>

          {composeResult && composeResult.ok && composeResult.tweet && (
            <div style={S.composeResult}>
              <div style={S.tweetPreview}>
                <div style={S.tweetText}>{composeResult.tweet.text}</div>
                <div style={S.tweetMeta}>
                  {composeResult.tweet.charCount}/280 chars · {composeResult.tweet.model} · {composeResult.tweet.tokensUsed} tokens
                  {composeResult.totalElapsedMs ? ` · ${(composeResult.totalElapsedMs / 1000).toFixed(1)}s total` : ""}
                </div>
              </div>

              {composeResult.image && (
                <div style={S.imgPreview}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={composeResult.image.url} alt="generated" style={S.imgThumb} />
                  <div style={S.tweetMeta}>
                    via {composeResult.image.provider} · {(composeResult.image.elapsedMs / 1000).toFixed(1)}s
                  </div>
                </div>
              )}

              {composeResult.imageError && (
                <div style={{ ...S.envItem, color: "#c92020", padding: 8 }}>image error: {composeResult.imageError}</div>
              )}

              <button
                onClick={postNow}
                disabled={posting || !composeResult.ok}
                style={S.btnPostNow}
              >
                {posting ? "🌀 posting…" : `🚀 post this to @${status?.config.xHandle || "spurdo"}`}
              </button>
            </div>
          )}

          {composeResult && !composeResult.ok && (
            <div style={{ ...S.envItem, color: "#c92020", padding: 12, background: "#ffeaea" }}>
              {composeResult.error || "unknown error"}
            </div>
          )}
        </section>

        {/* BANK — M4 (curated memes from GitHub) */}
        <BankPanel authedFetch={authedFetch} addLog={addLog} />

        {/* STYLE LORAS — M5 (only renders when stack supports them) */}
        <StyleLoraPanel authedFetch={authedFetch} addLog={addLog} />

        {/* LORA — M2.5 */}
        <LoraPanel authedFetch={authedFetch} addLog={addLog} adminSecret={secret} />

        {/* CONTROLS */}
        <section style={S.card}>
          <h2 style={S.h2}>⚙ CONTROLS</h2>
          <div style={S.controlsRow}>
            <button
              onClick={toggleKillSwitch}
              disabled={loading || !status}
              style={status?.killSwitch ? S.btnSuccess : S.btnDanger}
            >
              {status?.killSwitch ? "▶ resume spurdo" : "⏸ pause spurdo (kill switch)"}
            </button>
          </div>
          <p style={S.hint}>kill switch halts all crons. use it before deploys, when something looks weird :D</p>
        </section>

        {/* LOG */}
        <section style={S.card}>
          <div style={S.cardHeader}>
            <h2 style={S.h2}>📜 LOG</h2>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={fetchServerEvents} style={S.btnGhost}>↻ refresh</button>
            </div>
          </div>

          {log.length > 0 && (
            <div style={{ ...S.logPanel, marginBottom: 8, maxHeight: 110 }}>
              <div style={S.envBoxTitle}>this session</div>
              {log.map((l, i) => (
                <div key={i} style={{ ...S.logEntry, color: typeColor(l.type) }}>
                  <span style={S.logTime}>{l.time}</span> {l.msg}
                </div>
              ))}
            </div>
          )}

          <div style={S.logPanel}>
            <div style={S.envBoxTitle}>server (persistent · last 50)</div>
            {serverEvents.length === 0 ? (
              <div style={S.logEmpty}>no events yet</div>
            ) : (
              serverEvents.map((e, i) => (
                <div key={i} style={{ ...S.logEntry, color: typeColor(e.type === "post" ? "success" : e.type === "skip" ? "info" : e.type === "cron" ? "info" : (e.type as LogEntry["type"])) }}>
                  <span style={S.logTime}>{new Date(e.ts).toLocaleTimeString("en-US", { hour12: false })}</span>
                  <span style={S.eventTypeBadge}>{e.type}</span>
                  {e.msg}
                </div>
              ))
            )}
          </div>
        </section>

        <footer style={S.footer}>
          spurdo bot · M3: cron · {status?.timestamp ? new Date(status.timestamp).toLocaleString() : ""}
        </footer>
      </div>
    </div>
  );
}

function Stat({ label, value, good, small }: { label: string; value: string; good?: boolean; small?: boolean }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{label}</div>
      <div
        style={{
          ...S.statValue,
          ...(small ? { fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" } : {}),
          color: good === undefined ? "#1a1a1a" : good ? "#0a8c3a" : "#c92020",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function BudgetBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  // Color: green < 60%, amber 60-90%, red 90%+
  const color = pct >= 90 ? "#c92020" : pct >= 60 ? "#a06800" : "#0a8c3a";
  return (
    <div style={S.budgetItem}>
      <div style={S.budgetItemHeader}>
        <span style={{ fontWeight: 700, textTransform: "lowercase" }}>{label}</span>
        <span style={{ fontFamily: "monospace", fontSize: 11, color }}>
          {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div style={S.budgetBarTrack}>
        <div style={{ ...S.budgetBarFill, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function typeColor(t: LogEntry["type"]): string {
  return t === "error" ? "#c92020" : t === "warn" ? "#a06800" : t === "success" ? "#0a8c3a" : "#444";
}

function labelForProvider(p: "bank" | "fal" | "openai" | "custom"): string {
  if (p === "bank") return "bank (curated memes) — free, on-canon";
  if (p === "custom") return "custom upload — your image";
  if (p === "fal") return "fal (FLUX + LoRA) — generated";
  return "openai (gpt-image-1) — generated";
}

/** Convert a File to a base64 data URL for transport to post-now. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("FileReader returned non-string result"));
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

const S: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f5e9c9", fontFamily: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive', color: "#1a1a1a", padding: "24px 16px" },
  container: { maxWidth: 920, margin: "0 auto" },
  authBox: { maxWidth: 460, margin: "80px auto", padding: "32px 28px", background: "#fffbea", border: "3px solid #1a1a1a", boxShadow: "6px 6px 0 #1a1a1a" },
  authAscii: { fontFamily: "monospace", fontSize: 12, lineHeight: 1.3, marginBottom: 20, color: "#5a3820" },
  input: { width: "100%", padding: "12px 14px", border: "3px solid #1a1a1a", background: "#fff", fontFamily: "monospace", fontSize: 14, marginBottom: 12, boxSizing: "border-box" },
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 8 },
  h1: { fontSize: 26, margin: 0 },
  headerMeta: { fontSize: 13, color: "#5a3820" },
  card: { background: "#fffbea", border: "3px solid #1a1a1a", boxShadow: "4px 4px 0 #1a1a1a", padding: 20, marginBottom: 16 },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  h2: { fontSize: 16, margin: 0, letterSpacing: 1 },
  statusGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 12 },
  stat: { padding: 12, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  statLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", marginBottom: 4 },
  statValue: { fontSize: 16, fontWeight: 700 },
  envBox: { marginTop: 12, padding: 12, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  budgetBox: { marginTop: 12, padding: 12, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  budgetGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 },
  budgetItem: { display: "flex", flexDirection: "column", gap: 4 },
  budgetItemHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12 },
  budgetBarTrack: { height: 8, background: "#fff", border: "1px solid #1a1a1a", overflow: "hidden" },
  budgetBarFill: { height: "100%", transition: "width 0.3s" },
  envBoxTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, color: "#5a3820" },
  envBoxGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 4, fontFamily: "monospace", fontSize: 12 },
  envItem: { padding: "2px 0" },
  controlsRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  btnPrimary: { width: "100%", padding: "12px 18px", border: "3px solid #1a1a1a", background: "#ffe066", fontFamily: "inherit", fontSize: 16, cursor: "pointer", boxShadow: "3px 3px 0 #1a1a1a" },
  btnGhost: { padding: "6px 12px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 13, cursor: "pointer" },
  btnDanger: { padding: "12px 18px", border: "3px solid #1a1a1a", background: "#e94b3c", color: "#fff", fontFamily: "inherit", fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 #1a1a1a" },
  btnSuccess: { padding: "12px 18px", border: "3px solid #1a1a1a", background: "#8cc968", fontFamily: "inherit", fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 #1a1a1a" },
  hint: { fontSize: 12, color: "#5a3820", marginTop: 10, fontStyle: "italic" },
  logPanel: { background: "#f8f0d5", border: "2px solid #1a1a1a", padding: 10, fontFamily: "monospace", fontSize: 12, maxHeight: 220, overflow: "auto" },
  logEntry: { padding: "2px 0", lineHeight: 1.4 },
  logTime: { color: "#888", marginRight: 6 },
  logEmpty: { color: "#888", fontStyle: "italic" },
  footer: { textAlign: "center", fontSize: 12, color: "#888", marginTop: 24, fontFamily: "monospace" },
  // M2 compose-specific styles
  composeForm: { display: "flex", flexDirection: "column", gap: 12 },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", fontWeight: 700 },
  select: { padding: "10px 12px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "monospace", fontSize: 14, cursor: "pointer" },
  selectInline: { padding: "6px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "monospace", fontSize: 12, cursor: "pointer", marginLeft: 8 },
  providerLocked: { padding: "6px 10px", border: "2px solid #0a8c3a", background: "#f0f8ea", fontFamily: "monospace", fontSize: 12, marginLeft: 8 },
  providerLockedNote: { color: "#0a8c3a", fontStyle: "italic", marginLeft: 4 },
  customUploadBlock: { padding: 12, background: "#fffbea", border: "2px solid #1a1a1a" },
  dropzone: {
    border: "3px dashed #1a1a1a",
    background: "#fffbea",
    padding: 20,
    textAlign: "center",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
    marginTop: 8,
  },
  dropzoneActive: { background: "#fff3b0", borderColor: "#a06800", borderStyle: "solid" },
  dropzoneLabel: { display: "block", cursor: "pointer", width: "100%" },
  dropzoneText: { fontSize: 14, color: "#1a1a1a" },
  dropzoneHint: { fontSize: 11, color: "#5a3820", marginTop: 6, fontFamily: "monospace", fontStyle: "italic" },
  customPreviewImg: { maxWidth: "100%", maxHeight: 280, border: "2px solid #1a1a1a", display: "block" },
  btnSmall: { padding: "4px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 11, cursor: "pointer" },
  pillarBlurb: { fontSize: 13, color: "#5a3820", padding: "8px 12px", background: "#f5e9c9", border: "2px dashed #1a1a1a" },
  composeOpts: { display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820" },
  composeResult: { marginTop: 16, display: "flex", flexDirection: "column", gap: 12 },
  tweetPreview: { padding: 14, background: "#f8f0d5", border: "2px solid #1a1a1a" },
  tweetText: { fontSize: 16, whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 8 },
  tweetMeta: { fontFamily: "monospace", fontSize: 11, color: "#888", marginTop: 6 },
  imgPreview: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  imgThumb: { maxWidth: "100%", maxHeight: 480, border: "3px solid #1a1a1a", boxShadow: "4px 4px 0 #1a1a1a" },
  // M3: post-now + activity + events
  btnPostNow: {
    width: "100%",
    padding: "14px 18px",
    border: "3px solid #1a1a1a",
    background: "#8cc968",
    fontFamily: "inherit",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "4px 4px 0 #1a1a1a",
    marginTop: 8,
  },
  activityHeader: { fontSize: 14, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 },
  cronStrip: { fontFamily: "monospace", fontSize: 11, color: "#5a3820" },
  empty: { fontStyle: "italic", color: "#888", padding: 12, textAlign: "center" },
  tweetList: { display: "flex", flexDirection: "column", gap: 8 },
  tweetRow: { padding: 10, background: "#f8f0d5", border: "2px solid #1a1a1a" },
  tweetRowText: { fontSize: 14, marginBottom: 4, wordBreak: "break-word" },
  tweetRowMeta: { fontFamily: "monospace", fontSize: 11, color: "#5a3820" },
  link: { color: "#1a1a1a", textDecoration: "underline" },
  dryRunBadge: { display: "inline-block", padding: "1px 6px", background: "#ffd5d5", border: "1px solid #1a1a1a", fontFamily: "monospace", fontSize: 10, marginRight: 6 },
  imgBadge: { marginRight: 6 },
  eventTypeBadge: { display: "inline-block", padding: "0 6px", marginRight: 6, fontFamily: "monospace", fontSize: 10, background: "#f5e9c9", border: "1px solid #1a1a1a", textTransform: "uppercase", letterSpacing: 0.5 },
};
