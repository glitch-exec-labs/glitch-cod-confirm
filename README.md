# Glitch Grow COD Confirm

**AI voice agent that calls Indian COD customers to confirm Shopify orders before dispatch — cutting RTO (Return to Origin) rates by catching cancellations, wrong addresses, and fake orders.**

Built for the reality of Indian e-commerce: 60–70% of fashion/lifestyle orders are cash-on-delivery, and 25–40% of those are returned undelivered. A 60-second human-sounding confirmation call before the parcel ships pays for itself many times over.

> Part of **Glitch Grow**, the digital marketing domain inside **Glitch Executor Labs**.

---

## What it does

```
Shopify orders/create webhook (HMAC-verified, COD-only)
        │
        ▼  (10-min delay, DND-aware scheduler, per-shop allowlist)
LiveKit room created  +  outbound SIP call to customer
        │
        ▼  (room-composite egress recording → R2)
Customer answers
        │
        ▼  (greeting, then turn-by-turn:)
   ┌─────────────┬─────────────┐
   ▼             ▼             ▼
Sarvam STT   GPT-4o-mini   ElevenLabs TTS
(Saaras v3)  (60-token       (Samisha,
 hi-IN        budget)         pcm_8000)
   │             │             │
   └─────────────┼─────────────┘
                 ▼
        4 tool calls available:
   confirm_order · cancel_order ·
   request_human_agent · request_callback
                 │
                 ▼
      Shopify GraphQL orderUpdate
        (tag + note, ~2s)
                 │
                 ▼
        Auto-hangup ~10s after farewell
        (don't burn VoIP minutes on
         customers who hold the line)
```

**"Priya"** is a bilingual (Hindi/English) voice agent that:

1. Calls the customer ~10 minutes after order placement (DND-window aware)
2. Confirms product, amount, and delivery address in natural Hinglish
3. Handles cancellations / objections / human-agent requests / callback requests
4. Writes outcome tags to the Shopify order via GraphQL
5. Records every call to R2 + persists every conversation turn to PostgreSQL — building a paired (audio, transcript, outcome) corpus for future fine-tuning

---

## Stack

| Layer | Default | Notes |
|---|---|---|
| **Agent framework** | [LiveKit Agents JS](https://github.com/livekit/agents-js) v1.2.6 | Real-time WebRTC + first-class SIP, Node.js SDK |
| **TTS (production)** | [ElevenLabs](https://elevenlabs.io) `eleven_turbo_v2_5` (`pcm_8000`) | Won the Hindi A/B against Sarvam Bulbul on naturalness; enterprise tier removes the cost gap |
| **TTS (fallback)** | [Sarvam](https://sarvam.ai) Bulbul v3 (`neha`, native 8kHz) | Kept wired; flip `TTS_PROVIDER=sarvam` for vendor-outage recovery |
| **STT** | Sarvam Saaras v3 (`hi-IN`) | Best-in-class Hindi/Hinglish streaming. No competitive Node alternative |
| **LLM** | OpenAI `gpt-4o-mini` (60-token cap) | Token cap mechanically enforces the "≤12 word sentences" prompt rule |
| **Turn detection** | LiveKit Multilingual Model | Hindi-safe end-of-turn detection |
| **VAD** | Silero (prewarmed per worker, 8kHz) | Matches SIP sample rate — no resample step |
| **Telephony** | Vobiz SIP trunk via LiveKit outbound | DLT-registered Indian caller ID |
| **Backend** | Express.js + Prisma + PostgreSQL | Webhooks, scheduler, per-shop sessions, turn-by-turn transcript persistence |
| **Audio storage** | Cloudflare R2 (S3-compatible, $0 egress) | MP4/Opus room-composite recordings |
| **Shopify** | Custom App per shop (`orders/create` webhook) | Per-shop HMAC verification, allowlist gate |

---

## Quickstart

### Prerequisites

- Node.js 20+ · pnpm · PostgreSQL
- A LiveKit Cloud project + a SIP trunk (Vobiz or any DLT-registered Indian provider)
- API keys: Sarvam (STT), ElevenLabs **or** Sarvam (TTS), OpenAI (LLM)
- A Cloudflare R2 bucket (optional, for recordings)
- A Shopify Custom App per store (`read_orders` + `write_orders`)

### Install

```bash
git clone https://github.com/glitch-exec-labs/glitch-grow-cod-confirm.git
cd glitch-grow-cod-confirm
pnpm install
cp .env.example .env
# Edit .env (see "Configuration" below)
npx prisma generate
npx prisma db push

# Optional: copy the demo prompts as your starting point
cp prompts/hindi-prompt.example.txt   prompts/hindi-prompt.txt
cp prompts/english-prompt.example.txt prompts/english-prompt.txt
```

### Run (two processes)

```bash
# 1. Express webhook server (handles Shopify webhooks + tool endpoints + scheduler)
node src/server.js

# 2. LiveKit agent worker (Priya — the voice loop)
node src/livekit-agent.js start
```

Production: use the systemd units in `systemd/`.

### Test without burning real-customer minutes

```bash
# Dry-run the scheduler — logs what would dispatch, never places PSTN calls
DISPATCH_MODE=dry_run node src/server.js

# Place a real PSTN call to YOUR phone using a real order's context
# (bypasses dispatch_mode + DND for one-off testing)
curl "http://localhost:3104/flow-test-livekit?\
shop=your-store.myshopify.com&order=%231234&phone=%2B91XXXXXXXXXX&lang=hi-IN"
```

---

## Configuration

### Core (single-shop deploys can stop here)

```bash
# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_SIP_TRUNK_ID=ST_...
LIVEKIT_AGENT_NAME=cod-confirm-priya
LIVEKIT_TOOL_SECRET=<random 32-byte hex>      # agent ↔ server tool auth

# TTS — production default is ElevenLabs; flip to Sarvam in 10 seconds for
# outage recovery without redeploying.
TTS_PROVIDER=elevenlabs                       # elevenlabs | sarvam
ELEVEN_API_KEY=sk_...
ELEVENLABS_VOICE_ID=<voice-id-from-your-library>
# ELEVENLABS_MODEL=eleven_turbo_v2_5          # optional, sane default

# STT (Sarvam is required regardless of TTS provider)
SARVAM_API_KEY=sk_...

# LLM
OPENAI_API_KEY=sk-...

# SIP trunk
VOBIZ_SIP_HOST=...
VOBIZ_SIP_USERNAME=...
VOBIZ_SIP_PASSWORD=...
VOBIZ_FROM_NUMBER=+91XXXXXXXXXX               # DLT-registered

# Database
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/cod_confirm?schema=public

# Server
PORT=3104
COD_CONFIRM_WEBHOOK_BASE=https://your-domain.com/cod-confirm

# Single-store branding (used as fallback when STORE_BRANDING doesn't list a shop)
STORE_NAME="Your Store"
STORE_CATEGORY="online store"

# Dispatch mode (dry_run = log only, live = real PSTN calls via scheduler)
DISPATCH_MODE=dry_run

# DND window (IST hours; default 20:00–10:00 — humane, not just TRAI's 9pm cutoff)
DND_START_HOUR=20
DND_END_HOUR=10

# Recording (optional — Cloudflare R2 recommended for $0 training-pull egress)
RECORDING_BACKEND=r2                          # r2 | s3 | gcp | "" (off)
RECORDING_BUCKET=your-bucket
RECORDING_PREFIX=cod-confirm/
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...

# DPDP Act consent disclosure played at greeting (default on)
RECORDING_CONSENT_DISCLOSURE=on

# Auto-hangup grace window after farewell (ms; default 10000)
AUTO_HANGUP_MS=10000

# Scheduler concurrency (default 1 — Vobiz / single-trunk safe;
# raise carefully after testing trunk capacity)
SCHEDULER_MAX_PER_TICK=1
```

### Multi-tenant (two or more shops on one agent)

```bash
# Allowlist — webhooks from shops not in this list are rejected (HTTP 403)
ALLOWED_SHOPS=shop-a.myshopify.com,shop-b.myshopify.com

# Per-shop webhook secret (one-app-per-shop is the Shopify recommendation)
SHOPIFY_WEBHOOK_SECRETS={"shop-a.myshopify.com":"shpss_aaa","shop-b.myshopify.com":"shpss_bbb"}

# Per-shop branding — the name Priya speaks + the category in the prompt
STORE_BRANDING={"shop-a.myshopify.com":{"name":"Shop A","category":"fashion store"},"shop-b.myshopify.com":{"name":"Shop B","category":"online store"}}
```

When a webhook arrives from `shop-a.myshopify.com`, the scheduler dispatches with `store_name="Shop A"` flowing into the system prompt; Priya says *"नमस्ते, मैं Priya बोल रही हूँ Shop A से..."*. No code changes per shop.

### One-time setup commands

```bash
# Create the SIP trunk in LiveKit (prints the LIVEKIT_SIP_TRUNK_ID for .env)
node src/create-sip-trunk.mjs

# Configure LiveKit Cloud webhook → https://your-domain.com/cod-confirm/webhook/livekit/egress-ready
# Enable: room_started, participant_joined, egress_started, egress_updated, egress_ended
```

---

## Repo layout

```
src/
├── server.js                  Express: Shopify webhooks, tool endpoints, LiveKit
│                              webhooks, /health, /flow-test-livekit
├── livekit-agent.js           LiveKit worker: Priya's session loop —
│                              STT/LLM/TTS wiring, tool definitions, prompt rendering,
│                              auto-hangup guard, parallel cold-start (currently serial)
├── trigger-livekit-call.js    Outbound SIP + recording egress initiator
├── lib/
│   ├── shops.js               Allowlist + getShopBranding(shop) helper
│   └── scheduler.js           DND-aware scheduler, retry logic, atomic outcome writes
└── create-sip-trunk.mjs       One-time trunk setup

prompts/
├── hindi-prompt.example.txt   Demo Hindi prompt (committed — generic)
├── english-prompt.example.txt Demo English prompt (committed — generic)
├── hindi-prompt.txt           Production-tuned (gitignored — see "Two-repo split")
├── english-prompt.txt         Production-tuned (gitignored)
└── README.md                  How the prompt-loading + override works

prisma/
├── schema.prisma              Session · ScheduledCall · CallAttempt · CallTurn
└── migrations-manual/

systemd/
├── cod-confirm.service        Express server unit
└── cod-confirm-agent.service  LiveKit agent worker unit

scripts/                       One-off operational scripts (e.g. find-yesterday-cod.mjs)
```

---

## Key engineering decisions

### Two-repo split: open engine, proprietary prompts

The architecture is open source. The actual tuned Hindi/English prompts — the IP that compounds with every call — live in a private repo and are loaded at runtime from `prompts/<lang>-prompt.txt`. The public repo ships `prompts/<lang>-prompt.example.txt` (deliberately generic demo prompts) so the engine stays runnable end-to-end for anyone cloning it.

`buildSystemPrompt()` reads `prompts/<lang>-prompt.txt` first; if absent, falls back to the `.example.txt` with a warning. This is the canonical pattern that other "engine open, tuning closed" projects (Stripe, Supabase) use, and it draws a clean line so future prompt iterations stay proprietary without retroactively trying to scrub git history.

See `prompts/README.md` for the placeholder convention.

### Speakable product names

Shopify SKUs are catalog-friendly but TTS-hostile (*"Maybach Frame Karan Aujla Edition Luxury Sunglass With Original Packing"*). The `speakableProduct(raw, lang)` helper maps the SKU through a category keyword table to a single spoken noun (`चश्मे` / `sunglasses`) before it ever reaches the prompt. Brand words never reach TTS, so they can't be mispronounced.

Unknown SKUs fall back to the first 3 words with a console warning — loud enough that you'll add the new category the first time it appears.

### Numbers spoken as words

`hindiRupees(2350)` → `"दो हज़ार तीन सौ पचास रुपय"` — fully expanded, no digits anywhere. Earlier hints like `"2350 रुपय (Hindi words: 2 हज़ार 350 रुपय)"` had the LLM read the digit prefix verbatim. Deterministic conversion (1 to 99,99,999) means the LLM has no other option than to speak words.

### Cancel needs a re-confirmation turn

`cancel_order` requires three steps in the prompt: (1) probe reason, (2) explicit yes/no re-confirmation, (3) only then fire the tool. STT misheard *"मैंने ही किया था"* as *"मैंने नहीं किया था"* in real testing — a single mistranscribed word would otherwise cancel a legitimate order. Two utterances now have to mishear in a row, which is much rarer.

### STT-affirmative tolerance

Sarvam Saaras in `hi-IN` mode often mangles English words spoken by Hindi customers (`"confirm confirm"` → `कंपं कंपं`). The prompt explicitly tells the LLM to treat short garbled tokens (`कंपं / कंफर्म / यस / ओके / श्योर / राइट`) as YES when they appear in response to a yes/no question and no negative cue is present. Negative direction is still gated by the skepticism rule above.

### Auto-hangup after farewell

Without explicit hangup the SIP leg stays open until the *customer* presses end. Customers who set the phone down thinking the call was over (common) burned VoIP minutes for as long as the trunk would tolerate. Now: any of the 4 terminal tools arms a one-shot `RoomServiceClient.deleteRoom` timer (`AUTO_HANGUP_MS`, default 10s) on the next assistant turn. If the customer hangs up first, the timer is cleared in the session-close handler.

### Tool call must precede farewell

Hard rule in the prompt and re-validated by the testing pattern: `confirm_order` / `cancel_order` / `request_human_agent` / `request_callback` MUST fire in the same LLM turn as the customer's final yes — not after. Otherwise customers hung up on the *"ठीक है, confirm कर रही हूँ"* line and the order never got tagged.

### TLS prewarm at child-process spawn

Child job processes pre-spawned by LiveKit each fire `HEAD` requests against `api.sarvam.ai`, `api.elevenlabs.io`, `api.openai.com` during `prewarm()`. This primes Node's TLS session cache + DNS resolver, cutting per-call WS upgrade latency by a couple of seconds.

### 8kHz native audio (matches SIP)

Both Sarvam (`sampleRate: 8000`) and ElevenLabs (`encoding: 'pcm_8000'`) generate audio natively at 8kHz. Avoids the 24k → 8k resample that introduces robotic artifacts on PSTN. Silero VAD is also configured for 8kHz to skip its own resample step.

### Backchannel-tolerant interruptions

`minInterruptionWords: 3` + `minInterruptionDuration: 600`. Indian customers backchannel heavily (*"हाँ हाँ"* / *"accha"* / *"ji ji"* while the agent is still speaking) — politeness, not interruption. Both gates must cross to count as a real barge-in. Real objections (*"nahi chahiye"*, *"mujhe nahi chahiye"*) are 3+ words and pass through.

### Welcome is non-interruptible

`session.say(welcome, { allowInterruptions: false })`. A real call (#9022) showed customers pressing phone buttons during the greeting; the DTMF tone passed VAD → speech interrupted → STT got no transcribable text → LLM had nothing to respond to → AgentActivity exited → 11s of dead air → customer hung up. Making the ~10s greeting non-interruptible avoids the entire failure path. Subsequent turns stay interruptible.

### AEC warmup at 500ms (not 3000ms default)

LiveKit's default disables interruptions for the first 3 seconds of every agent turn for echo-canceller stabilization. Reduced to 500ms — enough to settle on a SIP call while keeping barge-in responsive from the first half-second of each turn.

### Devanagari in prompts (not Latin transliteration)

Hindi phrases are written `के लिए` (Devanagari) not `ke liye` (Latin). Bulbul v3 and Samisha both pronounce Devanagari with correct vowel length / stress; Latin transliteration drifted to mispronunciations in testing.

### The moat is the data

Prompts are a commodity. Per-call assets:
- **Audio** — MP4/Opus in R2 keyed by LiveKit room name
- **Transcript** — `CallTurn` rows in PostgreSQL keyed by room name (one row per agent/customer/tool turn)
- **Outcome** — `ScheduledCall.outcome` after the terminal tool fires

This paired (audio, transcript, outcome) corpus is what gets fine-tuned into proprietary STT/TTS/LLM weights over time — none of which a competitor cloning the public repo can replicate without similar call volume.

---

## Multi-tenant

Onboarding a second (third, fourth) Shopify store:

1. Install the Custom App on the store (`read_orders` + `write_orders` scopes); `Session` row is created in PostgreSQL with the per-shop access token.
2. Add the shop's myshopify domain to `ALLOWED_SHOPS`.
3. Add the per-shop webhook secret to `SHOPIFY_WEBHOOK_SECRETS` JSON map.
4. Add the per-shop branding to `STORE_BRANDING` JSON map: `{"name":"Brand Name","category":"online store"}`.
5. Restart the Express service (the LiveKit agent worker doesn't need restart — branding flows through SIP participant attributes per call).

No code changes. The scheduler resolves `getShopBranding(row.shop)` per dispatch. At ~10+ stores this env-var JSON should move to a Shopify metafield-based lookup at dispatch time; until then JSON is fine.

---

## Shopify integration

1. Create a Custom App per store (one app per shop, per Shopify's recommendation — never share a single app across stores)
2. Subscribe the `orders/create` webhook to:
   `https://your-domain.com/cod-confirm/webhook/shopify/orders-create`
3. Add the shop to `ALLOWED_SHOPS` and the secret to `SHOPIFY_WEBHOOK_SECRETS` (see Multi-tenant above)

Tags written to the order after each conversation:

| Tag | Meaning |
|---|---|
| `cod-confirmed` | Customer confirmed; ship it |
| `cod-cancelled` | Customer cancelled (reason in note) |
| `cod-agent-needed` | Needs human follow-up (details in note) |
| `cod-callback-requested` | Customer wants a callback (time in note) |

---

## Data pipeline

Every call produces three assets keyed by LiveKit room name:

```
CallTurn        room_name · turn_index · role · text
                · tool_name · tool_args · tool_result
                · lang · stt_confidence · started_at

ScheduledCall   shop · orderId · phone · status · attempts
                · scheduledAt · outcome · outcomeNote

R2 audio        s3://{bucket}/{prefix}{room_name}.mp4
```

The egress webhook (`/webhook/livekit/egress-ready`) writes the `audioUri` back onto the corresponding `CallAttempt` row, so transcripts and audio are joinable by `room_name` for downstream training-data extraction.

---

## Production notes

- **DLT compliance**: Indian telecom regulations require DLT-registered headers on outbound calls. Your SIP trunk provider must have a 140-series DLT-registered caller ID.
- **DND window**: Default 20:00–10:00 IST (humane window, tighter than TRAI's 21:00 cutoff). The `/flow-test-livekit` endpoint bypasses DND for testing.
- **Scheduler concurrency**: `SCHEDULER_MAX_PER_TICK=1` (default) keeps single-trunk providers happy. Raising it without verifying trunk capacity caused parallel-dispatch failures in our testing; raise carefully.
- **Tool auth**: Agent → server tool calls authenticated with `LIVEKIT_TOOL_SECRET` via `X-COD-Tool-Secret` header + `crypto.timingSafeEqual` comparison. Never expose tool endpoints publicly without this.
- **Outcome atomicity**: Outcome writes use `updateMany` with a non-terminal-status guard so parallel workers can't double-write a confirmed-then-cancelled order. First terminal-tool call wins.
- **Retry**: Failed dispatches (no answer / SIP error) retry up to `MAX_ATTEMPTS` (default 3) with exponential backoff via the scheduler.
- **Recording delay**: Egress is started ~10s after dispatch so the agent has time to publish its audio track before the room-composite compositor starts. Avoids "audio missing first 5s of greeting" recordings.

---

## Adapting

- **Brand**: Set `STORE_NAME` / `STORE_CATEGORY` (single-tenant) or `STORE_BRANDING` (multi-tenant) — no code edits.
- **TTS voice**: Change `ELEVENLABS_VOICE_ID` (must be in your ElevenLabs library). For Sarvam Bulbul, edit `speaker:` in `buildTTS()` — supported v3 female voices: `ritu`, `priya`, `neha`, `pooja`, `simran`, `kavya`, `ishita`, `shreya`, `roopa`, `amelia`, `sophia`, `tanya`, `shruti`, `suhani`, `kavitha`, `rupali`.
- **Prompt tuning**: edit `prompts/<lang>-prompt.txt` (gitignored — keep it in your private repo). Use the `{{placeholder}}` slots; full list in `prompts/README.md`.
- **New product category**: add one line to `CATEGORY_MAP` in `livekit-agent.js`.
- **Call timing**: adjust `CALL_DELAY_MS` and `DND_*_HOUR` env vars.
- **Multi-store**: see "Multi-tenant" above.

---

## License

Business Source License 1.1 — see [LICENSE](LICENSE). Converts to Apache 2.0 on 2030-04-18. Production use is permitted except for offering the software as a competing hosted/embedded product. For commercial licensing, contact `support@glitchexecutor.com`.

---

Built by [Glitch Executor Labs](https://glitchexecutor.com) — AI systems for Indian e-commerce.
