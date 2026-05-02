"use client";

import { useState, useEffect, useCallback } from "react";

// ============================================================
// SPURDO BOT — Mission Control Dashboard (M1 skeleton)
// ============================================================
// M1 has: auth gate, status panel, kill switch toggle, log panel.
// M2 will add: post panel, image gen, manual post.
// M3 will add: cron + scheduler stats.
// M4 will add: engagement panel.
// M5 will polish.
// ============================================================

type LogEntry = { time: string; msg: string; type: "info" | "success" | "error" | "warn" };
type StatusData = {
  timestamp: string;
  killSwitch: boolean;
  config: {
    project: string;
    xHandle: string;
    pillarsCount: number;
    contractAddress: string;
  };
  kvHealth: boolean;
  envCheck: Record<string, boolean>;
};

export default function BotDashboard() {
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLog((prev) => [{ time, msg, type }, ...prev].slice(0, 50));
  }, []);

  const fetchStatus = useCallback(
    async (silent = false) => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/status", {
          headers: { Authorization: `Bearer ${secret}` },
        });
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
    [secret, addLog]
  );

  const toggleKillSwitch = useCallback(async () => {
    if (!status) return;
    const next = !status.killSwitch;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/kill-switch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
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
  }, [status, secret, addLog, fetchStatus]);

  // Auto-poll status every 30s when authenticated
  useEffect(() => {
    if (!authenticated) return;
    const id = setInterval(() => fetchStatus(true), 30_000);
    return () => clearInterval(id);
  }, [authenticated, fetchStatus]);

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
  return (
    <div style={S.page}>
      <div style={S.container}>
        <header style={S.header}>
          <h1 style={S.h1}>spurdo mission control :DDD</h1>
          <span style={S.headerMeta}>
            project: <b>{status?.config.project}</b> · @{status?.config.xHandle}
          </span>
        </header>

        <section style={S.card}>
          <div style={S.cardHeader}>
            <h2 style={S.h2}>◈ STATUS</h2>
            <button onClick={() => fetchStatus()} style={S.btnGhost} disabled={loading}>
              {loading ? "..." : "↻ refresh"}
            </button>
          </div>
          {status && (
            <div style={S.statusGrid}>
              <Stat
                label="kill switch"
                value={status.killSwitch ? "ACTIVE — paused" : "off — running"}
                good={!status.killSwitch}
              />
              <Stat label="kv health" value={status.kvHealth ? "ok" : "FAIL"} good={status.kvHealth} />
              <Stat label="pillars loaded" value={String(status.config.pillarsCount)} good={status.config.pillarsCount > 0} />
              <Stat label="ca" value={status.config.contractAddress} small />
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
          <p style={S.hint}>
            kill switch halts all crons. use it before deploys, when something looks weird, or when da bear has had enough :D
          </p>
        </section>

        <section style={S.card}>
          <h2 style={S.h2}>🚧 COMING IN M2-M5</h2>
          <ul style={S.todoList}>
            <li>M2 — manual post composer with image gen + preview</li>
            <li>M3 — cron stats, scheduler decisions, daily counts</li>
            <li>M4 — mention queue, reply preview, family-account engage</li>
            <li>M5 — meme test, thread analyzer, raid mode toggle, polish</li>
          </ul>
        </section>

        <section style={S.card}>
          <h2 style={S.h2}>📜 LOG</h2>
          <div style={S.logPanel}>
            {log.length === 0 ? (
              <div style={S.logEmpty}>no events yet</div>
            ) : (
              log.map((l, i) => (
                <div key={i} style={{ ...S.logEntry, color: typeColor(l.type) }}>
                  <span style={S.logTime}>{l.time}</span> {l.msg}
                </div>
              ))
            )}
          </div>
        </section>

        <footer style={S.footer}>
          spurdo bot · M1 skeleton · {status?.timestamp ? new Date(status.timestamp).toLocaleString() : ""}
        </footer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  good,
  small,
}: {
  label: string;
  value: string;
  good?: boolean;
  small?: boolean;
}) {
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

function typeColor(t: LogEntry["type"]): string {
  return t === "error" ? "#c92020" : t === "warn" ? "#a06800" : t === "success" ? "#0a8c3a" : "#444";
}

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f5e9c9",
    fontFamily: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive',
    color: "#1a1a1a",
    padding: "24px 16px",
  },
  container: { maxWidth: 920, margin: "0 auto" },
  authBox: {
    maxWidth: 460,
    margin: "80px auto",
    padding: "32px 28px",
    background: "#fffbea",
    border: "3px solid #1a1a1a",
    boxShadow: "6px 6px 0 #1a1a1a",
  },
  authAscii: { fontFamily: "monospace", fontSize: 12, lineHeight: 1.3, marginBottom: 20, color: "#5a3820" },
  input: {
    width: "100%",
    padding: "12px 14px",
    border: "3px solid #1a1a1a",
    background: "#fff",
    fontFamily: "monospace",
    fontSize: 14,
    marginBottom: 12,
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 8 },
  h1: { fontSize: 26, margin: 0 },
  headerMeta: { fontSize: 13, color: "#5a3820" },
  card: {
    background: "#fffbea",
    border: "3px solid #1a1a1a",
    boxShadow: "4px 4px 0 #1a1a1a",
    padding: 20,
    marginBottom: 16,
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  h2: { fontSize: 16, margin: 0, letterSpacing: 1 },
  statusGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 12 },
  stat: { padding: 12, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  statLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#5a3820", marginBottom: 4 },
  statValue: { fontSize: 16, fontWeight: 700 },
  envBox: { marginTop: 12, padding: 12, background: "#f5e9c9", border: "2px solid #1a1a1a" },
  envBoxTitle: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, color: "#5a3820" },
  envBoxGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 4, fontFamily: "monospace", fontSize: 12 },
  envItem: { padding: "2px 0" },
  controlsRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  btnPrimary: {
    width: "100%",
    padding: "12px 18px",
    border: "3px solid #1a1a1a",
    background: "#ffe066",
    fontFamily: "inherit",
    fontSize: 16,
    cursor: "pointer",
    boxShadow: "3px 3px 0 #1a1a1a",
  },
  btnGhost: {
    padding: "6px 12px",
    border: "2px solid #1a1a1a",
    background: "#fff",
    fontFamily: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  btnDanger: {
    padding: "12px 18px",
    border: "3px solid #1a1a1a",
    background: "#e94b3c",
    color: "#fff",
    fontFamily: "inherit",
    fontSize: 15,
    cursor: "pointer",
    boxShadow: "3px 3px 0 #1a1a1a",
  },
  btnSuccess: {
    padding: "12px 18px",
    border: "3px solid #1a1a1a",
    background: "#8cc968",
    fontFamily: "inherit",
    fontSize: 15,
    cursor: "pointer",
    boxShadow: "3px 3px 0 #1a1a1a",
  },
  hint: { fontSize: 12, color: "#5a3820", marginTop: 10, fontStyle: "italic" },
  todoList: { fontSize: 13, color: "#5a3820", paddingLeft: 20, marginTop: 8 },
  logPanel: {
    background: "#f8f0d5",
    border: "2px solid #1a1a1a",
    padding: 10,
    fontFamily: "monospace",
    fontSize: 12,
    maxHeight: 220,
    overflow: "auto",
  },
  logEntry: { padding: "2px 0", lineHeight: 1.4 },
  logTime: { color: "#888", marginRight: 6 },
  logEmpty: { color: "#888", fontStyle: "italic" },
  footer: { textAlign: "center", fontSize: 12, color: "#888", marginTop: 24, fontFamily: "monospace" },
};
