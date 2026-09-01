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
// da dev moved wallets (aug 2026): G9ia iz da OLD dev wallet — it stays da
// ledger's dev identity (row, stakes, history). da NEW wallet signs future
// locks n receives dev's rev share + unlocks. treasury → new-dev = sweep,
// payouts 2 it credit da dev row (PAYOUT_PROXIES), n it never gets itz own
// contributor row (internal).
export const NEW_DEV_WALLET = "6y5aBnJb9LshwnwCV1zkmUCU6f7TxGY71FLT22CJJf6Y";
export const REVSHARE_WALLET = "Gf9QUuqfEX8K3WFgfF4J1SXtM2Za1LZwitByNFqgtgtQ";
const INTERNAL_WALLETS = [TREASURY, DEV_WALLET, NEW_DEV_WALLET, REVSHARE_WALLET];
// payouts routed thru an exchange deposit address — on-chain dest iz da exchange,
// da real recipient iz documented off-chain (multisig payout sheet). map dest → locker.
const PAYOUT_PROXIES: Record<string, string> = {
  // changenow deposit addr used for da jul 1 2026 (round 1) payout 2 da top locker
  "3RVaxZDX9dFatEwa6TCbV4kr3k5zhY5uX6ufqf3gatuc": "Hwk1ydVukuzEZ9AQx9UYrDpe2hbYfPSonohvYcqbpadp",
  // (no proxy 4 da new dev wallet — it haz itz OWN row now, role "dev2",
  //  so payouts 2 it land visibly on dat row from da handover cycle on)
};
const STREAMFLOW_PROGRAM = "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m";
const STREAMFLOW_API = "https://api-public.streamflow.finance";
// jun-21 ansem allocation: treasury sent 15m 2 da ansem wallet in one tx
// (verified on-chain — da 15m still sits there). it wuz pooled from three
// 5m legs (ism-attested): 8FGj…, 4JLSS…, n dev. da legs got swept in2
// 2026-08 cohorts B4 da transfer went out, so da engine strips 5m from
// each wallet's aug cohort n records an "alloc" ledger entry — dose
// tokens left da pool 4 da ansem deal n never earn rev share.
// vesting tranches: da pool locks vest linearly over 24 months n da multisig
// claims each month's tranche back 2 treasury (escrow → treasury). a claimed
// tranche unlocks EVRY contributor of dat cohort pro-rata (floor(cohort×num/den)
// each — dust stays unattributed, same as ansem). entries r applied IN ORDER
// against da cohort's REMAINING balance, so when month 2's tranche iz claimed
// add a NEW entry wit den = months left (23n, den 22n after dat, …) — dat
// equals 1/24 of da original evry time. (da jun-29 lock's 833k june tranche
// iz NOT here — it got re-swept in2 da round-two lock, so itz still locked
// n draining it would double-count.)
const VESTED_UNLOCKS: { ym: string; num: bigint; den: bigint; t: number; sig: string; legs?: Record<string, bigint> }[] = [
  // benis multisig lock (jul 3 · 157,715,013 · da r1 pool): tranche 1/24 =
  // 6,571,458.879 claimed aug 2 17:00 utc. (later moved treasury → rev
  // wallet aug 3, ~5.34m of it in2 da 8F7w time-lock — still NOT a
  // revshare pool, so da drain stands.)
  {
    ym: "2026-07", num: 1n, den: 24n, t: 1785690008,
    sig: "4vtn8P8RbdPx2dbUeDxMwVhAC5SpzsPx8XAV1oKrhUrVngHR26oyw3cwrYPNjwd6HZ5qkgk9qUZK3bnr1KFnPyMX",
  },
  // vesting cycle 2 (jul-9 lock · 5,100,000): tranche 1/24 = 212,500 claimed
  // aug 9 05:38 utc, sitting in treasury. da 2026-09 cohort spans TWO locks
  // (jul-9 + round-two), so dis entry drains ONLY da jul-9 contributors via
  // per-wallet `legs` (der jul-9-swept deposits — Σ legs = da lock exactly).
  {
    ym: "2026-09", num: 1n, den: 24n, t: 1786253927,
    sig: "5wKMj98pxFeRzgMfZZ2eGYp94DiRGMxivjpVv6Fz7CSyDmdytkoQ3FWtmTeFxj3kanK27XeUX2vGy5p3mECfToXw",
    legs: {
      "FvdPuHeopuLdX3ib4MqnAhnkc8vKhMQ6zAJtHeYXWyY3": 3_000_000_000_000n,
      "uGuTB2QsYQbJXSVBYCYmA2GtmjaAcw27q8UvWMdQ3pe": 1_000_000_000_000n,
      "HhGwhBNHNgtSSBhzexejDGyRuvQNxeiPEEeqGUxmAkB3": 1_000_000_000_000n,
      "AaA4XWwka8mNa1xt6qMNUmk4nUqEyQBbMN4nBnpyBdD3": 100_000_000_000n,
    },
  },
];
export const ANSEM_WALLET = "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52";
const ANSEM_ALLOC_SIG = "2L3kc9pa2muKWXS1PKm1iFQp9dU5seoj2ZzGKhFnhKFFAg96Qe7mcCA9t3F4Yk7vm6GC2Q115JwcaYwijEryLcjy";
const ANSEM_ALLOC_T = 1782016214; // 2026-06-21 04:30:14 utc
const ANSEM_ALLOC_YM = "2026-08"; // da cohort dose legs were swept in2
const ANSEM_ALLOC_LEGS: Record<string, bigint> = {
  "8FGj2bv5WuqiRCHzUDsC4tK9crbitNpj6GzG6UQD3c1N": 5_000_000_000_000n,
  "4JLSS9bKhsbH9pN9sA2pGWdmf5Q8aAcr5P8kUb8eSzJ2": 5_000_000_000_000n,
  [DEV_WALLET]: 5_000_000_000_000n,
};

function rpcUrls(): string[] {
  return [
    process.env.SOLANA_RPC,
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ].filter(Boolean) as string[];
}
const FAST = () => !!process.env.SOLANA_RPC;

/* ---------- rpc ---------- */
let GOOD_RPC: string | null = null;
async function rpcCallAt(url: string, method: string, params: unknown[], timeoutMs = 12000): Promise<any> {
  // 429/5xx = "slow down", not "give up" — back off n retry b4 failing da node.
  // helius free tier rate-limits hard; dropping a tx here means a wallet
  // silently loses a deposit, so patience > speed.
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        clearTimeout(t);
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "rpc error");
      return json.result;
    } finally {
      clearTimeout(t);
    }
  }
}
// getTransaction returning null iz a VALID response meaning "dis node dont have it"
// (pruned) — rpcCall only falls back on errors, so a null from da primary node
// silently ate old deposits while da diag said all ok. walk da nodes til one
// actually has da tx; null from evryone = genuinely gone (caller counts it).
async function getTxMulti(sig: string): Promise<any> {
  let sawError = false;
  for (const url of rpcUrls()) {
    try {
      const tx = await rpcCallAt(url, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      if (tx !== null) return tx;
    } catch { sawError = true; await sleep(250); }
  }
  return sawError ? undefined : null; // undefined → retry pass; null → all nodes agree itz gone
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

// paging runs newest→oldest, so hitting da cap silently eats da OLDEST history —
// exactly da early contributors. da dev wallet already sits >5000, so keep headroom
// n report truncation instead of swallowing it.
const SIG_CAP = 20000;
async function allSigsAt(url: string, addr: string, cap = SIG_CAP): Promise<SigInfo[]> {
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
async function allSigsMulti(addr: string, nodeStats: NodeStat[], cap = SIG_CAP): Promise<{ sigs: SigInfo[]; truncated: boolean }> {
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
  return { sigs: [...seen.values()], truncated: lists.some((l) => l !== null && l.length >= cap) };
}

/* ---------- transfer extraction ---------- */
type Flow = { owner: string; srcAddr?: string; srcOwner?: string; amount: bigint; time: number; sig: string };
type OutFlow = { dest: string; destOwner?: string; amount: bigint; time: number; sig: string };
type SolOut = { dest: string; lamports: bigint; time: number; sig: string };

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
export type ScanStats = { atas: number; sigs: number; ok: number; fail: number; trunc: number; gone: number };
async function scanWallet(owner: string, nodeStats: NodeStat[], extraAccts?: string[], skipOwnerSigs = false) {
  let tokenAccts: string[] = [];
  try {
    const r = await rpcCall("getTokenAccountsByOwner", [owner, { mint: MINT }, { encoding: "jsonParsed" }]);
    tokenAccts = (r.value || []).map((v: any) => v.pubkey);
  } catch { /* derived addresses still cover us */ }
  const derived: string[] = [];
  try { derived.push(await deriveAta(owner, MINT)); } catch { }
  try { derived.push(await deriveAta(owner, MINT, TOKEN22_PROG)); } catch { }
  const mine = new Set([...tokenAccts, ...derived, ...(extraAccts || [])]);
  // spl transfers never reference da owner wallet in accountKeys (handoff gotcha),
  // so mint flows all touch da token accts — for da dev wallet dat cuts ~5.7k
  // owner-sig txs (sol/streamflow noise) dat blew da 300s budget.
  const targets = [...new Set(skipOwnerSigs ? [...mine] : [owner, ...mine])];
  const sigMap = new Map<string, SigInfo>();
  let trunc = 0;
  for (const t of targets) {
    const got = await allSigsMulti(t, nodeStats);
    if (got.truncated) trunc++;
    for (const s of got.sigs)
      if (!s.err && !sigMap.has(s.signature)) sigMap.set(s.signature, s);
  }
  const sigs = [...sigMap.values()];
  const stats: ScanStats = { atas: mine.size, sigs: sigs.length, ok: 0, fail: 0, trunc, gone: 0 };
  const ins: Flow[] = [], outs: OutFlow[] = [], solOuts: SolOut[] = [];
  const useTx = (tx: any, sig: SigInfo) => {
    let t = deltaTransfers(tx, mine, owner);
    if (!t.ins.length && !t.outs.length) t = walkTransfers(tx, mine);
    const bt = sig.blockTime || (tx && tx.blockTime) || 0;
    for (const x of t.ins) ins.push({ ...x, time: bt, sig: sig.signature });
    for (const x of t.outs) outs.push({ ...x, time: bt, sig: sig.signature });
    // sol outflows — revshare payouts r plain SOL transfers, invisible 2 token deltas.
    // dest = biggest lamport gainer; amount = wat dey got (excludes da fee).
    const keys: string[] = (((tx.transaction || {}).message || {}).accountKeys || [])
      .map((k: any) => (typeof k === "string" ? k : k && k.pubkey));
    const iOwn = keys.indexOf(owner);
    const preB = (tx.meta && tx.meta.preBalances) || [], postB = (tx.meta && tx.meta.postBalances) || [];
    if (iOwn >= 0 && preB.length && (postB[iOwn] ?? 0) < (preB[iOwn] ?? 0)) {
      let best = -1, gain = 0;
      keys.forEach((_, i) => { const g = (postB[i] ?? 0) - (preB[i] ?? 0); if (i !== iOwn && g > gain) { gain = g; best = i; } });
      if (best >= 0 && gain >= 1_000_000) // ≥0.001 sol — ignores rent dust
        solOuts.push({ dest: keys[best], lamports: BigInt(gain), time: bt, sig: sig.signature });
    }
  };
  let queue = sigs;
  for (let pass = 0; pass < 3 && queue.length; pass++) {
    const CONC = pass > 0 ? 2 : FAST() ? 8 : 4;
    const WAIT = pass > 0 ? 600 : FAST() ? 60 : 180;
    const failed: SigInfo[] = [];
    for (let i = 0; i < queue.length; i += CONC) {
      const chunk = queue.slice(i, i + CONC);
      const txs = await Promise.all(chunk.map((s) => getTxMulti(s.signature)));
      txs.forEach((tx, j) => {
        if (tx === undefined) { failed.push(chunk[j]); return; }
        if (tx === null) { stats.gone++; return; } // evry node says pruned — count it, dont fake ok
        stats.ok++;
        useTx(tx, chunk[j]);
      });
      await sleep(WAIT);
    }
    queue = failed;
    if (queue.length) await sleep(1500); // let da rate limiter forgive us b4 da next pass
  }
  stats.fail += queue.length;
  return { ins, outs, solOuts, stats };
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
  for (const w of [DEV_WALLET, NEW_DEV_WALLET, TREASURY]) {
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
// paid = SOL lamports received from da revshare wallet (payouts r sol, not $spurdo)
// cohorts = locked amounts keyed by da month (YYYY-MM) dey become payout-eligible:
//   swept in month M → earns thru M+1 → paid on da 1st of M+2 (matches round 1
//   on-chain: may-swept wallets got da jul 1 payout, jun-swept did not).
// paidByMonth = actual sol payouts keyed by da month (YYYY-MM) of da transfer.
export type ContribRow = {
  wallet: string; locked: bigint; pending: bigint; deposited: bigint; returned: bigint;
  /** vested tranches claimed back 2 treasury — no longer locked, no longer earning */
  unlocked: bigint;
  n: number; first: number; last: number; paid: bigint; pct: number;
  cohorts: Record<string, bigint>;
  paidByMonth: Record<string, bigint>;
  /** per-wallet on-chain evidence — evry tx behind da balance, newest first.
   *  amount iz $spurdo raw units for deposit/return, LAMPORTS for payout. */
  txs: ContribTx[];
  /** "dev" = custodian row. excluded from `pool` (holder ledger / vault
   *  check) n pct stays 0, but da RENDER layer pays itz own genuine stakes
   *  evry cycle: eligOf() in revshare.html = r1 cohorts (≤ DEV_R1_YM,
   *  chain-derived 7,365,272) + DEV_EXTRA_STAKES (jul-31 lock own portion,
   *  ism-attested — never passed thru treasury so unscannable). deposits
   *  after round 1 r custodial n never earn. policy: HANDOFF item 1. */
  role?: "dev" | "dev2"; // dev2 = da NEW dev wallet's row: receives da dev
  // share from DEV_HANDOVER (sep 2026) onward; stakes/history stay on "dev"
};

export type ContribTx = {
  t: number;
  kind: "deposit" | "return" | "payout" | "alloc" | "unlock"; // alloc = ansem leg · unlock = vested tranche back 2 treasury
  amount: bigint;
  sig: string;
  /** deposits only: da payout month dis money earns from (via da sweep dat locked it) */
  ym?: string;
};

/** YYYY-MM of a unix-seconds timestamp (utc). */
function ymOf(tSec: number): string {
  return new Date(tSec * 1000).toISOString().slice(0, 7);
}
/** YYYY-MM shifted by n months. */
export function ymAdd(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
/**
 * Da payout month a sweep at time t qualifies for.
 *
 * Rule: money earns da first calendar month itz locked for FROM DA START,
 * n gets paid on da 1st after dat month ends. A sweep on da 1st catches da
 * whole month; a sweep mid-month misses it n waits 4 da next one.
 *
 * Matches evry payout on chain:
 *   may 11 sweep → first whole month june → paid jul 1  ✓ (round 1 basis wuz
 *                  exactly da may-11 sweep amount — 7yDM's 18,048,520 iz da
 *                  sum of its deposits thru may 10 to da lamport)
 *   jun 21 sweep → first whole month july → paid aug 1  ✓ (67oa n 4JLS got
 *                  nothing on jul 1 despite may deposits — dey swept jun 21)
 *   jul 9 / jul 31 sweeps → first whole month august → paid sep 1
 *   aug 1 sweep  → locked from da 1st, so august counts → paid sep 1
 */
function eligibleYm(tSec: number): string {
  const d = new Date(tSec * 1000);
  const sweepYm = ymOf(tSec);
  // swept on da 1st (utc) → dat month iz fully locked → paid da 1st after it.
  // otherwise da next full month iz da earner → paid da month after dat.
  return d.getUTCDate() === 1 ? ymAdd(sweepYm, 1) : ymAdd(sweepYm, 2);
}
export type RevshareData = {
  savedAt: number;
  rpcConfigured: boolean;
  decimals: number;
  supplyUi: number | null;
  revSolLamports: bigint; // current sol in da revshare wallet — da next-payout pot
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
  const dev = await scanWallet(DEV_WALLET, nodeStats, undefined, true); // inflow discovery only needs da atas
  // da NEW dev wallet receives sweeps from aug 2026 on — walk itz inflows
  // too, or treasury accts rotated in da new era can never be rediscovered
  const dev2scan = await scanWallet(NEW_DEV_WALLET, nodeStats, undefined, true);
  const candAccts = new Map<string, { srcOwner?: string; amount: bigint }>();
  for (const i of [...dev.ins, ...dev2scan.ins]) {
    if (!i.srcAddr) continue;
    const c = candAccts.get(i.srcAddr) || { srcOwner: i.srcOwner, amount: 0n };
    c.amount += i.amount;
    candAccts.set(i.srcAddr, c);
  }
  const discoveredAccts: string[] = [];
  const unknown = [...candAccts.entries()].filter(([, c]) => c.srcOwner !== TREASURY && c.srcOwner !== REVSHARE_WALLET);
  const closedMap: Record<string, boolean> = {};
  // getMultipleAccounts caps at 100 accts per call — chunk, dont truncate. a dropped
  // chunk = old treasury accts never discovered = contributors silently missing, so
  // count wat we couldnt check n surface it in da diag.
  let closedFail = 0;
  for (let i = 0; i < unknown.length; i += 100) {
    const batch = unknown.slice(i, i + 100);
    let r: any = null;
    for (let attempt = 0; attempt < 2 && r === null; attempt++) {
      r = await rpcCall("getMultipleAccounts", [batch.map(([a]) => a), { encoding: "base64" }]).catch(() => null);
      if (r === null && attempt === 0) await sleep(600);
    }
    if (!r || !r.value) { closedFail += batch.length; continue; }
    r.value.forEach((acc: any, j: number) => { closedMap[batch[j][0]] = acc === null; });
  }
  for (const [addr, c] of candAccts) {
    if (c.srcOwner === TREASURY) { discoveredAccts.push(addr); continue; }
    // closed + sweep-sized ONLY when da owner iz UNKNOWN (pruned metadata).
    // a KNOWN non-treasury owner = somebody else's token account — adopting
    // it makes der whole trading history look like treasury deposits.
    // burned us aug 2026: 7yDM closed itz trading acct (BbY4y64j…) → da
    // closed+sized branch adopted it → 873 amm fee drips became phantom
    // "contributors" (8eixuojQ 76.9m!) n fee sweeps 2 dev became fake
    // sweep events dat re-timed real holders' cohorts.
    if (!c.srcOwner && closedMap[addr] && c.amount >= 10n ** BigInt(decimals) * 1000n) {
      discoveredAccts.push(addr);
    }
  }

  // discovered accts ride along in da treasury scan (extraAccts → mine → their full
  // sig history walked, deposits attributed 2 da payer, sweeps 2 dev detected). we
  // deliberately do NOT scan da discovered OWNER wallets: da closed+sweep-sized
  // heuristic can catch a real holder who sent 2 dev (7yDMgrdZ haz 6.4m of dev
  // inflows on-chain today) — scanning their wallet as if it were a treasury
  // scrambles accounting (their trades become deposits/returns), n marking dem
  // internal vaporizes evry deposit dey ever made. burned us: da live table wuz
  // missing ~100m of locked attribution.
  const tre = await scanWallet(TREASURY, nodeStats, discoveredAccts);
  const rev = await scanWallet(REVSHARE_WALLET, nodeStats);
  const revSolLamports = await rpcCall("getBalance", [REVSHARE_WALLET])
    .then((r: any) => BigInt(r?.value ?? 0)).catch(() => 0n);

  // walkTransfers (parsed-instruction fallback) only knows da destination token
  // ACCT, not its owner — n sweep/return/payout detection all key off destOwner.
  // batch-resolve missing owners; closed accts stay unknown n get counted.
  let unresolvedOuts = 0;
  {
    const need = [...new Set([...tre.outs, ...rev.outs]
      .filter((o) => !o.destOwner && o.dest && o.dest !== "balance-delta")
      .map((o) => o.dest))];
    const ownerOf = new Map<string, string>();
    for (let i = 0; i < need.length; i += 100) {
      const batch = need.slice(i, i + 100);
      const r = await rpcCall("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]).catch(() => null);
      if (!r || !r.value) continue;
      r.value.forEach((acc: any, j: number) => {
        const ow = acc?.data?.parsed?.info?.owner;
        if (ow) ownerOf.set(batch[j], ow);
      });
    }
    for (const o of [...tre.outs, ...rev.outs]) {
      if (!o.destOwner && ownerOf.has(o.dest)) o.destOwner = ownerOf.get(o.dest);
      if (!o.destOwner) unresolvedOuts++;
    }
  }
  if (tre.stats.fail > 0 && tre.ins.length === 0) throw new Error(`rpc dropped ${tre.stats.fail} of ${tre.stats.sigs} treasury txs`);

  // payouts per wallet — SOL lamports out of da revshare wallet.
  // exchange-deposit dests (changenow etc) map back 2 da locker via PAYOUT_PROXIES.
  const paid = new Map<string, bigint>();
  const paidByMonth = new Map<string, Record<string, bigint>>();
  for (const o of rev.solOuts) {
    const w = PAYOUT_PROXIES[o.dest] || o.dest;
    paid.set(w, (paid.get(w) || 0n) + o.lamports);
    const ym = ymOf(o.time || 0);
    const rec = paidByMonth.get(w) || {};
    rec[ym] = (rec[ym] || 0n) + o.lamports;
    paidByMonth.set(w, rec);
  }

  // event timeline: deposit→pending, sweep→locked, returns drain pending den locked
  const internal = new Set(INTERNAL_WALLETS);
  type Ev = { t: number; ord: number; type: "dep" | "sweep" | "ret" | "vest"; w?: string; amt?: bigint; vestIdx?: number };
  const events: Ev[] = [];
  for (const d of tre.ins) {
    if (d.owner === "?") continue;
    // dev's own deposits DO flow thru da agg so its history renders (it
    // really contributed 7.37m 2 pool 1 n got paid 4 it jul 1) — da dev
    // row stays out of pool/share% below, but da render pays itz own
    // genuine stakes evry cycle (eligOf + DEV_EXTRA_STAKES in
    // revshare.html). other internal wallets stay out entirely.
    if (internal.has(d.owner) && d.owner !== DEV_WALLET) continue;
    // self-owned source acct = streamflow escrow (authority == own address).
    // dats lock proceeds flowing back in2 da treasury — dev-side money, not
    // a holder deposit. burned us: da jun-29 lock's escrow showed up as a
    // "contributor" wit 833k when dev claimed vested tokens.
    if (d.srcAddr && d.owner === d.srcAddr) continue;
    events.push({ t: d.time || 0, ord: 0, type: "dep", w: d.owner, amt: d.amount });
  }
  let sent2dev = 0n;
  for (const o of tre.outs) {
    if (o.destOwner === DEV_WALLET || o.destOwner === NEW_DEV_WALLET) { sent2dev += o.amount; events.push({ t: o.time || 0, ord: 1, type: "sweep" }); }
    else if (o.destOwner && !internal.has(o.destOwner)) events.push({ t: o.time || 0, ord: 2, type: "ret", w: o.destOwner, amt: o.amount });
  }
  // vest events splice in2 da timeline at der real claim time — a return
  // dat happens AFTER a claim must replay after da drain, or a fully-exited
  // wallet keeps phantom locked basis (da drain would apply 2 wat's left
  // instead of wat wuz locked at claim time)
  for (let i = 0; i < VESTED_UNLOCKS.length; i++) {
    events.push({ t: VESTED_UNLOCKS[i].t, ord: 3, type: "vest", vestIdx: i });
  }
  events.sort((a, b) => a.t - b.t || a.ord - b.ord);

  type Agg = {
    locked: bigint; pending: bigint; deposited: bigint; returned: bigint;
    n: number; first: number; last: number;
    cohorts: Record<string, bigint>; // eligible-from month → locked amount
  };
  const agg = new Map<string, Agg>();
  const get = (w: string): Agg => {
    let a = agg.get(w);
    if (!a) { a = { locked: 0n, pending: 0n, deposited: 0n, returned: 0n, n: 0, first: 0, last: 0, cohorts: {} }; agg.set(w, a); }
    return a;
  };
  const unlockedBy = new Map<string, bigint>();
  const vestTakes: { w: string; take: bigint; t: number; sig: string }[] = [];
  for (const e of events) {
    if (e.type === "dep") {
      const a = get(e.w!);
      a.pending += e.amt!; a.deposited += e.amt!; a.n++;
      if (e.t && (!a.first || e.t < a.first)) a.first = e.t;
      if (e.t > a.last) a.last = e.t;
    } else if (e.type === "vest") {
      // claimed tranche drains dat cohort AT CLAIM TIME — later returns
      // replay against da post-drain balance (true chain order). wit `legs`
      // only dose wallets drain (fraction of der leg, clamped) — used when
      // a cohort ym spans multiple locks n only one lock vested.
      const u = VESTED_UNLOCKS[e.vestIdx!];
      const drain = (w: string, a: Agg, basis: bigint) => {
        const c = a.cohorts[u.ym] || 0n;
        let take = (basis * u.num) / u.den;
        if (take > c) take = c;
        if (take <= 0n) return;
        a.cohorts[u.ym] = c - take;
        if (a.cohorts[u.ym] === 0n) delete a.cohorts[u.ym];
        a.locked -= take;
        unlockedBy.set(w, (unlockedBy.get(w) || 0n) + take);
        vestTakes.push({ w, take, t: u.t, sig: u.sig });
      };
      if (u.legs) {
        for (const [w, leg] of Object.entries(u.legs)) {
          const a = agg.get(w);
          if (a) drain(w, a, leg);
        }
      } else {
        for (const [w, a] of agg.entries()) drain(w, a, a.cohorts[u.ym] || 0n);
      }
    } else if (e.type === "sweep") {
      // pending → locked, tagged wit da payout month dis sweep qualifies for.
      // a wallet locked in july earns thru august n gets paid sep 1 — lumping
      // cohorts together diluted existing lockers da moment new money locked.
      const ym = eligibleYm(e.t);
      for (const a of agg.values()) {
        if (a.pending > 0n) {
          a.cohorts[ym] = (a.cohorts[ym] || 0n) + a.pending;
          a.locked += a.pending;
          a.pending = 0n;
        }
      }
    } else {
      const a = get(e.w!);
      a.returned += e.amt!;
      let r = e.amt!;
      const fromPending = r < a.pending ? r : a.pending;
      a.pending -= fromPending; r -= fromPending;
      // drain locked newest-cohort-first (returns r usually recent money)
      if (r > 0n) {
        for (const ym of Object.keys(a.cohorts).sort().reverse()) {
          if (r <= 0n) break;
          const take = a.cohorts[ym] < r ? a.cohorts[ym] : r;
          a.cohorts[ym] -= take;
          if (a.cohorts[ym] === 0n) delete a.cohorts[ym];
          r -= take;
        }
      }
      const drained = e.amt! - fromPending;
      a.locked = a.locked > drained ? a.locked - drained : 0n;
    }
  }
  // per-wallet tx ledger — same filters as da accounting (internal + escrow
  // excluded), so da modal always reconciles wit da row it supports.
  const sweepTimes = tre.outs
    .filter((o) => o.destOwner === DEV_WALLET || o.destOwner === NEW_DEV_WALLET)
    .map((o) => o.time || 0)
    .sort((a, b) => a - b);
  const cohortOfDep = (t: number): string | undefined => {
    const sw = sweepTimes.find((x) => x >= t);
    return sw !== undefined ? eligibleYm(sw) : undefined; // undefined = still pending
  };
  const txsByWallet = new Map<string, ContribTx[]>();
  const pushTx = (w: string, tx: ContribTx) => {
    const l = txsByWallet.get(w) || [];
    l.push(tx);
    txsByWallet.set(w, l);
  };
  for (const d of tre.ins) {
    if (d.owner === "?") continue;
    if (internal.has(d.owner) && d.owner !== DEV_WALLET) continue;
    if (d.srcAddr && d.owner === d.srcAddr) continue; // streamflow escrow
    pushTx(d.owner, { t: d.time || 0, kind: "deposit", amount: d.amount, sig: d.sig, ym: cohortOfDep(d.time || 0) });
  }
  for (const o of tre.outs) {
    if (!o.destOwner || o.destOwner === DEV_WALLET || internal.has(o.destOwner)) continue;
    pushTx(o.destOwner, { t: o.time || 0, kind: "return", amount: o.amount, sig: o.sig });
  }
  for (const o of rev.solOuts) {
    const w = PAYOUT_PROXIES[o.dest] || o.dest;
    pushTx(w, { t: o.time, kind: "payout", amount: o.lamports, sig: o.sig });
  }
  // ansem allocation: strip each leg from itz aug cohort n show da outflow
  // in dat wallet's ledger. clamped 2 wat da cohort actually holds so
  // synthetic (smaller) chains still replay cleanly.
  for (const [w, amt] of Object.entries(ANSEM_ALLOC_LEGS)) {
    const a = agg.get(w);
    if (!a) continue;
    const have = a.cohorts[ANSEM_ALLOC_YM] || 0n;
    const ded = have < amt ? have : amt;
    if (ded <= 0n) continue;
    a.cohorts[ANSEM_ALLOC_YM] = have - ded;
    if (a.cohorts[ANSEM_ALLOC_YM] === 0n) delete a.cohorts[ANSEM_ALLOC_YM];
    a.locked -= ded;
    pushTx(w, { t: ANSEM_ALLOC_T, kind: "alloc", amount: ded, sig: ANSEM_ALLOC_SIG });
  }
  // vest drains already replayed inside da event timeline (true chain
  // order vs returns) — here we just write der ledger entries
  for (const v of vestTakes) pushTx(v.w, { t: v.t, kind: "unlock", amount: v.take, sig: v.sig });
  for (const l of txsByWallet.values()) l.sort((a, b) => b.t - a.t);

  let pool = 0n, pendingTotal = 0n;
  for (const [w, a] of agg.entries()) {
    if (w === DEV_WALLET || w === NEW_DEV_WALLET) continue; // custodians — never in da holder pool
    pool += a.locked; pendingTotal += a.pending;
  }
  // da new dev wallet gets a row even wit zero deposits — it receives da
  // dev share from da handover cycle on, n dat should be VISIBLE
  get(NEW_DEV_WALLET);
  const devRole = (w: string) =>
    w === DEV_WALLET ? ({ role: "dev" as const }) : w === NEW_DEV_WALLET ? ({ role: "dev2" as const }) : {};
  const contribRows: ContribRow[] = [...agg.entries()]
    // evry wallet dat ever sent 2 da treasury gets a row — incl fully-refunded ones
    // (locked 0 · pending 0 · returned = all of it). da returned column iz da proof
    // dey got it back. share% iz locked-only so a refunded wallet reads 0% = no payout.
    .filter(([w, a]) => a.deposited > 0n || w === NEW_DEV_WALLET)
    .map(([w, a]) => ({
      wallet: w, locked: a.locked, pending: a.pending, deposited: a.deposited, returned: a.returned,
      unlocked: unlockedBy.get(w) || 0n,
      n: a.n, first: a.first, last: a.last, paid: paid.get(w) || 0n,
      cohorts: a.cohorts, paidByMonth: paidByMonth.get(w) || {},
      txs: (txsByWallet.get(w) || []).slice(0, 60), // newest 60 — payload bound
      pct: w === DEV_WALLET || w === NEW_DEV_WALLET || pool <= 0n ? 0 : Number((a.locked * 10000n) / pool) / 100,
      ...devRole(w),
    }))
    .sort((x, y) => {
      // custodian rows pinned last: old dev, den da new dev
      const rank = (r: { role?: string }) => (r.role === "dev" ? 1 : r.role === "dev2" ? 2 : 0);
      if (rank(x) !== rank(y)) return rank(x) - rank(y);
      return y.locked > x.locked ? 1 : y.locked < x.locked ? -1 : y.pending > x.pending ? 1 : -1;
    });

  const nodeAgg: Record<string, { ok: number; err: number; n: number }> = {};
  for (const s of nodeStats) {
    nodeAgg[s.node] = nodeAgg[s.node] || { ok: 0, err: 0, n: 0 };
    if (s.n < 0) nodeAgg[s.node].err++;
    else { nodeAgg[s.node].ok++; nodeAgg[s.node].n += s.n; }
  }
  const nodeDiag = Object.entries(nodeAgg).map(([k, v]) => k + ":" + (v.err ? `${v.ok}ok/${v.err}err` : `${v.n} sigs`)).join(" ");
  const truncTotal = dev.stats.trunc + tre.stats.trunc + rev.stats.trunc;
  const diagContrib =
    `server \u00b7 treasury: ${tre.stats.atas} acct \u00b7 ${tre.stats.ok}/${tre.stats.sigs} txs` +
    (tre.stats.fail ? ` (${tre.stats.fail} dropped)` : "") +
    ` \u00b7\u00b7 revshare: ${rev.stats.atas} acct \u00b7 ${rev.stats.ok}/${rev.stats.sigs} txs` +
    (rev.stats.fail ? ` (${rev.stats.fail} dropped)` : "") +
    (discoveredAccts.length ? ` \u00b7\u00b7 found ${discoveredAccts.length} old acct` : "") +
    (closedFail ? ` \u00b7\u00b7 WARN ${closedFail} acct unchecked (discovery incomplete)` : "") +
    (truncTotal ? ` \u00b7\u00b7 WARN sig cap hit on ${truncTotal} addr (old history cut)` : "") +
    (tre.stats.gone + rev.stats.gone + dev.stats.gone ? ` \u00b7\u00b7 WARN ${tre.stats.gone + rev.stats.gone + dev.stats.gone} tx pruned on all nodes` : "") +
    (unresolvedOuts ? ` \u00b7\u00b7 WARN ${unresolvedOuts} outs w/ unknown dest owner` : "") +
    ` \u00b7\u00b7 ${nodeDiag} \u00b7\u00b7 ${((Date.now() - t0) / 1000).toFixed(1)}s`;

  return {
    savedAt: Date.now(), rpcConfigured: FAST(), decimals, supplyUi, revSolLamports, locks,
    contribRows, pool, pendingTotal, sent2dev,
    diagLocks: "server \u00b7 sources: " + ldiag.join(" \u00b7 "),
    diagContrib,
  };
}

/* bigint-safe json — same $b convention da page uses */
export const jstr = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? { $b: v.toString() } : v));
export const jparse = (s: string) => JSON.parse(s, (_k, v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v));
