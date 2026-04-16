# Changelog — `glitch-cod-confirm`

Auto-regenerated from `git log` by `/home/support/bin/changelog-regen`,
called before every push by `/home/support/bin/git-sync-all` (cron `*/15 * * * *`).

**Purpose:** traceability. If a push broke something, scan dates + short SHAs
here; then `git show <sha>` to see the diff, `git revert <sha>` to undo.

**Format:** UTC dates, newest first. Each entry: `time — subject (sha) — N files`.
Body text (if present) shown as indented sub-bullets.

---

## 2026-04-15

- **17:18 UTC** — auto-sync: 2026-04-15 17:18 UTC (`3a2b760`) — 1 file
        M	MILESTONES.md
- **11:08 UTC** — auto-sync: 2026-04-15 11:08 UTC (`6e8693a`) — 4 files
        M	src/livekit-agent.js
        M	src/server.js
        M	src/trigger-livekit-call.js
- **10:57 UTC** — auto-sync: 2026-04-15 10:57 UTC (`0ab7ba9`) — 3 files
        A	MILESTONES.md
        M	src/livekit-agent.js
- **10:45 UTC** — auto-sync: 2026-04-15 10:45 UTC (`5c1b64b`) — 2 files
        M	src/livekit-agent.js
- **10:30 UTC** — auto-sync: 2026-04-15 10:30 UTC (`ccd1f26`) — 2 files
        M	src/livekit-agent.js
- **10:15 UTC** — auto-sync: 2026-04-15 10:15 UTC (`915074d`) — 5 files
        M	package.json
        M	pnpm-lock.yaml
        M	src/livekit-agent.js
        M	src/server.js
- **10:00 UTC** — auto-sync: 2026-04-15 10:00 UTC (`03223e2`) — 8 files
        M	package.json
        M	pnpm-lock.yaml
        A	src/create-sip-trunk.mjs
        A	src/livekit-agent.js
        M	src/server.js
        ... (+2 more)
- **08:15 UTC** — auto-sync: 2026-04-15 08:15 UTC (`d57ae65`) — 2 files
        M	src/server.js
- **08:00 UTC** — auto-sync: 2026-04-15 08:00 UTC (`166efd6`) — 2 files
        M	src/server.js
- **07:45 UTC** — auto-sync: 2026-04-15 07:45 UTC (`f119f08`) — 3 files
        M	src/server.js
        M	src/setup-bolna-agent.mjs
- **07:30 UTC** — auto-sync: 2026-04-15 07:30 UTC (`49553c9`) — 3 files
        M	src/server.js
        A	src/setup-bolna-agent.mjs
- **07:15 UTC** — auto-sync: 2026-04-15 07:15 UTC (`c257e70`) — 3 files
        M	src/setup-retell-agent.mjs
        A	src/update-retell-agent.mjs
- **07:00 UTC** — fix: surface Shopify GraphQL errors (ACCESS_DENIED no longer silent) (`44b336e`) — 2 files
    updateOrderTag was only checking data.data.orderUpdate.userErrors but Shopify
    returns top-level 'errors' array for ACCESS_DENIED and other request-level
    failures. Changed to throw on either, so safeTagUpdate wrapper returns a
    non-200-ish { ok: false, error } instead of falsely reporting success.
    Root cause discovered: URBAN (your-shop) Shopify session is missing write_orders
    scope. User needs to add scope to Dev Dashboard app + re-install.
- **06:53 UTC** — fix: Retell tool URLs missing /cod-confirm/ nginx prefix + defensive handlers (`de7fd19`) — 3 files
    Root cause of failed Shopify tag update:
    1. setup-retell-agent.mjs generated tool URLs at your-domain.com/webhook/...
       which nginx routed to port 3101 (Mokshya agency app) not port 3104 (cod-confirm).
       All tool calls returned 404 → never reached us.
    2. Tool handlers crashed when metadata was missing (curl tests with empty body)
       causing service restart loops.
    Fix:
    - Patched live LLM via update-retell-llm API
      to use /cod-confirm/webhook/retell/tool/<name> paths.
    - Updated setup script so future re-runs don't regress.
- **06:45 UTC** — auto-sync: 2026-04-15 06:45 UTC (`27d8693`) — 2 files
        M	src/server.js
- **06:15 UTC** — auto-sync: 2026-04-15 06:15 UTC (`061de66`) — 2 files
        M	src/server.js
- **06:09 UTC** — feat: initial scaffold of Glitch COD Confirm service (`a7d95f4`) — 7 files
    Voice AI agent for Indian COD order confirmation on Shopify stores.
    Stack:
    - Retell AI agent with ElevenLabs 'Monika' en-IN voice
    - GPT-4.1-mini as the brain, Hinglish system prompt (warm agent 'Priya')
    - 5 function calls: confirm_order / cancel_order / request_human_agent / request_callback / end_call
    - Express webhook server on :3104, exposed at your-domain.com/cod-confirm/*
    - Shared Postgres Session table via Prisma (reuses Shopify tokens from multi-store-theme-manager)
    - Systemd unit cod-confirm.service
    Still pending:
    - Exotel KYC + virtual number (production scale)
