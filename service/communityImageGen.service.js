// services/communityImageGen.service.js
//
// Finds a hero/header image for a community -- tries a real licensed
// Shutterstock photo first, falls back to an AI-generated image via
// Pollinations if Shutterstock is unavailable or turns up nothing usable,
// and falls back to a static default image if both fail.

const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classifyArchitectureType, generateImageDescription } = require('./ai.service');

const SHUTTERSTOCK_TOKEN = process.env.SHUTTERSTOCK_TOKEN;
const SHUTTERSTOCK_SUBSCRIPTION_ID = process.env.SHUTTERSTOCK_SUBSCRIPTION_ID;
const SHUTTERSTOCK_API_BASE = 'https://api.shutterstock.com/v2';
const POLLINATIONS_IMAGE_BASE = 'https://image.pollinations.ai/prompt';
const FALLBACK_HEADER_IMAGE = path.join(__dirname, '..', 'assets', 'default-header-image.svg');

// Shared, reusable agents so repeated calls (search, license, retries) can
// actually reuse the underlying TCP/TLS connection instead of paying for a
// fresh handshake every time. Previously a brand-new Agent was created
// inline on every request, which meant `keepAlive` never had anything to
// reuse -- pure overhead with none of the benefit. No longer forcing IPv4;
// let Node's default dual-stack resolution pick whichever path is faster.
const shutterstockHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 5 });
const shutterstockHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });

const KNOWN_TOWER_LOCATIONS = [
  'downtown dubai',
  'dubai marina',
  'business bay',
  'jbr',
  'jumeirah beach residence',
  'dubai creek harbour',
  'sobha hartland',
  'jlt',
  'jumeirah lake towers',
  'al reem island',
  'dubai south',
  'al furjan west',
  'town square',
];

const MODERN_VILLA_LOCATIONS = [
  'al furjan',
  'tilal al furjan',
  'dubai hills estate',
  'district one',
  'tilal al ghaf',
  'nad al sheba',
  'al sheba',
  'sustainable city',
  'zabeel',
  'al sufouh',
  'jumeirah village circle',
   'jvc',
];

const MEDITERRANEAN_VILLA_LOCATIONS = [
  'arabian ranches',
  'the springs',
  'the meadows',
  'the lakes',
  'jumeirah islands',
  'jumeirah park',
  'living legends',
  'falcon city',
  'al waha',
  'layan',
  'jouri hills',
  'Jumeirah village circle',
];

const LUXURY_ESTATE_LOCATIONS = [
  'emirates hill',
  'jumeirah golf estate',
  'al barari',
  'district one villas',
  'palma',
  'grand views',
  'Waterfront estates',
];

const TOWNHOUSE_LOCATIONS = [
  'villanova',
  'mudon',
  'reem',
  'damac hills',
  'akoya',
  'la rosa',
  'amaranta',
  'serena',
  'remraam',
  'arabella',
  'jvt',
  'motor city',
  'city walk',
];

function findMatch(normalized, list) {
  return list.some((name) => normalized.includes(name));
}

// Hand-written, accurate visual descriptions for well-known named
// communities -- used as the AI-fallback prompt in place of Groq's guess
// or the generic per-category template. These are curated once, here, so
// the AI path doesn't depend on Groq happening to "know" a specific
// neighborhood accurately (it often doesn't, and drifts to something
// generic or wrong). Keyed by the same lowercase substrings used for
// architecture-type classification above.
const LOCATION_VISUAL_HINTS = {
  'arabian ranches': 'Spanish Mission style villas with sand and terracotta toned stucco walls, red-brown tiled roofs, arched doorways, golf course fairways and lakes running through the community, palm-lined curving streets, low-rise (no towers)',
  'the springs': 'low-rise Mediterranean-style townhomes and villas around a series of connected lakes, cream and beige stucco walls, terracotta roofs, landscaped waterfront paths',
  'the meadows': 'low-rise villas with private gardens around a lake, cream stucco walls, terracotta roofs, mature palm and tree landscaping',
  'the lakes': 'low-rise villa community around interconnected lakes, cream and sand toned facades, terracotta roofs, lush landscaping',
  'jumeirah islands': 'low-rise villas on man-made islands surrounded by lakes and canals, Mediterranean-style architecture, private gardens',
  'al furjan': 'modern minimalist low-rise villas with clean geometric facades, light stucco and stone finishes, flat or low-pitched roofs, quiet suburban streets',
  'dubai hills estate': 'modern low-rise villas and townhouses bordering a golf course, contemporary architecture, light-toned facades, tree-lined streets',
  'jumeirah village circle': 'a mix of low-rise villas and mid-rise apartment buildings arranged in a circular community layout, modern facades, palm-lined roads',
  'emirates hill': 'large luxury mansions on a golf course, gated estate with mature landscaping, expansive private villas, low-rise (no towers)',
  'jumeirah golf estate': 'luxury villas and mansions along a championship golf course, contemporary architecture, manicured fairways and lakes',
  'al barari': 'luxury villas surrounded by dense tropical botanical landscaping and lakes, glass and wood modern architecture, lush greenery',
  'villanova': 'modern low-rise townhouses in tidy rows, light-toned facades, small private gardens, suburban streets',
  'damac hills': 'villas and townhouses around a golf course (Trump International Golf Club), modern architecture, landscaped fairways',
  'motor city': 'modern townhouses and low-rise apartments near a racetrack-themed masterplan, contemporary facades, palm-lined streets',
  'city walk': 'low-rise townhouses and boutique retail buildings, contemporary urban architecture, tree-lined pedestrian streets',
  'downtown dubai': 'dense cluster of ultra-modern glass skyscrapers including the Burj Khalifa, with the Dubai Fountain lake in the foreground',
  'dubai marina': 'a dense skyline of modern glass residential towers lining a marina waterway filled with yachts and boats',
  'business bay': 'dense modern glass high-rise towers along the Dubai Canal waterway, contemporary skyscrapers, no villas',
  'jbr': 'a row of modern high-rise residential towers directly on a sandy beach along the Arabian Gulf coastline',
  'jumeirah beach residence': 'a row of modern high-rise residential towers directly on a sandy beach along the Arabian Gulf coastline',
  'dubai creek harbour': 'modern glass residential towers along a waterway with a marina, Downtown Dubai skyline visible in the distance',
  'jlt': 'white and glass high-rise residential towers in a sweeping arc layout around interconnected artificial lakes, manicured park, palm trees',
  'jumeirah lake towers': 'white and glass high-rise residential towers in a sweeping arc layout around interconnected artificial lakes, manicured park, palm trees',
};

function getLocationHint(location) {
  const normalized = (location || '').toLowerCase();
  const key = Object.keys(LOCATION_VISUAL_HINTS).find((k) => normalized.includes(k));
  return key ? LOCATION_VISUAL_HINTS[key] : null;
}

// Deterministic pseudo-random index in [0, max) seeded by a string.
// Same location always maps to the same index (stable re-renders of the
// same brochure), but different locations spread across different indices
// instead of everyone piling onto results[0].
function seededIndex(seedStr, max) {
  const hash = crypto.createHash('md5').update(seedStr).digest('hex');
  const n = parseInt(hash.slice(0, 8), 16);
  return n % max;
}

// Classifies architecture type and builds both a stock-photo SEARCH QUERY
// and an AI image-generation PROMPT per type, with the actual location
// folded in so locations sharing a category don't all resolve identically.
async function buildSearchQuery(location) {
  const normalized = (location || '').toLowerCase();
  let architectureType;

  if (findMatch(normalized, MODERN_VILLA_LOCATIONS)) {
    architectureType = 'modern_villa';
  } else if (findMatch(normalized, MEDITERRANEAN_VILLA_LOCATIONS)) {
    architectureType = 'mediterranean_villa';
  } else if (findMatch(normalized, LUXURY_ESTATE_LOCATIONS)) {
    architectureType = 'luxury_estate';
  } else if (findMatch(normalized, TOWNHOUSE_LOCATIONS)) {
    architectureType = 'townhouse';
  } else if (findMatch(normalized, KNOWN_TOWER_LOCATIONS)) {
    architectureType = 'tower';
  } else {
    const aiResult = await classifyArchitectureType(location);
    architectureType = aiResult === 'villa' ? 'modern_villa' : 'tower';
  }

  console.log(`[communityImageGen] "${location}" -- classified as: ${architectureType}`);

  const aiPrompts = {
    modern_villa: 'professional real estate photography, aerial drone shot close enough to clearly show rows of modern minimalist villa rooftops and houses, Dubai, golden hour lighting, clean architecture, landscaped streets',
    mediterranean_villa: 'professional real estate photography, aerial drone shot close enough to clearly show Mediterranean style villa rooftops with terracotta tiles and houses, Dubai, golden hour lighting, palm trees, landscaped streets',
    luxury_estate: 'professional real estate photography, aerial drone shot close enough to clearly show large luxury mansion houses and rooftops, gated estate, Dubai, golden hour lighting, manicured grounds, greenery visible but houses the main subject',
    townhouse: 'professional real estate photography, aerial drone shot close enough to clearly show rows of modern townhouse rooftops, Dubai, golden hour lighting, tidy rows, landscaped streets',
    tower: 'professional real estate photography, aerial drone shot, Dubai high rise residential towers skyline, golden hour lighting, modern glass architecture',
  };

  // Shutterstock query is now a strict location search -- just the place
  // name (+ "Dubai" for disambiguation from same-named places elsewhere).
  // No style/category words at all. The goal: if Shutterstock actually has
  // photos of this specific place, find them; don't dilute the search with
  // generic terms that can pull in unrelated matches. The AI fallback prompt
  // (below) is what carries the architectural style guidance instead, since
  // it has no location search to lean on and needs that detail to generate
  // something plausible.
  const cleanLocation = (location || '').trim();
  const query = cleanLocation
    ? (/dubai/i.test(cleanLocation) ? cleanLocation : `${cleanLocation}, Dubai`)
    : 'Dubai';
  const aiPrompt = cleanLocation
    ? `${cleanLocation}, ${aiPrompts[architectureType]}`
    : aiPrompts[architectureType];

  return { query, aiPrompt, architectureType };
}

async function searchImages(query) {
  const response = await axios.get(`${SHUTTERSTOCK_API_BASE}/images/search`, {
    headers: { Authorization: `Bearer ${SHUTTERSTOCK_TOKEN}` },
    params: {
      query,
      orientation: 'horizontal',
      image_type: 'photo',
      per_page: 10,
      sort: 'popular',
    },
    timeout: 35000,
    httpAgent: shutterstockHttpAgent,
    httpsAgent: shutterstockHttpsAgent,
    // Forcing IPv4: curl consistently connects to this exact host in
    // under 1s with the same network/auth, while axios intermittently
    // hangs until timeout. That pattern points at a broken/blackholed
    // IPv6 route for this host -- curl's Happy Eyeballs fails over to
    // IPv4 almost instantly, but Node's default resolver doesn't, so it
    // can sit waiting on a dead IPv6 attempt until the timeout kills it.
    family: 4,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`Search failed (${response.status}): ${JSON.stringify(response.data).slice(0, 300)}`);
  }

  return response.data.data || [];
}

async function licenseImage(imageId) {
  const response = await axios.post(
    `${SHUTTERSTOCK_API_BASE}/images/licenses`,
    {
      images: [{ image_id: imageId, subscription_id: SHUTTERSTOCK_SUBSCRIPTION_ID, size: 'medium' }],
    },
    {
      headers: {
        Authorization: `Bearer ${SHUTTERSTOCK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 35000,
      httpAgent: shutterstockHttpAgent,
      httpsAgent: shutterstockHttpsAgent,
      family: 4,
      validateStatus: () => true,
    }
  );

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`License failed (${response.status}): ${JSON.stringify(response.data).slice(0, 300)}`);
  }

  const licensed = response.data.data?.[0];
  const downloadUrl = licensed?.download?.url;
  if (!downloadUrl) {
    throw new Error(`No download URL in license response: ${JSON.stringify(response.data).slice(0, 300)}`);
  }
  return downloadUrl;
}

async function downloadToFile(url, outputDir, filenameHint, headers = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    validateStatus: () => true,
    headers,
    timeout: 30000,
  });

  if (response.status !== 200) {
    // Try to surface whatever the server actually said -- arraybuffer
    // responses need decoding to read as text, and this is best-effort
    // since an error body isn't guaranteed to be valid UTF-8/JSON.
    let bodyPreview = '';
    try {
      bodyPreview = Buffer.from(response.data).toString('utf8').slice(0, 300);
    } catch (e) {
      bodyPreview = '(could not decode response body)';
    }
    console.error(`[communityImageGen] Download failed (${response.status}) from ${url.slice(0, 120)}... -- response: ${bodyPreview}`);
    throw new Error(`Download failed (${response.status})`);
  }

  const contentType = response.headers['content-type'] || '';
  let ext = '.jpg';
  if (contentType.includes('png')) ext = '.png';
  else if (contentType.includes('webp')) ext = '.webp';

  const localPath = path.join(outputDir, `${filenameHint}${ext}`);
  fs.writeFileSync(localPath, response.data);
  return localPath;
}

// --- Local relevance filter (no network call, can't time out or rate-limit) ---
// A handful of obvious off-topic signals per category. This is deliberately
// loose -- the goal is only to skip a clearly wrong photo (a beach resort for
// a villa community query), not to demand a perfect match. Previously this
// used a Groq call per candidate, which added an extra point of failure
// (timeouts, 429s) to the one path that most needs to be reliable.
const OFF_TOPIC_KEYWORDS = {
  modern_villa: ['beach resort', 'yacht', 'hotel pool', 'downtown skyline', 'high rise tower', 'coastline', 'marina', 'waterfront tower', 'cityscape', 'skyline', 'creek', 'business district', 'financial district'],
  mediterranean_villa: ['beach resort', 'yacht', 'hotel pool', 'downtown skyline', 'high rise tower', 'coastline', 'marina', 'waterfront tower', 'cityscape', 'skyline', 'creek', 'business district', 'financial district', 'tel aviv', 'israel', 'greece', 'greek island', 'santorini', 'italy', 'spain', 'portugal', 'mediterranean sea', 'europe'],
  luxury_estate: ['beach resort', 'yacht club', 'hotel pool', 'downtown skyline', 'coastline', 'marina', 'cityscape', 'skyline', 'creek'],
  townhouse: ['beach resort', 'yacht', 'golf course', 'downtown skyline', 'high rise tower', 'coastline', 'marina', 'cityscape', 'skyline', 'creek'],
  tower: ['villa community', 'desert dunes', 'farmland'],
};

// For low-rise categories, also look for at least one positive signal that
// the photo shows houses specifically -- catches generic-but-technically-
// not-negative results (e.g. a plain "aerial view of Dubai coastline" shot
// that matched the search query on relevance but shows no houses at all).
const POSITIVE_KEYWORDS = {
  modern_villa: ['villa', 'house', 'home', 'residential', 'community', 'neighborhood', 'rooftop', 'townhouse'],
  mediterranean_villa: ['villa', 'house', 'home', 'residential', 'community', 'neighborhood', 'rooftop', 'townhouse'],
  luxury_estate: ['villa', 'mansion', 'house', 'estate', 'residential', 'rooftop'],
  townhouse: ['townhouse', 'villa', 'house', 'home', 'residential', 'community', 'rooftop'],
  tower: [], // skyline/tower shots don't need a positive check -- negatives alone are enough
};

function looksOffTopic(description, architectureType) {
  const lower = (description || '').toLowerCase();
  const negatives = OFF_TOPIC_KEYWORDS[architectureType] || [];
  return negatives.some((phrase) => lower.includes(phrase));
}

function hasPositiveSignal(description, architectureType) {
  const positives = POSITIVE_KEYWORDS[architectureType] || [];
  if (!positives.length) return true; // no positive check defined for this category
  const lower = (description || '').toLowerCase();
  return positives.some((word) => lower.includes(word));
}

// --- Shutterstock path: real licensed photo ---------------------------
async function tryShutterstock(location, outputDir, filenameHint, query, architectureType) {
  if (!SHUTTERSTOCK_TOKEN || !SHUTTERSTOCK_SUBSCRIPTION_ID) {
    console.warn('[communityImageGen] SHUTTERSTOCK_TOKEN or SHUTTERSTOCK_SUBSCRIPTION_ID not set in .env; skipping Shutterstock.');
    return null;
  }

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[communityImageGen] [shutterstock] Searching for "${location}" (attempt ${attempt}/${maxAttempts})...`);

    try {
      const results = await searchImages(query);

      if (!results.length) {
        console.error(`[communityImageGen] [shutterstock] No search results for query: "${query}"`);
      } else {
        const startIdx = seededIndex(location || '', results.length);
        const ordered = results.map((_, i) => (startIdx + i) % results.length);

        // Tier 1: no off-topic keyword AND has a positive house/villa signal
        // (for categories that define one). This is the best match quality.
        let chosenIdx = ordered.find((idx) => {
          const description = results[idx].description || results[idx].title || '';
          return !looksOffTopic(description, architectureType) && hasPositiveSignal(description, architectureType);
        });

        // Tier 2: no off-topic keyword, but no explicit positive signal
        // either (description may just be sparse/generic).
        if (chosenIdx === undefined) {
          chosenIdx = ordered.find((idx) => {
            const description = results[idx].description || results[idx].title || '';
            return !looksOffTopic(description, architectureType);
          });
          if (chosenIdx !== undefined) {
            console.warn(`[communityImageGen] [shutterstock] No result had an explicit house/villa signal for "${location}" -- using best available (no off-topic keywords) instead.`);
          }
        }

        // Tier 3: everything looked off-topic. Use the seeded pick anyway --
        // a plausible real photo beats giving up and falling to the generic
        // AI image, as long as Shutterstock's API call itself succeeded.
        if (chosenIdx === undefined) {
          console.warn(`[communityImageGen] [shutterstock] Every result looked off-topic for "${location}" -- using the seeded pick anyway rather than falling back to AI.`);
          chosenIdx = startIdx;
        }

        const candidate = results[chosenIdx];
        const downloadUrl = await licenseImage(candidate.id);
        const localPath = await downloadToFile(downloadUrl, outputDir, filenameHint);
        console.log(`[communityImageGen] [shutterstock] Licensed & saved image to ${localPath} (query: "${query}", pick ${chosenIdx}/${results.length}, description: "${(candidate.description || candidate.title || '').slice(0, 80)}")`);
        return localPath;
      }
    } catch (err) {
      console.error(`[communityImageGen] [shutterstock] Attempt failed: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      const waitMs = 5000 * attempt;
      console.log(`[communityImageGen] [shutterstock] Retrying in ${waitMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  console.error(`[communityImageGen] [shutterstock] All ${maxAttempts} attempts failed for "${location}".`);
  return null;
}

// --- AI path: Pollinations-generated image -----------------------------
async function tryAIGeneration(location, outputDir, filenameHint, aiPrompt) {
  console.log(`[communityImageGen] [ai] Generating image for "${location}"...`);

  try {
    // Pollinations takes the prompt directly in the URL path, plus a
    // seed for deterministic-per-location output and a size hint.
    const seed = parseInt(crypto.createHash('md5').update(location || '').digest('hex').slice(0, 8), 16);
    const url = `${POLLINATIONS_IMAGE_BASE}/${encodeURIComponent(aiPrompt)}?width=1600&height=900&seed=${seed}&nologo=true`;

    const localPath = await downloadToFile(url, outputDir, filenameHint, {
      'User-Agent': 'Mozilla/5.0 (compatible; BankeBrochureEngine/1.0)',
    });
    console.log(`[communityImageGen] [ai] Generated & saved image to ${localPath} (prompt: "${aiPrompt}")`);
    return localPath;
  } catch (err) {
    console.error(`[communityImageGen] [ai] Attempt failed: ${err.message}`);
    return null;
  }
}

// Returns { imagePath, source } where source is 'shutterstock', 'ai', or
// 'fallback' -- so callers (brochure.js, templates) can tell/display which
// pipeline actually produced the header image.
async function generateCommunityHeaderImage(location, outputDir, filenameHint) {
  const { query, aiPrompt, architectureType } = await buildSearchQuery(location);

  const shutterstockPath = await tryShutterstock(location, outputDir, filenameHint, query, architectureType);
  if (shutterstockPath) {
    return { imagePath: shutterstockPath, source: 'shutterstock' };
  }

  console.log(`[communityImageGen] >>> Header image for "${location}" is AI-GENERATED (Shutterstock had no usable photo of this location).`);

  // Priority 1: a hand-curated, accurate description for well-known named
  // communities -- more reliable than Groq's guess, since Groq's knowledge
  // of a specific micro-neighborhood is often generic or wrong. Priority 2
  // (only if no curated hint exists): ask Groq. Priority 3: the generic
  // per-category template.
  const curatedHint = getLocationHint(location);
  const groqDescription = curatedHint ? null : await generateImageDescription(location, architectureType);
  const description = curatedHint || groqDescription;
  if (curatedHint) {
    console.log(`[communityImageGen] [ai] Using curated description for "${location}": "${curatedHint}"`);
  } else if (groqDescription) {
    console.log(`[communityImageGen] [ai] Using Groq-written description for "${location}": "${groqDescription}"`);
  } else {
    console.log(`[communityImageGen] [ai] No curated hint and Groq description unavailable -- using generic ${architectureType} style prompt instead.`);
  }
  let richAiPrompt = null;
  if (description) {
    // Strip any trailing punctuation before appending more text (avoids
    // "...desert backdrop., professional..." double-punctuation), and cap
    // overall length -- long prompts have caused Pollinations to return 500s.
    const cleanedDescription = description.replace(/[.!?]+$/, '').trim();
    richAiPrompt = `${location}, ${cleanedDescription}, aerial drone photography, golden hour`;
    if (richAiPrompt.length > 220) {
      richAiPrompt = richAiPrompt.slice(0, 220);
    }
  }

  // Tier 1: the rich, location-specific Groq description (best quality).
  let aiPath = richAiPrompt ? await tryAIGeneration(location, outputDir, filenameHint, richAiPrompt) : null;

  // Tier 2: if that failed, fall back to the shorter, previously-reliable
  // generic per-category prompt before giving up entirely. Pollinations
  // only allows ONE request in flight per IP at a time -- firing tier 2
  // immediately after tier 1 fails risks colliding with tier 1's request
  // if it's still processing server-side even though we stopped waiting on
  // it, which is exactly what caused "Queue full (max: 1)" errors. Wait
  // long enough for that to clear before trying again.
  if (!aiPath) {
    console.log('[communityImageGen] [ai] Waiting 15s before the next attempt (Pollinations allows only one request in flight at a time)...');
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const promptForTier2 = richAiPrompt
      ? (() => {
          console.log(`[communityImageGen] [ai] Rich description prompt failed -- retrying once with the generic ${architectureType} style prompt.`);
          return aiPrompt;
        })()
      : aiPrompt;
    aiPath = await tryAIGeneration(location, outputDir, filenameHint, promptForTier2);
  }

  if (aiPath) {
    return { imagePath: aiPath, source: 'ai' };
  }

  console.error(`[communityImageGen] Both Shutterstock and AI generation failed for "${location}"; using static fallback image.`);
  return { imagePath: FALLBACK_HEADER_IMAGE, source: 'fallback' };
}

module.exports = { generateCommunityHeaderImage };