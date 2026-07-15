// ============================================================
// revshare scan engine — server-side twin of public/revshare.html
//
// why server-side: browsers can only reach one public solana rpc
// (pruned, recent history only) — full-history nodes reject or
// rate-limit browser calls. from da server we get complete history,
// and one shared cache serves evry visitor.
//
// zero new deps: vanilla ed25519 pda derivation (verified against
// @solana/web3.js, 200/200 random pairs), fetch, WebCrypto.
// SOLANA_RPC env (helius/quicknode url) makes it fast n guaranteed;
// widout it we lean on api.mainnet-beta.solana.com (full bigtable
// history, reachable server-side).
// ============================================================

export const MINT = "991L48va9rMiysu3fCpeg5p9bN4NLzhujojzmFtkgacE";
export const TREASURY = "ByXqkMujMBCgCbWsjJ1EreVKfT3PTZYy9MMxNRu58Smd";
export const DEV_WALLET = "G9ia5A2UyzDcstjpaXxRPwZL6U3Hwi15j6eSoyWqDexV";
export const REVSHARE_WALLET = "Gf9QUuqfEX8K3WFgfF4J1SXtM2Za1LZwitByNFqgtgtQ";
const INTERNAL_WALLETS = [TREASURY, DEV_WALLET, REVSHARE_WALLET];
const STREAMFLOW_PROGRAM = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m";
const STREAMFLOW_API = "https://api-public.streamflow.finance";

function rpcUrls(): string[] {
  return [
    process.env.SOLANA_RPC,
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.drpc.org",
  ].filter(Boolean) as string[];
}
const FAST = () => !!process.env.SOLANA_RPC;

/* ---------- rpc ---------- */
let GOOD_RPC: string | null = null;
async function rpcCallAt(url: string, method: string, params: unknown[], timeoutMs = 12000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  } finally {
    clearTimeout(t);
  }
}
async function rpcCall(method: string, params: unknown[]): Promise<any> {
  let lastErr: unknown = new Error("no rpc");
  const urls = rpcUrls();
  const order = GOOD_RPC ? [GOOD_RPC, ...urls.filter((u) => u !== GOOD_RPC)] : urls;
  for (const url of order) {
    try {
      const result = await rpcCallAt(url, method, params);
      GOOD_RPC = url;
      return result;
    } catch (e) {
      lastErr = e;
      if (url === GOOD_RPC) GOOD_RPC = null;
    }
  }
  throw lastErr;
}

/* ---------- vanilla ata derivation ---------- */
const ED_P = 2n ** 255n - 19n;
const edMod = (a: bigint) => { a %= ED_P; return a < 0n ? a + ED_P : a; };
const edPow = (b: bigint, e: bigint) => { let r = 1n; b = edMod(b); while (e > 0n) { if (e & 1n) r = (r * b) % ED_P; b = (b * b) % ED_P; e >>= 1n; } return r; };
const edInv = (a: bigint) => edPow(a, ED_P - 2n);
const ED_D = edMod(-121665n * edInv(121666n));
function isOnCurve(b: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i] & (i === 31 ? 0x7f : 0xff));
  if (y >= ED_P) return false;
  const y2 = edMod(y * y);
  const x2 = edMod(edMod(y2 - 1n) * edInv(edMod(ED_D * y2 + 1n)));
  let x = edPow(x2, (ED_P + 3n) / 8n);
  if (edMod(x * x) !== x2) x = edMod(x * edPow(2n, (ED_P - 1n) / 4n));
  if (edMod(x * x) !== x2) return false;
  if (x === 0n && ((b[31] & 0x80) >>> 7) === 1) return false;
  return true;
}
const B58A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const v = B58A.indexOf(c); if (v < 0) throw new Error("bad b58"); n = n * 58n + BigInt(v); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}
function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const teEnc = (s: string) => new TextEncoder().encode(s);
function concatB(arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const TOKEN_PROG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22_PROG = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROG = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
async function findPda(seeds: Uint8Array[], programId32: Uint8Array): Promise<Uint8Array> {
  for (let bump = 255; bump >= 0; bump--) {
    const buf = concatB([...seeds, new Uint8Array([bump]), programId32, teEnc("ProgramDerivedAddress")]);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    if (!isOnCurve(h)) return h;
  }
  throw new Error("no pda");
}
async function deriveAta(owner: string, mint: string, tokenProg = TOKEN_PROG): Promise<string> {
  const pda = await findPda([b58decode(owner), b58decode(tokenProg), b58decode(mint)], b58decode(ATA_PROG));
  return b58encode(pda);
}

/* ---------- sigs ---------- */
type SigInfo = { signature: string; blockTime?: number; err?: unknown };
export type NodeStat = { node: string; n: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function allSigsAt(url: string, addr: string, cap = 5000): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  while (out.length < cap) {
    const opts: Record<string, unknown> = before ? { limit: 1000, before } : { limit: 1000 };
    const batch: SigInfo[] = await rpcCallAt(url, "getSignaturesForAddress", [addr, opts], 8000);
    if (!batch || !batch.length) break;
    out.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }
  return out;
}
/* dedicated rpc haz full history — union wit pruned publics only wastes da time budget */
function sigEndpoints(): string[] {
  if (FAST()) return [process.env.SOLANA_RPC as string];
  return rpcUrls();
}
const DEAD_NODES = new Map<string, number>(); // url -> fail count (benched at 2)
async function allSigsMulti(addr: string, nodeStats: NodeStat[], cap = 5000): Promise<SigInfo[]> {
  const eps = sigEndpoints().filter((u) => (DEAD_NODES.get(u) || 0) < 2);
  if (!eps.length) throw new Error("all sig nodes benched");
  const lists = await Promise.all(eps.map(async (u) => {
    let l: SigInfo[] | null = null;
    for (let attempt = 0; attempt < 2 && l === null; attempt++) {
      try { l = await allSigsAt(u, addr, cap); }
      catch { if (attempt === 0) await sleep(300); }
    }
    if (l === null) DEAD_NODES.set(u, (DEAD_NODES.get(u) || 0) + 1);
    else DEAD_NODES.delete(u);
    nodeStats.push({ node: u.replace(/^https?:\/\//, "").split("/")[0].split(".")[0], n: l === null ? -1 : l.length });
    return l;
  }));
  if (lists.every((l) => l === null)) throw new Error("sig fetch failed for " + addr.slice(0, 6));
  const seen = new Map<string, SigInfo>();
  for (const l of lists) for (const s of l || []) if (!seen.has(s.signature)) seen.set(s.signature, s);
  return [...seen.values()];
}

/* ---------- transfer extraction ---------- */
type Flow = { owner: string; srcAddr?: string; srcOwner?: string; amount: bigint; time: number; sig: string };
type OutFlow = { dest: string; destOwner?: string; amount: bigint; time: number; sig: string };

function deltaTransfers(tx: any, mine: Set<string>, scanOwner: string) {
  const res: { ins: Omit<Flow, "time" | "sig">[]; outs: Omit<OutFlow, "time" | "sig">[] } = { ins: [], outs: [] };
  const meta = tx && tx.meta;
  if (!meta || !meta.preTokenBalances || !meta.postTokenBalances) return res;
  let keys: string[] = (((tx.transaction || {}).message || {}).accountKeys || [])
    .map((k: any) => (typeof k === "string" ? k : k && k.pubkey));
  const la = meta.loadedAddresses || {};
  keys = keys.concat(la.writable || [], la.readonly || []);
  const pre = new Map<number, any>(), post = new Map<number, any>();
  for (const b of meta.preTokenBalances) if (b.mint === MINT) pre.set(b.accountIndex, b);
  for (const b of meta.postTokenBalances) if (b.mint === MINT) post.set(b.accountIndex, b);
  const rows: { addr: string; owner: string; delta: bigint }[] = [];
  for (const i of new Set([...pre.keys(), ...post.keys()])) {
    const addr = keys[i];
    if (!addr) continue;
    const p = pre.get(i), q = post.get(i);
    const before = BigInt((p && p.uiTokenAmount && p.uiTokenAmount.amount) || "0");
    const after = BigInt((q && q.uiTokenAmount && q.uiTokenAmount.amount) || "0");
    rows.push({ addr, owner: (q && q.owner) || (p && p.owner) || addr, delta: after - before });
  }
  const isMine = (r: { addr: string; owner: string }) => mine.has(r.addr) || r.owner === scanOwner;
  for (const r of rows) {
    if (!isMine(r) || r.delta === 0n) continue;
    if (r.delta > 0n) {
      const payer = rows.filter((x) => x.delta < 0n && !isMine(x)).sort((a, b) => (a.delta < b.delta ? -1 : 1))[0];
      res.ins.push({ owner: (payer && payer.owner) || "?", srcAddr: payer && payer.addr, srcOwner: payer && payer.owner, amount: r.delta });
    } else {
      const recv = rows.filter((x) => x.delta > 0n && !isMine(x)).sort((a, b) => (a.delta > b.delta ? -1 : 1))[0];
      res.outs.push({ dest: (recv && recv.addr) || "balance-delta", destOwner: recv && recv.owner, amount: -r.delta });
    }
  }
  return res;
}

function walkTransfers(tx: any, mine: Set<string>) {
  const res: { ins: Omit<Flow, "time" | "sig">[]; outs: Omit<OutFlow, "time" | "sig">[] } = { ins: [], outs: [] };
  if (!tx || !tx.transaction) return res;
  const groups: any[][] = [(tx.transaction.message.instructions || [])];
  for (const inner of (tx.meta && tx.meta.innerInstructions) || []) groups.push(inner.instructions || []);
  for (const g of groups)
    for (const ix of g) {
      const p = ix.parsed;
      if (!p || (ix.program !== "spl-token" && ix.program !== "spl-token-2022")) continue;
      if (p.type !== "transfer" && p.type !== "transferChecked") continue;
      const info = p.info || {};
      if (p.type === "transferChecked" && info.mint && info.mint !== MINT) continue;
      const raw = info.amount ?? (info.tokenAmount && info.tokenAmount.amount) ?? "0";
      let amt: bigint;
      try { amt = BigInt(raw); } catch { continue; }
      if (amt === 0n) continue;
      const owner = info.authority || info.multisigAuthority || info.source || "?";
      if (mine.has(info.destination)) res.ins.push({ owner, srcAddr: info.source, srcOwner: owner, amount: amt });
      else if (mine.has(info.source)) res.outs.push({ dest: info.destination, amount: amt });
    }
  return res;
}

/* ---------- wallet scan ---------- */
export type ScanStats = { atas: number; sigs: number; ok: number; fail: number };
async function scanWallet(owner: string, nodeStats: NodeStat[], extraAccts?: string[]) {
  let tokenAccts: string[] = [];
  try {
    const r = await rpcCall("getTokenAccountsByOwner", [owner, { mint: MINT }, { encoding: "jsonParsed" }]);
    tokenAccts = (r.value || []).map((v: any) => v.pubkey);
  } catch { /* derived addresses still cover us */ }
  const derived: string[] = [];
  try { derived.push(await deriveAta(owner, MINT)); } catch { }
  try { derived.push(await deriveAta(owner, MINT, TOKEN22_PROG)); } catch { }
  const mine = new Set([...tokenAccts, ...derived, ...(extraAccts || [])]);
  const targets = [...new Set([owner, ...mine])];
  const sigMap = new Map<string, SigInfo>();
  for (const t of targets)
    for (const s of await allSigsMulti(t, nodeStats))
      if (!s.err && !sigMap.has(s.signature)) sigMap.set(s.signature, s);
  const sigs = [...sigMap.values()];
  const stats: ScanStats = { atas: mine.size, sigs: sigs.length, ok: 0, fail: 0 };
  const ins: Flow[] = [], outs: OutFlow[] = [];
  const useTx = (tx: any, sig: SigInfo) => {
    let t = deltaTransfers(tx, mine, owner);
    if (!t.ins.length && !t.outs.length) t = walkTransfers(tx, mine);
    const bt = sig.blockTime || (tx && tx.blockTime) || 0;
    for (const x of t.ins) ins.push({ ...x, time: bt, sig: sig.signature });
    for (const x of t.outs) outs.push({ ...x, time: bt, sig: sig.signature });
  };
  let queue = sigs;
  for (let pass = 0; pass < 2 && queue.length; pass++) {
    const CONC = FAST() ? 10 : pass === 0 ? 4 : 2;
    const WAIT = FAST() ? 30 : pass === 0 ? 180 : 500;
    const failed: SigInfo[] = [];
    for (let i = 0; i < queue.length; i += CONC) {
      const chunk = queue.slice(i, i + CONC);
      const txs = await Promise.all(chunk.map((s) =>
        rpcCall("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => undefined)));
      txs.forEach((tx, j) => {
        if (tx === undefined) { failed.push(chunk[j]); return; }
        stats.ok++;
        if (tx) useTx(tx, chunk[j]);
      });
      await sleep(WAIT);
    }
    queue = failed;
    if (queue.length && pass === 0) await sleep(1200);
  }
  stats.fail += queue.length;
  return { ins, outs, stats };
}

/* ---------- locks ---------- */
const OFF = { withdrawn: 17, canceledAt: 25, end: 33, start: 409, deposited: 417, period: 425, perPeriod: 433, cliff: 441, cliffAmount: 449, name: 463, closed: 671 };
export type Lock = {
  address: string; name: string;
  deposited: bigint; withdrawn: bigint; cliffAmount: bigint; perPeriod: bigint;
  start: number; end: number; cliff: number; period: number; canceledAt: number; closed: boolean;
};
async function fetchLocksRpc(): Promise<Lock[]> {
  const result = await rpcCall("getProgramAccounts", [
    STREAMFLOW_PROGRAM,
    { encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 177, bytes: MINT } }] },
  ]);
  const locks: Lock[] = [];
  for (const acc of result || []) {
    try {
      const bytes = Uint8Array.from(Buffer.from(acc.account.data[0], "base64"));
      if (bytes.length < 680) continue;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const u64 = (off: number) => dv.getBigUint64(off, true);
      const name = new TextDecoder().decode(bytes.slice(OFF.name, OFF.name + 64)).replace(/\u0000/g, "").trim();
      locks.push({
        address: acc.pubkey, name,
        deposited: u64(OFF.deposited), withdrawn: u64(OFF.withdrawn),
        cliffAmount: u64(OFF.cliffAmount), perPeriod: u64(OFF.perPeriod),
        start: Number(u64(OFF.start)), end: Number(u64(OFF.end)),
        cliff: Number(u64(OFF.cliff)), period: Number(u64(OFF.period)),
        canceledAt: Number(u64(OFF.canceledAt)), closed: bytes[OFF.closed] === 1,
      });
    } catch { /* skip weird account */ }
  }
  return locks;
}
async function fetchLocksApi(): Promise<Lock[]> {
  const base = STREAMFLOW_API + "/v2/api/contracts/tabularium/?";
  const urls: string[] = [];
  for (const w of [DEV_WALLET, TREASURY]) {
    urls.push(base + "sender=" + encodeURIComponent(w));
    urls.push(base + "recipient=" + encodeURIComponent(w));
  }
  const settled = await Promise.allSettled(urls.map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error("api " + r.status); return r.json(); })));
  const rows: any[] = [];
  let ok = false;
  for (const s of settled) if (s.status === "fulfilled" && Array.isArray(s.value)) { ok = true; rows.push(...s.value); }
  if (!ok) throw new Error("api unreachable");
  const toSec = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : 0);
  const parseAmt = (v: any, decimals: number) => {
    const s = String(v ?? "0").trim();
    if (!s || s === "null") return 0n;
    if (s.includes(".")) { const [i, f = ""] = s.split("."); return BigInt(i + (f + "0".repeat(decimals)).slice(0, decimals)); }
    return BigInt(s);
  };
  const seen = new Set<string>();
  return rows
    .filter((r) => r.mint === MINT && !seen.has(r.address) && seen.add(r.address))
    .map((r) => ({
      address: r.address, name: r.name || "",
      deposited: parseAmt(r.amount, 6), withdrawn: parseAmt(r.claimedAmount, 6),
      cliffAmount: parseAmt(r.cliffAmount, 6), perPeriod: parseAmt(r.amountPerPeriod, 6),
      start: toSec(r.startDt), end: toSec(r.endDt), cliff: toSec(r.startDt),
      period: Number(r.period || 0), canceledAt: toSec(r.canceledDt), closed: !!r.isClosed,
    }));
}

/* ---------- full scan ---------- */
export type ContribRow = {
  wallet: string; locked: bigint; pending: bigint; deposited: bigint; returned: bigint;
  n: number; first: number; last: number; paid: bigint; pct: number;
};
export type RevshareData = {
  savedAt: number;
  rpcConfigured: boolean;
  decimals: number;
  supplyUi: number | null;
  locks: Lock[];
  contribRows: ContribRow[];
  pool: bigint; pendingTotal: bigint; sent2dev: bigint;
  diagLocks: string; diagContrib: string;
};

export async function runFullScan(): Promise<RevshareData> {
  const t0 = Date.now();
  let decimals = 6, supplyUi: number | null = null;
  try {
    const r = await rpcCall("getTokenSupply", [MINT]);
    decimals = r.value.decimals;
    supplyUi = Number(r.value.uiAmountString || r.value.uiAmount);
  } catch { /* pct just stays unknown */ }

  // locks: chain + api merged
  const [rpcRes, apiRes] = await Promise.allSettled([fetchLocksRpc(), fetchLocksApi()]);
  const ldiag: string[] = [];
  const byAddr = new Map<string, Lock>();
  if (apiRes.status === "fulfilled") { for (const l of apiRes.value) byAddr.set(l.address, l); ldiag.push(`api ok (${apiRes.value.length})`); }
  else ldiag.push("api fail");
  if (rpcRes.status === "fulfilled") { for (const l of rpcRes.value) byAddr.set(l.address, l); ldiag.push(`rpc ok (${rpcRes.value.length})`); }
  else ldiag.push("rpc fail");
  if (rpcRes.status === "rejected" && apiRes.status === "rejected") throw new Error("locks unreachable: rpc+api both failed");
  const locks = [...byAddr.values()];

  // contributor scan wit dev-side discovery
  const nodeStats: NodeStat[] = [];
  const dev = await scanWallet(DEV_WALLET, nodeStats);
  const candAccts = new Map<string, { srcOwner?: string; amount: bigint }>();
  for (const i of dev.ins) {
    if (!i.srcAddr) continue;
    const c = candAccts.get(i.srcAddr) || { srcOwner: i.srcOwner, amount: 0n };
    c.amount += i.amount;
    candAccts.set(i.srcAddr, c);
  }
  const discoveredAccts: string[] = [];
  const discoveredOwners = new Set<string>();
  const unknown = [...candAccts.entries()].filter(([, c]) => c.srcOwner !== TREASURY && c.srcOwner !== REVSHARE_WALLET);
  const closedMap: Record<string, boolean> = {};
  if (unknown.length) {
    const r = await rpcCall("getMultipleAccounts", [unknown.map(([a]) => a).slice(0, 100), { encoding: "base64" }]).catch(() => null);
    ((r && r.value) || []).forEach((acc: any, j: number) => { closedMap[unknown[j][0]] = acc === null; });
  }
  for (const [addr, c] of candAccts) {
    if (c.srcOwner === TREASURY) { discoveredAccts.push(addr); continue; }
    if (closedMap[addr] && c.amount >= 10n ** BigInt(decimals) * 1000n) { // closed + sweep-sized (≥1000 tokens)
      discoveredAccts.push(addr);
      if (c.srcOwner) discoveredOwners.add(c.srcOwner);
    }
  }

  const tre = await scanWallet(TREASURY, nodeStats, discoveredAccts);
  for (const vo of discoveredOwners) {
    if (vo === TREASURY || vo === DEV_WALLET) continue;
    const extra = await scanWallet(vo, nodeStats);
    tre.ins.push(...extra.ins); tre.outs.push(...extra.outs);
    tre.stats.atas += extra.stats.atas; tre.stats.sigs += extra.stats.sigs;
    tre.stats.ok += extra.stats.ok; tre.stats.fail += extra.stats.fail;
  }
  const rev = await scanWallet(REVSHARE_WALLET, nodeStats);
  if (tre.stats.fail > 0 && tre.ins.length === 0) throw new Error(`rpc dropped ${tre.stats.fail} of ${tre.stats.sigs} treasury txs`);

  // payouts per wallet
  const paid = new Map<string, bigint>();
  for (const o of rev.outs) {
    const w = o.destOwner || o.dest;
    if (!w || w === "balance-delta") continue;
    paid.set(w, (paid.get(w) || 0n) + o.amount);
  }

  // event timeline: deposit→pending, sweep→locked, returns drain pending den locked
  const internal = new Set([...INTERNAL_WALLETS, ...discoveredOwners]);
  type Ev = { t: number; ord: number; type: "dep" | "sweep" | "ret"; w?: string; amt?: bigint };
  const events: Ev[] = [];
  for (const d of tre.ins) {
    if (d.owner === "?" || internal.has(d.owner)) continue;
    events.push({ t: d.time || 0, ord: 0, type: "dep", w: d.owner, amt: d.amount });
  }
  let sent2dev = 0n;
  for (const o of tre.outs) {
    if (o.destOwner === DEV_WALLET) { sent2dev += o.amount; events.push({ t: o.time || 0, ord: 1, type: "sweep" }); }
    else if (o.destOwner && !internal.has(o.destOwner)) events.push({ t: o.time || 0, ord: 2, type: "ret", w: o.destOwner, amt: o.amount });
  }
  events.sort((a, b) => a.t - b.t || a.ord - b.ord);

  type Agg = { locked: bigint; pending: bigint; deposited: bigint; returned: bigint; n: number; first: number; last: number };
  const agg = new Map<string, Agg>();
  const get = (w: string): Agg => {
    let a = agg.get(w);
    if (!a) { a = { locked: 0n, pending: 0n, deposited: 0n, returned: 0n, n: 0, first: 0, last: 0 }; agg.set(w, a); }
    return a;
  };
  for (const e of events) {
    if (e.type === "dep") {
      const a = get(e.w!);
      a.pending += e.amt!; a.deposited += e.amt!; a.n++;
      if (e.t && (!a.first || e.t < a.first)) a.first = e.t;
      if (e.t > a.last) a.last = e.t;
    } else if (e.type === "sweep") {
      for (const a of agg.values()) { a.locked += a.pending; a.pending = 0n; }
    } else {
      const a = get(e.w!);
      a.returned += e.amt!;
      let r = e.amt!;
      const fromPending = r < a.pending ? r : a.pending;
      a.pending -= fromPending; r -= fromPending;
      a.locked = a.locked > r ? a.locked - r : 0n;
    }
  }
  let pool = 0n, pendingTotal = 0n;
  for (const a of agg.values()) { pool += a.locked; pendingTotal += a.pending; }
  const contribRows: ContribRow[] = [...agg.entries()]
    // evry wallet dat ever sent 2 da treasury gets a row — incl fully-refunded ones
    // (locked 0 · pending 0 · returned = all of it). da returned column iz da proof
    // dey got it back. share% iz locked-only so a refunded wallet reads 0% = no payout.
    .filter(([, a]) => a.deposited > 0n)
    .map(([w, a]) => ({
      wallet: w, locked: a.locked, pending: a.pending, deposited: a.deposited, returned: a.returned,
      n: a.n, first: a.first, last: a.last, paid: paid.get(w) || 0n,
      pct: pool > 0n ? Number((a.locked * 10000n) / pool) / 100 : 0,
    }))
    .sort((x, y) => (y.locked > x.locked ? 1 : y.locked < x.locked ? -1 : y.pending > x.pending ? 1 : -1));

  const nodeAgg: Record<string, { ok: number; err: number; n: number }> = {};
  for (const s of nodeStats) {
    nodeAgg[s.node] = nodeAgg[s.node] || { ok: 0, err: 0, n: 0 };
    if (s.n < 0) nodeAgg[s.node].err++;
    else { nodeAgg[s.node].ok++; nodeAgg[s.node].n += s.n; }
  }
  const nodeDiag = Object.entries(nodeAgg).map(([k, v]) => k + ":" + (v.err ? `${v.ok}ok/${v.err}err` : `${v.n} sigs`)).join(" ");
  const diagContrib =
    `server \u00b7 treasury: ${tre.stats.atas} acct \u00b7 ${tre.stats.ok}/${tre.stats.sigs} txs` +
    (tre.stats.fail ? ` (${tre.stats.fail} dropped)` : "") +
    ` \u00b7\u00b7 revshare: ${rev.stats.atas} acct \u00b7 ${rev.stats.ok}/${rev.stats.sigs} txs` +
    (rev.stats.fail ? ` (${rev.stats.fail} dropped)` : "") +
    (discoveredAccts.length ? ` \u00b7\u00b7 found ${discoveredAccts.length} old acct` : "") +
    ` \u00b7\u00b7 ${nodeDiag} \u00b7\u00b7 ${((Date.now() - t0) / 1000).toFixed(1)}s`;

  return {
    savedAt: Date.now(), rpcConfigured: FAST(), decimals, supplyUi, locks,
    contribRows, pool, pendingTotal, sent2dev,
    diagLocks: "server \u00b7 sources: " + ldiag.join(" \u00b7 "),
    diagContrib,
  };
}

/* bigint-safe json — same $b convention da page uses */
export const jstr = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? { $b: v.toString() } : v));
export const jparse = (s: string) => JSON.parse(s, (_k, v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v));
