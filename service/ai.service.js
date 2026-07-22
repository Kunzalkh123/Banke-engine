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

async function callGroqText(prompt) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set in .env');
  }

  const response = await axios.post(
    GROQ_API_URL,
    {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    },
    {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  let content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Groq response missing content');
  }

  // Qwen "thinking" models emit their reasoning wrapped in <think>...</think>
  // before the real answer -- strip that out so callers only see the
  // final answer.
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  return content;
}

function extractJsonPayload(rawText) {
  let candidate = rawText.trim();

  try {
    const direct = JSON.parse(candidate);
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === 'object') return direct;
  } catch (e) {
    // fall through
  }

  const cleaned = candidate.replace(/```json|```/g, '').trim();
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  const jsonText = arrayMatch ? arrayMatch[0] : objectMatch ? objectMatch[0] : cleaned;
  const fixedText = jsonText.replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(fixedText);
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

module.exports = { generateDescription, generateHeader, generateStats, classifyArchitectureType };