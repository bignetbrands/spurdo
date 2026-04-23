# $spurdo landing

da ebin bear from 2008 haz arriv on solana :DDD

Single-page site for the $spurdo memecoin deposit window + rev share program. Built as a static HTML page — no build step, no framework, no dependencies.

## Files

- `index.html` — the landing page (single file, inline CSS + JS)
- `spurdo.png` — canonical spurdo character image (13.9 KB)
- `spurdo-scooter.png` — scooter spurdo for the bottom-of-screen slider animation (17 KB)

All three files must live in the same directory. Total page weight under 60 KB.

## Run locally

Open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

Any static host works — GitHub Pages, Vercel, Netlify, Cloudflare Pages, plain S3, a VPS with nginx. No build step.

### GitHub Pages

After pushing to GitHub, go to **Settings → Pages**, pick the `main` branch and `/` root, save. The site goes live at `https://<username>.github.io/<repo-name>/` within a minute.

## Configure before launch

Three constants at the top of the `<script>` block in `index.html`:

```js
const DEADLINE_ISO = null;   // e.g. '2026-04-25T23:59:59Z' for a fixed countdown target
const DEPOSIT_URL  = null;   // e.g. 'https://app.spurdo.xyz/deposit' for the deposit dapp
const X_URL        = 'https://x.com/spurdo';
```

- `DEADLINE_ISO`: ISO 8601 string for when the deposit window closes. When `null`, the countdown is a rolling 3 days from page load (useful for dev / preview).
- `DEPOSIT_URL`: URL of the deposit dapp. When `null`, the hero "deposit now :DDD" button and the how-to CTA scroll to the countdown section instead of opening a dapp. Set this when the dapp is live and both CTAs will auto-rewire to open it in a new tab.
- `X_URL`: the X (Twitter) handle link used in the footer.

## Contract

`991L48va9rMiysu3fCpeg5p9bN4NLzhujojzmFtkgacE` (Solana)

## Terms

50% of creator fees flow to depositors. 3-day deposit window. 20-moon (month) lock with 5% unlock per moon.

## License

Do whatever u want w da bear :DDD
