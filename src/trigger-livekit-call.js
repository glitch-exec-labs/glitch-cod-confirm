/**
 * Trigger an outbound voice call via LiveKit Cloud + Vobiz SIP trunk.
 *
 * Resolves a Shopify order to its real context, then asks LiveKit to:
 *   1. Create a fresh room (one per call)
 *   2. Originate a SIP call through our Vobiz trunk to the customer's number
 *   3. Dispatch our cod-confirm-priya agent into that room
 *
 * Per-call context (customer name, order number, total, product, address, shop,
 * shopify_order_id) is passed via participantAttributes — the agent reads them
 * via ctx.waitForParticipant().attributes inside src/livekit-agent.js.
 */

import { SipClient, AgentDispatchClient } from 'livekit-server-sdk';

const LK_URL              = process.env.LIVEKIT_URL;
const LK_KEY              = process.env.LIVEKIT_API_KEY;
const LK_SECRET           = process.env.LIVEKIT_API_SECRET;
const LK_SIP_TRUNK_ID     = process.env.LIVEKIT_SIP_TRUNK_ID;
const LK_AGENT_NAME       = process.env.LIVEKIT_AGENT_NAME || 'cod-confirm-priya';

function ensureCreds() {
  const missing = [];
  if (!LK_URL) missing.push('LIVEKIT_URL');
  if (!LK_KEY) missing.push('LIVEKIT_API_KEY');
  if (!LK_SECRET) missing.push('LIVEKIT_API_SECRET');
  if (!LK_SIP_TRUNK_ID) missing.push('LIVEKIT_SIP_TRUNK_ID');
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

/**
 * Trigger a call.
 *
 * @param {object} params
 * @param {string} params.phone           - Recipient phone in E.164 (e.g. +919XXXXXXXXX)
 * @param {object} params.order           - Order context (customerName, name, total,
 *                                          product, city, area, id, shop)
 * @param {string} [params.lang]          - 'hi-IN' (default) or 'en-IN'. Flows
 *                                          into agent as participant attribute
 *                                          and drives prompt / STT / TTS language.
 * @param {string} [params.roomName]      - Override room name (default: cod-{order.name}-{ts})
 * @returns {Promise<{ ok: true, room_name: string, sip: object }>}
 */
export async function triggerLivekitCall({ phone, order, lang, roomName }) {
  ensureCreds();
  if (!phone) throw new Error('phone required (E.164)');
  if (!order) throw new Error('order required');

  const slug = (order.name || `order-${order.id}`).replace(/[^a-zA-Z0-9-]/g, '');
  const room = roomName || `cod-${slug}-${Date.now()}`;

  // Dispatch the agent into the room BEFORE the SIP call connects, so the
  // agent is ready to greet the customer the moment they pick up.
  const dispatchClient = new AgentDispatchClient(LK_URL, LK_KEY, LK_SECRET);
  await dispatchClient.createDispatch(room, LK_AGENT_NAME, {
    metadata: JSON.stringify({ shop: order.shop, order_id: order.id, order_name: order.name }),
  });

  // Now originate the outbound SIP call. participantAttributes flow through
  // to agent's ctx.waitForParticipant().attributes.
  const sipClient = new SipClient(LK_URL, LK_KEY, LK_SECRET);
  const sip = await sipClient.createSipParticipant(
    LK_SIP_TRUNK_ID,
    phone,
    room,
    {
      participantIdentity: `customer-${phone}`,
      participantName: order.customerName || 'Customer',
      participantAttributes: {
        customer_name:    order.customerName || 'Customer',
        order_number:     order.name || `#${order.id}`,
        total_amount:     String(order.total ?? ''),
        product_name:     order.product || 'your order',
        delivery_city:    order.city || '',
        delivery_area:    order.area || '',
        shop:             order.shop || '',
        shopify_order_id: String(order.id || ''),
        language:         lang === 'en-IN' ? 'en-IN' : 'hi-IN',
        // Brand context. Caller-passed order.storeName wins, else STORE_NAME
        // env, else the agent defaults to "our store" (see livekit-agent.js).
        // For multi-tenant, resolve per-shop (e.g. from a Shopify metafield)
        // and pass in via order.storeName / order.storeCategory.
        store_name:       order.storeName     || process.env.STORE_NAME     || '',
        store_category:   order.storeCategory || process.env.STORE_CATEGORY || '',
      },
      playRingtone: true,
      ringingTimeout: 30,
      maxCallDuration: 300,
      waitUntilAnswered: false,
    },
  );

  return { ok: true, room_name: room, sip };
}
