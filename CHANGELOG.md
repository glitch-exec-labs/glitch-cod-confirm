# Changelog — `glitch-cod-confirm`

Auto-regenerated from `git log` by `/home/support/bin/changelog-regen`,
called before every push by `/home/support/bin/git-sync-all` (cron `*/15 * * * *`).

**Purpose:** traceability. If a push broke something, scan dates + short SHAs
here; then `git show <sha>` to see the diff, `git revert <sha>` to undo.

**Format:** UTC dates, newest first. Each entry: `time — subject (sha) — N files`.
Body text (if present) shown as indented sub-bullets.

---

## 2026-04-16

- **21:45 UTC** — auto-sync: 2026-04-16 21:45 UTC (`6526f59`) — 5 files
        M	.env.example
        M	prisma/schema.prisma
        M	src/livekit-agent.js
        M	src/server.js
        M	src/trigger-livekit-call.js
- **20:45 UTC** — auto-sync: 2026-04-16 20:45 UTC (`e1c7841`) — 4 files
        M	MILESTONES.md
        M	README.md
        M	src/setup-bolna-agent.mjs
- **20:33 UTC** — Genericize store brand, scrub client references for public-repo readiness (`3bafdca`) — 7 files
    Completes the genericization pass started in 0535981 (auto-sync picked up
    the agent/trigger-call/retell-setup changes before a human commit landed).
    Prompts, welcomes, and agent names now read from STORE_NAME / STORE_CATEGORY
    env vars (single-tenant default) or from order.storeName / order.storeCategory
    participant attributes (multi-tenant path, resolved per-shop by the caller of
    triggerLivekitCall). Default STORE_NAME="our store", STORE_CATEGORY="online
    store" so the agent degrades gracefully if the env is unset.
    Touched in 0535981:
    - src/livekit-agent.js      — store_name/store_category threaded through
                                  Hindi + English prompts, welcome, attrs. New
- **20:30 UTC** — auto-sync: 2026-04-16 20:30 UTC (`0535981`) — 4 files
        M	src/livekit-agent.js
        M	src/setup-retell-agent.mjs
        M	src/trigger-livekit-call.js
- **20:22 UTC** — Fix 6 P1/P2 reliability issues in tool pipeline (`3dbbf51`) — 3 files
    Addresses issues #7–#12 discovered on post-launch review of the
    Shopify → LiveKit → Shopify writeback path.
    - #9 (P1): COD gateway detection now normalizes non-alphanumerics,
      so "Cash on Delivery", "cash-on-delivery", "cashondelivery" and "COD"
      all classify as COD instead of being silently skipped as prepaid.
    - #8 (P1): /webhook/livekit/tool/* now requires X-COD-Tool-Secret
      matched against LIVEKIT_TOOL_SECRET via timingSafeEqual. Fails
      closed if the secret is not configured. Agent sends the header.
    - #7 (P1): Tool handler returns 400 on bad input and 500 on real
      backend failures, not 200+{ok:false}. Agent requires both res.ok
- **05:41 UTC** — Add DISPATCH_MODE=dry_run|live gate for safe beta testing (`101e978`) — 1 file
    Default mode remains 'live' (so missing env doesn't surprise-disable
    production). For beta, set DISPATCH_MODE=dry_run.
    In dry_run:
      - Webhook handler runs full validation (HMAC, allowlist, COD detection,
        phone normalization, DND adjustment, idempotency)
      - ScheduledCall rows are enqueued exactly as in production
      - Scheduler picks up due rows on its 30s tick
      - Instead of calling triggerLivekitCall, the scheduler logs the full
        payload and writes status='done', outcome='dry_run' + a CallAttempt
        with disposition='dry_run'
- **05:15 UTC** — auto-sync: 2026-04-16 05:15 UTC (`c4226ec`) — 3 files
        M	src/lib/scheduler.js
        M	src/server.js
- **04:35 UTC** — Production-ready beta: DB queue, DND, phone normalization, retry, allowlist (`4f054a0`) — 4 files
    Full P0+P1 production hardening push. Replaces the in-memory setTimeout
    Map (which lost every pending call on restart) with a durable Postgres-
    backed queue and 30s poll scheduler.
    SERVER (src/server.js) — rewritten:
      - Webhook handler now enqueues ScheduledCall rows idempotently via
        @@unique([shop, orderId]) — Shopify retries can't create duplicates
      - HMAC-missing rejected (was silently accepted before)
      - ALLOWED_SHOPS gate — webhook from non-beta stores returns 200 silently
        (doesn't leak which shops we serve) and increments reject counter
      - Phone normalized on ingress via normalizePhone() — invalid phones
- **04:30 UTC** — auto-sync: 2026-04-16 04:30 UTC (`2f33721`) — 7 files
        M	prisma/schema.prisma
        A	src/lib/dnd.js
        A	src/lib/fetch.js
        A	src/lib/phone.js
        A	src/lib/scheduler.js
        ... (+1 more)
- **03:03 UTC** — Add comprehensive README for public repo SEO (`f54db35`) — 1 file
    - Full architecture diagram and stack breakdown
    - Setup instructions with .env template
    - Design decisions (8kHz TTS, Devanagari prompts, platform comparison)
    - Shopify integration guide with tag reference
    - Adaptation guide for other stores
    Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
- **03:01 UTC** — Fix 3 correctness bugs in webhook and COD detection paths (`6597b2e`) — 1 file
    P1: Webhook HMAC bypass — reject requests missing X-Shopify-Hmac-Sha256
        when SHOPIFY_WEBHOOK_SECRET is configured. Previously a request with
        no header at all was silently accepted, allowing unauthenticated
        callers to trigger fake COD calls.
    P1: COD detection TypeError — payment_gateway_names is an array in real
        Shopify payloads, but .toLowerCase() was called on it directly.
        Now joins array to string before matching.
    P2: Tag writeback silent success — updateOrderTag() returned early without
        throwing when no Shopify session existed. Callers reported ok:true to
        the voice agent while the tag was never written. Now throws so callers
- **02:56 UTC** — Voice AI agent for Indian COD order confirmation on Shopify stores (`c6484ae`) — 15 files
    Stack:
    - LiveKit Agents JS + Sarvam Bulbul v3 TTS (voice=neha, sampleRate=8000)
    - Sarvam Saaras v3 STT (hi-IN, Hinglish code-switch)
    - GPT-4o-mini as the brain, bilingual system prompt (warm agent "Priya")
    - Vobiz SIP trunk for outbound PSTN calls via LiveKit
    - Express webhook server for Shopify orders/create integration
    - Prisma + PostgreSQL for session/order state
    Features:
    - Bilingual (hi-IN default, en-IN via ?lang=en-IN)
    - 5 function calls: confirm_order, cancel_order, request_human_agent, request_callback, end_call
