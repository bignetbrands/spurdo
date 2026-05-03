"use client";

import { useState, useCallback, useEffect } from "react";

// ============================================================
// BANK PANEL — memedepot version
// ============================================================

type LogFn = (msg: string, type?: "info" | "success" | "error" | "warn") => void;

interface MemeEntry {
  id: string;
  rawUrl: string;
  source: "scraped" | "fallback";
}

interface BankManifest {
  fetchedAt: string;
  source: string;
  count: number;
  scrapedCount: number;
  fallbackCount: number;
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
          addLog(
            `bank refreshed: ${data.manifest.count} memes from ${data.manifest.source}`,
            "success"
          );
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
        community-curated memes scraped from memedepot. anyone can submit there. cached for 1 hour, refresh to pick up new uploads. used by COMPOSE when provider = bank.
      </p>

      {error && (
        <div style={S.errorBox}>
          <strong>error:</strong> {error}
          <div style={S.hint}>
            check that memedepot.com/d/{`{slug}`} exists and has at least one image. set MEMEDEPOT_SLUG env if your slug differs from the project id.
          </div>
        </div>
      )}

      {manifest && (
        <>
          <div style={S.summaryRow}>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>total memes</div>
              <div style={{ ...S.summaryValue, color: manifest.count > 0 ? "#0a8c3a" : "#c92020" }}>
                {manifest.count}
              </div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>scraped live</div>
              <div style={S.summaryValue}>{manifest.scrapedCount}</div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>fallback</div>
              <div style={S.summaryValue}>{manifest.fallbackCount}</div>
            </div>
            <div style={S.summaryItem}>
              <div style={S.summaryLabel}>last fetched</div>
              <div style={{ ...S.summaryValue, fontSize: 11 }}>
                {new Date(manifest.fetchedAt).toLocaleString()}
              </div>
            </div>
          </div>

          {manifest.error && (
            <div style={S.warnBox}>
              <strong>scrape warning:</strong> {manifest.error}
              <div style={S.hint}>serving fallback entries from MEMEDEPOT_FALLBACK_IDS env var.</div>
            </div>
          )}

          <div style={S.linkRow}>
            <a href={`https://${manifest.source}`} target="_blank" rel="noopener noreferrer" style={S.link}>
              ↗ open {manifest.source}
            </a>
          </div>

          {manifest.count === 0 ? (
            <div style={S.empty}>
              bank is empty. upload some authentic spurdo memes at <strong>memedepot.com/d/spurdo</strong>, then click refresh.
            </div>
          ) : (
            <>
              <div style={S.thumbGrid}>
                {previewEntries.map((e) => (
                  <a
                    key={e.id}
                    href={e.rawUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={S.thumbLink}
                    title={`${e.id}\nsource: ${e.source}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={e.rawUrl} alt={e.id} style={S.thumbImg} loading="lazy" />
                    <div style={S.thumbName}>
                      {e.source === "scraped" ? "🌐" : "📌"} {e.id.slice(0, 8)}…
                    </div>
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
  errorBox: { padding: 12, background: "#ffeaea", border: "2px solid #c92020", color: "#c92020", marginBottom: 12, fontSize: 13 },
  warnBox: { padding: 10, background: "#fff5d5", border: "2px solid #a06800", color: "#a06800", marginBottom: 12, fontSize: 12 },
  summaryRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 16 },
  summaryItem: { padding: 10, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  summaryLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", marginBottom: 4 },
  summaryValue: { fontSize: 18, fontWeight: 700 },
  linkRow: { marginBottom: 12 },
  link: { fontFamily: "monospace", fontSize: 12, color: "#1a1a1a", textDecoration: "underline" },
  empty: { fontStyle: "italic", color: "#888", padding: 12, textAlign: "center", background: "#f8f0d5", border: "2px dashed #1a1a1a" },
  thumbGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 12 },
  thumbLink: { textDecoration: "none", color: "#1a1a1a", border: "2px solid #1a1a1a", background: "#fff", padding: 4, display: "flex", flexDirection: "column", gap: 4 },
  thumbImg: { width: "100%", height: 100, objectFit: "cover", display: "block", background: "#f8f0d5" },
  thumbName: { fontFamily: "monospace", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  btnGhost: { padding: "4px 10px", border: "2px solid #1a1a1a", background: "#fff", fontFamily: "inherit", fontSize: 12, cursor: "pointer" },
};
