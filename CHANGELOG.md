# Changelog — `glitch-cod-confirm`

Auto-regenerated from `git log` by `/home/support/bin/changelog-regen`,
called before every push by `/home/support/bin/git-sync-all` (cron `*/15 * * * *`).

**Purpose:** traceability. If a push broke something, scan dates + short SHAs
here; then `git show <sha>` to see the diff, `git revert <sha>` to undo.

**Format:** UTC dates, newest first. Each entry: `time — subject (sha) — N files`.
Body text (if present) shown as indented sub-bullets.

---

## 2026-04-16

- **04:30 UTC** — auto-sync: 2026-04-16 04:30 UTC (`36bb45d`) — 6 files
        M	prisma/schema.prisma
        A	src/lib/dnd.js
        A	src/lib/fetch.js
        A	src/lib/phone.js
        A	src/lib/scheduler.js
        ... (+1 more)
- **03:03 UTC** — Add comprehensive README for public repo SEO (`8f5e629`) — 1 file
    - Full architecture diagram and stack breakdown
    - Setup instructions with .env template
    - Design decisions (8kHz TTS, Devanagari prompts, platform comparison)
    - Shopify integration guide with tag reference
    - Adaptation guide for other stores
    Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
- **03:01 UTC** — Fix 3 bugs: webhook auth bypass, COD detection crash, silent tag failure (`98f8bec`) — 1 file
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
- **02:56 UTC** — Voice AI agent for Indian COD order confirmation on Shopify stores (`c97d5e2`) — 15 files
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
