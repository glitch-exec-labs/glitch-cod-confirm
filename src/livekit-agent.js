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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  cli,
  defineAgent,
  llm,
  ServerOptions,
  tokenize,
  tts,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomServiceClient } from 'livekit-server-sdk';
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
// Prompts live in `prompts/` as text templates with {{placeholder}} fields.
// Production deployments tune `prompts/hindi-prompt.txt` and
// `prompts/english-prompt.txt` (gitignored — the real IP). The public repo
// ships `*.example.txt` generic demos that are used as a fallback so the
// engine is runnable out-of-the-box for anyone who clones it.
//
// This two-file layout is what keeps the architecture open while the tuned
// wording stays proprietary. See prompts/README.md.
const PROMPTS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const promptCache = new Map();

function loadPromptTemplate(basename) {
  if (promptCache.has(basename)) return promptCache.get(basename);
  const real = resolvePath(PROMPTS_DIR, `${basename}.txt`);
  const demo = resolvePath(PROMPTS_DIR, `${basename}.example.txt`);
  let path;
  if (existsSync(real)) {
    path = real;
  } else if (existsSync(demo)) {
    path = demo;
    console.warn(`[prompts] Using demo fallback ${demo} — copy to ${basename}.txt and tune for production.`);
  } else {
    throw new Error(`[prompts] Missing both ${real} and ${demo}`);
  }
  const text = readFileSync(path, 'utf8');
  promptCache.set(basename, text);
  return text;
}

function renderTemplate(tmpl, vars) {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

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

  const isEn = lang === 'en-IN';
  const fallbackCtx = isEn
    ? `(No order context provided. This is a test / demo call — briefly greet the caller and mention you are Priya from ${v.store_name}; do not invent an order.)`
    : `(No order context. This is a test / demo call — briefly greet the caller and explain you are Priya from ${v.store_name}; do not invent an order.)`;

  // Collapse the Shopify SKU to a short speakable category before it hits
  // the prompt. SKUs like "Maybach Frame Karan Aujla Edition Luxury Sunglass
  // With Original Packing" otherwise get read verbatim — TTS mispronounces
  // brand words ("Maybach" → "May-bach") and code-mix prosody breaks on the
  // 13-English-word run. This keeps the prompt's own speech-friendliness
  // rule honoured at build time rather than hoping the LLM obeys it.
  const spoken = speakableProduct(v.product_name, lang);

  const vars = {
    store_name:           v.store_name,
    store_category:       v.store_category,
    store_article:        articleFor(v.store_category),
    context_block:        ctxLines || fallbackCtx,
    order_number_phrase:  v.order_number || (isEn ? 'your order' : 'अपना order'),
    product_phrase:       spoken
                            ? (isEn ? `a ${spoken}` : `एक ${spoken}`)
                            : (isEn ? 'your product' : 'अपना product'),
    amount_phrase:        v.total_amount
                            ? (isEn ? englishRupees(v.total_amount) : hindiRupees(v.total_amount))
                            : (isEn ? 'the stated amount' : 'बताया गया amount'),
    address_phrase:       (v.delivery_area || (isEn ? 'your address' : 'आपका address'))
                            + (v.delivery_city ? `, ${v.delivery_city}` : ''),
    call_real_suffix:     v.order_number
                            ? (isEn ? ` I am calling about your order ${v.order_number}.` : ` आपके order number ${v.order_number} के बारे में call की है।`)
                            : '',
  };

  const tmpl = loadPromptTemplate(isEn ? 'english-prompt' : 'hindi-prompt');
  return renderTemplate(tmpl, vars);
}


/**
 * Collapse a raw Shopify product title into a short speakable category
 * ("sunglasses", "shirt", ...) in the caller's language. Fed to the prompt
 * so Priya never has to read a full SKU out loud.
 *
 * Strategy: scan the SKU's lowercased words for the first keyword that maps
 * to a category. Falls back to the raw title trimmed to ≤ 3 words if no
 * keyword matches (which is better than a 10-word SKU but still a signal
 * that CATEGORY_MAP needs a new entry). Returns empty string if input is
 * empty so the caller can drop to the "आपका product" / "your product"
 * default.
 *
 * Adding a new category is one line. Brand names are NEVER entries — the
 * whole point is to get brands out of the spoken text.
 */
const CATEGORY_MAP = {
  // keyword           [ en_spoken,   hi_spoken  ]
  sunglass:            ['sunglasses', 'चश्मे'],
  sunglasses:          ['sunglasses', 'चश्मे'],
  glasses:             ['glasses',    'चश्मे'],
  spectacle:           ['glasses',    'चश्मे'],
  spectacles:          ['glasses',    'चश्मे'],
  goggle:              ['goggles',    'चश्मे'],
  goggles:             ['goggles',    'चश्मे'],
  shade:               ['sunglasses', 'चश्मे'],
  shades:              ['sunglasses', 'चश्मे'],
  shirt:               ['shirt',      'शर्ट'],
  tshirt:              ['t-shirt',    'टी-शर्ट'],
  't-shirt':           ['t-shirt',    'टी-शर्ट'],
  tee:                 ['t-shirt',    'टी-शर्ट'],
  hoodie:              ['hoodie',     'हुडी'],
  jacket:              ['jacket',     'जैकेट'],
  jean:                ['jeans',      'जीन्स'],
  jeans:               ['jeans',      'जीन्स'],
  trouser:             ['trousers',   'ट्राउज़र'],
  trousers:            ['trousers',   'ट्राउज़र'],
  pant:                ['trousers',   'ट्राउज़र'],
  pants:               ['trousers',   'ट्राउज़र'],
  short:               ['shorts',     'शॉर्ट्स'],
  shorts:              ['shorts',     'शॉर्ट्स'],
  cap:                 ['cap',        'टोपी'],
  hat:                 ['hat',        'टोपी'],
  shoe:                ['shoes',      'जूते'],
  shoes:               ['shoes',      'जूते'],
  sneaker:             ['sneakers',   'स्नीकर्स'],
  sneakers:            ['sneakers',   'स्नीकर्स'],
  boot:                ['boots',      'बूट्स'],
  boots:               ['boots',      'बूट्स'],
  sandal:              ['sandals',    'चप्पल'],
  sandals:             ['sandals',    'चप्पल'],
  slipper:             ['slippers',   'चप्पल'],
  slippers:            ['slippers',   'चप्पल'],
  watch:               ['watch',      'घड़ी'],
  wristwatch:          ['watch',      'घड़ी'],
  bag:                 ['bag',        'बैग'],
  backpack:            ['backpack',   'बैग'],
  handbag:             ['handbag',    'हैंडबैग'],
  wallet:              ['wallet',     'वॉलेट'],
  ring:                ['ring',       'अंगूठी'],
  bracelet:            ['bracelet',   'कंगन'],
  necklace:            ['necklace',   'हार'],
  chain:               ['chain',      'चेन'],
  earring:             ['earrings',   'बालियाँ'],
  earrings:            ['earrings',   'बालियाँ'],
  perfume:             ['perfume',    'परफ्यूम'],
  deodorant:           ['deodorant',  'डीओ'],
  cream:               ['cream',      'क्रीम'],
  lotion:              ['lotion',     'लोशन'],
  shampoo:             ['shampoo',    'शैम्पू'],
  serum:               ['serum',      'सीरम'],
  oil:                 ['oil',        'तेल'],
};

function speakableProduct(raw, lang) {
  const title = String(raw || '').trim();
  if (!title) return '';
  const isEn = lang === 'en-IN';
  const idx = isEn ? 0 : 1;

  const tokens = title.toLowerCase().split(/[^a-z\u0900-\u097f]+/).filter(Boolean);
  for (const t of tokens) {
    if (CATEGORY_MAP[t]) return CATEGORY_MAP[t][idx];
  }

  // No category keyword matched. Don't read the full SKU — trim to first 3
  // tokens of the original title so we emit *something* but limit prosody
  // damage. Seeing this in the wild means CATEGORY_MAP needs a new entry.
  const trimmed = title.split(/\s+/).slice(0, 3).join(' ');
  if (trimmed !== title) {
    console.warn(`[speakableProduct] no category match for "${title}" — trimmed to "${trimmed}". Consider adding a CATEGORY_MAP entry.`);
  }
  return trimmed;
}

// Fully-spoken Hindi for amounts — NO digits anywhere in the output.
//
// Earlier this returned a hint like "2350 रुपय (Hindi words: 2 हज़ार 350
// रुपय)" — which still contained the digits "2", "350" and "2350". The LLM
// took the path of least resistance and read the digit prefix verbatim
// ("2350 रुपय"), so the customer heard Arabic numerals in the middle of a
// Hindi sentence. Since the placeholder is the ONLY thing the LLM sees for
// the amount, we now return pure spoken Hindi — there is no digit option.
//
// Supports 1 – 99,99,999 (covers all realistic COD tickets up to ~1 crore).
const HI_NUM_0_99 = [
  'शून्य','एक','दो','तीन','चार','पाँच','छह','सात','आठ','नौ',
  'दस','ग्यारह','बारह','तेरह','चौदह','पंद्रह','सोलह','सत्रह','अठारह','उन्नीस',
  'बीस','इक्कीस','बाईस','तेईस','चौबीस','पच्चीस','छब्बीस','सत्ताईस','अट्ठाईस','उनतीस',
  'तीस','इकत्तीस','बत्तीस','तैंतीस','चौंतीस','पैंतीस','छत्तीस','सैंतीस','अड़तीस','उनतालीस',
  'चालीस','इकतालीस','बयालीस','तैंतालीस','चौवालीस','पैंतालीस','छियालीस','सैंतालीस','अड़तालीस','उनचास',
  'पचास','इक्यावन','बावन','तिरपन','चौवन','पचपन','छप्पन','सत्तावन','अट्ठावन','उनसठ',
  'साठ','इकसठ','बासठ','तिरसठ','चौंसठ','पैंसठ','छियासठ','सड़सठ','अड़सठ','उनहत्तर',
  'सत्तर','इकहत्तर','बहत्तर','तिहत्तर','चौहत्तर','पचहत्तर','छिहत्तर','सतहत्तर','अठहत्तर','उनासी',
  'अस्सी','इक्यासी','बयासी','तिरासी','चौरासी','पचासी','छियासी','सत्तासी','अट्ठासी','नवासी',
  'नब्बे','इक्यानवे','बानवे','तिरानवे','चौरानवे','पंचानवे','छियानवे','सत्तानवे','अट्ठानवे','निन्यानवे',
];
function hindiNumber(n) {
  if (n < 100) return HI_NUM_0_99[n];
  if (n < 1000) {
    const h = Math.floor(n / 100), rem = n % 100;
    return HI_NUM_0_99[h] + ' सौ' + (rem ? ' ' + hindiNumber(rem) : '');
  }
  if (n < 100000) {
    const k = Math.floor(n / 1000), rem = n % 1000;
    return hindiNumber(k) + ' हज़ार' + (rem ? ' ' + hindiNumber(rem) : '');
  }
  if (n < 10000000) {
    const l = Math.floor(n / 100000), rem = n % 100000;
    return hindiNumber(l) + ' लाख' + (rem ? ' ' + hindiNumber(rem) : '');
  }
  return String(n); // outside realistic COD range
}
function hindiRupees(n) {
  const amt = Math.floor(Number(String(n).replace(/[^0-9.]/g, '')));
  if (!Number.isFinite(amt) || amt <= 0) return String(n);
  return `${hindiNumber(amt)} रुपय`;
}

// Fully-spoken English for amounts — same rationale as hindiRupees.
const EN_NUM_0_19 = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const EN_TENS     = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function englishNumber(n) {
  if (n < 20) return EN_NUM_0_19[n];
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    return EN_TENS[t] + (u ? '-' + EN_NUM_0_19[u] : '');
  }
  if (n < 1000) {
    const h = Math.floor(n / 100), rem = n % 100;
    return EN_NUM_0_19[h] + ' hundred' + (rem ? ' ' + englishNumber(rem) : '');
  }
  if (n < 100000) {
    const k = Math.floor(n / 1000), rem = n % 1000;
    return englishNumber(k) + ' thousand' + (rem ? ' ' + englishNumber(rem) : '');
  }
  if (n < 10000000) {
    const l = Math.floor(n / 100000), rem = n % 100000;
    return englishNumber(l) + ' lakh' + (rem ? ' ' + englishNumber(rem) : '');
  }
  return String(n);
}
function englishRupees(n) {
  const amt = Math.floor(Number(String(n).replace(/[^0-9.]/g, '')));
  if (!Number.isFinite(amt) || amt <= 0) return String(n);
  return `${englishNumber(amt)} rupees`;
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
// TTS provider factory. Switch via TTS_PROVIDER env var: 'elevenlabs'
// (default, production) or 'sarvam' (fallback — kept wired for single-vendor
// outage recovery and regression insurance). Both return a
// @livekit/agents-compatible TTS instance.
//
// ElevenLabs (Samisha, eleven_turbo_v2_5) won the A/B on subjective Hindi
// naturalness with TTFT in the same ballpark as Sarvam and better cold-start.
// Enterprise-tier pricing removed the cost argument that originally favored
// Sarvam. Sarvam stays as a 10-second env-var flip if ElevenLabs has an
// outage or voice access is disrupted.
//
// Sample rate matches SIP 8kHz for both paths so the downstream pipeline is
// unchanged. Voice IDs / speakers are env-tunable so we can pin a specific
// ElevenLabs voice without touching code.
function buildTTS(lang) {
  const provider = (process.env.TTS_PROVIDER || 'elevenlabs').toLowerCase();
  if (provider === 'elevenlabs') {
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) {
      throw new Error('TTS_PROVIDER=elevenlabs but ELEVENLABS_VOICE_ID is not set');
    }
    console.log(`[tts] provider=elevenlabs voice=${voiceId} lang=${lang}`);
    return new elevenlabs.TTS({
      voiceId,
      // turbo_v2_5 is the low-latency multilingual model; the non-turbo
      // multilingual_v2 is better quality but adds ~400ms TTFT which hurts
      // SIP UX. If the A/B test shows turbo is too flat, try 'eleven_multilingual_v2'.
      model: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      language: lang,                // 'hi-IN' | 'en-IN' — plugin strips to base lang
      encoding: 'pcm_8000',          // match SIP sample rate
      // apiKey from ELEVEN_API_KEY env var (plugin default)
    });
  }
  console.log(`[tts] provider=sarvam speaker=neha lang=${lang}`);
  return new sarvam.TTS({
    model: 'bulbul:v3',
    speaker: 'neha',
    targetLanguageCode: lang,
    pace: 1.0,
    sampleRate: 8000,
  });
}

function buildTools(v) {
  // Sandbox/test rooms arrive without shop + shopify_order_id attributes, so
  // backend tool endpoints 400 on every call. The LLM would then retry the
  // same tool within one user turn; each retry keeps the TTS WS open with no
  // text to synthesize, and after ~60s Sarvam closes the WS with code 408
  // ("Websocket was left open without any messages for too long"). The plugin
  // flags that as unrecoverable and the whole AgentSession dies. Short-circuit
  // here with a terminal message so the LLM stops retrying and can voice a
  // graceful fallback instead.
  const hasOrderContext = Boolean(v.shop && v.shopify_order_id);

  async function postTool(name, payload) {
    if (!hasOrderContext) {
      console.warn(`[tool ${name}] SKIPPED: no shop/shopify_order_id on this call (likely sandbox)`);
      return `Tool ${name} is unavailable for this call because order context is missing. Do NOT call this tool again. Apologise briefly to the customer and end the call.`;
    }
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

    // Warm DNS + TLS sessions for the upstreams we open per-call. A full
    // cold TLS handshake to api.sarvam.ai and api.elevenlabs.io is 3–6s
    // each from this VPS; per-call session.start() serialised both, giving
    // customers 10–12s of dead air before the greeting, and in peak minutes
    // 20+s (they hung up). Hitting each host once at prewarm primes Node's
    // TLS session cache and DNS, cutting subsequent WS upgrades to ~500ms.
    //
    // HEAD/200-OK isn't important — connection and TLS negotiation are the
    // slow steps. Fire-and-forget; failure is not fatal.
    const warmupHosts = [
      'https://api.sarvam.ai/',
      'https://api.elevenlabs.io/v1/models',
      'https://api.openai.com/v1/models',
    ];
    await Promise.all(warmupHosts.map(async (url) => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 4000);
        await fetch(url, { method: 'HEAD', signal: controller.signal }).catch(() => {});
        clearTimeout(t);
      } catch { /* best-effort */ }
    }));
    console.log('[prewarm] TLS/DNS warmed for Sarvam + ElevenLabs + OpenAI');
  },

  entry: async (ctx) => {
    // Connect to the LiveKit room (required before waitForParticipant).
    await ctx.connect();

    // ── Parallelize cold-start with SIP ring ────────────────────────────
    // Previously: await waitForParticipant (2–8s SIP ring), THEN serially
    // run session.start() (5–12s for STT/TTS/LLM WS upgrades). Customers
    // heard 10–20s of dead air post-pickup and hung up.
    //
    // Now: session is constructed with hi-IN defaults and session.start()
    // is kicked off the moment ctx.connect() returns, running in parallel
    // with the SIP ring. By the time the customer picks up, STT/TTS WS
    // connections are already warm. Greeting fires near-instantly.
    //
    // hi-IN is hard-coded for the warmup because 98% of our traffic is
    // Hindi. If the participant turns out to be en-IN, the default Sarvam
    // Saaras hi-IN STT still handles English words passably (Hinglish is
    // its training distribution), and ElevenLabs multilingual TTS speaks
    // both languages. Small quality cost on the 2% edge case, zero cost
    // on the 98%. A full mid-flight STT/TTS rebuild for language swap is
    // significantly more complex and not worth it.

    // Mutable per-call context. Event handlers close over these by
    // reference so they see populated values once waitForParticipant
    // returns. Handlers don't actually FIRE until the user speaks or the
    // LLM generates, both of which happen AFTER v/lang are set.
    const ctxMut = {
      v: {},
      lang: 'hi-IN',
      turnIndex: 0,
      sipCallId: null,
    };
    const roomName = ctx.room?.name || '';

    async function postTurn({ role, text, tool_name, tool_args, tool_result, stt_confidence }) {
      if (!ctxMut.v.shop || !ctxMut.v.shopify_order_id || !roomName) return; // test/demo calls without order context — skip
      const payload = {
        shop:              ctxMut.v.shop,
        shopify_order_id:  ctxMut.v.shopify_order_id,
        room_name:         roomName,
        sip_call_id:       ctxMut.sipCallId,
        turn_index:        ctxMut.turnIndex++,
        role,
        text:              text || '',
        lang:              ctxMut.lang,
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

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: new sarvam.STT({
        model: 'saaras:v3',
        languageCode: 'hi-IN',  // hi-IN warmup default; see block comment above
      }),
      llm: new openai.LLM({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        // 60 tokens ≈ one short Hindi sentence (~12 words). Forces brevity
        // mechanically — combined with the "ONE sentence" prompt rule, cuts
        // per-turn TTS latency dramatically.
        // Prompt caching is automatic on OpenAI for prompts ≥1024 tokens —
        // our ~1800-token system prompt auto-caches after the 2nd call
        // within a 5-min window, saving ~300ms per subsequent LLM call.
        maxTokens: 60,
      }),
      // TTS provider is env-selectable so we can A/B Sarvam vs ElevenLabs on
      // the same call flow. Default is `elevenlabs` in production. WS
      // streaming path either way — REST adds 10–15s per turn which kills UX.
      tts: buildTTS('hi-IN'),  // hi-IN warmup default
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      preemptiveGeneration: true,    // default; false caused >10s startup delay, users hung up before greeting
      // AEC warmup default is 3000ms — interruptions are DISABLED during warmup.
      // 500ms is enough for echo canceller to stabilise on a SIP call while
      // keeping barge-in responsive from the first second of each agent turn.
      aecWarmupDuration: 500,
      // Indian customers backchannel heavily — "हाँ हाँ", "हाँ जी", "accha",
      // "ji ji" while the agent is still speaking is POLITENESS, not an
      // interruption. The earlier threshold of 2 words was still getting
      // tripped by "हाँ जी" and shredding Priya's sentences into 1-word
      // fragments (real call #8998 restarted "आपने" 6 times in 20 seconds).
      // Two gates must BOTH be crossed to count as an interruption:
      //   - minInterruptionWords: 3  → real objections are "nahi chahiye",
      //                                "mujhe nahi chahiye", "galat hai yeh"
      //                                — all 3+ words. Polite 1–2-word
      //                                backchannels pass through.
      //   - minInterruptionDuration: 600ms → sustained speech, not a quick
      //                                syllable. Filters echo clicks and
      //                                half-heard TTS feedback.
      minInterruptionWords: 3,
      minInterruptionDuration: 600,
    });

    // Auto-hangup guard: once any of these tools fires, the call is done —
    // the next assistant turn is just the farewell. Without this guard, the
    // SIP leg stayed up until the CUSTOMER hung up, burning VoIP minutes on
    // anyone who forgot to press end.
    const TERMINAL_TOOLS = new Set([
      'confirm_order',
      'cancel_order',
      'request_human_agent',
      'request_callback',
    ]);
    let terminalToolFired = false;
    let hangupTimer = null;
    let voicemailDetected = false;
    let userTurnCount = 0;
    // 10s bounds the typical farewell (~5s spoken) + a couple seconds of
    // customer "ok thank you" tail + grace buffer. Shorter risks clipping the
    // farewell on slower TTS; much longer wastes minutes on customers who
    // silently hold the line. Tune via AUTO_HANGUP_MS env var if needed.
    const autoHangupMs = parseInt(process.env.AUTO_HANGUP_MS || '10000', 10);

    // Voicemail / answering-machine detection.
    //
    // Real call #2953 (Abhijit, Storico) went to voicemail. Sarvam Saaras
    // running in hi-IN mode transliterated the English voicemail prompts
    // into Devanagari ("Call has been forwarded to voicemail" became
    // "कॉल हैज़ बीन फॉरवर्डेड टू वॉइस मेल"). Priya thought it was a real
    // customer, delivered the full pitch into the voicemail recording,
    // then waited 2 minutes for a yes/no — burning ~2 minutes of VoIP
    // minutes per such call.
    //
    // Strategy: pattern-match the first few user transcripts against the
    // standard Indian-carrier voicemail prompts (in Devanagari-transliterated
    // English AND native Hindi). If we hit a match in the first 4 user
    // utterances after dispatch, kill the call immediately. After that
    // window we treat any "voicemail"-shaped phrase as legitimate
    // conversation — false positives become a real risk past the greeting.
    //
    // Patterns are deliberately broad: a partial match anywhere in the
    // transcript is enough. Better to over-cancel a few real calls than
    // under-detect voicemail at scale.
    const VOICEMAIL_PATTERNS = [
      /व[ोॉ]इस[\s\-]*मे/,            // "voice mail" → वॉइस मेल / वोइस मेल
      /फ[ॉो]रवर्डेड\s+टू/,            // "forwarded to"
      /न[ॉो]ट\s+अव[ेै]लेबल/,          // "not available"
      /रिक[ॉो]र्ड\s+य[ोौ]र\s+म[ैे]सेज/, // "record your message"
      /लीव\s+अ\s+म[ैे]सेज/,          // "leave a message"
      /एट\s+द\s+ट[ोौ]न/,             // "at the tone"
      /आफ्टर\s+द\s+बीप/,            // "after the beep"
      /व्हेन\s+य[ोौ]\s+ह[ैै]व\s+फिनिश्ड/, // "when you have finished"
      /इस\s+समय\s+उपलब्ध\s+नहीं/,    // Hindi: "not available right now"
      /कृपया\s+संदेश\s+छोड़/,          // Hindi: "please leave a message"
      /voicemail|voice\s*mail/i,
      /answering\s*machine/i,
      /please\s+(record|leave)\s+(your\s+)?(message|name)/i,
      /(after|at)\s+the\s+(tone|beep)/i,
    ];

    function hangupNow(reason) {
      const roomName = ctx.room?.name;
      if (!roomName) return;
      const lkUrl = process.env.LIVEKIT_URL;
      const lkKey = process.env.LIVEKIT_API_KEY;
      const lkSecret = process.env.LIVEKIT_API_SECRET;
      if (!lkUrl || !lkKey || !lkSecret) {
        console.warn(`[hangup] LIVEKIT_* env missing — cannot terminate room (${reason})`);
        return;
      }
      console.log(`[hangup] deleteRoom ${roomName} — ${reason}`);
      const rs = new RoomServiceClient(lkUrl, lkKey, lkSecret);
      rs.deleteRoom(roomName).catch(err =>
        console.log(`[hangup] deleteRoom (likely already closed): ${err.message}`)
      );
    }

    // Each event handler persists to Postgres AND still logs to journalctl
    // so on-the-fly debugging remains zero-friction.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const transcript = ev.transcript || '';
      console.log(`[user] ${transcript}`);
      userTurnCount++;

      // Voicemail check — only in the first 4 user transcripts after
      // dispatch (window covers a multi-line voicemail intro). Past that,
      // any "voicemail"-shaped phrase is real conversation.
      if (!voicemailDetected && userTurnCount <= 4) {
        const matched = VOICEMAIL_PATTERNS.find(p => p.test(transcript));
        if (matched) {
          voicemailDetected = true;
          console.log(`[voicemail] detected on user turn #${userTurnCount}: "${transcript}" (matched ${matched})`);
          // Tag this attempt as voicemail via the postTurn channel so
          // dashboards can filter on it; treat outcome as no_answer (the
          // scheduler retry path) — the customer wasn't actually reached.
          postTurn({
            role: 'tool',
            text: 'voicemail_detected',
            tool_name: 'voicemail_detected',
            tool_args: { transcript },
            tool_result: 'hangup',
          });
          hangupNow('voicemail detected');
          return;
        }
      }

      postTurn({
        role: 'user',
        text: transcript,
        stt_confidence: typeof ev.confidence === 'number' ? ev.confidence : undefined,
      });
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item?.role !== 'assistant') return;
      const text = ev.item.textContent ?? '';
      console.log(`[priya] ${text.slice(0, 200)}`);
      postTurn({ role: 'assistant', text });

      // If a terminal tool already fired, THIS is the farewell turn.
      // Schedule the SIP hangup after the turn has had time to speak out.
      if (terminalToolFired && !hangupTimer) {
        const roomName = ctx.room?.name;
        hangupTimer = setTimeout(async () => {
          try {
            if (!roomName) return;
            const lkUrl = process.env.LIVEKIT_URL;
            const lkKey = process.env.LIVEKIT_API_KEY;
            const lkSecret = process.env.LIVEKIT_API_SECRET;
            if (!lkUrl || !lkKey || !lkSecret) {
              console.warn('[auto-hangup] LIVEKIT_* env missing — cannot terminate room');
              return;
            }
            console.log(`[auto-hangup] deleting room ${roomName} after farewell — VoIP-minutes guard (${autoHangupMs}ms)`);
            const rs = new RoomServiceClient(lkUrl, lkKey, lkSecret);
            await rs.deleteRoom(roomName);
          } catch (err) {
            // Most common non-fatal error: room already gone because the
            // customer hung up first. Log at info level, not error.
            console.log(`[auto-hangup] deleteRoom (likely already closed): ${err.message}`);
          }
        }, autoHangupMs);
      }
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
        if (TERMINAL_TOOLS.has(c.name)) {
          terminalToolFired = true;
          console.log(`[auto-hangup] armed after terminal tool: ${c.name}`);
        }
      }
    });
    session.on(voice.AgentSessionEventTypes.Close, () => {
      // Clear the pending hangup timer so we don't fire deleteRoom on an
      // already-closed room after the session ends via natural disconnect.
      if (hangupTimer) {
        clearTimeout(hangupTimer);
        hangupTimer = null;
      }
      console.log(`[livekit-agent] session closed after ${ctxMut.turnIndex} turns`);
    });

    // ── Serial start (reverted from parallelize) ───────────────────────
    // Earlier attempt: kick off session.start with a placeholder agent in
    // parallel with waitForParticipant, then updateAgent once attrs arrive.
    // Cold-start dropped to ~100ms, BUT placeholder Agent (empty tools,
    // trivial instructions) caused AgentActivity mainTask to self-exit
    // immediately — "no scheduled speech, no work, exiting." When updateAgent
    // then fired, the framework couldn't recover the dead activity and
    // session.say(welcome) silently dropped. Real customers (Storico #2907)
    // sat through 30s of dead air. Awaiting updateActivityTask.result didn't
    // help because the activity had already exited before we got there.
    //
    // Reverted to serial: wait for participant, build real agent with real
    // attrs, then start the session with that real agent. Cold-start is
    // ~3-5s with TLS/DNS pre-warmed (vs ~10s without), but the welcome
    // ALWAYS plays. Reliability beats latency at this stage.
    const participant = await ctx.waitForParticipant();

    // Pull dynamic context from participant attributes (set by
    // SipClient.createSipParticipant's participantAttributes option).
    const attrs = participant.attributes || {};
    ctxMut.lang = attrs.language === 'en-IN' ? 'en-IN' : 'hi-IN';
    ctxMut.sipCallId = attrs.sip_call_id || null;
    ctxMut.v = {
      customer_name:    attrs.customer_name    || 'Customer',
      order_number:     attrs.order_number     || '',
      total_amount:     attrs.total_amount     || '',
      product_name:     attrs.product_name     || 'your order',
      delivery_city:    attrs.delivery_city    || '',
      delivery_area:    attrs.delivery_area    || '',
      shop:             attrs.shop             || '',
      shopify_order_id: attrs.shopify_order_id || '',
      store_name:       attrs.store_name       || process.env.STORE_NAME     || 'our store',
      store_category:   attrs.store_category   || process.env.STORE_CATEGORY || 'online store',
    };
    const v = ctxMut.v;
    const lang = ctxMut.lang;
    console.log(`[livekit-agent] call for ${v.customer_name} / ${v.order_number} (${v.shop}) lang=${lang}`);

    const realAgent = new voice.Agent({
      instructions: buildSystemPrompt(v, lang),
      tools: buildTools(v),
    });

    const coldStartMs = Date.now();
    await session.start({ agent: realAgent, room: ctx.room });
    console.log(`[cold-start] serial-start: ${Date.now() - coldStartMs}ms (TLS prewarmed)`);

    // Welcome is NON-interruptible — see #9022 commit 556a91d for why.
    session.say(buildWelcome(v, lang), { allowInterruptions: false });
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
