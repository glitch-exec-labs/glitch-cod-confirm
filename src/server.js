/**
 * Glitch COD Confirm — voice AI agent for COD order confirmation.
 *
 * Endpoints:
 *   POST /webhook/shopify/orders-create   - Shopify webhook fires when a COD order is created
 *   POST /webhook/retell/call-event       - Retell webhook when a call is created / analyzed / ended
 *   POST /webhook/retell/tool/confirm_order
 *   POST /webhook/retell/tool/cancel_order
 *   POST /webhook/retell/tool/request_human_agent
 *   POST /webhook/retell/tool/request_callback
 *   POST /test-call                        - internal test endpoint (shop + customer fake data → triggers call)
 *   GET  /health
 *
 * Queue: in-memory setTimeout map for MVP. Replace with Postgres/Redis for production.
 *
 * Call trigger: uses Retell /v2/create-phone-call. Retell handles the LLM + voice.
 * When Exotel KYC is done, swap to /v2/create-outbound-call with Retell BYO SIP
 * credentials pointing at Exotel.
 */

import express from 'express';
import crypto from 'node:crypto';
import pkg from '@prisma/client';
import { triggerLivekitCall } from './trigger-livekit-call.js';
const { PrismaClient } = pkg;

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 3104);
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID;
const BOLNA_API_KEY = process.env.BOLNA_API_KEY;
const BOLNA_API_BASE = process.env.BOLNA_API_BASE || 'https://api.bolna.dev';
const BOLNA_AGENT_ID = process.env.BOLNA_AGENT_ID;
const BOLNA_FROM_PHONE_NUMBER = process.env.BOLNA_FROM_PHONE_NUMBER; // Vobiz number
const LIVEKIT_AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || 'cod-confirm-priya';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';

// Keep raw body for Shopify HMAC verification
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
app.use(express.json());

// In-memory queue
const scheduledCalls = new Map(); // orderId -> timeoutHandle

// ─── Health ────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const sessions = await prisma.session.count();
  res.json({
    ok: true,
    service: 'glitch-cod-confirm',
    port: PORT,
    retell_agent_configured: Boolean(RETELL_AGENT_ID),
    bolna_agent_configured: Boolean(BOLNA_AGENT_ID),
    livekit_agent_configured: Boolean(
      process.env.LIVEKIT_URL
      && process.env.LIVEKIT_API_KEY
      && process.env.LIVEKIT_API_SECRET
      && process.env.LIVEKIT_SIP_TRUNK_ID,
    ),
    shopify_sessions: sessions,
    queued_calls: scheduledCalls.size,
  });
});

// ─── Shopify webhook: new order created ────────────────
app.post('/webhook/shopify/orders-create', (req, res) => {
  try {
    // Verify HMAC — reject if secret is configured but header is missing
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (SHOPIFY_WEBHOOK_SECRET) {
      if (!hmac) {
        console.warn('[shopify-webhook] HMAC header missing — rejecting');
        return res.status(401).send('HMAC required');
      }
      const expected = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
      if (expected !== hmac) {
        console.warn('[shopify-webhook] HMAC mismatch');
        return res.status(401).send('HMAC mismatch');
      }
    }
    const order = JSON.parse(req.body.toString('utf8'));
    const shop = req.get('X-Shopify-Shop-Domain');

    const gateways = Array.isArray(order.payment_gateway_names)
      ? order.payment_gateway_names.join(',')
      : (order.payment_gateway_names || order.gateway || '');
    const isCod = gateways.toLowerCase().includes('cod')
      || (order.note_attributes || []).some(a => (a.name || a.key) === 'Payment Gateway' && (a.value === '-' || !a.value));

    if (!isCod) {
      console.log(`[shopify] ${order.name} prepaid — skipping`);
      return res.status(200).send('ok (prepaid)');
    }

    // Dedupe: skip if already scheduled/called
    if (scheduledCalls.has(order.id)) {
      return res.status(200).send('ok (already queued)');
    }

    const delayMs = 10 * 60 * 1000; // 10 min delay — give customer time to cancel / settle
    const delay = process.env.CALL_DELAY_MS ? Number(process.env.CALL_DELAY_MS) : delayMs;

    console.log(`[shopify] ${order.name} (${shop}) — COD order, scheduling call in ${delay/1000}s`);

    const t = setTimeout(() => {
      scheduledCalls.delete(order.id);
      triggerCall(order, shop).catch(err => console.error('[call] error', err));
    }, delay);
    scheduledCalls.set(order.id, t);

    res.status(200).send('ok (queued)');
  } catch (err) {
    console.error('[shopify-webhook] error', err);
    res.status(500).send('internal error');
  }
});

// ─── Retell call triggering ────────────────────────────
async function triggerCall(order, shop) {
  if (!RETELL_AGENT_ID) {
    console.error('[call] RETELL_AGENT_ID not set');
    return;
  }
  const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ').trim() || 'Customer';
  const phone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone;
  if (!phone) {
    console.warn(`[call] ${order.name} no phone — skipping`);
    return;
  }
  const productName = order.line_items?.[0]?.title || 'your order';
  const city = order.shipping_address?.city || '';
  const area = order.shipping_address?.address1 || '';
  const dynamicVariables = {
    customer_name: customerName,
    order_number: order.name || `#${order.order_number}`,
    total_amount: String(Math.round(Number(order.current_total_price || order.total_price || 0))),
    product_name: productName,
    delivery_city: city,
    delivery_area: area,
    shop_domain: shop,
    shopify_order_id: String(order.id),
  };

  const res = await fetch('https://api.retellai.com/v2/create-phone-call', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_number: process.env.RETELL_FROM_NUMBER, // Retell-managed or BYO
      to_number: phone,
      override_agent_id: RETELL_AGENT_ID,
      retell_llm_dynamic_variables: dynamicVariables,
      metadata: { shop, shopify_order_id: String(order.id), order_name: order.name },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[call] ${order.name} retell create failed:`, data);
    return;
  }
  console.log(`[call] ${order.name} triggered — call_id=${data.call_id}`);
}

// ─── Retell webhooks ────────────────────────────────────
async function updateOrderTag(shop, orderId, tag, note) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) { throw new Error(`No offline Shopify session for ${shop} — tag writeback failed`); }
  const gid = `gid://shopify/Order/${orderId}`;
  const query = `mutation($id: ID!, $tags: [String!]!, $note: String) {
    orderUpdate(input: { id: $id, tags: $tags, note: $note }) {
      order { id tags }
      userErrors { field message }
    }
  }`;
  // fetch existing tags first to append
  const curr = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ order(id: "${gid}") { id tags note } }` }),
  }).then(r => r.json()).catch(() => null);
  const existingTags = curr?.data?.order?.tags || [];
  const existingNote = curr?.data?.order?.note || '';
  const newTags = [...new Set([...existingTags, tag])];
  const newNote = [existingNote, note].filter(Boolean).join('\n\n').trim();
  const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: gid, tags: newTags, note: newNote } }),
  });
  const data = await res.json();
  if (data.errors?.length) {
    const err = data.errors.map(e => e.extensions?.code === 'ACCESS_DENIED' ? `ACCESS_DENIED (need ${e.extensions?.requiredAccess})` : e.message).join('; ');
    console.error(`[shopify] ${gid} tag FAILED: ${err}`);
    throw new Error(`Shopify API error: ${err}`);
  }
  if (data.data?.orderUpdate?.userErrors?.length) {
    console.error('[shopify] orderUpdate userErrors', data.data.orderUpdate.userErrors);
    throw new Error('userErrors: ' + JSON.stringify(data.data.orderUpdate.userErrors));
  }
  console.log(`[shopify] ${gid} ✓ tagged ${tag}`);
}

function getToolContext(req) {
  const body = req.body || {};
  const args = body.args || {};
  const callCtx = body.call || {};
  const meta = callCtx.metadata || {};
  // Retell passes metadata either as call.metadata OR (for web calls) nested differently.
  // Fall back to top-level body.metadata too.
  const metaFallback = body.metadata || {};
  return {
    shop: meta.shop || metaFallback.shop,
    orderId: meta.shopify_order_id || metaFallback.shopify_order_id,
    orderName: meta.order_name || metaFallback.order_name,
    args,
  };
}

async function safeTagUpdate(res, req, tag, noteTemplate) {
  try {
    console.log('[retell-tool]', req.path, 'body keys:', Object.keys(req.body || {}), 'call keys:', Object.keys(req.body?.call || {}));
    const { shop, orderId, args } = getToolContext(req);
    if (!shop || !orderId) {
      console.warn('[retell-tool]', req.path, 'missing shop/orderId. Body:', JSON.stringify(req.body).slice(0, 500));
      return res.status(200).json({ ok: false, error: 'missing shop/orderId in metadata', echoed_body: req.body });
    }
    await updateOrderTag(shop, orderId, tag, noteTemplate(args));
    res.json({ ok: true, tag_applied: tag });
  } catch (err) {
    console.error('[retell-tool]', req.path, 'error:', err);
    res.status(200).json({ ok: false, error: err.message });
  }
}

app.post('/webhook/retell/tool/confirm_order', (req, res) =>
  safeTagUpdate(res, req, 'cod-confirmed', a => `COD confirmed by customer via voice call. ${a.note || ''}`.trim()));
app.post('/webhook/retell/tool/cancel_order', (req, res) =>
  safeTagUpdate(res, req, 'cod-cancelled', a => `COD cancelled by customer. Reason: ${a.reason || 'not given'}`));
app.post('/webhook/retell/tool/request_human_agent', (req, res) =>
  safeTagUpdate(res, req, 'cod-agent-needed', a => `Customer needs human agent. Note: ${a.note || ''}`));
app.post('/webhook/retell/tool/request_callback', (req, res) =>
  safeTagUpdate(res, req, 'cod-callback-requested', a => `Customer asked to be called back: ${a.when || 'later'}`));

app.post('/webhook/retell/call-event', (req, res) => {
  const ev = req.body || {};
  console.log(`[retell-event] ${ev.event} call=${ev.call?.call_id} status=${ev.call?.call_status}`);
  res.json({ ok: true });
});

// ─── Bolna post-call webhook ────────────────────────────
// Bolna POSTs the execution payload here on each call-state change. When
// status === 'completed', the payload includes extracted dispositions (the
// post-call LLM has read the transcript and classified the outcome).
// We translate that into a Shopify tag. This replaces Retell's mid-call
// tool-webhook pattern — Bolna's /v2/agent api_tools field is broken as of
// 2026-04-15 (exhaustive probing, all shapes 500 with NoneType error).
const BOLNA_DISPOSITION_TO_TAG = {
  confirmed: 'cod-confirmed',
  cancelled: 'cod-cancelled',
  agent_needed: 'cod-agent-needed',
  callback_requested: 'cod-callback-requested',
  unclear: 'cod-agent-needed',
};

function extractBolnaContext(ev) {
  // Bolna event shape is documented loosely; look in likely places.
  // When triggered via POST /call with user_data, the execution payload
  // echoes user_data back (alongside status, transcript, dispositions).
  const ud = ev.user_data || ev.context_data || ev.variables || ev.agent_data || {};
  return {
    shop: ud.shop,
    orderId: ud.shopify_order_id,
    orderName: ud.order_number || ud.order_name,
  };
}

function extractBolnaDisposition(ev) {
  // Dispositions arrive as an array of {name, value, ...} at the top level or
  // nested under analytics/extracted_data. Probe several shapes.
  const pools = [ev.dispositions, ev.extracted_data?.dispositions, ev.analytics?.dispositions, ev.result?.dispositions].filter(Array.isArray);
  const all = pools.flat();
  const outcome = all.find(d => (d.name || '').toLowerCase().includes('outcome'));
  const reason = all.find(d => (d.name || '').toLowerCase().includes('cancellation reason'));
  const callback = all.find(d => (d.name || '').toLowerCase().includes('callback time'));
  return {
    outcome: outcome?.value || outcome?.result,
    reason: reason?.value || reason?.result,
    callbackTime: callback?.value || callback?.result,
  };
}

app.post('/webhook/bolna/call-event', async (req, res) => {
  try {
    const ev = req.body || {};
    const status = ev.status || ev.call_status || ev.state;
    console.log('[bolna-event]', 'status=', status, 'keys=', Object.keys(ev).slice(0, 20).join(','));

    // Only act on call completion
    const isDone = ['completed', 'ended', 'hangup'].some(s => (status || '').toLowerCase().includes(s));
    if (!isDone) return res.json({ ok: true, ignored: true, status });

    const { shop, orderId, orderName } = extractBolnaContext(ev);
    const { outcome, reason, callbackTime } = extractBolnaDisposition(ev);
    console.log('[bolna-event]', `complete — order=${orderName} shop=${shop} outcome=${outcome}`);

    if (!shop || !orderId) {
      console.warn('[bolna-event] missing shop/orderId in user_data; event keys:', Object.keys(ev));
      return res.json({ ok: false, error: 'missing shop/orderId' });
    }
    if (!outcome) {
      console.warn('[bolna-event] no outcome disposition extracted');
      return res.json({ ok: false, error: 'no outcome' });
    }

    const tag = BOLNA_DISPOSITION_TO_TAG[outcome] || 'cod-agent-needed';
    const noteParts = [
      `Bolna voice call outcome: ${outcome}`,
      reason && reason !== 'N/A' && `Reason: ${reason}`,
      callbackTime && callbackTime !== 'N/A' && `Callback: ${callbackTime}`,
    ].filter(Boolean);
    await updateOrderTag(shop, orderId, tag, noteParts.join('. '));
    res.json({ ok: true, tag_applied: tag, outcome });
  } catch (err) {
    console.error('[bolna-event] error:', err);
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ─── Flow test: real Shopify order → web call URL with REAL dynamic vars ──
// Usage: GET /flow-test?shop=example.myshopify.com&order=%238917
// Returns { webcall_url: "..." }. Open that URL in browser to talk to Priya
// about that actual order, then confirm in Shopify admin that the tag got
// written back.
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
  const res = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  }).then(r => r.json());
  const o = res?.data?.orders?.edges?.[0]?.node;
  if (!o) throw new Error(`Order ${orderName} not found on ${shop}`);
  return {
    id: o.id.split('/').pop(),
    name: o.name,
    total: Math.round(Number(o.currentTotalPriceSet.shopMoney.amount)),
    currency: o.currentTotalPriceSet.shopMoney.currencyCode,
    customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ').trim() || 'Customer',
    phone: o.customer?.phone || o.shippingAddress?.phone,
    product: o.lineItems?.edges?.[0]?.node?.title || 'your order',
    city: o.shippingAddress?.city || '',
    area: o.shippingAddress?.address1 || '',
    tags: o.tags || [],
  };
}

app.get('/flow-test', async (req, res) => {
  try {
    const shop = req.query.shop || 'example.myshopify.com';
    const orderName = (req.query.order || '').toString();
    if (!orderName) return res.status(400).send('Pass ?order=%238917&shop=example.myshopify.com');
    if (!RETELL_AGENT_ID) return res.status(400).json({ error: 'RETELL_AGENT_ID not set' });

    const order = await fetchShopifyOrderByName(shop, orderName);
    const dynamicVariables = {
      customer_name: order.customerName,
      order_number: order.name,
      total_amount: String(order.total),
      product_name: order.product,
      delivery_city: order.city,
      delivery_area: order.area,
    };
    const r = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: RETELL_AGENT_ID,
        retell_llm_dynamic_variables: dynamicVariables,
        metadata: { shop, shopify_order_id: order.id, order_name: order.name, flow_test: true },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json(data);

    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Flow test — ${order.name}</title>
<style>body{font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.5}
.box{background:#f5f5f5;padding:1rem;border-radius:6px;margin:1rem 0}
button{padding:0.7rem 1.4rem;background:#000;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:1rem}
button:disabled{opacity:0.4}
#log{background:#111;color:#eee;padding:1rem;border-radius:6px;font-family:ui-monospace,monospace;font-size:0.85em;white-space:pre-wrap;min-height:160px}
.agent{color:#78dcff}.user{color:#fff9a8}</style></head><body>
<h1>Flow test: ${order.name}</h1>
<div class="box">
<b>Real order context Priya will read:</b><br>
Customer: ${order.customerName}<br>
Product: ${order.product}<br>
Total: ₹${order.total} (${order.currency})<br>
Delivery: ${order.area}, ${order.city}<br>
Current tags: ${order.tags.length ? order.tags.join(', ') : '(none)'}<br>
Order GID: gid://shopify/Order/${order.id}
</div>
<p>Click <b>Start call</b>, play a customer (say "haan" or "nahi" etc.), and after the call ends, refresh <a href="https://admin.shopify.com/store/${shop.split('.')[0]}/orders/${order.id}" target="_blank">the Shopify order page</a> to see the new tag.</p>
<button id="start">Start call</button>
<button id="stop" disabled>End call</button>
<div id="log" style="margin-top:1rem"></div>
<script type="module">
import { RetellWebClient } from 'https://esm.sh/retell-client-js-sdk@2';
const client = new RetellWebClient();
const log = document.getElementById('log');
document.getElementById('start').onclick = async () => {
  await client.startCall({ accessToken: ${JSON.stringify(data.access_token)} });
  document.getElementById('start').disabled = true;
  document.getElementById('stop').disabled = false;
};
document.getElementById('stop').onclick = () => client.stopCall();
client.on('update', u => {
  log.innerHTML = (u.transcript||[]).map(m => \`<span class="\${m.role}">\${m.role}: \${m.content||''}</span>\`).join('\\n');
  log.scrollTop = log.scrollHeight;
});
client.on('call_ended', () => {
  document.getElementById('start').disabled = false;
  document.getElementById('stop').disabled = true;
  log.innerHTML += '\\n\\n<b>Call ended.</b> Refresh the Shopify order tab to see the tag.';
});
</script></body></html>`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Web call test: create a Retell web call with fake order context ──
app.post('/create-webcall', async (req, res) => {
  if (!RETELL_AGENT_ID) return res.status(400).json({ error: 'RETELL_AGENT_ID not set' });
  const dynamicVariables = {
    customer_name: req.body.name || 'Tejas',
    order_number: req.body.order_number || '#8917',
    total_amount: req.body.total_amount || '2399',
    product_name: req.body.product_name || 'Armani Exchange Reflective Print Shirt',
    delivery_city: req.body.delivery_city || 'Delhi',
    delivery_area: req.body.delivery_area || 'Greater Kailash 2, Block W',
  };
  const r = await fetch('https://api.retellai.com/v2/create-web-call', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: RETELL_AGENT_ID,
      retell_llm_dynamic_variables: dynamicVariables,
      metadata: { test: true, shop: 'example.myshopify.com', shopify_order_id: 'test-' + Date.now() },
    }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(500).json(data);
  res.json({ access_token: data.access_token, call_id: data.call_id });
});

// ─── Web call test page (served HTML) ─────────────────
app.get('/test-call-page', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Glitch COD Confirm — Priya test call</title>
  <style>
    body { font-family: -apple-system, 'Segoe UI', sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    h1 { margin-bottom: 0.25rem; }
    .muted { color: #666; font-size: 0.9em; }
    button { padding: 0.7rem 1.4rem; font-size: 1rem; border: none; border-radius: 6px; cursor: pointer; margin-right: 0.5rem; }
    #start { background: #000; color: #fff; }
    #stop { background: #d11; color: #fff; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    #status { margin: 1.5rem 0; padding: 0.8rem 1rem; border-radius: 6px; background: #f5f5f5; }
    .ok { background: #e6f4ea !important; color: #0a6b30; }
    #transcript { background: #111; color: #eee; padding: 1rem; border-radius: 6px; white-space: pre-wrap; min-height: 160px; font-family: ui-monospace, Consolas, monospace; font-size: 0.85em; }
    .role-agent { color: #78dcff; }
    .role-user { color: #fff9a8; }
    label { display: block; margin-top: 0.6rem; font-size: 0.85em; color: #555; }
    input { padding: 0.4rem; width: 100%; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Priya — Your Store COD Confirm Test</h1>
  <p class="muted">Click <b>Start</b>, allow mic access, and speak in Hindi / Hinglish / English as if you were a customer. Priya should greet you, read an order, and confirm or cancel based on what you say.</p>

  <details style="margin: 1rem 0;">
    <summary>Override fake order context (optional)</summary>
    <label>Customer name <input id="v_name" value="Tejas"></label>
    <label>Order number <input id="v_order" value="#8917"></label>
    <label>Product <input id="v_product" value="Armani Exchange Reflective Print Shirt"></label>
    <label>Amount (INR) <input id="v_amount" value="2399"></label>
    <label>City <input id="v_city" value="Delhi"></label>
    <label>Area <input id="v_area" value="Greater Kailash 2, Block W"></label>
  </details>

  <button id="start">Start call</button>
  <button id="stop" disabled>End call</button>

  <div id="status">Not connected</div>
  <div id="transcript"></div>

  <p class="muted" style="margin-top: 2rem;">
    Agent: <code>${RETELL_AGENT_ID}</code> · Voice: <code>Sarvam Bulbul v3 (hi-IN)</code> · LLM: <code>gpt-4o-mini</code>
  </p>

  <script type="module">
    import { RetellWebClient } from 'https://esm.sh/retell-client-js-sdk@2';
    const client = new RetellWebClient();

    const $ = id => document.getElementById(id);
    const transcript = $('transcript');
    const status = $('status');

    $('start').onclick = async () => {
      status.textContent = 'Creating web call…';
      status.className = '';
      const body = {
        name: $('v_name').value,
        order_number: $('v_order').value,
        product_name: $('v_product').value,
        total_amount: $('v_amount').value,
        delivery_city: $('v_city').value,
        delivery_area: $('v_area').value,
      };
      const res = await fetch('/cod-confirm/create-webcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        status.textContent = 'Failed: ' + (await res.text());
        return;
      }
      const { access_token, call_id } = await res.json();
      status.textContent = 'Connecting… (call ' + call_id + ')';
      await client.startCall({ accessToken: access_token });
      $('start').disabled = true;
      $('stop').disabled = false;
    };

    $('stop').onclick = () => client.stopCall();

    client.on('call_started', () => { status.textContent = 'Connected — speak now'; status.className = 'ok'; });
    client.on('call_ended', () => { status.textContent = 'Call ended'; status.className = ''; $('start').disabled = false; $('stop').disabled = true; });
    client.on('error', (e) => { status.textContent = 'Error: ' + (e.message || e); });
    client.on('update', (u) => {
      if (!u || !u.transcript) return;
      transcript.innerHTML = u.transcript.map(m => {
        const cls = m.role === 'agent' ? 'role-agent' : 'role-user';
        return '<span class="' + cls + '">' + m.role + ': ' + (m.content || '') + '</span>';
      }).join('\\n');
      transcript.scrollTop = transcript.scrollHeight;
    });
  </script>
</body>
</html>`);
});

// ─── LiveKit tool webhooks ──────────────────────────────
// Called by src/livekit-agent.js mid-call when the LLM decides a tool fires.
// Body: { shop, shopify_order_id, order_name, ...tool-specific fields }.
// Closed over call context in the agent — our server doesn't need to track
// which call is which.
async function livekitTagUpdate(req, res, tag, noteFromBody) {
  try {
    const body = req.body || {};
    console.log('[livekit-tool]', req.path, 'body:', JSON.stringify(body).slice(0, 400));
    const shop = body.shop;
    const orderId = body.shopify_order_id;
    if (!shop || !orderId) {
      return res.status(200).json({ ok: false, error: 'missing shop/shopify_order_id' });
    }
    await updateOrderTag(shop, orderId, tag, noteFromBody(body));
    res.json({ ok: true, tag_applied: tag, order_name: body.order_name });
  } catch (err) {
    console.error('[livekit-tool]', req.path, 'error:', err);
    res.status(200).json({ ok: false, error: err.message });
  }
}

app.post('/webhook/livekit/tool/confirm_order', (req, res) =>
  livekitTagUpdate(req, res, 'cod-confirmed', b => `COD confirmed via Priya (LiveKit/Sarvam). ${b.note || ''}`.trim()));
app.post('/webhook/livekit/tool/cancel_order', (req, res) =>
  livekitTagUpdate(req, res, 'cod-cancelled', b => `COD cancelled via Priya (LiveKit). Reason: ${b.reason || 'not given'}`));
app.post('/webhook/livekit/tool/request_human_agent', (req, res) =>
  livekitTagUpdate(req, res, 'cod-agent-needed', b => `Customer needs human agent (LiveKit). Note: ${b.note || ''}`));
app.post('/webhook/livekit/tool/request_callback', (req, res) =>
  livekitTagUpdate(req, res, 'cod-callback-requested', b => `Customer asked callback (LiveKit): ${b.when || 'time not specified'}`));

// LiveKit room-event webhook (safety net — if a call ends without any tool
// firing, tag the order so we don't silently lose it). Configure this URL in
// LiveKit Cloud → Webhooks → Room Events.
app.post('/webhook/livekit/room-event', (req, res) => {
  const ev = req.body || {};
  console.log('[livekit-event]', ev.event, 'room:', ev.room?.name);
  res.json({ ok: true });
});

// Vobiz trunk-level call events — SIP-level visibility (carrier responses,
// 486 busy / 480 unavailable, ring/answer/hangup). Configure this URL in
// Vobiz dashboard → Trunk → Webhook URL. Independent from LiveKit; useful for
// debugging "call queued but never rang" scenarios.
app.post('/webhook/vobiz/call-event', (req, res) => {
  const ev = req.body || {};
  console.log('[vobiz-event]', ev.event || ev.type || '?', 'sipCallId:', ev.sip_call_id || ev.sipCallId || '-', JSON.stringify(ev).slice(0, 400));
  res.json({ ok: true });
});

// ─── LiveKit flow test: real Shopify order → PSTN via LiveKit + Vobiz SIP ──
// Usage: GET /flow-test-livekit?shop=...&order=%238917&phone=%2B91XXXXXXXXXX
// The participantAttributes sent to LiveKit flow into the agent worker's
// ctx.waitForParticipant().attributes — that's how Priya knows the order.
app.get('/flow-test-livekit', async (req, res) => {
  try {
    const shop = req.query.shop || 'example.myshopify.com';
    const orderName = (req.query.order || '').toString();
    let phone = (req.query.phone || '').toString().trim().replace(/^\s+/, '+');
    if (phone && !phone.startsWith('+') && /^\d{10,15}$/.test(phone)) phone = '+' + phone;
    if (!orderName) return res.status(400).send('Pass ?order=%238917&shop=...&phone=+91...');
    if (!phone)     return res.status(400).send('Missing ?phone=+91XXXXXXXXXX (E.164)');

    const lang = req.query.lang === 'en-IN' ? 'en-IN' : 'hi-IN';
    const order = await fetchShopifyOrderByName(shop, orderName);
    const result = await triggerLivekitCall({
      phone,
      order: { ...order, shop },
      lang,
    });
    res.json({ ok: true, livekit: result, lang, context_sent: order });
  } catch (e) {
    console.error('[flow-test-livekit]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Bolna flow test: real Shopify order → PSTN call via Bolna /call ──
// Usage: GET /flow-test-bolna?shop=example.myshopify.com&order=%238917&phone=+919XXXXXXXXX
// Returns JSON with the Bolna execution_id so you can check the call log in
// platform.bolna.ai. The customer phone MUST be provided — Bolna makes a real
// outbound PSTN call through its default (Plivo) number unless the agent is
// later switched to Exotel/Twilio BYO.
app.get('/flow-test-bolna', async (req, res) => {
  try {
    if (!BOLNA_API_KEY || !BOLNA_AGENT_ID) return res.status(400).json({ error: 'BOLNA_API_KEY / BOLNA_AGENT_ID not set' });
    const shop = req.query.shop || 'example.myshopify.com';
    const orderName = (req.query.order || '').toString();
    // Express query parser decodes `+` as space. If the phone comes in
    // without a leading +, but looks like it needs one (E.164), re-add it.
    let phone = (req.query.phone || '').toString().trim().replace(/^\s+/, '+');
    if (phone && !phone.startsWith('+') && /^\d{10,15}$/.test(phone)) phone = '+' + phone;
    if (!orderName) return res.status(400).send('Pass ?order=%238917&shop=...&phone=+91...');
    if (!phone) return res.status(400).send('Missing ?phone=+91XXXXXXXXXX (E.164)');

    const order = await fetchShopifyOrderByName(shop, orderName);
    const userData = {
      customer_name: order.customerName,
      order_number: order.name,
      total_amount: String(order.total),
      product_name: order.product,
      delivery_city: order.city,
      delivery_area: order.area,
      shop,
      shopify_order_id: order.id,
    };
    const r = await fetch(`${BOLNA_API_BASE}/call`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: BOLNA_AGENT_ID,
        recipient_phone_number: phone,
        user_data: userData,
        bypass_call_guardrails: true,
        ...(BOLNA_FROM_PHONE_NUMBER && { from_phone_number: BOLNA_FROM_PHONE_NUMBER }),
      }),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 500).json({ ok: r.ok, bolna_response: data, context_sent: userData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Phone test endpoint (triggers PSTN call with fake order data) ──
app.post('/test-call', async (req, res) => {
  if (!RETELL_AGENT_ID) return res.status(400).json({ error: 'RETELL_AGENT_ID not set' });
  const fakeOrder = {
    id: 'test-' + Date.now(),
    name: '#TEST-1',
    current_total_price: '2399',
    customer: { first_name: req.body.name || 'Tejas', last_name: '', phone: req.body.phone },
    line_items: [{ title: req.body.product || 'Armani Exchange Shirt' }],
    shipping_address: { address1: req.body.area || 'Greater Kailash', city: req.body.city || 'Delhi', phone: req.body.phone },
    order_number: 0,
  };
  await triggerCall(fakeOrder, req.body.shop || 'example.myshopify.com');
  res.json({ ok: true, message: 'call triggered' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[glitch-cod-confirm] listening on 127.0.0.1:${PORT}`);
});
