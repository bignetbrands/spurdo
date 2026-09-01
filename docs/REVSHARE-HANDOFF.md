# revshare handoff — for claude code

state as of commit `571cee4` (2026-07-13). read dis first, den `public/revshare.html` and `src/lib/revshare-scan.ts`.

## wat dis iz

`/revshare` page = live proof of da benis lock system:
1. holders send $spurdo → treasury `ByXqkMujMBCgCbWsjJ1EreVKfT3PTZYy9MMxNRu58Smd`
2. at deadline, treasury sweeps all → dev wallet `G9ia5A2UyzDcstjpaXxRPwZL6U3Hwi15j6eSoyWqDexV`
3. dev locks in streamflow (program `strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m`, mint filter @ byte offset 177)
4. treasury → holder transfers = refund (b4 sweep) or unlock-return (after) — both reduce dat wallet's locked amount
5. monthly revshare paid from `Gf9QUuqfEX8K3WFgfF4J1SXtM2Za1LZwitByNFqgtgtQ`

page shows: locks (deposited/unlocked/next-unlock), locked-wallet table (locked · share% · pending · returned · revshare paid), csv export. per-cycle ELIGIBLE share = payout split (see items 1 n 3 below — not raw locked, n dev's basis iz frozen at r1).

## architecture

- **`src/lib/revshare-scan.ts`** — scan engine (server). vanilla, zero new deps:
  - ata derivation: hand-rolled ed25519 on-curve + pda (verified 200/200 vs @solana/web3.js). closed token accts keep sig history at da derived address — dis iz how pre-sweep deposits r recovered.
  - discovery: dev wallet inflows reveal historical treasury accts (closed + sweep-sized filter so dex pools dont leak in).
  - extraction: token-balance deltas primary (owner-matched, catches CPI/router flows), parsed instructions fallback.
  - accounting: event timeline — deposit→pending, sweep(→dev)→locked, returns drain pending den locked. fully-refunded wallets drop.
  - sigs unioned across all rpc nodes w/ per-node stats (public nodes prune history + rate limit; dats why server-side).
- **`src/app/api/revshare-data/route.ts`** — GET, upstash redis cache (key `revshare:data:v1`, 5-day staleness, `?force=1` bypass), scan lock `revshare:scan-lock` (90s, stale-while-scanning). bigints serialized as `{$b:"123"}` — client `jparse` revives.
- **`public/revshare.html`** — self-contained page. source order: localStorage (`spurdo_revshare_v5`, 5-day) → `/api/revshare-data` → full in-browser engine (twin of da server lib, kept as fallback). route: `/revshare` rewrite in `next.config.ts`.

## immediate open items

~~all resolved (aug 2026)~~ — SOLANA_RPC iz set, da cache round-trip bug iz
fixed (upstash automaticDeserialization), scans complete in ~45-60s, all
contributors show, payouts read from chain. see prs #3-#23 4 da full trail.

## payout policy — LOCKED IN (aug 2026, confirmed by ism)

deez r product decisions, not bugs. dont "fix" dem:

1. **dev earns rev share ONLY on itz own genuine stakes** (ism-confirmed
   aug 2026), a fixed two-entry schedule in `eligOf` (revshare.html):
   - **stake 1 — round 1: 7,365,272** (apr 29-30 deposits · may-11 sweep ·
     2026-07 cohort, chain-derived). paid 2.707 sol jul 1; keeps earning
     evry cycle — aug, sep, onward.
   - **stake 2 — jul-31 lock: 3,461,005.205545** (`DEV_EXTRA_STAKES`).
     dev's own portion of da jul-31 lock. it went STRAIGHT from dev's
     wallet in2 streamflow — never thru treasury — so da scan cannot see
     it; da amount iz attested by ism. locked jul 31 → first full month
     aug → first pays sep 1 (cohort 2026-09).
   evryting ELSE dev deposited after round 1 iz custodial — pooled holder
   tokens passing thru 4 locking — n NEVER earns. dev also signs da
   time-based "dev lock"s. its row renders pinned last wit da "old dev ·
   custodian" tag, clickable like any holder (receipts popup restored per
   ism aug 2026), n its holding column shows ONLY da own-stakes total
   (7,365,272 + 3,461,005.205545 = 10,826,277.58 — NOT da custodial benis
   it also holds). NOTE: da scan cannot see dev unlocks either (escrow →
   dev never touches treasury), so both stakes r fixed by DATE/amount, not
   live balance — if a dev stake ever leaves streamflow, or dev adds a NEW
   genuine stake, edit `DEV_EXTRA_STAKES`/`DEV_R1_YM` by hand.
   **DEV WALLET MIGRATION (aug 2026, ism):** G9ia iz da OLD dev wallet —
   it stays da ledger's dev identity (row · stakes · history). da NEW dev
   wallet `6y5aBnJb9LshwnwCV1zkmUCU6f7TxGY71FLT22CJJf6Y` signs future
   locks n receives dev's rev share + unlocks from now on: treasury →
   new-dev = sweep (cohort timing included), SOL payouts 2 it credit da
   dev row via `PAYOUT_PROXIES`, n it iz internal — never itz own
   contributor row. if da NEW wallet ever makes a GENUINE stake of itz
   own, dat needs a fresh ism decision — dont just add it 2
   `DEV_EXTRA_STAKES`.

2. **cohort rule** (reverse-engineered from round 1, verified 2 da lamport):
   money earns da first calendar month itz locked for FROM DA START, paid on
   da 1st after dat month ends. swept mid-month → misses dat month; swept ON
   da 1st → catches it. may-11 sweep → paid jul 1 ✓ (round 1 basis wuz
   exactly 157,702,436 = dat sweep; 7yDM's 18,048,520 = its deposits thru
   may 10). jun-21 swept wallets got nothing jul 1 ✓. aug-1 sweep → paid
   sep 1.

3. **per-cycle share%.** share of payout month E = holder's eligible cohorts
   (swept on/b4 da 1st of E-1) ÷ dat cycle's eligible pool. share of TOTAL
   locked iz meaningless da moment two cohorts exist — it diluted august
   projections when da jul/aug locks landed (pr #18/#22).

4. **payouts r SOL** (kreator fees), read from da rev wallet's outflows,
   grouped by month. exchange-routed payouts (changenow) map back via
   PAYOUT_PROXIES in revshare-scan.ts — one line per proxy, documented wit
   da payout sheet dat proves da recipient.

5. **locks r pooled containers.** no holder owns a lock on-chain; da
   contributor table IZ da ownership ledger, reconstructed from treasury
   deposit history. dats why refunds flow back thru treasury (da returned
   column) n why dis accounting exists at all.

6. **da jun-21 ansem allocation.** treasury sent 15,000,000 2 da ansem
   wallet `GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52` on jun 21 2026
   04:30 utc (sig `2L3kc9pa2m…EryLcjy`, verified on-chain — da 15m still
   sits there). it wuz pooled from three 5m legs (ism-attested): 8FGj…
   (may-28 deposit), 4JLSS… (may-17 deposit), n dev (custodial). dose
   legs got swept in2 2026-08 cohorts B4 da transfer, so BOTH engines
   strip 5m from each leg's aug cohort (`ANSEM_ALLOC_LEGS`, server +
   twin) n record an "alloc" entry in dat wallet's receipts modal —
   tokens dat went 2 ansem earn NOTHING. if another allocation ever
   happens, add itz legs 2 da same constant.

7. **vested unlocks (monthly).** da pool locks vest linearly over 24
   months n da multisig claims each month's tranche back 2 treasury.
   first one: aug 2 2026 17:00 utc, 6,571,458.879 = 157,715,013.1 / 24
   from da jul-3 "Benis Multisig" lock (sig `4vtn8P8R…KFnPyMX`). a
   claimed tranche unlocks evry contributor of dat cohort PRO-RATA
   (floor(cohort/24) each, dust unattributed) — der locked n eligible
   basis drops, so da NEXT cycle's pool shrinks accordingly, n da
   "unlocked" column + an "unlock" receipts-modal entry show it. dis
   keeps da vault check honest (streamflow really lost da tranche).
   engine constant: `VESTED_UNLOCKS` (server + twin) — entries apply IN
   ORDER against da REMAINING cohort, so month 2 = a new entry wit
   den 23n, den 22n, etc (each equals 1/24 of original). da jun-29
   lock's june tranche (833k) iz NOT listed — it wuz re-swept in2 da
   round-two lock so it never stopped being locked. WHEN A TRANCHE GETS
   RE-LOCKED in2 a REVSHARE POOL lock: remove or offset itz entry, or
   holders lose basis on money dat went back in2 streamflow.
   **`legs`**: when a cohort ym spans MULTIPLE locks (2026-09 = jul-9
   lock + round-two lock), a plain pro-rata drain would tax da wrong
   holders — give da entry a `legs` map (wallet → itz swept amount in
   DAT lock, Σ legs = da lock) n only dose wallets drain
   floor(leg×num/den). second entry (aug 9): vc2 tranche 1, 212,500 =
   5,100,000/24, legs FvdP 3m · uGuT 1m · HhGw 1m · AaA4 100k.
   post-claim custody moves seen on-chain (aug 2026): da benis tranche
   went treasury → REV WALLET aug 3 (internal — engine ignores it) n
   ~5.34m of it in2 da new 8F7w TIME-based lock aug 7. neither iz a
   revshare pool, so da drains stand. purpose of 8F7w unconfirmed by
   ism — ask b4 treating it as anything but dev custody. drains splice IN2 da event
   timeline at claim time, so returns after a claim replay against da
   post-drain balance (a fully-exited wallet ends at locked 0, no
   phantom basis). NOTE: da csv's eligible_YM columns r CURRENT basis
   (post-drain) — dey r NOT da as-settled basis of already-paid cycles;
   da paid_YM_sol columns carry da settled truth (jul wuz paid on da
   full 157,702,436 b4 any tranche vested).

## maybe next

- ~~cron route to refresh da redis cache nightly~~ done (pr #16, 04:20 utc)
- reconcile check: sum(locked by holders) vs streamflow deposited minus returns — surface mismatch on da page
- ~~payout helper~~ done-ish: da csv now carries per-month paid_YYYY-MM_sol n eligible_YYYY-MM columns — da "share of <month>" column × pot iz da transfer list

## invariants — dont break

- **spurdish**: page copy follows da calibration in `SPURDO-CHARACTER-BIBLE.md` — flavor heavy on headers/lore, plain english on functional stuff (numbers, dates, deposit/pool/timer words). all lowercase, no periods/commas/!, :DDD emoticons, "spurdo"/"spärde" never take da b-swap.
- **cache versioning**: any change 2 row/payload shape → bump BOTH `spurdo_revshare_vN` (client) and `revshare:data:vN` (redis key) or users render stale wrong shapes 4 days.
- **no silent failures**: evry data path reports into da diag lines. dis rule found evry bug so far — keep it.
- **fetch discipline** (ism requirement): data only fetched on manual refresh or 5-day auto. no per-pageload scans.
- **test pattern**: playwright against `public/` wit mocked rpc routes — see git history commits for scenario shapes (refund/partial-return/pending, closed-acct, shallow-node union).

## gotchas dat already burned us

- `getTokenAccountsByOwner` only shows LIVING accts — closed accts vanish, derive da ata instead.
- plain spl transfers never reference da owner wallet in accountKeys — owner-scan alone misses deposits.
- publicnode = pruned history; api.mainnet-beta + drpc reject browser calls (fine server-side).
- streamflow lock sender iz da DEV wallet not da multisig.
- `.catch(() => null)` on rpc calls = wallets silently missing. count failures, retry pass, surface.
