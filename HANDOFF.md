# TraffiAlert GH — bot handoff

This note is for either Grok Bot working on TraffiAlert GH. The user (Riddim Boss) runs two bots in separate Grok Bot accounts that cannot message each other:

- TraffiAlertGh Annex (this account)
- traffialertgh (his other Grok Bot account)

When one runs out of credits, the other picks up from this file. Keep this note current. Append a Log entry when you stop work. Never put secrets, passwords, keys, or tokens in this file or in chat — env var and secret *names* only.

## Project

TraffiAlert GH is a Ghana traffic-alert product: a website and an Android app.

**Site** — repo [TraffiAlertGH/traffialert-site](https://github.com/TraffiAlertGH/traffialert-site). Static on GitHub Pages at [traffialert.com](https://traffialert.com). It talks to Supabase with the anon key. The admin page uses Supabase auth plus the RPCs `get_app_admin_stats` and `get_app_admin_locations`.

**Android app** — Expo React Native, package `gh.traffialert.app`. APKs are published as GitHub releases.

**Pay server** — Node on Render, currently in test mode, using Paystack MoMo. Premium codes look like `TA-XXXX-XXXX-XXXX`. Payment references are `TA-…`.

## Accounts and services

- **GitHub:** OriginalSolution. Can read, branch, open PRs, and merge. `gh` on the shared computer is logged in the same way, with `gh auth setup-git` already run.
- **Project Gmail:** traffialertgh@gmail.com
- **Supabase:** project `aayygoxexboduevbmjgi`, in the org **TraffiAlert GH**, owned by traffialertgh@gmail.com, Pro plan. A different Supabase login (riddimbossy-prog's Org) does **not** contain this project. Do not treat that org as TraffiAlert.
- **Render:** service `traffialert-pay`, id `srv-dbrmm5om7kps73cnjq40`, Original Solutions workspace, free plan, Frankfurt, autoDeploy off, test mode. Live URL: https://traffialert-pay.onrender.com

## Pay server source

The live pay server source is in the private repo [OriginalSolution/traffitech-gh-alert](https://github.com/OriginalSolution/traffitech-gh-alert), branch `cursor/traffialert-gh-v1-4c59`, folder `server/pay`, plus `supabase/migrations`. It is not on `main`.

Env var names (values are secrets — do not record them here):

- `PAYSTACK_SECRET_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `TA_PAY_SECRET`
- Optional: `MONITOR_KEY`, `ALLOWED_ORIGIN`, `CALLBACK_URL`, `PAYSTACK_BASE_URL`

Supabase private-schema tables: `ta_payments`, `ta_premium_codes`, `ta_pay_config`, `ta_redeem_attempts`.

RPCs:

- Secret-gated (need `TA_PAY_SECRET`): `ta_record_payment`, `ta_find_code`, `ta_founding_taken`
- Used by the app: `redeem_premium_code`, `get_premium_status`

## Product decisions (user confirmed)

- There is a 7-day free trial.
- Keep Premium as "coming soon" on the home page, with no pay link, until payments are live.
- Medit USA LTD is the data controller.

## Done (2026-11-14)

Site review fixes were merged to `main` via [PR #1](https://github.com/TraffiAlertGH/traffialert-site/pull/1) (merge commit `7422834`) and are live.

Key changes:

- Admin script moved out of `admin.html` into `assets/admin.js`, with a CSP on the admin page
- Session stored in `sessionStorage`
- `pay.js`: resume, no retry, MoMo prefix check
- Privacy policy: Medit USA LTD is the controller; service providers; Ghana Data Protection Act 843
- Added `robots.txt`, `sitemap.xml`, `404.html`
- Resized Maame portrait images
- Monitor workflow now uses the `MONITOR_EMAIL` repo secret

Repo secret names only: `MONITOR_EMAIL`, `PAY_MONITOR_KEY`.

## Open work / next steps

1. **Pay verify leak.** The pay server returns the Premium code for a payment reference alone. The fix is to require the init token or a matching phone, plus rate limits. A working reference implementation is uncommitted at `/workspace/repos/traffialert-pay` on the shared computer (`src/service.js` and related files; 18 tests passing). Port that into `server/pay` on traffitech-gh-alert, and change `pay.js` on the site so verify sends the token or phone. Show the change to the user before any Render deploy.
2. **Merge `server/pay` to `main`** of OriginalSolution/traffitech-gh-alert.
3. **Render.** The free plan cold-starts, and no health check path is set.
4. **Supabase grants.** Anon has `EXECUTE` on the secret-gated payment RPCs. Review those grants.
5. **7-day trial.** Decided, but not implemented anywhere yet.
6. **Supabase audit.** A read-only audit (RLS, RPC grants, exposed schemas, advisors, row counts) is still pending until the traffialertgh@gmail.com Supabase account is connected. Do not use riddimbossy-prog's Org for this.
7. **Unused repo.** An empty private repo [TraffiAlertGH/traffialert-pay](https://github.com/TraffiAlertGH/traffialert-pay) was created for a replacement pay server and is unused. Delete it only if the user asks.

## How to work with the user

- Be concise.
- Don't make him repeat logins.
- Never post passwords, keys, or tokens in chat.
- Show changes before pushing or deploying, unless he explicitly says to push or deploy.
- The site checkout on the shared computer is `/workspace/repos/traffialert-site`. Related pay-server work also lives under `/workspace/repos/`.

## Log

Append a dated entry when you stop work. Say which bot you are, what you did, and what is still open.

### 2026-11-14 — TraffiAlertGh Annex

Added this `HANDOFF.md` and pushed it to `main` of TraffiAlertGH/traffialert-site. Site review fixes are already live (PR #1, merge `7422834`). The pay-server verify fix is written locally at `/workspace/repos/traffialert-pay` but is not yet ported into `server/pay` and has not been deployed. The Supabase connector is not yet signed in as traffialertgh@gmail.com, so the live project audit is still blocked. A second Supabase sign-in was offered; use traffialertgh@gmail.com, ideally in a private window, so the old riddimbossy-prog login is not reused.
