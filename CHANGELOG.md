# Changelog — `glitch-cod-confirm`

Auto-regenerated from `git log` by `/home/support/bin/changelog-regen`,
called before every push by `/home/support/bin/git-sync-all` (cron `*/15 * * * *`).

**Purpose:** traceability. If a push broke something, scan dates + short SHAs
here; then `git show <sha>` to see the diff, `git revert <sha>` to undo.

**Format:** UTC dates, newest first. Each entry: `time — subject (sha) — N files`.
Body text (if present) shown as indented sub-bullets.

---

## 2026-04-19

- **18:15 UTC** — auto-sync: 2026-04-19 18:15 UTC (`5910316`) — 1 file
        M	src/livekit-agent.js
- **17:08 UTC** — docs: detailed session handover with exact test commands (`5a92945`) — 1 file
    The previous handover was too high-level — next session didn't know
    how to fire a test call. This version has:
    - Copy-paste-ready test command at the TOP of the doc
    - Known failure modes + symptom → root cause → fix table
    - All API keys rotated today flagged as potentially in chat transcript
    - Honest status: Urban Classics live but Vobiz/Sarvam WS reliability
      issues remain. Not "production-ready" yet.
    - User's Pipecat evaluation ask captured as next-session priority
    - Current TTS config revert to WS streaming (REST gave 20s turn times)
    Also includes the uncommitted TTS revert (REST StreamAdapter → WS
- **13:15 UTC** — auto-sync: 2026-04-19 13:15 UTC (`2d96aa5`) — 2 files
        M	src/livekit-agent.js
- **12:45 UTC** — auto-sync: 2026-04-19 12:45 UTC (`de7aed7`) — 2 files
        M	src/livekit-agent.js
- **12:13 UTC** — perf: shorter responses to cut per-turn latency (`59d0286`) — 1 file
    - maxTokens 120 → 60 on gpt-4o-mini mechanically enforces brevity
    - Prompt updated: ONE sentence per response, no chaining with
      "और"/"फिर"/"और" (Hindi) or "and"/"then"/"so" (English)
    - OpenAI prompt caching is automatic for prompts ≥1024 tokens;
      our ~1800-token system prompt caches after 2nd call in 5 min,
      saving ~300ms/call on LLM first-token latency
    Root cause of perceived slowness on +919039999585 test: Priya was
    generating 2-3 long sentences per turn (~10s spoken audio each),
    making total turn time feel like 13s when actual LLM+TTS latency
    was only ~3s. Brevity fixes the UX.
- **10:45 UTC** — auto-sync: 2026-04-19 10:45 UTC (`42b80da`) — 2 files
        M	src/livekit-agent.js
- **00:51 UTC** — docs: refresh handover for 2026-04-19 session (`1c27668`) — 1 file
    Full state snapshot: Urban Classics live, per-shop HMAC map,
    DND tightened to 20:00–10:05 IST, freshness filters active,
    4-store cost model + expansion plan documented.
    Resume instructions included — open this file first next session.
- **00:26 UTC** — feat: freshness filters + clearer HMAC startup log (`7d4e5e4`) — 2 files
    - QUEUE_ONLY_AFTER (ISO timestamp): hard cutoff for going-live moments.
      Orders created on/before this moment are 200-ack'd but not queued.
      Prevents Shopify's 48h retry backlog from flooding the call queue
      when HMAC/webhook issues get fixed.
    - MAX_ORDER_AGE_HOURS (default 6): rolling freshness check. Orders
      older than this are skipped. Catches post-outage recovery scenarios
      where calling 2-day-old orders would be bad UX.
    - Both filters AND together. Failed webhooks still return 200 so
      Shopify stops retrying; logged as "stale: <reason>".
    - Startup HMAC log now distinguishes per-shop map / fallback / none —
- **00:23 UTC** — chore: document humane DND window defaults (10:00–20:00 IST) (`3ece7a4`) — 1 file
    TRAI allows 09:00–21:00 but waking someone at 9am after they ordered
    at 9pm the night before is a poor customer experience. Tightening
    to 10:00–20:00 gives a 10-hour call window with buffer on both ends.
    No code change — dnd.js was already env-var driven; just documenting
    the recommended values in .env.example.
- **00:17 UTC** — feat: per-shop webhook secret map for multi-store deployments (`fb821c7`) — 2 files
    Every Shopify store has its own app in the Dev Dashboard with its own
    Client Secret, so webhook HMACs are signed with different keys per
    store. The old single SHOPIFY_WEBHOOK_SECRET could only validate one
    store at a time — all other stores' webhooks were rejected as HMAC
    mismatch (observed on Urban Classics in production).
    - Add SHOPIFY_WEBHOOK_SECRETS env var (JSON map keyed by myshopify
      domain) matching the glitch-grow-ads-agent pattern
    - Resolve secret per-request using X-Shopify-Shop-Domain header
    - SHOPIFY_WEBHOOK_SECRET retained as fallback for single-store setups
    - Health endpoint now surfaces per-shop count + fallback status

## 2026-04-18

- **23:27 UTC** — perf: VAD at 8kHz matches SIP audio natively, halves CPU load (`3a994cd`) — 1 file
    Root cause of "inference is slower than realtime" warnings at call start:
    Silero VAD defaulted to 16kHz while SIP audio arrives at 8kHz. The plugin
    was resampling every frame 8→16kHz before inference, then processing twice
    as many samples per window. On our 2-CPU VPS, this collided with Sarvam
    STT/TTS WebSocket startup + LLM initialization → VAD fell behind realtime.
    Fix: load VAD with sampleRate: 8000. Silero's ONNX model natively supports
    both 8k and 16k — no quality trade-off, just skips the resample step and
    halves samples-per-window.
    Also: minSilenceDuration 550ms → 400ms for snappier turn-end detection on
    SIP latency (default tuned for studio mic, not phone lines).
- **23:22 UTC** — docs: add session handover for 2026-04-18 (`90ba186`) — 1 file
    Snapshot of production state, everything shipped this session, open
    items, known issues, env var diff, and resume instructions. Start
    here when picking up the project again.
- **00:27 UTC** — chore: update license contact to support@glitchexecutor.com (`99d91db`) — 2 files
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- **00:25 UTC** — chore: relicense from MIT to BSL 1.1 (`d74d3d8`) — 2 files
    License converts to Apache 2.0 on 2030-04-18. Production use permitted
    except for offering as a competing hosted/embedded product.
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- **00:08 UTC** — docs: add MIT LICENSE file (`b8c8c98`) — 1 file
- **00:05 UTC** — docs: overhaul README to reflect shipped pipeline (`6d1f72d`) — 1 file
    - Architecture diagram updated to show full flow: webhook → scheduler
      → LiveKit room → SIP call + audio egress → per-turn transcript →
      Shopify tag write
    - Data pipeline section: CallTurn (PostgreSQL) + R2 audio recording,
      moat rationale, DPDP consent disclosure
    - New env vars documented: LIVEKIT_TOOL_SECRET, RECORDING_BACKEND,
      R2_*, RECORDING_CONSENT_DISCLOSURE, DISPATCH_MODE, STORE_NAME,
      STORE_CATEGORY
    - LiveKit webhook setup instructions added
    - Key design decisions expanded: AEC warmup tuning (3000→500ms),

## 2026-04-17

- **23:50 UTC** — perf: cut barge-in lag and response latency (`4498c1a`) — 1 file
    - aecWarmupDuration 3000→500ms: SDK disables all interruptions during
      AEC warmup; 3s was blocking customer barge-in for the entire first
      3 seconds of every Priya turn. 500ms stabilises echo canceller on SIP
      while making interruptions responsive from the start.
    - maxTokens: 120 on gpt-4o-mini: Priya only speaks 1-2 short Hindi
      sentences per turn (~60-90 tokens). Uncapped generation was adding
      unnecessary LLM latency after every interruption.
    - minInterruptionWords: 2: prevents single-syllable breath / "hmm"
      sounds from cutting Priya off; real barge-in still triggers cleanly.
- **23:43 UTC** — fix: switch room composite egress to MP4+Opus to resolve codec error (`0695413`) — 1 file
    OGG caused "no supported codec is compatible with all outputs" on every
    call — room composite's rendering pipeline needs an explicit codec.
    MP4 with AudioCodec.OPUS + audioOnly: true is the canonical working
    combination. File extension changed from .ogg → .mp4.
- **23:26 UTC** — fix: call confirm_order in same turn as customer's final confirmation (`bbf1232`) — 1 file
    Previous behaviour: LLM said the confirmation phrase, then waited for
    user to speak again, THEN called the tool — causing a race where if
    the customer hung up before the next turn, the tool never fired.
    Fix: prompt now instructs the model to call confirm_order in the same
    LLM response as the customer's "हाँ/sahi hai/yes" — tool fires before
    the speech, in the same turn, no second user input required.
    Also tightened tool description to reinforce same-turn behaviour.
- **23:17 UTC** — fix: force tool call before farewell to prevent missed Shopify writes (`fdd1354`) — 1 file
    Hindi + English prompts: added MANDATORY rule that no goodbye/farewell
    may be spoken until a tool (confirm_order / cancel_order / etc.) has
    been called. Step 3 instruction strengthened from "फिर call करो" to
    "उसी turn में तुरंत call करो — tool call के बिना goodbye मत बोलो."
    Root cause: on first live call (#8973) Priya said the confirmation
    phrase then jumped straight to farewell without calling confirm_order,
    leaving the Shopify order untagged. This rule closes that gap.
- **23:04 UTC** — fix: capture assistant transcript text + delay egress start (`7bd83cc`) — 2 files
    - Use `item.textContent` (SDK getter) instead of `item.content` (raw
      array) when persisting assistant turns — fixes blank Priya rows in
      CallTurn table, confirmed against v1.2.6 chat_context.js source.
    - Delay audio egress start by 10 s so the agent has time to join the
      room and publish its audio track before startRoomCompositeEgress is
      called — fixes "no supported codec is compatible with all outputs"
      error that occurred on empty rooms at dispatch time.
    Validated on first live smoke call: 13-turn Hindi conversation,
    order #8973 confirmed by customer, egress fix pending next call.
- **20:45 UTC** — auto-sync: 2026-04-17 20:45 UTC (`032346f`) — 2 files
        M	src/server.js
- **20:15 UTC** — auto-sync: 2026-04-17 20:15 UTC (`05a92ad`) — 2 files
        M	src/server.js
- **19:30 UTC** — Add Cloudflare R2 backend for recording egress ($0 egress for training) (`e9dcd79`) — 3 files
    Adds RECORDING_BACKEND=r2 alongside existing gcp and s3 options. R2 is
    S3-compatible, so reuses LiveKit's S3Upload class with two extra fields
    the generic s3 path didn't set: endpoint=https://<account>.r2.cloudflare
    storage.com and forcePathStyle=true. Region is hardcoded to "auto" (R2
    convention).
    Why default to R2: training pulls the full dataset to a GPU box once per
    experiment. At 100K calls/mo (~24 GB/mo accumulated), egress at GCS/S3
    rates is ~$3/training-run; R2 is $0. Storage itself is ~$0.40/mo at that
    scale (under free tier for the first couple of years).
    Config: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
- **02:45 UTC** — auto-sync: 2026-04-17 02:45 UTC (`a049126`) — 2 files
        M	src/livekit-agent.js
- **02:26 UTC** — chore: add gitleaks pre-commit hook (`38b7ec9`) — 1 file
    Blocks commits containing API keys, tokens, or other secrets.
    Install locally: pre-commit install
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

## 2026-04-16

- **22:28 UTC** — Add data-moat foundation: per-turn transcripts, audio egress, consent (`456f4ac`) — 2 files
    Building the proprietary dataset for later training. Schema + endpoint +
    agent changes were captured by auto-sync as 6ba5363; this commit adds the
    manual-migration artifact that applies the new columns against an already-
    running Postgres.
    Feature set (across this commit and 6ba5363):
    Schema (prisma/schema.prisma)
    - CallAttempt gains audioUri, audioFormat, audioDurationMs,
      audioSampleRate, lang, consentGiven, turnCount — pointers + metadata
      so the training exporter can join (audio, transcript, outcome).
    - New CallTurn model: one row per utterance. Fields: turnIndex (monotonic),
- **21:45 UTC** — auto-sync: 2026-04-16 21:45 UTC (`6ba5363`) — 6 files
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
