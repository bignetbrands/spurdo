"use client";

import { useState, useCallback, useEffect } from "react";

// ============================================================
// BANK PANEL
// ============================================================
// Read-only window into the meme bank GitHub repo.
//   - Shows count + repo slug + when last refreshed
//   - "↻ refresh" force-refreshes the manifest cache
//   - Lists tags discovered across all entries (helps verify pillar matching)
//   - Shows a thumbnail grid of bank contents for quick eyeballing
//
// Bank contents are managed via git push to the source repo, not in
// the dashboard. This panel is for visibility, not editing.
// ============================================================

type LogFn = (msg: string, type?: "info" | "success" | "error" | "warn") => void;

interface MemeEntry {
  filename: string;
  rawUrl: string;
  tags: string[];
  primaryPillar?: string;
  sizeBytes?: number;
}

interface BankManifest {
  fetchedAt: string;
  repoSlug: string;
  count: number;
  entries: MemeEntry[];
  error?: string;
}

interface Props {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  addLog: LogFn;
}

export function BankPanel({ authedFetch, addLog }: Props) {
  const [manifest, setManifest] = useState<BankManifest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const fetchManifest = useCallback(
    async (force: boolean = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await authedFetch(`/api/admin/bank${force ? "?refresh=1" : ""}`);
        const data = await res.json();
        if (!res.ok || !data.ok) {
          const msg = data.error || `HTTP ${res.status}`;
          setError(msg);
          if (force) addLog(`bank refresh failed: ${msg}`, "error");
          return;
        }
        setManifest(data.manifest);
        if (force) {
          addLog(`bank refreshed: ${data.manifest.count} memes from ${data.manifest.repoSlug}`, "success");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [authedFetch, addLog]
  );

  useEffect(() => {
    fetchManifest(false);
  }, [fetchManifest]);

  // Aggregate tag counts across the bank for visibility
  const tagCounts = (() => {
    if (!manifest) return [] as Array<[string, number]>;
    const counts = new Map<string, number>();
    for (const e of manifest.entries) {
      for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  })();

  const previewEntries = manifest
    ? showAll
      ? manifest.entries
      : manifest.entries.slice(0, 12)
    : [];

  return (
    <section style={S.card}>
      <div style={S.cardHeader}>
        <h2 style={S.h2}>📦 MEME BANK</h2>
        <button onClick={() => fetchManifest(true)} disabled={loading} style={S.btnGhost}>
          {loading ? "…" : "↻ refresh"}
        </button>
      </div>
      <p style={S.hint}>
        curated authentic memes from a github repo. push images to the repo, click refresh, they appear here. used by COMPOSE when provider = bank.
      </p>

      {error && (
        <div style={S.errorBox}>
          <strong>error:</strong> {error}
          <div style={S.hint}>
            common fixes: (1) create the repo bignetbrands/spurdo-memes with a /memes folder, (2) push at least one image, (3) set GITHUB_TOKEN env in vercel if rate-limited
          </div>
        </div>
      )}

      {manifest && !error && (
        <>
          <div style={S.summaryRow}>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>memes</div>
              <div style={{ ...S.summaryValue, color: manifest.count > 0 ? "#0a8c3a" : "#c92020" }}>
                {manifest.count}
              </div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>repo</div>
              <div style={{ ...S.summaryValue, fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>
                {manifest.repoSlug}
              </div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>last fetched</div>
              <div style={{ ...S.summaryValue, fontSize: 11 }}>
                {new Date(manifest.fetchedAt).toLocaleString()}
              </div>
            </div>
          </div>

          {manifest.count === 0 ? (
            <div style={S.empty}>
              bank is empty. create <code>bignetbrands/spurdo-memes</code> with a <code>/memes</code> folder and push some pngs.
            </div>
          ) : (
            <>
              {tagCounts.length > 0 && (
                <div style={S.tagBlock}>
                  <div style={S.envBoxTitle}>tags discovered ({tagCounts.length})</div>
                  <div style={S.tagList}>
                    {tagCounts.slice(0, 30).map(([tag, n]) => (
                      <span key={tag} style={S.tagChip}>
                        {tag} <span style={S.tagCount}>×{n}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div style={S.thumbGrid}>
                {previewEntries.map((e) => (
                  <a
                    key={e.filename}
                    href={e.rawUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={S.thumbLink}
                    title={`${e.filename}\ntags: ${e.tags.join(", ")}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={e.rawUrl} alt={e.filename} style={S.thumbImg} loading="lazy" />
                    <div style={S.thumbName}>{e.filename}</div>
                  </a>
                ))}
              </div>
              {manifest.entries.length > 12 && (
                <button onClick={() => setShowAll((v) => !v)} style={S.btnGhost}>
                  {showAll ? "show fewer" : `show all ${manifest.entries.length}`}
                </button>
              )}
            </>
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
  envBoxTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, color: "#5a3820" },
  errorBox: { padding: 12, background: "#ffeaea", border: "2px solid #c92020", color: "#c92020", marginBottom: 12, fontSize: 13 },
  summaryRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 },
  summaryItem: { padding: 10, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  summaryLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", marginBottom: 4 },
  summaryValue: { fontSize: 18, fontWeight: 700 },
  empty: { fontStyle: "italic", color: "#888", padding: 12, textAlign: "center", background: "#f8f0d5", border: "2px dashed #1a1a1a" },
  tagBlock: { marginBottom: 16, padding: 10, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  tagList: { display: "flex", flexWrap: "wrap", gap: 4 },
  tagChip: { fontFamily: "monospace", fontSize: 11, padding: "2px 6px", background: "#fff", border: "1px solid #1a1a1a" },
  tagCount: { color: "#888", marginLeft: 2 },
  thumbGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 12 },
  thumbLink: { textDecoration: "none", color: "#1a1a1a", border: "2px solid #1a1a1a", background: "#fff", padding: 4, display: "flex", flexDirection: "column", gap: 4 },
  thumbImg: { width: "100%", height: 100, objectFit: "cover", display: "block", background: "#f8f0d5" },
  thumbName: { fontFamily: "monospace", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  btnGhost: { padding: "4px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 12, cursor: "pointer" },
};
