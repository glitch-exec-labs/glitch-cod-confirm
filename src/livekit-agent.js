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
  return `***REMOVED***

***REMOVED***

## Call context (dynamic values — customer से मत पूछो, ये ***REMOVED***)

***REMOVED***

## Call flow (इन steps को order में follow करो)

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
***REMOVED***
***REMOVED***

***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

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

// ── English prompt ─────────────────────────────────────────────────────────
function englishPrompt(v, ctxLines) {
  return `***REMOVED***

***REMOVED***

## Call context (known already — do NOT ask)

***REMOVED***

## Call flow (follow in order)

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
***REMOVED***
***REMOVED***

**Common questions:**
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***

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
  if (lang === 'en-IN') {
    const address = hasRealName ? v.customer_name : '';
    return `Hello${address ? ' ' + address : ''}, this is Priya calling from Your Store. I'm calling to confirm your recent order.`;
  }
  // Hindi / Hinglish — written in DEVANAGARI so Bulbul v3 renders natively.
  // "के लिए" in Devanagari avoids Latin-transliteration drift that produced
  // "thi liye" in earlier tests.
  const address = hasRealName ? `${v.customer_name} जी` : '';
  return `***REMOVED***`;
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
