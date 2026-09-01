// cohort accounting test — mirrors da real chain sequence. run:
//   npx tsx scripts/cohort-test.mts
// synthetic chain (mocked rpc) replayed thru da REAL engine:
//   A deposits apr → swept may 11  → 2026-07 cohort (paid jul 1 ✓ matches chain)
//   B deposits may → swept jun 21  → 2026-08 cohort (got NO jul payout ✓)
//   C deposits jun → swept jul 9   → 2026-09 cohort
//   C deposits jul → swept AUG 1   → 2026-09 cohort (swept on da 1st → aug iz
//                                    fully locked → paid sep 1, da real case)
//   A gets a jul 1 SOL payout      → paidByMonth["2026-07"]
//   B returns part of locked       → drains newest cohort first
//   dev haz r1 + custodial deposits; ansem alloc strips dev's aug custodial;
//   da aug-2 vest tranche (1/24) drains jul cohorts in-timeline;
//   D fully exits AFTER da claim   → regression guard 4 timeline ordering
const MINT = "991L48va9rMiysu3fCpeg5p9bN4NLzhujojzmFtkgacE";
const TREASURY = "ByXqkMujMBCgCbWsjJ1EreVKfT3PTZYy9MMxNRu58Smd";
const DEV = "G9ia5A2UyzDcstjpaXxRPwZL6U3Hwi15j6eSoyWqDexV";
const REV = "Gf9QUuqfEX8K3WFgfF4J1SXtM2Za1LZwitByNFqgtgtQ";
const A = "AAAAwa11et11111111111111111111111111111111a";
const B = "BBBBwa11et11111111111111111111111111111111b";
const C = "CCCCwa11et11111111111111111111111111111111c";
const TRE_ATA = "treATA1111111111111111111111111111111111111";
const DEV_ATA = "devATA1111111111111111111111111111111111111";

const TS = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const M = (n: number) => String(Math.round(n * 1_000_000));

type TokTx = { time: number; srcAcct: string; srcOwner: string; dstAcct: string; dstOwner: string; amt: string };
const tokTxs: Record<string, TokTx> = {
  depA:   { time: TS("2026-04-25T12:00:00Z"), srcAcct: "aATA", srcOwner: A, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(10) },
  sweep1: { time: TS("2026-05-11T12:00:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: DEV_ATA, dstOwner: DEV, amt: M(10) },
  depB:   { time: TS("2026-05-17T12:00:00Z"), srcAcct: "bATA", srcOwner: B, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(6) },
  sweep2: { time: TS("2026-06-21T12:00:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: DEV_ATA, dstOwner: DEV, amt: M(6) },
  depC1:  { time: TS("2026-06-30T12:00:00Z"), srcAcct: "cATA", srcOwner: C, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(3) },
  sweep3: { time: TS("2026-07-09T12:00:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: DEV_ATA, dstOwner: DEV, amt: M(3) },
  depC2:  { time: TS("2026-07-28T12:00:00Z"), srcAcct: "cATA", srcOwner: C, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(20) },
  sweep4: { time: TS("2026-08-01T12:18:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: DEV_ATA, dstOwner: DEV, amt: M(20) },
  // unlock-return 2 B AFTER sweeps: drains locked (newest cohort first)
  retB:   { time: TS("2026-07-30T12:00:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: "bATA", dstOwner: B, amt: M(2) },
};
// B also deposits again jul 29 so B haz two cohorts (aug from jun sweep, sep from jul sweep)
tokTxs.depB2 = { time: TS("2026-07-29T12:00:00Z"), srcAcct: "bATA", srcOwner: B, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(4) };
// dev's own deposit b4 da may sweep (mirrors da real 7.37m in pool 1)
tokTxs.depDev = { time: TS("2026-04-28T12:00:00Z"), srcAcct: DEV_ATA, srcOwner: DEV, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(2) };
// dev CUSTODIAL deposit after round 1 (mirrors da real may 27/30 13.2m) —
// swept jun 21 → 2026-08 cohort on da row, but per policy it never earns 4 dev
tokTxs.depDev2 = { time: TS("2026-05-20T12:00:00Z"), srcAcct: DEV_ATA, srcOwner: DEV, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(5) };
// streamflow escrow claim flowing back in2 treasury: source acct owns ITSELF
const ESCROW = "escrowSe1fOwned111111111111111111111111111x";
tokTxs.depEscrow = { time: TS("2026-07-29T13:00:00Z"), srcAcct: ESCROW, srcOwner: ESCROW, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: M(1) };
// D fully exits AFTER da aug-2 vest claim — regression guard 4 timeline
// ordering: da drain must replay at claim time, den da return drains da
// REST. (da old post-pass code left D wit phantom locked 9,584 here.)
const D = "DDDDwa11et11111111111111111111111111111111d";
tokTxs.depD = { time: TS("2026-04-26T12:00:00Z"), srcAcct: "dATA", srcOwner: D, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: "240000" };
tokTxs.retD = { time: TS("2026-08-03T12:00:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: "dATA", dstOwner: D, amt: "230000" };
// NEW dev wallet era (aug 2026): treasury → new-dev iz a SWEEP, payouts 2
// new-dev credit da (old-)dev row, n new-dev never gets itz own row.
// E deposits aug 10 → swept 2 NEW dev aug 20 (mid-month) → 2026-10 cohort.
const NEWDEV = "6y5aBnJb9LshwnwCV1zkmUCU6f7TxGY71FLT22CJJf6Y";
const NEWDEV_ATA = "newdevATA111111111111111111111111111111111x";
const E = "EEEEwa11et11111111111111111111111111111111e";
tokTxs.depE = { time: TS("2026-08-10T12:00:00Z"), srcAcct: "eATA", srcOwner: E, dstAcct: TRE_ATA, dstOwner: TREASURY, amt: "100000" };
tokTxs.sweep5 = { time: TS("2026-08-20T12:00:00Z"), srcAcct: TRE_ATA, srcOwner: TREASURY, dstAcct: NEWDEV_ATA, dstOwner: NEWDEV, amt: "100000" };

// SOL payout jul 1 → A only (mirrors round 1: only da may-swept cohort got paid)
const solTxs = [
  { time: TS("2026-07-01T12:00:00Z"), dest: A, lamports: 5_000_000_000 },
  { time: TS("2026-07-01T12:05:00Z"), dest: DEV, lamports: 1_000_000_000 }, // round-1 dev payout
  { time: TS("2026-08-02T19:00:00Z"), dest: NEWDEV, lamports: 500_000_000 }, // aug payout 2 da NEW dev wallet
];

function mkTok(t: TokTx) {
  return {
    blockTime: t.time,
    transaction: { message: { accountKeys: [t.srcAcct, t.dstAcct] }, signatures: ["x"] },
    meta: {
      preTokenBalances: [
        { accountIndex: 0, mint: MINT, owner: t.srcOwner, uiTokenAmount: { amount: t.amt } },
        { accountIndex: 1, mint: MINT, owner: t.dstOwner, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: MINT, owner: t.srcOwner, uiTokenAmount: { amount: "0" } },
        { accountIndex: 1, mint: MINT, owner: t.dstOwner, uiTokenAmount: { amount: t.amt } },
      ],
    },
  };
}
function mkSol(x: { time: number; dest: string; lamports: number }) {
  return {
    blockTime: x.time,
    transaction: { message: { accountKeys: [REV, x.dest] }, signatures: ["s"] },
    meta: { preTokenBalances: [], postTokenBalances: [], preBalances: [x.lamports + 5000, 0], postBalances: [0, x.lamports] },
  };
}

const treSigs = Object.entries(tokTxs).filter(([, t]) => t.srcAcct === TRE_ATA || t.dstAcct === TRE_ATA)
  .map(([id, t]) => ({ signature: "tok_" + id, blockTime: t.time, err: null }));
const devSigs = Object.entries(tokTxs).filter(([, t]) => t.dstAcct === DEV_ATA)
  .map(([id, t]) => ({ signature: "tok_" + id, blockTime: t.time, err: null }));
const revSigs = solTxs.map((x, i) => ({ signature: "sol_" + i, blockTime: x.time, err: null }));

globalThis.fetch = (async (url: any, init: any) => {
  const ok = (result: any) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  if (String(url).includes("streamflow")) return new Response(JSON.stringify([]), { status: 200 });
  const { method, params } = JSON.parse(init.body);
  switch (method) {
    case "getTokenSupply": return ok({ value: { decimals: 6, uiAmountString: "1000000000", uiAmount: 1e9 } });
    case "getProgramAccounts": return ok([]);
    case "getBalance": return ok({ value: 96_000_000_000 });
    case "getTokenAccountsByOwner": {
      const o = params[0];
      if (o === DEV) return ok({ value: [{ pubkey: DEV_ATA }] });
      if (o === TREASURY) return ok({ value: [{ pubkey: TRE_ATA }] });
      return ok({ value: [] });
    }
    case "getSignaturesForAddress": {
      const a = params[0];
      if (a === TRE_ATA || a === TREASURY) return ok(treSigs);
      if (a === DEV_ATA) return ok(devSigs);
      if (a === REV) return ok(revSigs);
      return ok([]);
    }
    case "getTransaction": {
      const sig = params[0];
      if (sig.startsWith("tok_")) return ok(mkTok(tokTxs[sig.slice(4)]));
      if (sig.startsWith("sol_")) return ok(mkSol(solTxs[Number(sig.slice(4))]));
      return ok(null);
    }
    case "getMultipleAccounts": return ok({ value: (params[0] as string[]).map(() => ({ data: ["", "base64"] })) });
    default: return ok(null);
  }
}) as any;

const { runFullScan } = await import("../src/lib/revshare-scan.ts");
const d = await runFullScan();
const Mn = (n: bigint | undefined) => Number(n || 0n) / 1e6;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, det?: unknown) => {
  if (c) { pass++; console.log("ok  ", l); }
  else { fail++; console.log("FAIL", l, JSON.stringify(det, (_k, v) => (typeof v === "bigint" ? Mn(v) : v))); }
};
const row = (w: string) => d.contribRows.find((r) => r.wallet === w)!;

// da vested-unlock tranche (1/24) drains jul cohorts: A 10m → 9,583,334
check("A jul cohort = 9,583,334 after 1/24 vest (unlock 416,666)", row(A).cohorts["2026-07"] === 9_583_334n && Object.keys(row(A).cohorts).length === 1, row(A).cohorts);
check("A unlocked = 416,666 wit da real tranche sig", row(A).unlocked === 416_666n && row(A).txs.some((x: any) => x.kind === "unlock" && x.amount === 416_666n && x.sig.startsWith("4vtn8P8R")), { u: row(A).unlocked });
check("A paidByMonth: 5 SOL in 2026-07", Number(row(A).paidByMonth["2026-07"] || 0n) / 1e9 === 5, row(A).paidByMonth);
// B: 6m jun-swept → 2026-08. jul 29 deposit of 4m iz still PENDING at da jul 30
// return, so da 2m return refunds pending first (correct — dats a refund, not an
// unlock) leaving 2m pending, which sweep4 den locks in2 2026-09.
check("B cohorts: aug=6m (untouched), sep=2m (4m dep - 2m refund)", Mn(row(B).cohorts["2026-08"]) === 6 && Mn(row(B).cohorts["2026-09"]) === 2, row(B).cohorts);
check("B returned=2m locked=8m", Mn(row(B).returned) === 2 && Mn(row(B).locked) === 8, { r: row(B).returned, l: row(B).locked });
check("C cohorts: sep=23m (jul-9 3m + jul-31 20m), no aug", Mn(row(C).cohorts["2026-09"]) === 23 && !row(C).cohorts["2026-08"], row(C).cohorts);
check("C got no payouts", Object.keys(row(C).paidByMonth).length === 0);
const sums = d.contribRows.every((r) => Object.values(r.cohorts).reduce((a, b) => a + b, 0n) === r.locked);
check("Σcohorts === locked for every wallet", sums);
// eligibility math da page uses: cohorts ≤ ym
const elig = (r: any, ym: string) => Object.entries(r.cohorts).filter(([k]) => k <= ym).reduce((a, [, v]) => a + (v as bigint), 0n);
// holder-only pools (engine-level fact: `pool`/vault check stay holder-only)
const holders = d.contribRows.filter((r) => r.role !== "dev");
const augPool = holders.reduce((a, r) => a + elig(r, "2026-08"), 0n);
const sepPool = holders.reduce((a, r) => a + elig(r, "2026-09"), 0n);
check("aug-eligible pool = 15,583,334 (A 9,583,334 + B 6m)", augPool === 15_583_334n, augPool);
check("sep-eligible pool = 40,583,334 (jul locks join, minus vested tranche)", sepPool === 40_583_334n, sepPool);
check("C aug-eligible = 0 (no dilution of aug payout)", Mn(elig(row(C), "2026-08")) === 0);

check("escrow (self-owned src) never becomes a holder row", !d.contribRows.find((r) => r.wallet === ESCROW), d.contribRows.map((r) => r.wallet.slice(0, 8)));

// ── tx ledger (holder modal evidence) ──
const at = row(A).txs;
check("A ledger: unlock + payout + deposit, newest first", at.length === 3 && at[0].kind === "unlock" && at[1].kind === "payout" && at[2].kind === "deposit", at.map((x: any) => x.kind));
check("A deposit tagged ym 2026-07 wit sig", at[2].ym === "2026-07" && at[2].sig === "tok_depA", at[2]);
check("A payout iz lamports (5 SOL)", Number(at[1].amount) / 1e9 === 5 && at[1].sig === "sol_0", at[1]);
const bt = row(B).txs;
check("B ledger: 2 deposits + 1 return", bt.filter(x => x.kind === "deposit").length === 2 && bt.filter(x => x.kind === "return").length === 1, bt.map(x => x.kind));
check("no wallet's ledger contains da escrow tx", d.contribRows.every(r => r.txs.every(x => x.sig !== "tok_depEscrow")));

// ── dev custodian row ──
const dv = d.contribRows.find((r) => r.wallet === DEV);
check("old dev row role=dev, pinned second-last; dev2 row LAST", !!dv && dv.role === "dev" && d.contribRows[d.contribRows.length - 2].wallet === DEV && d.contribRows[d.contribRows.length - 1].wallet === NEWDEV && d.contribRows[d.contribRows.length - 1].role === "dev2", d.contribRows.map(r => r.wallet.slice(0,4)+(r.role?":"+r.role:"")));
// da ansem-alloc DEV leg fires here: dev's 5m custodial aug cohort iz
// stripped (clamped 2 wat da synth cohort holds) n an alloc tx recorded
check("dev cohorts: jul 1,916,667 (2m minus 1/24 vest) — aug stripped by ansem", dv && dv.cohorts["2026-07"] === 1_916_667n && !dv.cohorts["2026-08"] && Number(dv.paidByMonth["2026-07"] || 0n) / 1e9 === 1, dv && { c: dv.cohorts, p: dv.paidByMonth });
check("dev unlocked = 83,333 (r1 stake vests like evryone)", dv && dv.unlocked === 83_333n, dv && dv.unlocked);
check("dev locked = 1,916,667 after alloc + vest (Σcohorts still === locked)", dv && dv.locked === 1_916_667n, dv && dv.locked);
const allocTx = dv && dv.txs.find((x: any) => x.kind === "alloc");
check("dev ledger haz alloc tx: 5m wit da real ansem sig", !!allocTx && Mn(allocTx.amount) === 5 && allocTx.sig.startsWith("2L3kc9pa2mu"), allocTx);
check("dev pct = 0", dv?.pct === 0);
check("pool EXCLUDES dev (40,683,334 holders: post-vest + E 100k)", d.pool === 40_683_334n, d.pool);
// da render rule (eligOf in revshare.html): dev earns ONLY on itz own genuine
// stakes — r1 chain cohorts (≤ DEV_R1_YM) + da attested jul-31 own stake.
// custodial deposits after r1 never earn, holders unchanged.
const DEV_R1_YM = "2026-07";
const DEV_EXTRA_STAKES: Record<string, bigint> = { "2026-09": 3461005205545n };
// handover: dev basis routes 2 da dev2 row from 2026-09 on (mirrors da page)
const DEV_HANDOVER_YM = "2026-09";
const devBasis = (ym: string) => {
  let sum = ym >= DEV_R1_YM ? elig(dv, DEV_R1_YM) : 0n;
  for (const k of Object.keys(DEV_EXTRA_STAKES)) if (k <= ym) sum += DEV_EXTRA_STAKES[k];
  return sum;
};
const eligOf = (r: any, ym: string) => {
  if (r.role === "dev") return ym >= DEV_HANDOVER_YM ? 0n : devBasis(ym);
  if (r.role === "dev2") return ym >= DEV_HANDOVER_YM ? devBasis(ym) : 0n;
  return elig(r, ym);
};
const dv2 = d.contribRows.find((r) => r.role === "dev2")!;
check("dev aug-eligible = 1,916,667 (drained r1 only)", eligOf(dv, "2026-08") === 1_916_667n, eligOf(dv, "2026-08"));
check("OLD dev sep-eligible = 0 (handover)", eligOf(dv, "2026-09") === 0n, eligOf(dv, "2026-09"));
check("dev2 sep-eligible = drained r1 + jul-31 stake (da dev basis moved here)", eligOf(dv2, "2026-09") === 1_916_667n + 3461005205545n, eligOf(dv2, "2026-09"));
check("dev2 aug-eligible = 0 (b4 handover)", eligOf(dv2, "2026-08") === 0n);
check("dev jun-eligible = 0 (nothing b4 r1 paid)", Mn(eligOf(dv, "2026-06")) === 0);
const augPoolR = d.contribRows.reduce((a, r) => a + eligOf(r, "2026-08"), 0n);
const sepPoolR = d.contribRows.reduce((a, r) => a + eligOf(r, "2026-09"), 0n);
check("render aug pool = 17,500,001 (holders 15,583,334 + dev 1,916,667)", augPoolR === 17_500_001n, augPoolR);
check("render sep pool = post-vest holders + drained dev r1 + jul-31 stake", sepPoolR === 42_500_001n + 3461005205545n, sepPoolR);
check("dev ledger has deposit + payout", dv && dv.txs.some(x => x.kind === "deposit") && dv.txs.some(x => x.kind === "payout"), dv?.txs);

// ── post-claim exit: timeline-order regression guard ──
const dr = row(D);
check("D (exited after claim): locked 0, no cohorts — no phantom basis", dr.locked === 0n && Object.keys(dr.cohorts).length === 0, dr.cohorts);
check("D unlocked 10,000 · returned 230,000 (deposited 240,000 fully reconciles)", dr.unlocked === 10_000n && dr.returned === 230_000n && dr.deposited === 240_000n, { u: dr.unlocked, r: dr.returned });
check("D ledger order: return · unlock · deposit (newest first)", dr.txs.map((x: any) => x.kind).join(",") === "return,unlock,deposit", dr.txs.map((x: any) => x.kind));

// ── new dev wallet era ──
check("treasury → NEW dev iz a sweep: E's aug-10 dep → 2026-10 cohort", row(E).cohorts["2026-10"] === 100_000n && row(E).locked === 100_000n, row(E).cohorts);
check("payout 2 NEW dev lands on da dev2 ROW (aug 0.5 SOL, visible)", dv2 && Number(dv2.paidByMonth["2026-08"] || 0n) / 1e9 === 0.5 && !(dv.paidByMonth["2026-08"]), { d2: dv2.paidByMonth, d: dv.paidByMonth });
check("dev2 row: zero deposits, locked 0, pct 0", dv2.deposited === 0n && dv2.locked === 0n && dv2.pct === 0, { dep: dv2.deposited, l: dv2.locked });

// emit payload 4 da render harness
const { jstr } = await import("../src/lib/revshare-scan.ts");
(await import("fs")).writeFileSync("/tmp/synth-payload.json", jstr(d));
console.log("(synth payload written)");
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
