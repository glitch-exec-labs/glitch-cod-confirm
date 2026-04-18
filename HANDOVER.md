# Session Handover — 2026-04-18

Snapshot of everything shipped this session, current production state, and what's left to do. Start here when resuming.

---

## Production state

| Component | Status |
|---|---|
| `cod-confirm.service` (Express, :3104) | 🟢 active · `DISPATCH_MODE=live` |
| `cod-confirm-agent.service` (LiveKit worker) | 🟢 active |
| Shopify webhook (`orders/create`) | 🟢 wired, HMAC-verified |
| LiveKit webhooks (`/webhook/livekit/egress-ready`) | 🟢 wired, JWT-verified via `WebhookReceiver` |
| Vobiz SIP trunk | 🟢 outbound IN working · ❌ international (CA tested, blocked) |
| Cloudflare R2 (`glitch-cod-recordings`) | 🟢 MP4/Opus landing under `cod-confirm/` prefix |
| PostgreSQL (CallTurn + CallAttempt) | 🟢 per-turn transcript persistence working |
| Shopify tag writes | 🟢 verified on order #8973 (`cod-confirmed`) |
| License | 🟢 BSL 1.1, change date 2030-04-18, Apache 2.0 successor |

**Last successful end-to-end call:** `cod-8973-1776469400808`
- 13 turns captured to `CallTurn`
- `confirm_order` tool fired same-turn as customer's "हाँ"
- Shopify `cod-confirmed` tag written
- Audio egress `EG_U6UomGvKjeqq` → `r2://glitch-cod-recordings/cod-confirm/cod-8973-1776469400808.mp4`

---

## Everything shipped this session

### GitHub issues closed (#7–#12)
All six P1/P2 issues fixed + closed with notes on test gaps:
- #7 — Agent trusted 2xx; now validates `data.ok === true`
- #8 — Tool endpoints now require `X-COD-Tool-Secret` header (`timingSafeEqual`)
- #9 — COD detection normalized (strips non-alphanum, handles all Shopify gateway variants)
- #10 — `livekitTagUpdate` returns proper 4xx/5xx instead of 200+`{ok:false}`
- #11 — `updateOrderTag` throws on HTTP non-2xx, non-JSON, GraphQL errors
- #12 — Scheduler split into two phases; atomic `updateMany` with `outcome=null` for first-write-wins

### Data moat foundation (the actual business asset)
- **`CallTurn` model** — one row per utterance (user / assistant / tool), `@@unique([roomName, turnIndex])` for idempotent upserts
- **`CallAttempt` extended** — `audioUri`, `audioFormat`, `audioDurationMs`, `audioSampleRate`, `lang`, `consentGiven`, `turnCount`
- **Per-turn webhook** — `POST /webhook/livekit/turn` from agent (fire-and-forget, shared-secret auth)
- **LiveKit egress webhook** — `POST /webhook/livekit/egress-ready` with dual auth (JWT via `WebhookReceiver` OR `X-COD-Tool-Secret` fallback)
- **R2 audio egress** — started 10s after dispatch (gives agent time to publish tracks), MP4/Opus format via `EncodingOptions({ audioCodec: AudioCodec.OPUS })`
- **DPDP consent disclosure** — added to welcome message, toggle via `RECORDING_CONSENT_DISCLOSURE`

### Voice quality + correctness fixes
- **Assistant transcript extraction** — was using `item.content` (array of parts), now uses `item.textContent` (SDK getter)
- **Egress codec** — OGG → MP4+Opus resolved "no supported codec compatible with all outputs"
- **Tool-fires-same-turn** — prompt rewritten so `confirm_order` fires *before* the farewell phrase, in the same LLM turn as customer's "हाँ". Previously the tool was a deferred step and never fired if customer hung up first.
- **AEC warmup tuning** — 3000ms → 500ms. SDK disables interruptions during AEC warmup; 3s was blocking barge-in for the entire first 3 seconds of every Priya turn.
- **LLM token cap** — `maxTokens: 120` on gpt-4o-mini (Priya only speaks 1–2 short sentences; uncapped generation was adding latency)
- **`minInterruptionWords: 2`** — prevents single-syllable noise from cutting Priya off

### Security + repo hygiene
- Git history scrubbed of client references via `git filter-repo` + force-push
- Three R2 credential leaks rotated (final AKID starts `0cab`)
- `gitleaks` pre-commit hook deployed (caught nothing since the rotation)
- LiveKit Cloud webhook has `X-COD-Tool-Secret` removed (dead header)
- LICENSE switched from MIT → BSL 1.1 (change date 2030-04-18, successor Apache 2.0)
- README fully rewritten to reflect shipped pipeline

---

## Known issues / open items

### Urgent
- **TTS "inference slower than realtime"** at call start — ~200–800ms delays from Sarvam TTS during the first few seconds. Root cause unconfirmed; likely network latency to Sarvam API or stream chunk buffering. User reported "Priya hangs mid-conversation" — may or may not be related.

### Important
- **No regression tests** for any of the 6 closed GitHub issues (called out in every close comment). Next developer should add at least smoke-level tests before touching tool endpoints.
- **Issue #2 still open** — per-shop prompt customization via Shopify metafields. Metafield resolution at dispatch time isn't built yet. Current `STORE_NAME`/`STORE_CATEGORY` env vars are single-tenant only.
- **Vobiz blocks international** — CA test number didn't ring. Irrelevant for production (India-only customers) but flag for any future expansion.

### Nice-to-have
- Migrate legacy files out of `src/` — `setup-retell-agent.mjs`, `setup-bolna-agent.mjs`, `update-retell-agent.mjs` are dead code
- Dashboard for CallTurn analytics (confirm rate, cancel reasons, turn counts per outcome)
- Move LiveKit egress webhook events to a typed event router instead of the current `if/else` chain

---

## Key files changed this session

| File | What |
|---|---|
| `src/server.js` | LiveKit webhook handlers (`/turn`, `/egress-ready`), `WebhookReceiver`, dual auth, rawBody capture, express.json type expansion |
| `src/livekit-agent.js` | `postTurn()` fire-and-forget, consent disclosure, textContent fix, AEC warmup tuning, maxTokens cap, minInterruptionWords, tool-fires-same-turn prompt |
| `src/trigger-livekit-call.js` | R2/S3/GCP egress upload builder, 10s delayed egress start, MP4+Opus codec |
| `src/lib/scheduler.js` | Two-phase dispatch, atomic first-write-wins outcome recording |
| `prisma/schema.prisma` | New `CallTurn` model, extended `CallAttempt`, new index |
| `prisma/migrations-manual/20260416210000_data_moat/migration.sql` | Production migration for CallTurn + CallAttempt columns |
| `.env.example` | All new env vars documented |
| `README.md` | Full rewrite — architecture diagram, data pipeline, design decisions, production notes |
| `LICENSE` | BSL 1.1 with Glitch Executor Labs as licensor, 2030-04-18 change date |
| `HANDOVER.md` | This file |

---

## Env vars added / changed

```bash
# New — tool auth
LIVEKIT_TOOL_SECRET=<strong-random-32+ char>

# New — brand context (single-tenant; multi-tenant via metafields is future work)
STORE_NAME="Urban Classics Store"
STORE_CATEGORY=fashion

# New — audio recording
RECORDING_BACKEND=r2
RECORDING_BUCKET=glitch-cod-recordings
RECORDING_PREFIX=cod-confirm/
R2_ACCOUNT_ID=<redacted>
R2_ACCESS_KEY_ID=<rotated, AKID starts 0cab>
R2_SECRET_ACCESS_KEY=<rotated>
RECORDING_CONSENT_DISCLOSURE=on

# Existing — now in live mode
DISPATCH_MODE=live
```

---

## How to resume

### Start a call to verify everything still works
```bash
curl "http://127.0.0.1:3104/flow-test-livekit?shop=f51039.myshopify.com&order=8973&phone=%2B919039999585"
# Expected: ok:true, room_name, sip participantId, egress_id:null
# (egress_id in response is always null — actual egress fires 10s later, see logs)
```

### Verify pipeline end-to-end after a call
```bash
# 1. CallTurn rows
PSQL_URL="${DATABASE_URL%%\?*}" psql "$PSQL_URL" \
  -c "SELECT role, text, \"turnIndex\" FROM \"CallTurn\" WHERE \"roomName\" LIKE 'cod-8973%' ORDER BY \"turnIndex\";"

# 2. Egress started + completed
sudo journalctl -u cod-confirm.service --since "5 minutes ago" | grep -i egress

# 3. Shopify tag (check admin)
# Order should have: cod-confirmed | cod-cancelled | cod-agent-needed | cod-callback-requested
```

### If server is down
```bash
sudo systemctl status cod-confirm.service cod-confirm-agent.service
sudo journalctl -u cod-confirm.service --since "10 minutes ago" --no-pager | tail -40
```

### Next suggested work (in priority order)
1. Investigate + fix TTS "inference slower than realtime" — likely the #1 user-visible issue
2. Add regression tests for the 6 closed issues (#7–#12)
3. Close issue #2 — per-shop metafield resolution at dispatch time
4. Delete legacy `setup-retell-*.mjs` / `setup-bolna-*.mjs` files

---

## Contact

Commercial licensing / enterprise deployment: **support@glitchexecutor.com**
