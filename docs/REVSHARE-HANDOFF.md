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

1. **vercel env**: `SOLANA_RPC = https://mainnet.helius-rpc.com/?api-key=KEY` (free tier fine). widout it server uses api.mainnet-beta — full history but rate-limited, scans slower n can drop txs.
2. after deploy: hit `/api/revshare-data?force=1` once (30–60s), den verify `/revshare` diag line starts `server ·` and old lockers appear. ism can cross-check vs solscan transfers on da treasury.
3. if wallets still missing: diag line format iz `treasury: N acct · ok/sigs txs ·· found N old acct ·· node:sigs…` — a node showing `err` or low sigs = history gap; a missing wallet + clean diag = accounting rule question, check `runFullScan` event timeline.

## maybe next

- cron route to refresh da redis cache nightly (crons already exist in `vercel.json`, copy da pattern)
- reconcile check: sum(locked by holders) vs streamflow deposited minus returns — surface mismatch on da page
- payout helper: csv → batch transfer list for da monthly revshare run

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
