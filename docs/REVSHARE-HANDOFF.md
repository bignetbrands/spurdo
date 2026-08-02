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
   time-based "dev lock"s. its row renders pinned last wit da "dev ·
   custodian" tag, its holding column shows ONLY da own-stakes total
   (7,365,272 + 3,461,005.205545 = 10,826,277.58 — NOT da custodial benis
   it also holds), n it haz NO receipts popup (per ism) — da evidence
   lives in da month-cell tooltips n da devtag tooltip. NOTE: da scan cannot see dev unlocks either (escrow →
   dev never touches treasury), so both stakes r fixed by DATE/amount, not
   live balance — if a dev stake ever leaves streamflow, or dev adds a NEW
   genuine stake, edit `DEV_EXTRA_STAKES`/`DEV_R1_YM` by hand.

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
