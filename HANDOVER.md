# Session Handover — 2026-04-19

Latest snapshot. Start here when resuming. Previous session logs are at the bottom for reference.

---

## 🟢 Production state (2026-04-19 ~05:55 IST)

| Component | Status |
|---|---|
| `cod-confirm.service` (Express, :3104) | 🟢 active · `DISPATCH_MODE=live` |
| `cod-confirm-agent.service` (LiveKit worker) | 🟢 active, VAD prewarmed at 8 kHz |
| Shopify webhook (`orders/create`) | 🟢 HMAC via per-shop map (1 shop: Urban) |
| LiveKit webhooks (`/webhook/livekit/egress-ready`) | 🟢 JWT-verified via `WebhookReceiver` |
| Vobiz SIP trunk | 🟢 India outbound · ❌ international (CA blocked) |
| Cloudflare R2 (`glitch-cod-recordings`) | 🟢 MP4/Opus landing |
| PostgreSQL (CallTurn + CallAttempt + Session) | 🟢 per-turn transcripts working |
| Shopify tag writes | 🟢 verified (`cod-confirmed` on #8973) |
| Allowed shops | `f51039.myshopify.com` (Urban Classics only) |
| DND window | **20:00 → 10:05 IST** (10-hour call window) |
| Freshness cutoff | `QUEUE_ONLY_AFTER=2026-04-19T00:25:25Z` · `MAX_ORDER_AGE_HOURS=6` |
| License | 🟢 BSL 1.1, change date 2030-04-18, Apache 2.0 successor |

**First real production call expected:** 10:05 AM IST, 2026-04-19. No backfill — stale orders from Shopify's retry queue get 200-ack'd but skipped.

---

## 🏪 The 4 Urban-family stores (live data)

| Store | Shopify handle | App (Dev Dashboard) | Auth slug | Orders/30d | COD% | AOV | Call cost/mo @ ₹10.98 |
|---|---|---|---|---|---|---|---|
| **Urban Classics** | `f51039.myshopify.com` | `Glitch Grow X Urban` (`glitch-grow-x-urban-9`) | `urban` | **377** | 85% | ₹2,068 | ₹3,514 |
| **Trendsetters** | `acmsuy-g0.myshopify.com` | `Glitch Grow X Trendsetter` (`glitch-grow-x-trendsetter-5`) | `trendsetters` | 212 | 79% | ₹2,132 | ₹1,834 |
| **Storico** | `ys4n0u-ys.myshopify.com` | `Glitch Grow X Storico` (`glitch-grow-x-storico-6`) | `storico` | 171 | 87% | ₹2,244 | ₹1,636 |
| **Classico** | `52j1ga-hz.myshopify.com` | `Glitch Grow X Classicoo` (`glitch-grow-x-classicoo-5`) | `classicoo` | 27 | 100% | ₹1,946 | ₹296 |
| **FLEET** | | | | **787** | ~85% | — | **₹7,280/mo** |

**Fleet economics:** GMV ₹16.7L/mo · Call cost 0.44% of GMV · Net positive ~₹34,486/mo at 60% RTO-catch rate.

**Canonical source of truth:** `/home/support/multi-store-theme-manager/SHOPIFY_STORES_INFRA.md`

---

## 🔒 Multi-app architecture — key operational rule

**Every store has its own Shopify Dev Dashboard app** under the single `Glitch Executor` org (support@glitchexecutor.com Partner account). Each app → own Client ID + Client Secret → **signs webhook HMACs with a different secret per store**.

Implication: we use a JSON map `SHOPIFY_WEBHOOK_SECRETS` in `.env`, keyed by `.myshopify.com` domain. Adding a new store = adding one entry to the map. Fallback `SHOPIFY_WEBHOOK_SECRET` (singular) exists but is unset in prod so misconfigs fail loudly.

```bash
# Current state (Urban only — real value in /home/support/glitch-cod-confirm/.env, NEVER commit)
SHOPIFY_WEBHOOK_SECRETS='{"f51039.myshopify.com":"shpss_<urban-client-secret>"}'
SHOPIFY_WEBHOOK_SECRET=
```

---

## 🛠 Everything shipped this session (2026-04-19)

### Performance (barge-in / mid-conversation hang fix)
- **Silero VAD at 8 kHz** — matches SIP audio natively, skips resample step, halves samples/window. Resolves "inference is slower than realtime" warnings at call start on 2-CPU VPS.
- **`minSilenceDuration` 550 → 400 ms** — snappier turn-end detection for SIP latency.
- All prior barge-in fixes from 2026-04-18 still active (`aecWarmupDuration: 500`, `minInterruptionWords: 2`, `maxTokens: 120`).

### Cost accounting
- Ran 4 end-to-end test calls, 4.9 min total, cost ~₹10.96 (~$0.13)
- Per-call unit economics: **₹2.74 average** (LiveKit + Sarvam + OpenAI + Vobiz + R2)
- Projection for 1,000 calls/day: ~₹3.3L/mo, or ~₹10.98/call at scale

### Shopify multi-store HMAC fix (production blocker!)
- **Discovered:** every real Shopify webhook had been HMAC-rejected for 48 hours (no real orders had ever reached the app). Test calls worked only because `/flow-test-livekit` bypasses the webhook path.
- **Root cause:** single `SHOPIFY_WEBHOOK_SECRET` can't handle multi-app architecture (each store's app has its own Client Secret).
- **Fix:** added `SHOPIFY_WEBHOOK_SECRETS` JSON map keyed by shop domain. Resolves secret per-request using `X-Shopify-Shop-Domain` header (`resolveShopifySecret()` helper). Matches the existing `glitch-grow-ads-agent` pattern.
- **Deployed:** Urban Classics Client Secret installed; confirmed `shopify_hmac_per_shop_count: 1` in health endpoint.

### Tighter DND window (user-requested humane hours)
- Was: 21:00 → 09:05 IST (TRAI minimum)
- Now: **20:00 → 10:05 IST** (10-hour call window)
- Env vars `DND_START_HOUR=20` `DND_END_HOUR=10` (dnd.js was already env-driven, no code change)

### Freshness filters (prevents Shopify retry-backlog flood)
- `QUEUE_ONLY_AFTER` = ISO timestamp, hard cutoff for go-live moments — set to 2026-04-19T00:25:25Z
- `MAX_ORDER_AGE_HOURS` = 6, rolling freshness backstop
- Both return 200 (to stop Shopify retries) but skip queueing — logged as `stale: <reason>`
- Prevents the 48h backlog of previously-rejected webhooks from flooding the queue now that HMAC is fixed

### Docs + observability
- `README.md` already overhauled yesterday — still current
- Startup log now distinguishes `YES (per-shop=N)` / `YES (fallback)` / `NO` instead of binary yes/no
- `.env.example` documents all new env vars with rationale
- Memory file `project_glitch_cod_confirm.md` updated with full 8-store app mapping
- `multi-store-theme-manager/SHOPIFY_STORES_INFRA.md` updated with Dev Dashboard app names alongside slugs

---

## ⏭ Next steps (resume here)

### Immediate (when you wake up)
1. **Watch the 10:05 AM IST window open**:
   ```bash
   sudo journalctl -u cod-confirm.service --since "today 10:00 IST" | grep -E "queued|dispatch|stale"
   ```
   Expect: a flurry of `stale: before_go_live_cutoff` messages as Shopify drains its retry queue, followed by the first `queued` when a genuinely-new order arrives.
2. **Verify first real call lands** — customer's phone should ring ~10 min after webhook arrival, Shopify tag written, CallTurn rows persist, R2 audio file created.
3. **Monitor Urban for 24-48h** before onboarding other stores.

### After Urban is stable — expand to other 3 stores
4. Get Client Secrets for Trendsetters / Storico / Classicoo apps from Partner Dashboard.
5. Update `SHOPIFY_WEBHOOK_SECRETS` JSON map to include all 4 domains.
6. Add their `.myshopify.com` domains to the shop allowlist.
7. Handle the **Storico + Classicoo "no COD tag" quirk** — they use `paymentGatewayNames = ["Cash on Delivery (COD)"]` but DON'T apply a `COD` tag. The existing COD detection in `server.js` already checks `payment_gateway_names` (normalized, handles "cash_on_delivery" → "cashondelivery"), so should work — but verify on first test webhook per store.

### Open backlog items
- Issue #2: per-shop prompt customization via Shopify metafields (not yet built).
- No regression tests for issues #7–#12.
- Legacy files to delete: `src/setup-retell-agent.mjs`, `src/setup-bolna-agent.mjs`, `src/update-retell-agent.mjs`.
- Fine-tune Sarvam STT on the accumulating R2 audio corpus (long-term moat play).
- TTS startup lag on first few seconds of call — still present, likely Sarvam WS connection warmup. Low priority unless user complaints surface.

---

## 🔑 Security note

Urban Classics Client Secret was pasted in chat on 2026-04-19. It's in `.env` (gitignored) + chat transcript. Low practical risk but **rotate from Partner Dashboard at any convenient time** — regenerate in Glitch Grow X Urban config, update `SHOPIFY_WEBHOOK_SECRETS` map, restart.

---

## 📁 Files modified this session (2026-04-19)

| File | What |
|---|---|
| `src/livekit-agent.js` | Silero VAD at 8 kHz + 400ms silence threshold |
| `src/server.js` | `SHOPIFY_WEBHOOK_SECRETS` JSON map · `resolveShopifySecret()` · freshness filter (`isOrderFresh`) · startup HMAC log |
| `.env.example` | Documented multi-store HMAC pattern, freshness filters, DND vars |
| `HANDOVER.md` | This document |
| `/home/support/multi-store-theme-manager/SHOPIFY_STORES_INFRA.md` | Dev Dashboard app names added to the slug table |
| `~/.claude/.../memory/project_glitch_cod_confirm.md` | 8-store app mapping appended |

All commits pushed to `github.com/glitch-exec-labs/glitch-cod-confirm` main branch. See `git log --oneline` for the sequence.

---

## 🔁 How to resume verification

```bash
# 1. Health snapshot
curl -s http://127.0.0.1:3104/health | python3 -m json.tool

# Expected today after 10:05 IST:
# "dispatch_mode": "live", "live": true
# "shopify_hmac_per_shop_count": 1
# "in_dnd_now": false (after 10:05)
# "queue": { "queued": N, "dispatching": 0, "doneToday": M, "failedToday": 0 }

# 2. Latest call turns
PSQL_URL=$(grep '^DATABASE_URL=' /home/support/glitch-cod-confirm/.env | cut -d= -f2- | tr -d '"' | sed 's/?.*//')
psql "$PSQL_URL" -c "SELECT \"roomName\", role, text FROM \"CallTurn\" ORDER BY \"createdAt\" DESC LIMIT 20;"

# 3. Recent call outcomes
psql "$PSQL_URL" -c "SELECT \"orderId\", outcome, \"createdAt\" FROM \"ScheduledCall\" ORDER BY \"createdAt\" DESC LIMIT 20;"

# 4. Service logs (latest)
sudo journalctl -u cod-confirm.service --since "today 10:00 IST" --no-pager | grep -E "queued|dispatch|stale|error" | tail -50
sudo journalctl -u cod-confirm-agent.service --since "today 10:00 IST" --no-pager | grep -E "\[priya\]|\[user\]|\[tool\]|session closed" | tail -50

# 5. If something's wrong
sudo systemctl status cod-confirm.service cod-confirm-agent.service
sudo journalctl -u cod-confirm.service -n 100 --no-pager
sudo journalctl -u cod-confirm-agent.service -n 100 --no-pager
```

---

## 📚 Previous session (2026-04-18) — full log kept for context

Production foundation was laid in the 2026-04-18 session:
- 6 GitHub issues (#7–#12) fixed + closed
- Data moat built: `CallTurn` table, R2 MP4/Opus egress, DPDP consent, LiveKit webhook routing
- First successful end-to-end call: `cod-8973-1776469400808` (13 turns, `confirm_order` tool fired in-turn, Shopify tag written, R2 audio captured)
- License: MIT → BSL 1.1
- README rewrite to reflect shipped pipeline
- AEC warmup 3000→500ms, LLM maxTokens 120, minInterruptionWords 2

See `git log --oneline` for commit sequence. Both sessions' changes are on main.

---

## Contact

Commercial licensing / enterprise deployment: **support@glitchexecutor.com**
