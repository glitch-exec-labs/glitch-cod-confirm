# Glitch COD Confirm

**AI voice agent that calls Indian e-commerce customers to confirm cash-on-delivery orders, cutting RTO (return to origin) rates by catching cancellations, wrong addresses, and fake orders before dispatch.**

Built for Shopify stores selling in India where 60-70% of orders are COD and RTO rates run 25-40%.

https://github.com/user-attachments/assets/placeholder

---

## How it works

```
Shopify order webhook ──► Express server (10 min delay) ──► LiveKit SIP call
                                                                │
                               Customer answers phone ◄────────┘
                                        │
                   ┌────────────────────┤
                   ▼                    ▼                    ▼
             Sarvam STT           GPT-4o-mini          Sarvam TTS
           (Saaras v3)         (conversation AI)     (Bulbul v3 @ 8kHz)
                   │                    │                    │
                   └────────────────────┤
                                        ▼
                              Tool call decision:
                      confirm_order │ cancel_order │
                    request_human_agent │ request_callback
                                        │
                                        ▼
                          Shopify GraphQL orderUpdate
                        (tag + note written in ~2 seconds)
```

**"Priya"** is a bilingual (Hindi/English) voice agent that:

1. Calls the customer 10 minutes after order placement
2. Confirms the product, amount, and delivery address
3. Handles cancellations, objections, and human-agent requests naturally
4. Writes confirmation/cancellation tags back to Shopify immediately

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Voice agent framework** | [LiveKit Agents JS](https://github.com/livekit/agents-js) v1.2.x | Real-time WebRTC rooms with SIP bridging, first-class Node.js SDK |
| **TTS** | [Sarvam AI](https://sarvam.ai) Bulbul v3 (`neha` voice, 8kHz native) | Best-in-class Hindi telephony TTS. Native 8kHz output skips the 24k→8k resample that makes other TTS sound robotic on phone calls |
| **STT** | Sarvam Saaras v3 (`hi-IN`) | Handles Hindi-English code-switching (Hinglish) natively |
| **LLM** | OpenAI GPT-4o-mini | Fast, cheap, good enough for structured COD conversations |
| **Turn detection** | LiveKit Multilingual Model | Hindi-safe turn detection — doesn't cut off mid-sentence on Hindi speech patterns |
| **VAD** | Silero (prewarmed per worker) | Low-latency voice activity detection |
| **Telephony** | Vobiz SIP trunk via LiveKit outbound | DLT-registered Indian caller ID, PSTN termination |
| **Backend** | Express.js + Prisma + PostgreSQL | Shopify session management, webhook handling, order state |
| **Hosting** | Shopify Custom App (webhook source) | `orders/create` webhook triggers the call flow |

## Key design decisions

**Why 8kHz native TTS matters:**
LiveKit's Sarvam plugin defaults to 24kHz output, which gets resampled down to 8kHz for the SIP/PSTN leg. That resample introduces artifacts that make the voice sound robotic. Setting `sampleRate: 8000` on the Sarvam TTS constructor tells Bulbul v3 to generate at 8kHz natively — matching [Sarvam's own cookbook config](https://docs.sarvam.ai/) — and produces a dramatically more natural voice on phone calls.

**Why Devanagari in the system prompt:**
Hindi prompts are written in Devanagari script (`के लिए`), not Latin transliteration (`ke liye`). Bulbul v3 handles Devanagari natively with correct vowel length and stress. Latin transliteration caused mispronunciations like "thi liye" in testing.

**Why LiveKit over Bolna/Retell:**
We evaluated three platforms before settling on LiveKit:
- **Retell + ElevenLabs**: User feedback was "voice feels too choppy and looks like AI bot"
- **Bolna + Sarvam**: Three independent bugs blocked go-live (broken `api_tools` validator, silent Vobiz uplink failure, Twilio queue stall)
- **LiveKit + Sarvam**: Full control over audio pipeline, native 8kHz output, self-hosted agent worker. First real PSTN test feedback: "much better than all previous tests"

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL
- [pnpm](https://pnpm.io/)
- A [LiveKit Cloud](https://livekit.io/) project (or self-hosted LiveKit server)
- A [Sarvam AI](https://sarvam.ai/) API key
- An [OpenAI](https://platform.openai.com/) API key
- A SIP trunk provider (we use [Vobiz](https://vobiz.ai/)) with a DLT-registered Indian number
- A Shopify store with a Custom App that has `read_orders` and `write_orders` scopes

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
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_SIP_TRUNK_ID=ST_...        # created by src/create-sip-trunk.mjs

# Voice AI
SARVAM_API_KEY=sk_...
OPENAI_API_KEY=sk-...

# SIP trunk (Vobiz or your provider)
VOBIZ_SIP_HOST=sip.your-provider.com
VOBIZ_SIP_USERNAME=your_sip_user
VOBIZ_SIP_PASSWORD=your_sip_pass
VOBIZ_FROM_NUMBER=+91XXXXXXXXXX

# Shopify
SHOPIFY_WEBHOOK_SECRET=your_webhook_hmac_secret
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/cod_confirm

# Server
PORT=3104
NODE_ENV=production
COD_CONFIRM_WEBHOOK_BASE=https://your-domain.com/cod-confirm
```

### Create SIP trunk (one-time)

```bash
node -r dotenv/config src/create-sip-trunk.mjs
# Prints LIVEKIT_SIP_TRUNK_ID — paste into .env
```

### Run

Two processes (use systemd, pm2, or two terminals):

```bash
# 1. Express webhook server (receives Shopify webhooks, serves tool endpoints)
node src/server.js

# 2. LiveKit agent worker (connects to LiveKit Cloud, handles voice calls)
node src/livekit-agent.js start
```

### Test

```bash
# Browser-based test (no phone needed — uses LiveKit web playground)
curl "http://localhost:3104/flow-test-livekit?shop=your-store.myshopify.com&order=%238917"
# Returns a URL — open it in browser to talk to Priya

# Real PSTN call test (requires SIP trunk + Indian phone number)
curl "http://localhost:3104/flow-test-livekit?shop=your-store.myshopify.com&order=%238917&phone=%2B91XXXXXXXXXX"
```

### Bilingual support

Default language is Hindi (`hi-IN`). Switch to English with:

```bash
curl "http://localhost:3104/flow-test-livekit?shop=...&order=...&lang=en-IN"
```

The `lang` parameter controls STT language, TTS voice, system prompt, and welcome message as a set.

## Shopify integration

1. Create a Custom App in your Shopify admin with `read_orders` and `write_orders` scopes
2. Subscribe to the `orders/create` webhook pointing to `https://your-domain.com/cod-confirm/webhook/shopify/orders-create`
3. Set `SHOPIFY_WEBHOOK_SECRET` in `.env` to the webhook's HMAC secret

When a COD order comes in, the server waits 10 minutes (configurable) then initiates an outbound call. After the conversation, one of these tags is written to the order:

| Tag | Meaning |
|-----|---------|
| `cod-confirmed` | Customer confirmed the order |
| `cod-cancelled` | Customer cancelled (reason captured in order note) |
| `cod-agent-needed` | Customer needs human help (details in note) |
| `cod-callback-requested` | Customer asked to be called back (time in note) |

## Architecture

```
src/
├── server.js              # Express app: Shopify webhooks, tool endpoints, flow tests
├── livekit-agent.js       # LiveKit agent worker: Priya's brain (STT/LLM/TTS/tools)
├── trigger-livekit-call.js # Outbound call initiator via LiveKit SIP
├── create-sip-trunk.mjs   # One-time SIP trunk setup helper
├── setup-retell-agent.mjs # (Legacy) Retell agent setup — kept for reference
├── setup-bolna-agent.mjs  # (Legacy) Bolna agent setup — kept for reference
└── update-retell-agent.mjs # (Legacy) Retell update helper

prisma/
└── schema.prisma          # Session + order state schema

systemd/
└── cod-confirm-agent.service  # systemd unit for the LiveKit agent worker
```

## Production notes

- **DLT compliance**: Indian telecom regulations require DLT registration for outbound calls. Your SIP trunk provider must have a DLT-registered caller ID with a 140-series header.
- **Call delay**: The 10-minute delay between order and call is intentional — it gives customers time to complete payment flows and reduces "I just placed it" confusion.
- **Silero VAD prewarming**: The VAD model is loaded once per worker process in the `prewarm` hook, not per-call. This saves ~2s cold-start per call.
- **Error handling**: Tool endpoints return `{ ok: false, error: "..." }` on failure. Priya's LLM receives this and gracefully handles it ("Let me connect you to our team").

## Adapting for your store

1. **Brand name**: Set `STORE_NAME` and `STORE_CATEGORY` in `.env` — these feed the Hindi + English prompts in `src/livekit-agent.js` at runtime, no code edits needed
2. **Prompts**: Edit `hindiPrompt()` and `englishPrompt()` in `src/livekit-agent.js`
3. **Voice**: Change the `speaker` option in the TTS config. See the comment in the source for the full list of Bulbul v3 voices
4. **Language**: Add more languages by extending `buildSystemPrompt()` and `buildWelcome()` with new language branches

## License

MIT

---

Built by [Glitch Executor](https://glitchexecutor.com) — AI systems for e-commerce and trading.
