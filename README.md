# Glitch COD Confirm

**AI voice agent that calls Indian e-commerce customers to confirm cash-on-delivery orders — cutting RTO rates by catching cancellations, wrong addresses, and fake orders before dispatch. Every call is transcribed and recorded to build a proprietary training dataset.**

Built for Shopify stores selling in India where 60–70% of orders are COD and RTO rates run 25–40%.

---

## How it works

```
Shopify orders/create webhook
         │
         ▼ (10-min delay, DND-aware scheduler)
  LiveKit room created
         │
         ├──► Agent (Priya) dispatched into room
         │
         ├──► Outbound SIP call → customer's phone (Vobiz trunk)
         │
         └──► Audio egress → Cloudflare R2 (.mp4, Opus)
                   │
         Customer answers
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
Sarvam STT    GPT-4o-mini    Sarvam TTS
(Saaras v3)  (structured    (Bulbul v3,
              conversation)  8kHz native)
    │              │              │
    └──────────────┼──────────────┘
                   │
         Per-turn transcript
         persisted → PostgreSQL
         (CallTurn table)
                   │
         Tool call decision:
    confirm_order │ cancel_order │
 request_human_agent │ request_callback
                   │
         Shopify GraphQL orderUpdate
       (tag + note written, ~2 seconds)
```

**"Priya"** is a bilingual (Hindi/English) voice agent that:

1. Calls the customer 10 minutes after order placement (configurable, DND-window aware)
2. Confirms the product, amount, and delivery address in natural Hinglish
3. Handles cancellations, objections, and human-agent requests gracefully
4. Writes confirmation/cancellation tags back to Shopify immediately via GraphQL
5. Records every call to Cloudflare R2 and captures every turn to PostgreSQL — building a proprietary dataset for future model fine-tuning

---

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Voice agent framework** | [LiveKit Agents JS](https://github.com/livekit/agents-js) v1.2.x | Real-time WebRTC rooms with SIP bridging, first-class Node.js SDK |
| **TTS** | [Sarvam AI](https://sarvam.ai) Bulbul v3 (`neha` voice, 8kHz native) | Best-in-class Hindi telephony TTS. Native 8kHz output skips the 24k→8k resample that makes other TTS sound robotic on phone calls |
| **STT** | Sarvam Saaras v3 (`hi-IN`) | Handles Hindi-English code-switching (Hinglish) natively |
| **LLM** | OpenAI GPT-4o-mini (120 token cap) | Fast and cheap; 120-token cap keeps responses to 1–2 sentences and cuts post-interruption latency |
| **Turn detection** | LiveKit Multilingual Model | Hindi-safe turn detection — doesn't cut off mid-sentence on Hindi speech patterns |
| **VAD** | Silero (prewarmed per worker) | Low-latency voice activity detection, shared across calls |
| **Telephony** | Vobiz SIP trunk via LiveKit outbound | DLT-registered Indian caller ID, PSTN termination |
| **Backend** | Express.js + Prisma + PostgreSQL | Shopify sessions, webhook handling, call state, per-turn transcript storage |
| **Audio storage** | Cloudflare R2 (S3-compatible) | $0 egress fees; MP4/Opus recordings paired with CallTurn rows for training data |
| **Shopify** | Custom App webhook (`orders/create`) | HMAC-verified, COD-only filter, per-shop session management |

---

## Key design decisions

### 8kHz native TTS
LiveKit's Sarvam plugin defaults to 24kHz output, which gets resampled down to 8kHz for the SIP/PSTN leg. That resample introduces artifacts that make the voice sound robotic. Setting `sampleRate: 8000` on the Sarvam TTS constructor tells Bulbul v3 to generate at 8kHz natively — matching Sarvam's own benchmark config — and produces a dramatically more natural voice on phone calls.

### Devanagari in the system prompt
Hindi prompts are written in Devanagari script (`के लिए`), not Latin transliteration (`ke liye`). Bulbul v3 handles Devanagari natively with correct vowel length and stress. Latin transliteration caused mispronunciations in testing.

### AEC warmup tuned to 500ms
The LiveKit SDK runs an Acoustic Echo Cancellation warmup period at the start of each agent turn during which interruptions are fully disabled. The default is 3000ms — meaning a customer who speaks in the first 3 seconds is completely ignored. We reduced this to 500ms, which is enough to stabilise the echo canceller on a SIP call while keeping barge-in responsive from the first half-second.

### Tool call fires before farewell
A critical LLM behaviour constraint: Priya is instructed to call `confirm_order` / `cancel_order` in the **same LLM turn** as the customer's final confirmation — not after. Without this, the model said the confirmation phrase, waited for the customer's next utterance, and then called the tool. If the customer hung up before that next turn (common), the Shopify order was never tagged.

### The moat is the data, not the prompts
Prompts are a commodity. Every call generates:
- **Audio file** — MP4/Opus in Cloudflare R2, keyed by LiveKit room name
- **Per-turn transcript rows** — `CallTurn` table in PostgreSQL, one row per utterance (agent + customer + tool calls), linked to the room name

This paired audio+transcript corpus is the asset — used to fine-tune Sarvam STT/TTS on actual Indian COD call patterns over time.

### Consent disclosure
Every call opens with a recording consent disclosure in Hindi and English (required under India's DPDP Act 2023). Disable with `RECORDING_CONSENT_DISCLOSURE=off` for non-recording deployments.

---

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL
- [pnpm](https://pnpm.io/)
- A [LiveKit Cloud](https://livekit.io/) project
- A [Sarvam AI](https://sarvam.ai/) API key
- An [OpenAI](https://platform.openai.com/) API key
- A SIP trunk provider (Vobiz or similar) with a DLT-registered Indian number
- A Shopify store with a Custom App (`read_orders` + `write_orders` scopes)
- A [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket (optional — for audio recording)

### Install

```bash
git clone https://github.com/glitch-exec-labs/glitch-cod-confirm.git
cd glitch-cod-confirm
pnpm install
cp .env.example .env
# Edit .env with your credentials
npx prisma generate
npx prisma db push
```

### Configure .env

```bash
# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_SIP_TRUNK_ID=ST_...           # created by src/create-sip-trunk.mjs
LIVEKIT_AGENT_NAME=cod-confirm-priya  # must match the worker's defineAgent name
LIVEKIT_TOOL_SECRET=strong-random-secret  # shared secret between agent ↔ server

# Voice AI
SARVAM_API_KEY=your_sarvam_key
OPENAI_API_KEY=sk-...

# SIP trunk (Vobiz or your provider)
VOBIZ_SIP_HOST=xxxx.sip.vobiz.ai
VOBIZ_SIP_USERNAME=your_sip_user
VOBIZ_SIP_PASSWORD=your_sip_pass
VOBIZ_FROM_NUMBER=+91XXXXXXXXXX       # DLT-registered number

# Shopify
SHOPIFY_WEBHOOK_SECRET=your_webhook_hmac_secret

# Database
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/cod_confirm?schema=public

# Server
PORT=3104
NODE_ENV=production
COD_CONFIRM_WEBHOOK_BASE=https://your-domain.com/cod-confirm

# Brand (feeds Priya's prompts at runtime — no code edits needed)
STORE_NAME="Your Store Name"
STORE_CATEGORY=fashion           # e.g. fashion, electronics, homeware

# Dispatch mode (dry_run = log only, live = real calls)
DISPATCH_MODE=dry_run

# Audio recording (optional — Cloudflare R2)
RECORDING_BACKEND=r2             # r2 | s3 | gcp
RECORDING_BUCKET=your-bucket-name
RECORDING_PREFIX=cod-confirm/
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key

# DPDP Act consent disclosure (default: on)
RECORDING_CONSENT_DISCLOSURE=on
```

### Create SIP trunk (one-time)

```bash
node -r dotenv/config src/create-sip-trunk.mjs
# Prints LIVEKIT_SIP_TRUNK_ID — paste into .env
```

### Configure LiveKit webhooks

In your LiveKit Cloud project settings, add a webhook pointing to:
```
https://your-domain.com/cod-confirm/webhook/livekit/egress-ready
```
Enable at minimum: `room_started`, `participant_joined`, `egress_started`, `egress_updated`, `egress_ended`.

### Run

Two processes (use systemd, pm2, or two terminals):

```bash
# 1. Express webhook server
node src/server.js

# 2. LiveKit agent worker
node src/livekit-agent.js start
```

Systemd unit files for both services are in `systemd/`.

### Test without a real call

```bash
# Dry-run: dispatches agent + shows what would be called (no PSTN call)
DISPATCH_MODE=dry_run node src/server.js
curl "http://localhost:3104/flow-test-livekit?shop=your-store.myshopify.com&order=1234"

# Live PSTN call to a specific number (bypasses DND window)
curl "http://localhost:3104/flow-test-livekit?shop=your-store.myshopify.com&order=1234&phone=%2B91XXXXXXXXXX"

# English call
curl "http://localhost:3104/flow-test-livekit?...&lang=en-IN"
```

---

## Shopify integration

1. Create a Custom App in Shopify admin with `read_orders` + `write_orders` scopes
2. Subscribe the `orders/create` webhook to:
   `https://your-domain.com/cod-confirm/webhook/shopify/orders-create`
3. Set `SHOPIFY_WEBHOOK_SECRET` in `.env`

After each conversation, one of these tags is written to the order:

| Tag | Meaning |
|-----|---------|
| `cod-confirmed` | Customer confirmed — ship it |
| `cod-cancelled` | Customer cancelled (reason in order note) |
| `cod-agent-needed` | Needs human follow-up (details in note) |
| `cod-callback-requested` | Customer asked for callback (time in note) |

---

## Data pipeline

Every call produces two assets, keyed by LiveKit room name:

### CallTurn (PostgreSQL)
One row per conversation turn — agent speech, customer utterances, and tool calls.

```
room_name · turn_index · role (user/assistant/tool) · text
· tool_name · tool_args · tool_result · lang · stt_confidence
```

### Audio recording (Cloudflare R2)
MP4/Opus file at `{RECORDING_PREFIX}{room_name}.mp4`. Recording starts 10 seconds after dispatch (gives the agent time to join and publish its audio track before the egress compositor starts).

The paired audio+transcript corpus is the foundation for fine-tuning STT/TTS/LLM on real Indian COD call patterns.

---

## Architecture

```
src/
├── server.js               # Express: Shopify webhooks, tool endpoints, LiveKit webhooks,
│                           #   health check, flow-test-livekit
├── livekit-agent.js        # LiveKit agent worker: Priya (STT/LLM/TTS/tools/turn persist)
├── trigger-livekit-call.js # Outbound call + audio egress initiator
├── lib/
│   └── scheduler.js        # Cron-based call scheduler (DND window, retry logic,
│                           #   atomic first-write-wins outcome recording)
└── create-sip-trunk.mjs    # One-time SIP trunk setup

prisma/
├── schema.prisma           # ShopifySession · CallAttempt · CallTurn models
└── migrations-manual/      # Hand-authored migrations for production deployments

systemd/
├── cod-confirm.service         # Express server unit
└── cod-confirm-agent.service   # LiveKit agent worker unit
```

---

## Production notes

- **DLT compliance**: Indian telecom regulations require DLT registration for outbound calls. Your SIP trunk provider must have a DLT-registered caller ID with a 140-series header.
- **DND window**: The scheduler blocks calls between 21:00–09:00 IST by default. The `flow-test-livekit` endpoint bypasses this for testing.
- **Call delay**: 10 minutes between order placement and call. Gives customers time to complete payment flows and reduces "I just placed it" confusion.
- **Dispatch mode**: `DISPATCH_MODE=dry_run` lets the scheduler run without making real PSTN calls — useful for staging environments.
- **Silero VAD prewarming**: The VAD model is loaded once per worker process in the `prewarm` hook. Saves ~2s cold-start per call.
- **Retry logic**: Failed calls (no answer, error) are retried up to `MAX_ATTEMPTS` times (default: 3) with exponential backoff. Outcome is written with atomic `updateMany` (first-write-wins — parallel workers can't double-write).
- **Tool auth**: Agent-to-server tool calls are authenticated with `LIVEKIT_TOOL_SECRET` via `X-COD-Tool-Secret` header + `crypto.timingSafeEqual` comparison. Never expose tool endpoints publicly without this.

---

## Adapting for your store

1. **Brand**: Set `STORE_NAME` and `STORE_CATEGORY` in `.env` — no code edits needed
2. **Voice**: Change the `speaker` value in `livekit-agent.js`. Supported Bulbul v3 female voices: `ritu`, `priya`, `neha`, `pooja`, `simran`, `kavya`, `ishita`, `shreya`, `roopa`, `amelia`, `sophia`, `tanya`, `shruti`, `suhani`, `kavitha`, `rupali`
3. **Language**: Add branches to `buildSystemPrompt()` and `buildWelcome()` for new languages
4. **Call timing**: Adjust `CALL_DELAY_MS` (default 600000) and DND window in `scheduler.js`
5. **Multi-store**: Pass `store_name` / `store_category` per order at dispatch time — they flow through as participant attributes to the agent

---

## License

Business Source License 1.1 — see [LICENSE](LICENSE). Converts to Apache 2.0 on 2030-04-18. Production use is permitted except for offering the software as a competing hosted/embedded product. For commercial licensing, contact licensing@glitchexecutor.com.

---

Built by [Glitch Executor](https://glitchexecutor.com) — AI systems for Indian e-commerce.
