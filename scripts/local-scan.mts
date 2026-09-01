// run da REAL full chain scan locally n write da payload 2 /tmp/live-scan.json
//   npx tsx scripts/local-scan.mts                          (public rpc fallback)
//   SOLANA_RPC="https://..." npx tsx scripts/local-scan.mts (fast, helius)
// used 4 ops: verifying da engine against chain, or pushing a fresh payload
// in2 redis when da server's rpc key iz down (see docs/REVSHARE-HANDOFF.md)
const { runFullScan, jstr } = await import("../src/lib/revshare-scan.ts");
const d = await runFullScan();
// NEVER write a payload wit dropped txs — a rate-limited public-node run
// once produced a 1-row payload dat got pushed 2 da live cache (sep 1 2026)
if (/dropped/.test(d.diagContrib || "")) {
  console.error("REFUSING 2 write payload — scan haz drops:", d.diagContrib);
  process.exit(2);
}
(await import("fs")).writeFileSync("/tmp/live-scan.json", jstr(d));
console.log("diagContrib:", d.diagContrib);
console.log("diagLocks:", d.diagLocks);
console.log("rows:", d.contribRows.length, " rev wallet:", (Number(d.revSolLamports) / 1e9).toFixed(4), "SOL");
for (const l of d.locks || []) {
  const num = (x: unknown) => (typeof x === "bigint" ? Number(x) : Number(x || 0));
  console.log(" ", l.address.slice(0, 8), (l.name || "").slice(0, 18).padEnd(18),
    "dep", (num(l.deposited) / 1e6).toFixed(1) + "m", "wd", (num(l.withdrawn) / 1e6).toFixed(1) + "m");
}
console.log("(payload written 2 /tmp/live-scan.json)");
