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
const CALL_DELAY_MS = Number(process.env.CALL_DELAY_MS ?? 10 * 60_000); // 10 min default

// Raw body needed for Shopify HMAC verification
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
app.use(express.json());

// Counters for /health
let rejectCount = { hmac_missing: 0, hmac_mismatch: 0, shop_blocked: 0 };

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

    // 3. COD detection — payment_gateway_names is typically an array
    const gateways = Array.isArray(order.payment_gateway_names)
      ? order.payment_gateway_names.join(',')
      : (order.payment_gateway_names || order.gateway || '');
    const isCod = gateways.toLowerCase().includes('cod')
      || (order.note_attributes || []).some(a => (a.name || a.key) === 'Payment Gateway' && (a.value === '-' || !a.value));

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

  // Fetch current tags/note to append (not replace)
  const currResp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ order(id: "${gid}") { id tags note } }` }),
  });
  const curr = await currResp.json().catch(() => null);
  const existingTags = curr?.data?.order?.tags || [];
  const existingNote = curr?.data?.order?.note || '';
  const newTags = [...new Set([...existingTags, tag])];
  const newNote = [existingNote, note].filter(Boolean).join('\n\n').trim();

  const resp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables: { id: gid, tags: newTags, note: newNote } }),
  });
  const data = await resp.json();
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

async function livekitTagUpdate(req, res, toolName, noteFromBody) {
  try {
    const body = req.body || {};
    console.log('[livekit-tool]', toolName, 'body:', JSON.stringify(body).slice(0, 400));
    const shop = body.shop;
    const orderId = body.shopify_order_id;
    if (!shop || !orderId) {
      return res.status(200).json({ ok: false, error: 'missing shop/shopify_order_id' });
    }

    const outcome = TOOL_TO_OUTCOME[toolName];
    const tag = OUTCOME_TO_TAG[outcome];
    const note = noteFromBody(body);

    await updateOrderTag(shop, orderId, tag, note);
    await markScheduledCallOutcome(prisma, { shop, orderId, outcome, notes: note });

    res.json({ ok: true, tag_applied: tag, order_name: body.order_name });
  } catch (err) {
    console.error('[livekit-tool]', toolName, 'error:', err);
    res.status(200).json({ ok: false, error: err.message });
  }
}

app.post('/webhook/livekit/tool/confirm_order', (req, res) =>
  livekitTagUpdate(req, res, 'confirm_order', b => `COD confirmed via Priya. ${b.note || ''}`.trim()));
app.post('/webhook/livekit/tool/cancel_order', (req, res) =>
  livekitTagUpdate(req, res, 'cancel_order', b => `COD cancelled via Priya. Reason: ${b.reason || 'not given'}`));
app.post('/webhook/livekit/tool/request_human_agent', (req, res) =>
  livekitTagUpdate(req, res, 'request_human_agent', b => `Customer needs human agent. Note: ${b.note || ''}`));
app.post('/webhook/livekit/tool/request_callback', (req, res) =>
  livekitTagUpdate(req, res, 'request_callback', b => `Customer asked callback: ${b.when || 'time not specified'}`));

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
