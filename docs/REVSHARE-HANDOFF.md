# revshare handoff — for claude code

state as of commit `571cee4` (2026-07-13). read dis first, den `public/revshare.html` and `src/lib/revshare-scan.ts`.

## wat dis iz

`/revshare` page = live proof of da benis lock system:
1. holders send $spurdo → treasury `ByXqkMujMBCgCbWsjJ1EreVKfT3PTZYy9MMxNRu58Smd`
2. at deadline, treasury sweeps all → dev wallet `G9ia5A2UyzDcstjpaXxRPwZL6U3Hwi15j6eSoyWqDexV`
3. dev locks in streamflow (program `strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m`, mint filter @ byte offset 177)
4. treasury → holder transfers = refund (b4 sweep) or unlock-return (after) — both reduce dat wallet's locked amount
5. monthly revshare paid from `Gf9QUuqfEX8K3WFgfF4J1SXtM2Za1LZwitByNFqgtgtQ`

page shows: locks (deposited/unlocked/next-unlock), locked-wallet table (locked · share% · pending · returned · revshare paid), csv export. share% on locked only = payout split.

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

1. **dev earns NOTHING from rev share.** da dev wallet iz a custodian only:
   treasury pools holder deposits → dev signs da streamflow locks. its own
   locks r da time-based ones (shown as "dev lock" on da page); its own
   treasury deposits r internal n excluded from evry pool. round 1 (jul 1)
   paid dev 2.707 sol on-chain as a one-off — dat wuz da last time. da
   page's holder-only split IZ da payout sheet.

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
