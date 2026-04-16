/**
 * Glitch COD Confirm — LiveKit voice agent (Priya).
 *
 * Long-running worker process. Registers with LiveKit Cloud, subscribes to
 * dispatch requests, and handles each inbound call with Sarvam Bulbul v3 TTS,
 * Sarvam Saaras v3 STT, Gemini 2.0 Flash LLM, and mid-call function tools that
 * write Shopify tags via our existing Express endpoints at
 * /webhook/livekit/tool/*.
 *
 * Trigger a call from outside: see src/trigger-livekit-call.js — that
 * creates a SIP participant via Vobiz trunk and dispatches this agent into
 * the room.
 *
 * Architecture + idioms follow @livekit/agents v1.2.x Node.js patterns
 * (defineAgent prewarm+entry, ServerOptions, voice.Agent + voice.AgentSession,
 * participant attributes, session.say welcome, Zod tools, namespace plugin
 * imports, AgentSessionEventTypes constants). Apache-2.0 attribution below.
 *
 * Upstream: https://github.com/livekit/agents-js — @livekit/agents@1.2.6.
 * This worker is a downstream consumer, not a fork. Any patches we develop
 * that look generally useful go back upstream via PR, not vendor in here.
 */

import { fileURLToPath } from 'node:url';
import {
  cli,
  defineAgent,
  llm,
  ServerOptions,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as openai from '@livekit/agents-plugin-openai';
import { z } from 'zod';

const WEBHOOK_BASE = process.env.COD_CONFIRM_WEBHOOK_BASE
  || 'https://your-domain.com/cod-confirm';
// Shared secret matched against LIVEKIT_TOOL_SECRET on the Express side
// (requireLivekitToolAuth). Without this, /webhook/livekit/tool/* rejects us.
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';

// --- Prompt ----------------------------------------------------------------

/**
 * Render the Priya system prompt with dynamic per-call variables.
 * Values come from LiveKit participant attributes, set by the outbound-call
 * initiator via SipClient.createSipParticipant(..., { participantAttributes }).
 */
function buildSystemPrompt(v, lang) {
  const have = k => v[k] && String(v[k]).trim().length > 0;
  const ctxLines = [
    have('customer_name')    && `- Customer name: ${v.customer_name}`,
    have('order_number')     && `- Order number: ${v.order_number}`,
    have('total_amount')     && `- Total amount: Rs. ${v.total_amount} (say as spoken words, not digits)`,
    have('product_name')     && `- Product: ${v.product_name}`,
    (have('delivery_area') || have('delivery_city')) &&
      `- Delivery address: ${[v.delivery_area, v.delivery_city].filter(Boolean).join(', ')}`,
  ].filter(Boolean).join('\n');
  return lang === 'en-IN' ? englishPrompt(v, ctxLines) : hindiPrompt(v, ctxLines);
}

// ── Hindi / Hinglish prompt ────────────────────────────────────────────────
// Hindi phrases written in DEVANAGARI (not Latin transliteration) so Bulbul v3
// renders them natively — much better stress / vowel length than Latin
// "ke liye" which Sarvam sometimes mispronounces as "thi liye".
function hindiPrompt(v, ctxLines) {
  return `आप Priya हैं — Your Store (एक Indian online fashion store) की एक warm और professional customer service agent।

आपका काम है customer के cash-on-delivery (COD) order को confirm करना। आप naturally Hinglish बोलती हैं (Hindi-English mix जो ज़्यादातर Indian customers use करते हैं)। आवाज़ में warmth रखो, clauses के बीच natural pause लो — scripted मत लगना।

## Call context (dynamic values — customer से मत पूछो, ये पहले से मालूम है)

${ctxLines || '(No order context. This is a test / demo call — briefly greet the caller and explain you are Priya from Your Store; do not invent an order.)'}

## Call flow (इन steps को order में follow करो)

**Step 1 — Product और amount confirm करो.** जो उन्होंने order किया है और total amount spoken Hindi words में बताओ:
"आपने ${v.order_number || 'अपना order'} par ${v.product_name ? 'एक ' + v.product_name : 'अपना product'} order किया है, total ${v.total_amount ? hindiRupees(v.total_amount) : 'बताया गया amount'} — COD pe। सही है?"

**Step 2 — Delivery address confirm करो (CRITICAL — RTO का #1 cause है).** Address वापस read करो और explicitly confirmation माँगो:
"और delivery address है ${v.delivery_area || 'आपका address'}${v.delivery_city ? ', ' + v.delivery_city : ''} — यहाँ ही deliver करना है ना?"
अगर customer address wrong बताए, capture करो और \`request_human_agent\` call करो note "address correction needed: <details>"।

**Step 3 — Final confirm.** दोनों confirm हो जाने पर:
"ठीक है, मैं आपका order confirm कर रही हूँ। आपको पाँच से सात दिन में deliver हो जाएगा।"
फिर \`confirm_order\` tool call करो।

**Refusal / objections kisi भी step पर:**

- **Negative** ("नहीं", "cancel", "मुझे नहीं चाहिए", "मना", "ग़लती से") → once politely probe ("कोई बात नहीं, क्या reason थी?"), फिर \`cancel_order\` reason के साथ call करो, फिर कहो "ठीक है, मैं आपका order cancel कर देती हूँ। धन्यवाद।"
- **Wrong amount / wrong product** → \`request_human_agent\` call करो note में discrepancy describe करके — customer से argue मत करो।
- **Questions आप answer नहीं कर सकती** (size exchange, refund timing etc.) YA customer human/agent/representative मांगे → कहो "एक second, मैं आपको हमारे customer care agent से connect करवाती हूँ" और \`request_human_agent\` call करो।
- **Customer busy / later call** → "बिलकुल, कब call करूँ?" time capture करके \`request_callback\` call करो।

**Common factual questions — answer दो और current step पर वापस आ जाओ:**
- "कितने पैसे देने हैं?" → total को spoken Hindi words में repeat करो।
- "कब आएगा?" → "आपको पाँच से सात दिन में deliver हो जाएगा।"
- "Return policy क्या है?" → "सात दिन के अंदर return कर सकते हैं, easy process।"
- "ये call असली है?" → "बिलकुल, Your Store की तरफ़ से। ${v.order_number ? 'आपके order number ' + v.order_number + ' के बारे में call की है।' : ''}"

**Rules:**
- Warmth के साथ naturally बोलो। Clauses के बीच natural pause — scripted मत लगो।
- NEVER pressure। अगर customer साफ़ मना करे, acknowledge करो और cancel_order call करो।
- अगर customer English में बोले, आप भी English switch कर जाओ।
- अगर 2 follow-ups के बाद भी response unclear रहे, request_human_agent call करो।
- Tool call के बाद politely end करो। "धन्यवाद, आपका दिन शुभ हो" last line।

**Speech-friendliness (CRITICAL for TTS clarity):**
- Numbers ALWAYS spoken words में: "एक हज़ार नौ सौ नब्बे रुपय" — NEVER digits जैसे "Rs. 1990"।
- Product name short category में बोलो ("sunglasses", "shirt", "cap") — full English brand SKU names जैसे "Cartier Transparent Jaguar Karan Aujla Edition" out loud मत पढ़ो।
- लम्बे English brand names / model numbers बीच में मत डालो — prosody break होती है। "आपका product" use करो।
- Each response 2 short Hindi/Hinglish sentences के अंदर रखो।

Discount, stock for other items, promotional offers, other products — इन topics पर बात मत करो। सिर्फ़ THIS order पर focus।`;
}

// ── English prompt ─────────────────────────────────────────────────────────
function englishPrompt(v, ctxLines) {
  return `You are Priya, a warm and professional customer service agent calling from Your Store — an online fashion store in India. You speak Indian English naturally, in short sentences with warmth.

Your job is to CONFIRM a cash-on-delivery (COD) order the customer placed on the website. Be warm, never scripted.

## Call context (known already — do NOT ask)

${ctxLines || '(No order context provided. This is a test / demo call — briefly greet the caller and mention you are Priya from Your Store; do not invent an order.)'}

## Call flow (follow in order)

**Step 1 — Confirm product + amount.** State what they ordered and the total amount spoken as words:
"You ordered ${v.product_name ? 'a ' + v.product_name : 'your product'} on ${v.order_number || 'your order'}, total ${v.total_amount ? englishRupees(v.total_amount) : 'the stated amount'}, cash on delivery. Is that correct?"

**Step 2 — Confirm delivery address (CRITICAL — #1 RTO prevention).** Read address back and explicitly ask:
"And your delivery address is ${v.delivery_area || 'your address'}${v.delivery_city ? ', ' + v.delivery_city : ''} — is that correct?"
If the customer says the address is wrong, capture what's wrong and call \`request_human_agent\` with note "address correction needed: <details>".

**Step 3 — Final confirm.** After both product+amount AND address are confirmed:
"Great, I'm confirming your order now. It will be delivered in five to seven days."
Then call \`confirm_order\`.

**Refusal / objections at any step:**

- **Negative** ("no", "cancel", "don't want", "mistake") → probe once ("No problem, may I know the reason?"), then call \`cancel_order\` with reason, then "Okay, I've cancelled your order. Thank you."
- **Wrong amount / product** → \`request_human_agent\` — do NOT argue.
- **Questions you can't answer** OR customer asks for "agent / representative / human" → "One moment, let me connect you to our customer care agent" and call \`request_human_agent\`.
- **Customer busy / call later** → "Of course, when should I call back?" capture the time and call \`request_callback\`.

**Common questions:**
- "How much?" → restate amount as words.
- "When will it arrive?" → "Delivery is five to seven days."
- "What's the return policy?" → "You can return within seven days, easy process."
- "Is this call real?" → "Yes, this is from Your Store.${v.order_number ? ' I am calling about your order ' + v.order_number + '.' : ''}"

**Rules:**
- Warm, natural pauses between clauses. Not scripted.
- NEVER pressure. If they say no, acknowledge and cancel.
- If the customer switches to Hindi, you may too.
- If after 2 follow-ups response is still unclear, call request_human_agent.
- After the tool call, end politely: "Thank you, have a great day."

**Speech-friendliness (CRITICAL for TTS):**
- Numbers ALWAYS as spoken words: "one thousand nine hundred ninety rupees" — NEVER digits like "Rs. 1990".
- Use short shopper-friendly product names ("sunglasses", "shirt", "cap"), NOT full English SKUs with multiple brand words strung together.
- Keep responses to 2 short sentences.

Do NOT discuss: discounts outside the order, stock for other items, promotional offers, other products. Focus only on THIS order.`;
}

/**
 * Convert rupee amount to spoken Hindi words hint.
 */
function hindiRupees(n) {
  const amt = Number(String(n).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(amt) || amt <= 0) return String(n);
  if (amt >= 100000) return `${amt} रुपय (Hindi words: ${Math.floor(amt/100000)} लाख ${amt%100000 ? (amt%100000)+' ' : ''}रुपय)`;
  if (amt >= 1000)   return `${amt} रुपय (Hindi words: ${Math.floor(amt/1000)} हज़ार ${amt%1000 ? (amt%1000)+' ' : ''}रुपय)`;
  return `${amt} रुपय`;
}

/** Convert rupee amount to spoken English words hint. */
function englishRupees(n) {
  const amt = Number(String(n).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(amt) || amt <= 0) return String(n);
  if (amt >= 100000) return `${amt} rupees (say as: ${Math.floor(amt/100000)} lakh ${amt%100000 ? (amt%100000)+' ' : ''}rupees)`;
  if (amt >= 1000)   return `${amt} rupees (say as: ${Math.floor(amt/1000)} thousand ${amt%1000 ? (amt%1000)+' ' : ''}rupees)`;
  return `${amt} rupees`;
}

function buildWelcome(v, lang) {
  const hasRealName = v.customer_name && v.customer_name !== 'Customer';
  if (lang === 'en-IN') {
    const address = hasRealName ? v.customer_name : '';
    return `Hello${address ? ' ' + address : ''}, this is Priya calling from Your Store. I'm calling to confirm your recent order.`;
  }
  // Hindi / Hinglish — written in DEVANAGARI so Bulbul v3 renders natively.
  // "के लिए" in Devanagari avoids Latin-transliteration drift that produced
  // "thi liye" in earlier tests.
  const address = hasRealName ? `${v.customer_name} जी` : '';
  return `नमस्ते${address ? ' ' + address : ''}, मैं Priya बोल रही हूँ Your Store से। आपके order के confirmation के लिए call किया है।`;
}

// --- Tools -----------------------------------------------------------------

/**
 * Build the 4 Shopify-writing tools. Closed over call context so the LLM
 * doesn't have to re-pass shop/order_id/order_name on every invocation —
 * they're injected server-side from LiveKit participant attributes.
 */
function buildTools(v) {
  async function postTool(name, payload) {
    const url = `${WEBHOOK_BASE}/webhook/livekit/tool/${name}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Authenticate to /webhook/livekit/tool/* (issue #8).
          ...(TOOL_SECRET ? { 'X-COD-Tool-Secret': TOOL_SECRET } : {}),
        },
        body: JSON.stringify({
          shop: v.shop,
          shopify_order_id: v.shopify_order_id,
          order_name: v.order_number,
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // Issue #7: previously the agent trusted any 2xx. The backend used to
      // return 200 + {ok:false} on real failures, which the agent reported as
      // success to the customer. Now validate BOTH res.ok AND data.ok === true.
      if (!res.ok || data.ok !== true) {
        console.error(`[tool ${name}] FAILED http=${res.status} ok=${data.ok}:`, data);
        return `Tool ${name} failed: ${data.error || `HTTP ${res.status}`}. Do NOT tell the customer this succeeded.`;
      }
      return `Tool ${name} OK. ${data.tag_applied ? `Tag ${data.tag_applied} applied.` : ''}`;
    } catch (err) {
      console.error(`[tool ${name}] error:`, err);
      return `Tool ${name} errored: ${err.message}. Do NOT tell the customer this succeeded.`;
    }
  }

  return {
    confirm_order: llm.tool({
      description:
        'Call as soon as the customer gives a clear positive confirmation for the COD order ("haan", "yes", "theek hai", "kar do", "bhej do", "confirm", "sahi hai", "ji"). Marks the Shopify order cod-confirmed.',
      parameters: z.object({
        note: z.string().optional().describe('Optional short note from the conversation.'),
      }),
      execute: async ({ note }) => postTool('confirm_order', { note }),
    }),

    cancel_order: llm.tool({
      description:
        'Call when the customer clearly refuses the order ("nahi", "cancel", "mujhe nahi chahiye", "galti se ordered", "mana"). Captures the reason for reporting.',
      parameters: z.object({
        reason: z
          .string()
          .describe(
            'Short reason the customer gave for cancelling (e.g. wrong size, changed mind, ordered by mistake, price too high).',
          ),
      }),
      execute: async ({ reason }) => postTool('cancel_order', { reason }),
    }),

    request_human_agent: llm.tool({
      description:
        'Call when the customer asks for a human / agent / representative, or asks a question you cannot answer (specific refund timing, size exchange), or responds unclearly 2+ times in a row.',
      parameters: z.object({
        note: z
          .string()
          .describe('Short description of what the customer needs human help with.'),
      }),
      execute: async ({ note }) => postTool('request_human_agent', { note }),
    }),

    request_callback: llm.tool({
      description:
        'Call when the customer says they are busy and asks to be called later. Capture the time they specified.',
      parameters: z.object({
        when: z
          .string()
          .optional()
          .describe('When the customer wants the callback (e.g. "1 ghante mein", "evening", "kal subah").'),
      }),
      execute: async ({ when }) => postTool('request_callback', { when }),
    }),
  };
}

// --- Agent worker ----------------------------------------------------------

export default defineAgent({
  prewarm: async (proc) => {
    // Load Silero VAD once per worker process — shared across all calls.
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx) => {
    // Connect to the LiveKit room (required before waitForParticipant).
    await ctx.connect();
    // Wait for the SIP participant (the customer) to join the room.
    const participant = await ctx.waitForParticipant();

    // Pull dynamic context from participant attributes (set by
    // SipClient.createSipParticipant's participantAttributes option).
    const attrs = participant.attributes || {};
    // Per-call language. Set via participant attribute "language" =
    // 'hi-IN' (default) | 'en-IN'. Controls prompt, welcome, STT, TTS together.
    const lang = attrs.language === 'en-IN' ? 'en-IN' : 'hi-IN';
    const v = {
      customer_name:    attrs.customer_name    || 'Customer',
      order_number:     attrs.order_number     || '',
      total_amount:     attrs.total_amount     || '',
      product_name:     attrs.product_name     || 'your order',
      delivery_city:    attrs.delivery_city    || '',
      delivery_area:    attrs.delivery_area    || '',
      shop:             attrs.shop             || '',
      shopify_order_id: attrs.shopify_order_id || '',
    };
    console.log(`[livekit-agent] call for ${v.customer_name} / ${v.order_number} (${v.shop}) lang=${lang}`);

    const agent = new voice.Agent({
      instructions: buildSystemPrompt(v, lang),
      tools: buildTools(v),
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: new sarvam.STT({
        model: 'saaras:v3',
        languageCode: lang,
      }),
      llm: new openai.LLM({
        model: 'gpt-4o-mini',
        temperature: 0.6,
      }),
      tts: new sarvam.TTS({
        model: 'bulbul:v3',
        // bulbul:v3 streaming (WebSocket) accepts only native-v3 voices —
        // NOT legacy v1/v2 ones like anushka / manisha / vidya / arya (those
        // return WS 422). Native-v3 female list:
        //   ritu, priya, neha, pooja, simran, kavya, ishita, shreya,
        //   roopa, amelia, sophia, tanya, shruti, suhani, kavitha, rupali
        // Swap this string to iterate on voice quality.
        speaker: 'neha',
        targetLanguageCode: lang,
        pace: 1.0,                   // default; matches Sarvam's own benchmark-winning config
        // Match the SIP leg natively (8 kHz μ-law). Skipping the 24k→8k
        // resample step removes a major source of robotic artifacts on
        // phone calls per Sarvam's own cookbook config.
        sampleRate: 8000,
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      preemptiveGeneration: true,    // default; false caused >10s startup delay, users hung up before greeting
    });

    // Observability — not load-bearing, but useful in journalctl.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) console.log(`[user] ${ev.transcript}`);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item?.role === 'assistant') console.log(`[priya] ${ev.item.content?.slice?.(0, 200) ?? ''}`);
    });
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      console.log('[tool]', ev.functionCalls?.map?.(c => c.name).join(',') || '?');
    });
    session.on(voice.AgentSessionEventTypes.Close, () => {
      console.log('[livekit-agent] session closed');
    });

    await session.start({ agent, room: ctx.room });

    // Priya speaks first. LLM can riff afterwards.
    session.say(buildWelcome(v, lang), { allowInterruptions: true });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME || 'cod-confirm-priya',
  }),
);
