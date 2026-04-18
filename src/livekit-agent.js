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
  return `आप Priya हैं — ${v.store_name} (एक ${v.store_category}) की एक ***REMOVED***।

***REMOVED***

## Call context (dynamic values — customer से मत पूछो, ये ***REMOVED***)

${ctxLines || `(No order context. This is a test / demo call — briefly greet the caller and explain you are Priya from ${v.store_name}; do not invent an order.)`}

## Call flow (इन steps को order में follow करो)

***REMOVED***
***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***
- पहले \`confirm_order\` tool call करो (speech से पहले, same turn में)
***REMOVED***
***REMOVED***

***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
- "ये call असली है?" → "बिलकुल, ${v.store_name} की तरफ़ से। ${v.order_number ? 'आपके order number ' + v.order_number + ' के बारे में call की है।' : ''}"

**Rules:**
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***`;
}

// ── English prompt ─────────────────────────────────────────────────────────
function englishPrompt(v, ctxLines) {
  return `You are Priya, a ***REMOVED*** calling from ${v.store_name} — ${articleFor(v.store_category)} ${v.store_category}. You speak Indian English naturally, in short sentences with warmth.

***REMOVED***

## Call context (known already — do NOT ask)

${ctxLines || `(No order context provided. This is a test / demo call — briefly greet the caller and mention you are Priya from ${v.store_name}; do not invent an order.)`}

## Call flow (follow in order)

***REMOVED***
***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***
- First call \`confirm_order\` tool (before speaking, same turn)
***REMOVED***
***REMOVED***

***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

**Common questions:**
***REMOVED***
***REMOVED***
***REMOVED***
- "Is this call real?" → "Yes, this is from ${v.store_name}.${v.order_number ? ' I am calling about your order ' + v.order_number + '.' : ''}"

**Rules:**
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

***REMOVED***`;
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
  // Recording-consent notice. On by default for DPDP (India) / general
  // best practice; set RECORDING_CONSENT_DISCLOSURE=off only if your
  // deployment has consent captured out-of-band (e.g. on the Shopify
  // checkout page) or is running against test numbers.
  const withConsent = (process.env.RECORDING_CONSENT_DISCLOSURE || 'on').toLowerCase() !== 'off';

  if (lang === 'en-IN') {
    const address = hasRealName ? v.customer_name : '';
    const consent = withConsent ? ' This call may be recorded for quality and service improvement.' : '';
    return `Hello${address ? ' ' + address : ''}, this is Priya calling from ${v.store_name}. I'm calling to confirm your recent order.${consent}`;
  }
  // Hindi / Hinglish — written in DEVANAGARI so Bulbul v3 renders natively.
  // "के लिए" in Devanagari avoids Latin-transliteration drift that produced
  // "thi liye" in earlier tests.
  const address = hasRealName ? `${v.customer_name} जी` : '';
  const consent = withConsent ? ' यह call quality के लिए record की जा रही है।' : '';
  return `नमस्ते${address ? ' ' + address : ''}, मैं Priya बोल रही हूँ ${v.store_name} से। आपके order के confirmation के लिए call किया है।${consent}`;
}

/** "a" / "an" for English category phrases. "online store" → "an" only if
 *  first word starts with a vowel. Keeps prompt grammatical across
 *  "online fashion store", "ayurvedic pet brand", etc. */
function articleFor(s) {
  return /^[aeiou]/i.test(String(s || '').trim()) ? 'an' : 'a';
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
        'Call IMMEDIATELY in the same response when the customer confirms both product+amount AND address ("haan", "yes", "theek hai", "sahi hai", "ji", "bilkul"). Do NOT wait for a subsequent user turn. This marks the Shopify order cod-confirmed.',
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
    // SIP audio is 8kHz; matching VAD sample rate to input skips the resample
    // step AND halves samples-per-window → cuts "inference slower than realtime"
    // warnings at call start on our 2-CPU VPS.
    // minSilenceDuration reduced from default 550ms to 400ms for snappier
    // end-of-turn detection on SIP latency.
    proc.userData.vad = await silero.VAD.load({
      sampleRate: 8000,
      minSilenceDuration: 400,
    });
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
      // Brand context — passed per-call via participant attributes, with env
      // fallback for single-tenant deployments. For multi-tenant, resolve
      // per-shop (e.g. from a Shopify metafield) in trigger-livekit-call.js
      // and pass `store_name` / `store_category` in participantAttributes.
      store_name:       attrs.store_name       || process.env.STORE_NAME     || 'our store',
      store_category:   attrs.store_category   || process.env.STORE_CATEGORY || 'online store',
    };
    console.log(`[livekit-agent] call for ${v.customer_name} / ${v.order_number} (${v.shop}) lang=${lang}`);

    // ── Training-data moat: real-time turn persistence ──────────────────
    // Captures every user utterance, every assistant utterance, and every
    // tool call to Postgres via POST /webhook/livekit/turn. Paired with the
    // room-composite audio egress started in trigger-livekit-call.js, this
    // produces (audio, transcript, outcome) tuples for later training.
    //
    // - turnIndex is an in-worker monotonic counter. Unique across a single
    //   session; uniqueness across retries is enforced by the server's
    //   @@unique([roomName, turnIndex]) + upsert.
    // - postTurn is fire-and-forget: we do not block the voice pipeline on
    //   persistence. Failures log but don't bubble up.
    let turnIndex = 0;
    const roomName = ctx.room?.name || '';
    const sipCallId = attrs.sip_call_id || null;
    async function postTurn({ role, text, tool_name, tool_args, tool_result, stt_confidence }) {
      if (!v.shop || !v.shopify_order_id || !roomName) return; // test/demo calls without order context — skip
      const payload = {
        shop:              v.shop,
        shopify_order_id:  v.shopify_order_id,
        room_name:         roomName,
        sip_call_id:       sipCallId,
        turn_index:        turnIndex++,
        role,
        text:              text || '',
        lang,
        tool_name, tool_args, tool_result, stt_confidence,
        started_at:        new Date().toISOString(),
      };
      try {
        const res = await fetch(`${WEBHOOK_BASE}/webhook/livekit/turn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(TOOL_SECRET ? { 'X-COD-Tool-Secret': TOOL_SECRET } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.warn(`[turn-persist] HTTP ${res.status} for ${role} turn #${payload.turn_index}`);
        }
      } catch (err) {
        console.warn(`[turn-persist] fire-and-forget error on ${role} turn #${payload.turn_index}:`, err.message);
      }
    }

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
        maxTokens: 120,   // Priya speaks 1-2 short sentences — cap prevents slow generation
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
      // AEC warmup default is 3000ms — interruptions are DISABLED during warmup.
      // 500ms is enough for echo canceller to stabilise on a SIP call while
      // keeping barge-in responsive from the first second of each agent turn.
      aecWarmupDuration: 500,
      // Require at least 2 words before treating customer speech as a real
      // interruption — prevents single-syllable noise ("hmm", breath) from
      // cutting Priya off mid-sentence.
      minInterruptionWords: 2,
    });

    // Each event handler persists to Postgres AND still logs to journalctl
    // so on-the-fly debugging remains zero-friction.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      console.log(`[user] ${ev.transcript}`);
      postTurn({
        role: 'user',
        text: ev.transcript || '',
        stt_confidence: typeof ev.confidence === 'number' ? ev.confidence : undefined,
      });
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item?.role !== 'assistant') return;
      const text = ev.item.textContent ?? '';
      console.log(`[priya] ${text.slice(0, 200)}`);
      postTurn({ role: 'assistant', text });
    });
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      const calls = ev.functionCalls || [];
      console.log('[tool]', calls.map(c => c.name).join(',') || '?');
      for (const c of calls) {
        postTurn({
          role:        'tool',
          text:        c.name || '',
          tool_name:   c.name,
          tool_args:   c.arguments ?? c.args ?? undefined,
          tool_result: typeof c.result === 'string' ? c.result : (c.result ? JSON.stringify(c.result) : undefined),
        });
      }
    });
    session.on(voice.AgentSessionEventTypes.Close, () => {
      console.log(`[livekit-agent] session closed after ${turnIndex} turns`);
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
    // Bind worker health/metrics server to loopback only — nginx is not in
    // front of :8081 and LiveKit cloud doesn't need to reach it. Defense in
    // depth against a misconfigured firewall.
    host: process.env.LIVEKIT_AGENT_HTTP_HOST || '127.0.0.1',
  }),
);
