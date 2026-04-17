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

import { SipClient, AgentDispatchClient, EgressClient, EncodedFileType, EncodedFileOutput, EncodingOptions, AudioCodec, S3Upload, GCPUpload } from 'livekit-server-sdk';

const LK_URL              = process.env.LIVEKIT_URL;
const LK_KEY              = process.env.LIVEKIT_API_KEY;
const LK_SECRET           = process.env.LIVEKIT_API_SECRET;
const LK_SIP_TRUNK_ID     = process.env.LIVEKIT_SIP_TRUNK_ID;
const LK_AGENT_NAME       = process.env.LIVEKIT_AGENT_NAME || 'cod-confirm-priya';

// ── Egress (training-data audio capture) ─────────────────────────────────
// RECORDING_BACKEND    = 'gcp' | 's3' | 'r2' | '' (off)
// RECORDING_BUCKET     = bucket name (no protocol, no path)
// RECORDING_PREFIX     = optional key prefix, e.g. "cod-confirm/"
// GCP creds: GOOGLE_APPLICATION_CREDENTIALS_JSON (raw JSON string) OR default
//            service-account on the host.
// S3 creds:  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION.
// R2 creds:  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID.
//            R2 is S3-compatible — we reuse LiveKit's S3Upload and set
//            endpoint=https://<account>.r2.cloudflarestorage.com,
//            region=auto, forcePathStyle=true. Recommended default: zero
//            egress fees at training time make R2 the cheapest backend
//            for write-now-train-later workloads.
// If RECORDING_BACKEND is unset, egress is skipped with a warning log —
// calls still work, just no audio persisted.
const RECORDING_BACKEND = (process.env.RECORDING_BACKEND || '').toLowerCase();
const RECORDING_BUCKET  = process.env.RECORDING_BUCKET || '';
const RECORDING_PREFIX  = process.env.RECORDING_PREFIX || '';

function ensureCreds() {
  const missing = [];
  if (!LK_URL) missing.push('LIVEKIT_URL');
  if (!LK_KEY) missing.push('LIVEKIT_API_KEY');
  if (!LK_SECRET) missing.push('LIVEKIT_API_SECRET');
  if (!LK_SIP_TRUNK_ID) missing.push('LIVEKIT_SIP_TRUNK_ID');
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

function buildEgressUpload() {
  if (RECORDING_BACKEND === 'gcp') {
    if (!RECORDING_BUCKET) return null;
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '';
    return new GCPUpload({ bucket: RECORDING_BUCKET, credentials });
  }
  if (RECORDING_BACKEND === 's3') {
    if (!RECORDING_BUCKET) return null;
    return new S3Upload({
      bucket:    RECORDING_BUCKET,
      accessKey: process.env.AWS_ACCESS_KEY_ID || '',
      secret:    process.env.AWS_SECRET_ACCESS_KEY || '',
      region:    process.env.AWS_REGION || '',
    });
  }
  if (RECORDING_BACKEND === 'r2') {
    if (!RECORDING_BUCKET) return null;
    const accountId = process.env.R2_ACCOUNT_ID || '';
    if (!accountId) {
      console.warn('[egress] R2_ACCOUNT_ID not set — cannot build R2 endpoint');
      return null;
    }
    return new S3Upload({
      bucket:          RECORDING_BUCKET,
      accessKey:       process.env.R2_ACCESS_KEY_ID || '',
      secret:          process.env.R2_SECRET_ACCESS_KEY || '',
      // R2 ignores region semantics; "auto" is the convention.
      region:          'auto',
      // Virtual-hosted style doesn't work against R2; path-style does.
      endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle:  true,
    });
  }
  return null;
}

// Start a room-composite audio egress into the configured cloud bucket.
// Non-fatal: if anything fails, we log and continue with the call (better to
// lose a training recording than lose the customer).
async function startAudioEgress(room) {
  if (!RECORDING_BACKEND) {
    console.warn(`[egress] RECORDING_BACKEND not set — skipping audio capture for room ${room}`);
    return null;
  }
  const upload = buildEgressUpload();
  if (!upload) {
    console.warn(`[egress] RECORDING_BUCKET not set for backend=${RECORDING_BACKEND} — skipping`);
    return null;
  }
  try {
    const egressClient = new EgressClient(LK_URL, LK_KEY, LK_SECRET);
    // MP4 + Opus is the only reliable audioOnly combo for room composite egress.
    // OGG caused "no supported codec compatible with all outputs" — the compositor
    // pipeline needs explicit codec selection. MP4/Opus at 32kbps is fine for ASR.
    const filepath = `${RECORDING_PREFIX}${room}.mp4`;
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath,
      output: { case: RECORDING_BACKEND === 'gcp' ? 'gcp' : 's3', value: upload },
    });
    const info = await egressClient.startRoomCompositeEgress(room, {
      file: output,
      audioOnly: true,
      advanced: new EncodingOptions({ audioCodec: AudioCodec.OPUS }),
    });
    console.log(`[egress] started room=${room} egress_id=${info.egressId} → ${RECORDING_BACKEND}://${RECORDING_BUCKET}/${filepath}`);
    return info;
  } catch (err) {
    console.error(`[egress] failed to start for room ${room}:`, err?.message || err);
    return null;
  }
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

  // Start audio egress 10 s after dispatch — gives the agent time to join the
  // room and publish its audio track, which resolves the "no supported codec"
  // error that occurs when egress is started on an empty room.
  // Best-effort: transcripts are captured per-turn regardless of egress.
  setTimeout(() => {
    startAudioEgress(room).then(info => {
      if (info) console.log(`[egress] delayed start confirmed for room ${room}: egress_id=${info.egressId}`);
    });
  }, 10_000);

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

  return { ok: true, room_name: room, sip, egress_id: null };
}
