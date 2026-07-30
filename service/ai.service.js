// services/ai.service.js
//
// Generates the brochure's marketing description, hero headline, stat bar,
// and architecture classification using Groq's chat completions API.

const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.6-27b';

function summarizeListings(listings = []) {
  if (!listings.length) return 'No listings supplied.';

  const prices = listings.map((l) => l.price).filter((p) => typeof p === 'number');
  const beds = listings.map((l) => l.beds).filter(Boolean);
  const baths = listings.map((l) => l.baths).filter(Boolean);
  const areas = listings.map((l) => l.build_up_area).filter(Boolean);
  const forSale = listings.filter((l) => !l.frequency).length;
  const forRent = listings.length - forSale;

  const range = (arr) => (arr.length ? `${Math.min(...arr)}–${Math.max(...arr)}` : 'n/a');

  return [
    `Total listings: ${listings.length} (${forSale} for sale, ${forRent} for rent)`,
    `Price range: AED ${range(prices)}`,
    `Bedrooms: ${range(beds)}`,
    `Bathrooms: ${range(baths)}`,
    `Build-up area (sqft): ${range(areas)}`,
    `Titles: ${listings.map((l) => l.title).join(' | ')}`,
  ].join('\n');
}

async function callGroqText(prompt, attempt = 1, tokenBudget = 4096) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set in .env');
  }

  const maxAttempts = 5;
  const maxTokenBudget = 6144;
  let response;

  try {
    response = await axios.post(
      GROQ_API_URL,
      {
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        // qwen/qwen3.6-27b's documented switch for suppressing the visible
        // reasoning trace is `reasoning_format`, not `reasoning_effort` (that
        // one is scoped to the older qwen3 family and had no effect here --
        // confirmed by the model still emitting a full <think> block with it
        // set to 'none'). 'hidden' returns only the final answer.
        reasoning_format: 'hidden',
        // Safety net: with reasoning_format: 'hidden', the model's internal
        // reasoning tokens still count against this budget even though
        // they're stripped from the visible output -- too low a limit means
        // it can burn the whole budget thinking and never emit the actual
        // answer, leaving content empty. Escalated below if that happens.
        max_completion_tokens: tokenBudget,
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && attempt < maxAttempts) {
      // Honor Groq's Retry-After header when present, but cap it -- a
      // short Retry-After (a few seconds) means a transient per-minute
      // burst limit, worth waiting out. A LONG one (minutes) means a
      // daily/hourly quota is genuinely exhausted; waiting that out mid
      // -request would hang the whole brochure generation for no benefit
      // (rotating the API key doesn't reset this either -- rate limits are
      // tied to the account, not the individual key). Past the cap, fail
      // fast to the fallback copy instead of blocking on it.
      const retryAfterHeader = err.response.headers?.['retry-after'];
      const maxWaitMs = 60000;
      const requestedWaitMs = retryAfterHeader
        ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
        : 5000 * Math.pow(2, attempt - 1);

      if (requestedWaitMs > maxWaitMs) {
        console.error(`[ai.service] Groq rate limited (429) with a ${Math.round(requestedWaitMs / 1000)}s Retry-After -- this looks like an exhausted daily/hourly quota, not a transient limit. Not waiting it out; using fallback instead.`);
        throw err;
      }

      console.warn(`[ai.service] Groq rate limited (429), retrying in ${Math.round(requestedWaitMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, requestedWaitMs));
      return callGroqText(prompt, attempt + 1, tokenBudget);
    }
    if (status === 413 && attempt < maxAttempts) {
      // The escalation logic below (finish_reason: 'length') doubles the
      // token budget when the model runs out of room -- but qwen/qwen3.6-27b
      // is a Groq *preview* model with an actual max_completion_tokens
      // ceiling lower than what was requested here. Back off by halving
      // instead of assuming more is always safe.
      const smallerBudget = Math.max(2048, Math.floor(tokenBudget / 2));
      console.warn(`[ai.service] Groq rejected max_completion_tokens=${tokenBudget} as too large (413); retrying with ${smallerBudget} (attempt ${attempt + 1}/${maxAttempts})...`);
      return callGroqText(prompt, attempt + 1, smallerBudget);
    }
    throw err;
  }

  let content = response.data?.choices?.[0]?.message?.content;
  const finishReason = response.data?.choices?.[0]?.finish_reason;

  // finish_reason 'length' means the model ran out of token budget before
  // finishing -- this applies whether content came back completely empty
  // OR partially written but cut off mid-stream (e.g. a JSON array that
  // stops mid-string). Previously only the fully-empty case was retried,
  // so a truncated-but-non-empty response slipped through as if it were
  // a complete answer, and callers (e.g. JSON.parse in generateStats) had
  // to fail on malformed content instead of this getting a clean retry.
  if (finishReason === 'length' && attempt < maxAttempts && tokenBudget < maxTokenBudget) {
    const biggerBudget = Math.min(tokenBudget * 2, maxTokenBudget);
    console.warn(`[ai.service] Groq ran out of tokens before finishing (finish_reason: length, content ${content ? 'truncated' : 'empty'}); retrying with max_completion_tokens=${biggerBudget} (attempt ${attempt + 1}/${maxAttempts})...`);
    return callGroqText(prompt, attempt + 1, biggerBudget);
  }

  if (!content) {
    console.error('[ai.service] Groq response missing content. Full response:', JSON.stringify(response.data).slice(0, 1000));
    throw new Error(`Groq response missing content (finish_reason: ${finishReason || 'unknown'})`);
  }

  // Qwen "thinking" models emit their reasoning wrapped in <think>...</think>
  // before the real answer -- strip that out so callers only see the
  // final answer.
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // If an OPEN <think> tag survives, the response got cut off mid-reasoning
  // and never reached a real answer (or reasoning wasn't actually disabled).
  // Don't let raw reasoning text leak into the brochure -- fail loudly so
  // the caller falls back to its default copy instead.
  if (/<think>/i.test(content)) {
    throw new Error('Groq response was truncated mid-reasoning (no closing </think> tag)');
  }

  return content;
}

// Scans `text` starting from the first `openChar` and returns the
// substring up to its matching `closeChar`, tracking string literals so
// brackets inside quoted strings don't throw off the depth count.
// Returns null if no balanced match is found.
function extractBalancedJson(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // never balanced out -- truncated/malformed response
}

function extractJsonPayload(rawText) {
  const candidate = rawText.trim();

  // Fast path: the whole response is already valid JSON.
  try {
    const direct = JSON.parse(candidate);
    if (Array.isArray(direct) || (direct && typeof direct === 'object')) {
      return direct;
    }
  } catch (e) {
    // fall through to extraction below
  }

  const cleaned = candidate.replace(/```json/gi, '').replace(/```/g, '').trim();

  // Find both an object and an array candidate using bracket-depth
  // matching (not a greedy regex -- a greedy `/\{[\s\S]*\}/` grabs from the
  // FIRST brace to the LAST brace in the whole string, which breaks the
  // moment the model adds any trailing note or a second example block
  // containing its own braces). Then use whichever one actually starts
  // first in the text.
  const objectText = extractBalancedJson(cleaned, '{', '}');
  const arrayText = extractBalancedJson(cleaned, '[', ']');

  const candidates = [objectText, arrayText]
    .filter(Boolean)
    .sort((a, b) => cleaned.indexOf(a) - cleaned.indexOf(b));

  for (const text of candidates) {
    try {
      const fixed = text.replace(/,\s*([\]}])/g, '$1'); // trailing commas
      return JSON.parse(fixed);
    } catch (e) {
      // try the next candidate, if any
    }
  }

  throw new Error('Could not locate valid JSON in AI response');
}

async function generateDescription({ location, agencyName, listings, fallback }) {
  const listingSummary = summarizeListings(listings);

  const prompt = `You are writing the intro paragraph for a real-estate portfolio brochure PDF.

Agency: ${agencyName}
Community: ${location}

Listing data (use only these facts, do not invent numbers or amenities):
${listingSummary}

Write EXACTLY 2 short sentences (no more than 35 words total), confident but not salesy, in
the style of a boutique property agency. Mention the number of listings and the price range
briefly. Do not use exclamation points, emojis, or markdown. Return only the description
text, nothing else. Do not include any reasoning or explanation.`;

  try {
    const text = await callGroqText(prompt);
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const trimmed = sentences.slice(0, 2).join(' ').trim();
    return trimmed || fallback || defaultFallback(location, listings);
  } catch (err) {
    console.error('[ai.service] Description generation failed, using fallback:', err.message);
    return fallback || defaultFallback(location, listings);
  }
}

async function generateHeader({ location, agencyName, listings, fallback }) {
  const listingSummary = summarizeListings(listings);

  const prompt = `You are writing the hero section of a real-estate portfolio brochure PDF cover page.

Agency: ${agencyName}
Community: ${location}

Listing data (for context only, do not quote numbers in the headline):
${listingSummary}

Return ONLY a JSON object (no markdown, no code fences, no preamble, no reasoning, no explanation)
with exactly these keys:
{
  "eyebrow": "short uppercase-style label, e.g. a location breadcrumb, under 40 characters",
  "headlinePlain": "first part of a two-part headline, plain style, under 40 characters",
  "headlineEmphasis": "second part of the headline, shown in italics, under 25 characters"
}

Tone: confident, editorial, boutique property agency. No exclamation points, no emojis.
Your entire response must be nothing but the JSON object itself.`;

  try {
    const responseText = await callGroqText(prompt);
    console.log(`[ai.service] Raw header response: ${responseText.slice(0, 500)}`);
    const parsed = extractJsonPayload(responseText);
    if (parsed && parsed.eyebrow && parsed.headlinePlain && parsed.headlineEmphasis) {
      return parsed;
    }
    throw new Error('AI header response missing required keys');
  } catch (err) {
    console.error('[ai.service] Header generation failed, using fallback:', err.message);
    return fallback || defaultHeaderFallback(location);
  }
}

async function generateStats({ location, listings }) {
  const prompt = `You are writing the quick-facts stat bar for a real-estate portfolio brochure cover page.

Community: ${location}, Dubai, UAE

Return ONLY a JSON array (no markdown, no code fences, no preamble, no reasoning) of 5 to 7
objects, each with exactly these keys: "value" and "label".

Each object should be a plausible, well-known real amenity, landmark, or commute time for this
specific Dubai neighborhood -- for example: a nearby mall or retail destination, a metro station,
a beach, a school or hospital, a major highway, or travel time in minutes to Downtown Dubai,
Dubai Marina, or the airport. Include at least one nearby mall or shopping destination if one
genuinely exists near this location. Keep each "value" under 12 characters and each "label"
under 22 characters. Do not invent numbers that sound overly precise or false; keep travel
times as round, believable estimates. Do not include anything about the number of listings.

Your entire response must be nothing but the JSON array itself.`;

  try {
    const responseText = await callGroqText(prompt);
    console.log(`[ai.service] Raw stats response: ${responseText.slice(0, 500)}`);
    const parsed = extractJsonPayload(responseText);
    if (Array.isArray(parsed) && parsed.length >= 3) {
      return parsed;
    }
    throw new Error('AI stats response malformed or too short');
  } catch (err) {
    console.error('[ai.service] Stats generation failed, using fallback:', err.message);
    return [
      { value: 'Nearby', label: 'Mall' },
      { value: 'Nearby', label: 'Metro' },
      { value: 'Nearby', label: 'School' },
    ];
  }
}

async function checkImageRelevance({ location, architectureType, description }) {
  // No metadata to judge against -- don't block the pipeline on missing data.
  if (!description) return true;

  const humanType = {
    modern_villa: 'a villa or house neighborhood',
    mediterranean_villa: 'a villa or house neighborhood',
    luxury_estate: 'a luxury mansion or house estate',
    townhouse: 'a townhouse or row-house neighborhood',
    tower: 'high rise apartment towers',
  }[architectureType] || 'a residential property';

  const prompt = `A real-estate brochure needs a header photo showing ${humanType} in "${location}", Dubai.

A candidate stock photo has this description: "${description}"

Does this photo actually show real estate -- visible buildings, rooftops, or houses -- and not
just landscape, golf course, beach, or scenery with no buildings clearly visible?

Answer with EXACTLY ONE WORD, nothing else: YES or NO.`;

  try {
    const text = await callGroqText(prompt);
    return text.trim().toUpperCase().includes('YES');
  } catch (err) {
    console.error('[ai.service] Image relevance check failed, assuming relevant:', err.message);
    return true; // don't block the pipeline on a classifier hiccup
  }
}

async function classifyArchitectureType(location) {
  const prompt = `Is the Dubai, UAE neighborhood "${location}" primarily known for low-rise
villas and townhouses, or for high-rise apartment towers and skyscrapers?

Answer with EXACTLY ONE WORD, nothing else: either VILLA or TOWER.`;

  try {
    const text = await callGroqText(prompt);
    const cleaned = text.trim().toUpperCase();
    if (cleaned.includes('VILLA')) return 'villa';
    if (cleaned.includes('TOWER')) return 'tower';
    throw new Error(`Unclear classification response: "${text}"`);
  } catch (err) {
    console.error('[ai.service] Architecture classification failed, defaulting to tower:', err.message);
    return 'tower';
  }
}

function defaultFallback(location, listings = []) {
  return `A curated portfolio of ${listings.length} listing${listings.length === 1 ? '' : 's'} in ${location}.`;
}

function defaultHeaderFallback(location) {
  return {
    eyebrow: (location || 'DUBAI').toUpperCase(),
    headlinePlain: 'A curated portfolio for',
    headlineEmphasis: 'discerning buyers',
  };
}

async function generateImageDescription(location, architectureType) {
  const humanType = {
    modern_villa: 'a modern minimalist villa community',
    mediterranean_villa: 'a villa community with terracotta-roofed, Spanish/Mediterranean-style architecture',
    luxury_estate: 'a luxury gated mansion estate',
    townhouse: 'a townhouse community',
    tower: 'high rise residential towers',
  }[architectureType] || 'a residential community';

  const prompt = `Write a short, vivid visual description of what "${location}" in Dubai, UAE actually
looks like from the air, for use as an AI image-generation prompt. It is generally known for being
${humanType}.

Base this on real, known characteristics of this specific place if you know them (distinctive
buildings, layout, landscaping, water features, colors) -- not a generic Dubai description that
could apply to any neighborhood. If you don't have specific knowledge of this exact place, describe
a plausible version of ${humanType} in Dubai instead, but do not invent a description that leans on
another country or region.

Keep it to one sentence, under 40 words, written as a list of visual details (not full prose),
suitable for feeding directly into an image generator. Do not mention camera brands, do not use
the words "photo" or "photograph". Return only the description, nothing else.`;

  try {
    const text = await callGroqText(prompt);
    return text.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    console.error('[ai.service] Image description generation failed, using generic style prompt:', err.message);
    return null;
  }
}

module.exports = { generateDescription, generateHeader, generateStats, classifyArchitectureType, checkImageRelevance, generateImageDescription };