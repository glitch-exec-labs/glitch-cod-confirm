/**
 * Glitch COD Confirm — production webhook + scheduler server.
 *
 * Endpoints:
 *   GET  /health
 *   POST /webhook/shopify/orders-create       — enqueues a ScheduledCall
 *   POST /webhook/livekit/room-event          — LiveKit lifecycle events
 *   POST /webhook/livekit/tool/confirm_order
 *   POST /webhook/livekit/tool/cancel_order
 *   POST /webhook/livekit/tool/request_human_agent
 *   POST /webhook/livekit/tool/request_callback
 *   POST /webhook/vobiz/call-event            — SIP-level disposition visibility
 *   GET  /flow-test-livekit                   — dev: trigger a real call by order name
 *
 * Queue: Postgres (ScheduledCall model in prisma/schema.prisma). In-process
 * scheduler in src/lib/scheduler.js polls every 30s and dispatches via
 * triggerLivekitCall.
 */

import express from 'express';
import crypto from 'node:crypto';
import pkg from '@prisma/client';
import { WebhookReceiver } from 'livekit-server-sdk';
import { triggerLivekitCall } from './trigger-livekit-call.js';
import { normalizePhone } from './lib/phone.js';
import { computeScheduledAt, adjustForDnd, isDnd } from './lib/dnd.js';
import { isShopAllowed, ALLOWED_SHOPS, ALLOWLIST_ACTIVE } from './lib/shops.js';
import { fetchWithTimeout } from './lib/fetch.js';
import { startScheduler, markScheduledCallOutcome, DISPATCH_MODE } from './lib/scheduler.js';

const { PrismaClient } = pkg;

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3104);
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
// Shared secret sent by the LiveKit agent worker on every /webhook/livekit/tool/*
// request. If unset, the tool endpoints fail closed (reject everything) — no
// silent open mode, because these endpoints mutate Shopify state.
const LIVEKIT_TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';
const CALL_DELAY_MS = Number(process.env.CALL_DELAY_MS ?? 10 * 60_000); // 10 min default

// LiveKit Cloud signs webhook bodies with the project API secret and sends
// the signed JWT in the Authorization header. We verify with WebhookReceiver
// using the SAME API key/secret the agent worker uses to connect.
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY    || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const livekitWebhookReceiver = (LIVEKIT_API_KEY && LIVEKIT_API_SECRET)
  ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

// Raw body needed for Shopify HMAC verification
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
// Parse JSON for everything else, AND stash the raw Buffer so LiveKit
// webhook signature verification works without needing a second parser.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Counters for /health
let rejectCount = { hmac_missing: 0, hmac_mismatch: 0, shop_blocked: 0, tool_auth_missing: 0, tool_auth_mismatch: 0 };

// ─── Health ───────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const [sessions, queued, dispatching, doneToday, failedToday] = await Promise.all([
    prisma.session.count(),
    prisma.scheduledCall.count({ where: { status: 'queued' } }),
    prisma.scheduledCall.count({ where: { status: 'dispatching' } }),
    prisma.scheduledCall.count({ where: { status: 'done', updatedAt: { gte: new Date(Date.now() - 24*60*60*1000) } } }),
    prisma.scheduledCall.count({ where: { status: 'failed', updatedAt: { gte: new Date(Date.now() - 24*60*60*1000) } } }),
  ]);
  res.json({
    ok: true,
    service: 'glitch-cod-confirm',
    port: PORT,
    dispatch_mode: DISPATCH_MODE,
    live: DISPATCH_MODE === 'live',
    livekit_agent_configured: Boolean(
      process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET &&
      process.env.LIVEKIT_SIP_TRUNK_ID,
    ),
    shopify_hmac_configured: Boolean(SHOPIFY_WEBHOOK_SECRET),
    livekit_tool_auth_configured: Boolean(LIVEKIT_TOOL_SECRET),
    allowed_shops: ALLOWLIST_ACTIVE ? ALLOWED_SHOPS : 'open',
    shopify_sessions: sessions,
    queue: { queued, dispatching, doneToday, failedToday },
    rejects: rejectCount,
    in_dnd_now: isDnd(new Date()),
  });
});

// ─── Shopify webhook ─────────────────────────────────────────────────
app.post('/webhook/shopify/orders-create', async (req, res) => {
  try {
    // 1. HMAC verify
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (SHOPIFY_WEBHOOK_SECRET) {
      if (!hmac) {
        rejectCount.hmac_missing++;
        console.warn('[shopify-webhook] HMAC header missing — rejecting');
        return res.status(401).send('HMAC required');
      }
      const expected = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
      if (expected !== hmac) {
        rejectCount.hmac_mismatch++;
        console.warn('[shopify-webhook] HMAC mismatch');
        return res.status(401).send('HMAC mismatch');
      }
    }

    const order = JSON.parse(req.body.toString('utf8'));
    const shop = req.get('X-Shopify-Shop-Domain');

    // 2. Shop allowlist
    if (!isShopAllowed(shop)) {
      rejectCount.shop_blocked++;
      console.warn(`[shopify-webhook] blocked shop: ${shop}`);
      // Return 200 to not leak whether shop exists in our system
      return res.status(200).send('ok');
    }

    // 3. COD detection — payment_gateway_names can be an array OR a string.
    //    Normalize each entry: lowercase + strip non-alphanumerics so
    //    "Cash on Delivery", "cash-on-delivery", "cashondelivery" and "COD"
    //    all reduce to "cashondelivery" / "cod". `.includes('cod')` alone
    //    missed "Cash on Delivery" entirely (see issue #9).
    const gatewayList = Array.isArray(order.payment_gateway_names)
      ? order.payment_gateway_names
      : [order.payment_gateway_names || order.gateway || ''];
    const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const isCod = gatewayList.some(g => {
      const n = normalize(g);
      return n === 'cod' || n.includes('cashondelivery');
    }) || (order.note_attributes || []).some(a =>
      (a.name || a.key) === 'Payment Gateway' && (a.value === '-' || !a.value)
    );

    if (!isCod) {
      console.log(`[shopify] ${order.name} prepaid — skipping`);
      return res.status(200).send('ok (prepaid)');
    }

    // 4. Phone resolution + normalization
    const rawPhone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone;
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      console.warn(`[shopify] ${order.name} phone invalid/missing (raw=${JSON.stringify(rawPhone)}) — skipping`);
      return res.status(200).send('ok (no phone)');
    }

    // 5. Build payload
    const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ').trim() || 'Customer';
    const payload = {
      customer_name: customerName,
      total_amount:  String(Math.round(Number(order.current_total_price || order.total_price || 0))),
      product_name:  order.line_items?.[0]?.title || 'your order',
      delivery_city: order.shipping_address?.city || '',
      delivery_area: order.shipping_address?.address1 || '',
    };

    const orderId = String(order.id);
    const orderName = order.name || `#${order.order_number}`;
    const scheduledAt = computeScheduledAt(new Date(), CALL_DELAY_MS);

    // 6. Upsert into queue — idempotent on (shop, orderId). Shopify retries
    //    failed webhooks up to 48h; this prevents duplicate calls.
    await prisma.scheduledCall.upsert({
      where:  { shop_orderId: { shop, orderId } },
      update: {}, // if row already exists, don't disturb it (already scheduled or terminal)
      create: {
        shop, orderId, orderName, phone,
        lang: 'hi-IN',
        payload,
        scheduledAt,
        status: 'queued',
      },
    });

    const delaySec = Math.round((scheduledAt.getTime() - Date.now()) / 1000);
    console.log(`[shopify] queued ${orderName} (${shop}) → ${scheduledAt.toISOString()} (+${delaySec}s)${isDnd(new Date(Date.now() + CALL_DELAY_MS)) ? ' [DND-rolled]' : ''}`);
    res.status(200).send('ok (queued)');
  } catch (err) {
    console.error('[shopify-webhook] error', err);
    res.status(500).send('internal error');
  }
});

// ─── Shopify tag writeback (used by all tool webhooks) ───────────────
async function updateOrderTag(shop, orderId, tag, note) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) throw new Error(`No offline Shopify session for ${shop} — tag writeback failed`);

  const gid = `gid://shopify/Order/${orderId}`;
  const mutation = `mutation($id: ID!, $tags: [String!]!, $note: String) {
    orderUpdate(input: { id: $id, tags: $tags, note: $note }) {
      order { id tags }
      userErrors { field message }
    }
  }`;

  // Fetch current tags/note to append (not replace). If this read fails or
  // comes back malformed, ABORT — do not proceed to orderUpdate with empty
  // fallbacks, because the subsequent write would wipe the existing tags/note
  // (issue #12).
  const currResp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ order(id: "${gid}") { id tags note } }` }),
  });
  if (!currResp.ok) {
    throw new Error(`Shopify current-order read failed: HTTP ${currResp.status}`);
  }
  let curr;
  try {
    curr = await currResp.json();
  } catch (err) {
    throw new Error(`Shopify current-order read returned non-JSON: ${err.message}`);
  }
  if (curr?.errors?.length) {
    throw new Error('Shopify current-order read errors: ' + curr.errors.map(e => e.message).join('; '));
  }
  if (!curr?.data?.order) {
    throw new Error(`Shopify current-order read returned no order for ${gid}`);
  }
  const existingTags = curr.data.order.tags || [];
  const existingNote = curr.data.order.note || '';
  const newTags = [...new Set([...existingTags, tag])];
  const newNote = [existingNote, note].filter(Boolean).join('\n\n').trim();

  const resp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables: { id: gid, tags: newTags, note: newNote } }),
  });
  if (!resp.ok) {
    throw new Error(`Shopify orderUpdate failed: HTTP ${resp.status}`);
  }
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`Shopify orderUpdate returned non-JSON: ${err.message}`);
  }
  if (data.errors?.length) {
    const errStr = data.errors.map(e => e.extensions?.code === 'ACCESS_DENIED'
      ? `ACCESS_DENIED (need ${e.extensions?.requiredAccess})`
      : e.message).join('; ');
    throw new Error(`Shopify API error: ${errStr}`);
  }
  if (data.data?.orderUpdate?.userErrors?.length) {
    throw new Error('userErrors: ' + JSON.stringify(data.data.orderUpdate.userErrors));
  }
  console.log(`[shopify] ${gid} ✓ tagged ${tag}`);
}

// ─── LiveKit tool webhooks (called mid-call by Priya) ────────────────
const TOOL_TO_OUTCOME = {
  confirm_order: 'confirmed',
  cancel_order: 'cancelled',
  request_human_agent: 'agent_needed',
  request_callback: 'callback_requested',
};
const OUTCOME_TO_TAG = {
  confirmed: 'cod-confirmed',
  cancelled: 'cod-cancelled',
  agent_needed: 'cod-agent-needed',
  callback_requested: 'cod-callback-requested',
  no_answer: 'cod-no-answer',
};

// Shared-secret gate for /webhook/livekit/tool/* endpoints (issue #8). These
// endpoints mutate Shopify state, so they fail closed: if LIVEKIT_TOOL_SECRET
// is not configured, NO request is accepted. The agent worker sends the secret
// via X-COD-Tool-Secret header (see src/livekit-agent.js).
function requireLivekitToolAuth(req, res, next) {
  if (!LIVEKIT_TOOL_SECRET) {
    console.warn('[livekit-tool] LIVEKIT_TOOL_SECRET not configured — rejecting');
    return res.status(503).json({ ok: false, error: 'tool auth not configured' });
  }
  const got = req.get('X-COD-Tool-Secret') || '';
  if (!got) {
    rejectCount.tool_auth_missing++;
    return res.status(401).json({ ok: false, error: 'missing X-COD-Tool-Secret' });
  }
  const a = Buffer.from(got);
  const b = Buffer.from(LIVEKIT_TOOL_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    rejectCount.tool_auth_mismatch++;
    return res.status(401).json({ ok: false, error: 'invalid X-COD-Tool-Secret' });
  }
  next();
}

async function livekitTagUpdate(req, res, toolName, noteFromBody) {
  const body = req.body || {};
  console.log('[livekit-tool]', toolName, 'body:', JSON.stringify(body).slice(0, 400));
  const shop = body.shop;
  const orderId = body.shopify_order_id;
  if (!shop || !orderId) {
    // Client input error — 400, not 200. The agent (issue #7) treats any
    // non-2xx as failure.
    return res.status(400).json({ ok: false, error: 'missing shop/shopify_order_id' });
  }

  const outcome = TOOL_TO_OUTCOME[toolName];
  const tag = OUTCOME_TO_TAG[outcome];
  const note = noteFromBody(body);

  try {
    await updateOrderTag(shop, orderId, tag, note);
    await markScheduledCallOutcome(prisma, { shop, orderId, outcome, notes: note });
    res.json({ ok: true, tag_applied: tag, order_name: body.order_name });
  } catch (err) {
    // Real backend failure (Shopify write failed, DB write failed, etc).
    // Return 500 — do NOT pretend success. The agent checks both res.ok
    // AND data.ok (issue #7) before telling the customer the tool worked.
    console.error('[livekit-tool]', toolName, 'error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.post('/webhook/livekit/tool/confirm_order', requireLivekitToolAuth, (req, res) =>
  livekitTagUpdate(req, res, 'confirm_order', b => `COD confirmed via Priya. ${b.note || ''}`.trim()));
app.post('/webhook/livekit/tool/cancel_order', requireLivekitToolAuth, (req, res) =>
  livekitTagUpdate(req, res, 'cancel_order', b => `COD cancelled via Priya. Reason: ${b.reason || 'not given'}`));
app.post('/webhook/livekit/tool/request_human_agent', requireLivekitToolAuth, (req, res) =>
  livekitTagUpdate(req, res, 'request_human_agent', b => `Customer needs human agent. Note: ${b.note || ''}`));
app.post('/webhook/livekit/tool/request_callback', requireLivekitToolAuth, (req, res) =>
  livekitTagUpdate(req, res, 'request_callback', b => `Customer asked callback: ${b.when || 'time not specified'}`));

// ─── Training-data moat: per-turn transcript capture ────────────────
// The LiveKit agent worker posts one row per utterance as the call unfolds.
// Persisting mid-call (rather than one bulk dump at session Close) means a
// worker crash or an unclean hangup doesn't lose the first half of the
// conversation. Auth: same shared secret as the tool webhooks.
app.post('/webhook/livekit/turn', requireLivekitToolAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.shop || !b.shopify_order_id || !b.room_name || b.turn_index == null || !b.role || typeof b.text !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing shop/shopify_order_id/room_name/turn_index/role/text' });
  }
  if (!['user', 'assistant', 'tool'].includes(b.role)) {
    return res.status(400).json({ ok: false, error: `invalid role: ${b.role}` });
  }
  try {
    // @@unique([roomName, turnIndex]) + upsert gives us at-least-once safety
    // if the agent retries a POST that actually succeeded.
    await prisma.callTurn.upsert({
      where: { roomName_turnIndex: { roomName: b.room_name, turnIndex: b.turn_index } },
      update: {}, // first write wins; a retry is a no-op
      create: {
        shop:          b.shop,
        orderId:       String(b.shopify_order_id),
        roomName:      b.room_name,
        sipCallId:     b.sip_call_id || null,
        turnIndex:     b.turn_index,
        role:          b.role,
        text:          b.text,
        toolName:      b.tool_name || null,
        toolArgs:      b.tool_args || undefined,
        toolResult:    b.tool_result || null,
        lang:          b.lang || null,
        sttConfidence: typeof b.stt_confidence === 'number' ? b.stt_confidence : null,
        startedAt:     b.started_at ? new Date(b.started_at) : new Date(),
      },
    });
    // Cheap denormalized counter so dataset queries can filter "calls with
    // ≥ N turns" without a subquery.
    await prisma.callAttempt.updateMany({
      where: { roomName: b.room_name },
      data:  { turnCount: { increment: 1 } },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[livekit-turn] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// LiveKit Cloud webhook endpoint. This is the URL you configure in
// LiveKit Project Settings → Webhooks. LiveKit sends ALL project events
// to a single URL (room_started, room_finished, egress_started,
// egress_updated, egress_ended, participant_joined, ...) — we dispatch
// here based on the `event` field.
//
// Auth: LiveKit signs the raw body with the project API secret and
// includes the JWT in the Authorization header. We verify via
// WebhookReceiver using the SAME LIVEKIT_API_KEY / LIVEKIT_API_SECRET
// the agent worker uses. Custom headers (X-COD-Tool-Secret etc.) are
// NOT supported by LiveKit — that header config from earlier was a
// dead letter.
//
// For manual testing / replay, the fallback path still honours an
// X-COD-Tool-Secret header so you can POST synthetic payloads with
// curl. That path bypasses signature verification by design.
app.post('/webhook/livekit/egress-ready', async (req, res) => {
  try {
    let event = null;

    // Path A: real LiveKit webhook — has an Authorization JWT.
    const authHeader = req.get('Authorization') || '';
    if (authHeader && livekitWebhookReceiver) {
      if (!req.rawBody) {
        return res.status(400).json({ ok: false, error: 'raw body required for LiveKit signature verification' });
      }
      try {
        event = await livekitWebhookReceiver.receive(req.rawBody.toString('utf8'), authHeader);
      } catch (err) {
        console.warn('[livekit-webhook] signature verification failed:', err.message);
        return res.status(401).json({ ok: false, error: 'invalid LiveKit webhook signature' });
      }
    }
    // Path B: manual replay / curl — our internal shared secret.
    else if (req.get('X-COD-Tool-Secret')) {
      const got = req.get('X-COD-Tool-Secret');
      if (!LIVEKIT_TOOL_SECRET) {
        return res.status(503).json({ ok: false, error: 'tool auth not configured' });
      }
      const a = Buffer.from(got);
      const b = Buffer.from(LIVEKIT_TOOL_SECRET);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ ok: false, error: 'invalid X-COD-Tool-Secret' });
      }
      event = req.body; // trust the payload shape from a manual replay
    }
    // Path C: no auth → reject
    else {
      return res.status(401).json({ ok: false, error: 'missing Authorization or X-COD-Tool-Secret' });
    }

    // LiveKit test-event button sends a payload with event="" or a
    // minimal ping payload. Accept it but don't try to extract fields.
    const eventType = event?.event || '(unknown)';
    console.log(`[livekit-webhook] event=${eventType} id=${event?.id || '-'}`);

    // Only egress_ended carries the final audio URI. room_started,
    // participant_joined, etc. — just ack.
    if (eventType !== 'egress_ended') {
      return res.json({ ok: true, event: eventType, ignored: true });
    }

    const eg = event.egressInfo || event.egress_info || {};
    const roomName = eg.roomName || eg.room_name;
    const file = (eg.fileResults && eg.fileResults[0]) || (eg.file_results && eg.file_results[0]) || null;
    if (!roomName) {
      return res.status(400).json({ ok: false, error: 'egressInfo.roomName missing' });
    }

    // Duration comes as nanoseconds (int64) from LiveKit. Convert to ms.
    let durationMs = null;
    if (file?.duration) {
      const ns = typeof file.duration === 'bigint' ? Number(file.duration) : Number(file.duration);
      if (Number.isFinite(ns)) durationMs = Math.round(ns / 1_000_000);
    }

    // File format inferred from filename extension (OGG by our egress config).
    let audioFormat = null;
    const filename = file?.filename || '';
    const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
    if (m) audioFormat = m[1].toLowerCase();

    const audioUri = file?.location || filename || null;

    const updated = await prisma.callAttempt.updateMany({
      where: { roomName },
      data: {
        audioUri,
        audioFormat,
        audioDurationMs: durationMs,
        // consentGiven is set true because our welcome always plays the
        // disclosure (unless RECORDING_CONSENT_DISCLOSURE=off, in which
        // case deployment takes responsibility for consent out-of-band).
        consentGiven:    (process.env.RECORDING_CONSENT_DISCLOSURE || 'on').toLowerCase() !== 'off',
      },
    });
    console.log(`[livekit-egress] room=${roomName} uri=${audioUri} dur=${durationMs}ms rows=${updated.count}`);
    res.json({ ok: true, event: eventType, rows_updated: updated.count });
  } catch (err) {
    console.error('[livekit-webhook] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// LiveKit room-event webhook (optional — safety net for visibility)
app.post('/webhook/livekit/room-event', (req, res) => {
  const ev = req.body || {};
  console.log('[livekit-event]', ev.event, 'room:', ev.room?.name);
  res.json({ ok: true });
});

// Vobiz SIP-level events — configure Vobiz dashboard → Trunk → Webhook URL.
// Used for post-mortem visibility; call outcomes still come from LiveKit tools.
app.post('/webhook/vobiz/call-event', async (req, res) => {
  const ev = req.body || {};
  console.log('[vobiz-event]', ev.event || ev.type || '?', 'sipCallId:', ev.sip_call_id || ev.sipCallId || '-', JSON.stringify(ev).slice(0, 400));
  res.json({ ok: true });
});

// ─── Dev / flow-test: manually trigger a call for a real Shopify order ──
async function fetchShopifyOrderByName(shop, orderName) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) throw new Error(`No session for ${shop}`);
  const q = `{
    orders(first: 1, query: ${JSON.stringify(`name:${orderName}`)}) {
      edges {
        node {
          id name createdAt
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName phone }
          shippingAddress { address1 city phone }
          lineItems(first: 1) { edges { node { title } } }
          customAttributes { key value }
          tags
        }
      }
    }
  }`;
  const resp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const data = await resp.json();
  const o = data?.data?.orders?.edges?.[0]?.node;
  if (!o) throw new Error(`Order ${orderName} not found on ${shop}`);
  return {
    id:           o.id.split('/').pop(),
    name:         o.name,
    total:        Math.round(Number(o.currentTotalPriceSet.shopMoney.amount)),
    currency:     o.currentTotalPriceSet.shopMoney.currencyCode,
    customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ').trim() || 'Customer',
    phone:        o.customer?.phone || o.shippingAddress?.phone,
    product:      o.lineItems?.edges?.[0]?.node?.title || 'your order',
    city:         o.shippingAddress?.city || '',
    area:         o.shippingAddress?.address1 || '',
    tags:         o.tags || [],
  };
}

app.get('/flow-test-livekit', async (req, res) => {
  try {
    const shop = req.query.shop;
    const orderName = (req.query.order || '').toString();
    const phoneRaw = (req.query.phone || '').toString();
    const lang = req.query.lang === 'en-IN' ? 'en-IN' : 'hi-IN';

    if (!shop || !orderName) {
      return res.status(400).send('Pass ?shop=...myshopify.com&order=%238917&phone=+91XXXXXXXXXX');
    }

    const phone = normalizePhone(phoneRaw);
    if (!phone) return res.status(400).send(`Invalid phone: ${phoneRaw}`);

    const order = await fetchShopifyOrderByName(shop, orderName);
    const result = await triggerLivekitCall({ phone, order: { ...order, shop }, lang });
    res.json({ ok: true, livekit: result, lang, context_sent: order });
  } catch (e) {
    console.error('[flow-test-livekit]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────
async function onFinalFail(row, reason) {
  try {
    await updateOrderTag(row.shop, row.orderId, OUTCOME_TO_TAG.no_answer,
      `Customer did not answer after ${row.attempts} automated attempts. Last error: ${reason}`);
  } catch (err) {
    console.error('[final-fail] tag write failed for', row.orderName, err.message);
  }
}

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`[glitch-cod-confirm] listening on 127.0.0.1:${PORT}`);
  console.log(`[glitch-cod-confirm] DISPATCH MODE: ${DISPATCH_MODE === 'live' ? '🟢 LIVE — real customer calls will be placed' : '🔒 DRY-RUN — no real calls (set DISPATCH_MODE=live to enable)'}`);
  console.log(`[glitch-cod-confirm] HMAC configured: ${Boolean(SHOPIFY_WEBHOOK_SECRET) ? 'YES' : 'NO (OPEN — development only!)'}`);
  console.log(`[glitch-cod-confirm] LiveKit tool auth: ${Boolean(LIVEKIT_TOOL_SECRET) ? 'YES' : 'NO (tool webhooks will reject all requests)'}`);
  console.log(`[glitch-cod-confirm] shop allowlist: ${ALLOWLIST_ACTIVE ? ALLOWED_SHOPS.join(', ') : 'OPEN (all shops)'}`);
  console.log(`[glitch-cod-confirm] call delay: ${CALL_DELAY_MS}ms  |  DND now: ${isDnd(new Date())}`);

  // Warm queue depth for visibility on cold-start
  const [queued, dispatching] = await Promise.all([
    prisma.scheduledCall.count({ where: { status: 'queued' } }),
    prisma.scheduledCall.count({ where: { status: 'dispatching' } }),
  ]);
  console.log(`[glitch-cod-confirm] queue depth on startup: queued=${queued}, dispatching=${dispatching}`);

  // Start the scheduler loop
  startScheduler(prisma, { onFinalFail });
});

// Graceful shutdown — disconnect Prisma so in-flight queries finish
process.on('SIGTERM', async () => {
  console.log('[glitch-cod-confirm] SIGTERM — shutting down');
  await prisma.$disconnect();
  process.exit(0);
});
