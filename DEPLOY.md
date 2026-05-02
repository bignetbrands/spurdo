# Deploy Guide

End-to-end setup for `spurdosparde.fun`. Allow ~30 minutes for first deploy.

## What you'll need

- A Vercel account
- An Upstash account (Redis storage)
- An Anthropic API key
- An OpenAI API key (with org verified for gpt-image-1)
- X API credentials (Basic tier, ~$200/mo) — 5 keys
- Your domain `spurdosparde.fun` (already yours)

## 1. Push the code to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. **Import Git Repository** → pick `bignetbrands/spurdo`
3. **Framework preset**: Next.js (auto-detected from `package.json`)
4. **Root directory**: leave as default (repo root)
5. **Build command**: leave as default (`next build`)
6. Click **Deploy**

The first deploy will likely fail because env vars aren't set — that's fine, we set them next.

## 2. Add Upstash Redis

In your Vercel project:

1. Go to **Storage** tab
2. **Create Database** → **Upstash for Redis** (this is the successor to "Vercel KV", which Vercel deprecated in 2024-25)
3. Pick a region close to your function region (e.g. `iad1` for US East)
4. Click **Create**
5. **Connect to Project** → pick this project, accept all environments

Vercel auto-injects these env vars from the Upstash integration:
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

(The code reads either pair, so don't worry about which set you have.)

## 3. Add the rest of the env vars

In **Settings → Environment Variables**, add the following. Set environment to **Production, Preview, Development** for all of them unless noted.

### Project identity

| Var | Value |
|---|---|
| `PROJECT` | `spurdo` |

### Auth secrets — generate fresh random strings, don't reuse

Generate two strong random strings (32+ chars each) — anywhere works, e.g. `openssl rand -hex 32` in a terminal, or just smash characters yourself.

| Var | Value | Used for |
|---|---|---|
| `ADMIN_SECRET` | `<random string>` | the password for `/bot` dashboard |
| `CRON_SECRET` | `<random string>` | Vercel sends this in cron requests; routes verify it |

**Save the `ADMIN_SECRET` somewhere safe** — that's how you'll log into `/bot`.

### LLM keys

| Var | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` from console.anthropic.com |
| `OPENAI_API_KEY` | `sk-proj-...` from platform.openai.com |

**OpenAI org verification:** gpt-image-1 requires that your OpenAI org is verified. Go to platform.openai.com → **Settings → Organization → Verification** and complete it. Takes ~24h to approve. Without it, image gen returns a 403.

### X API credentials (Basic tier — paid, $200/mo)

From your X developer portal:

| Var | Value |
|---|---|
| `TWITTER_API_KEY` | "Consumer Keys" → API Key |
| `TWITTER_API_SECRET` | "Consumer Keys" → API Key Secret |
| `TWITTER_ACCESS_TOKEN` | "Authentication Tokens" → Access Token (must be generated while authenticated as `@spurdo`) |
| `TWITTER_ACCESS_TOKEN_SECRET` | matching Access Token Secret |
| `TWITTER_BEARER_TOKEN` | "Authentication Tokens" → Bearer Token |

⚠️ The Access Token + Secret pair binds the API to a specific account. **Generate them while @spurdo is the active session in your X dev portal**, otherwise the bot will post from the wrong account.

## 4. Redeploy

After adding env vars, hit **Deployments → ⋯ → Redeploy** on the latest deployment. Build should now succeed.

## 5. Connect the domain

1. **Settings → Domains**
2. Add `spurdosparde.fun`
3. Vercel will give you DNS records — add them at your registrar
4. Wait ~5 minutes for propagation
5. Visit `https://spurdosparde.fun` — should show the landing page
6. Visit `https://spurdosparde.fun/bot` — should show the auth gate

## 6. Verify the M1 setup

Log into `/bot` with your `ADMIN_SECRET`. You should see:

- **kv health**: ok
- **pillars loaded**: 6
- **env vars**: all green checkmarks
- **kill switch**: off

Toggle the kill switch on and off to confirm KV writes work end-to-end.

The cron stubs will start firing every 5 / 30 minutes but currently return 501 ("not implemented") — that's expected for M1.

## 7. Test the cron auth (optional)

```bash
curl -i https://spurdosparde.fun/api/cron/tweet
# should return: 401 Unauthorized

curl -i -H "Authorization: Bearer YOUR_CRON_SECRET" https://spurdosparde.fun/api/cron/tweet
# should return: 501 with M1 stub message
```

If you see `401` from Vercel's actual scheduled invocations, your `CRON_SECRET` env var doesn't match what Vercel is sending — re-generate, redeploy.

## Duplicating for a new project

To launch project N+1 from this same codebase:

1. Copy `config/spurdo/` → `config/newproject/`
2. Edit the 6 files (character.md, pillars.json, voice.json, image-prompts.json, accounts.json, token.json)
3. Replace `public/landing.html` and reference images with the new project's
4. Create a fresh Vercel project pointed at this same repo
5. Set `PROJECT=newproject` in env vars (everything else gets new values)
6. Add new Upstash, new X API creds, new domain
7. Deploy

The KV namespacing (every key prefixed `${PROJECT}:`) means projects can't collide even if they share infra.

## Common issues

**Auth gate rejects my password** — `ADMIN_SECRET` isn't set, or you've got trailing whitespace. Re-set it cleanly in Vercel.

**`kv health: FAIL`** — Upstash integration didn't auto-add env vars. Go to Storage → your Upstash DB → Settings → ensure project is connected.

**`kvHealthCheck()` works but tweets won't post (M2+)** — usually `TWITTER_ACCESS_TOKEN` was generated while logged into the wrong X account. Regenerate while authenticated as @spurdo.

**Cron route returns 401 from Vercel** — `CRON_SECRET` mismatch between env var and what Vercel sends. Set the env var and trigger a fresh deploy (env var changes need a new build).

**OpenAI image gen returns 403** — org not verified. See section 3.
