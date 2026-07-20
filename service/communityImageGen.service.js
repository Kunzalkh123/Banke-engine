// services/communityImageGen.service.js
//
// Generates a hero/header image for a community using your own deployed
// Cloudflare Worker (free-image-generation-api), backed by Workers AI.

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { classifyArchitectureType } = require('./ai.service');

const IMAGE_API_URL = process.env.IMAGE_API_URL;
const IMAGE_API_KEY = process.env.IMAGE_API_KEY;
const MIN_VALID_IMAGE_BYTES = 5000; // real images are always much bigger than this

const KNOWN_TOWER_LOCATIONS = [
  'downtown dubai',
  'dubai marina',
  'business bay',
  'jbr',
  'jumeirah beach residence',
  'city walk',
  'dubai creek harbour',
  'sobha hartland',
  'jvc',
  'jumeirah village circle',
  'jlt',
  'jumeirah lake towers',
  'al reem island',
  'dubai south',
  'al furjan west', // Al Furjan West has a residential tower cluster
  'town square',
];

// Modern-style low-rise villa communities (flat roofs, contemporary look)
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
];

// Mediterranean-style villa communities (terracotta roofs, arches)
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
];

// Ultra-luxury gated estate communities (custom mansions, golf course /
// lake frontage, oversized plots -- e.g. Emirates Hills, which is
// exclusively mansion-style villas built around the Montgomerie golf
// course and a network of lakes)
const LUXURY_ESTATE_LOCATIONS = [
  'emirates hill',
  'jumeirah golf estate',
  'al barari',
  'district one villas',
  'palma',
  'grand views',
];

// Townhouse-style communities (attached/semi-attached, family-oriented)
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
  'jumeirah village triangle',
  'jvt',
  'motor city',
];

// Shared composition block reused across all villa-style prompts.
// This is the specific shot type that reliably reads as "a community"
// rather than "a single house": a 45-degree oblique aerial angle
// (never straight top-down, never eye-level), with a curving street
// threading between many properties so multiple rooftops are visible
// simultaneously in one continuous frame.
const COMMUNITY_COMPOSITION = [
  '45-degree oblique aerial drone angle, not straight top-down, not eye-level street view',
  'at least 8 to 10 separate villa rooftops clearly visible in the single frame at once',
  'one continuous curving residential road weaving between the properties and connecting them visually',
  'villas arranged in a repeating cluster on both sides of the road, some closer to camera and some receding into the background',
  'consistent architectural style repeated across every villa in frame',
  'each villa separated by low walls, driveways, or landscaping -- never touching or merged together',
  'wide-angle establishing shot of the neighborhood block, similar to a real estate drone listing photo',
];

function buildCommunityShot(subjectLines, extraLines) {
  return [...subjectLines, ...COMMUNITY_COMPOSITION, ...extraLines].join(', ');
}

async function buildPrompt(location) {
  const normalized = (location || '').toLowerCase();
  let architectureType;

  if (findMatch(normalized, MODERN_VILLA_LOCATIONS)) {
    architectureType = 'modern_villa';
    console.log(`[communityImageGen] "${location}" -- matched Modern Villa`);
  } else if (findMatch(normalized, MEDITERRANEAN_VILLA_LOCATIONS)) {
    architectureType = 'mediterranean_villa';
    console.log(`[communityImageGen] "${location}" -- matched Mediterranean Villa`);
  } else if (findMatch(normalized, LUXURY_ESTATE_LOCATIONS)) {
    architectureType = 'luxury_estate';
    console.log(`[communityImageGen] "${location}" -- matched Luxury Estate`);
  } else if (findMatch(normalized, TOWNHOUSE_LOCATIONS)) {
    architectureType = 'townhouse';
    console.log(`[communityImageGen] "${location}" -- matched Townhouse`);
  } else if (findMatch(normalized, KNOWN_TOWER_LOCATIONS)) {
    architectureType = 'tower';
    console.log(`[communityImageGen] "${location}" -- matched Tower`);
  } else {
    const aiResult = await classifyArchitectureType(location);
    architectureType = aiResult === 'villa' ? 'modern_villa' : 'tower';
    console.log(`[communityImageGen] "${location}" -- AI classified as: ${aiResult} -> using ${architectureType}`);
  }

  // ------------------------------------------------------------------
  // MODERN VILLA
  // ------------------------------------------------------------------
  if (architectureType === 'modern_villa') {
    return buildCommunityShot(
      [
        `Professional aerial drone photograph of the ${location} neighborhood, Dubai, UAE`,
        'cream and beige contemporary flat-roof villas',
        'large glass windows and elegant entrance facades',
        'small private gardens and covered parking for each villa',
        'palm trees lining the curving road',
      ],
      [
        'golden hour lighting, soft long shadows',
        'ultra realistic architectural photography, natural colors, slight film grain',
        'no apartment towers, no skyscrapers, no commercial buildings',
        'not CGI, not illustration, no text, no watermark',
      ]
    );
  }

  // ------------------------------------------------------------------
  // MEDITERRANEAN VILLA
  // ------------------------------------------------------------------
  if (architectureType === 'mediterranean_villa') {
    return buildCommunityShot(
      [
        `Professional aerial drone photograph of the ${location} neighborhood, Dubai, UAE`,
        'cream-colored villas with terracotta roof tiles',
        'decorative arches and balconies',
        'lush trees and small front gardens for each villa',
      ],
      [
        'warm sunset lighting',
        'real estate photography, photorealistic, natural lighting, slight atmospheric haze',
        'no skyscrapers, no apartment towers',
        'not CGI, no text, no watermark',
      ]
    );
  }

  // ------------------------------------------------------------------
  // LUXURY ESTATES
  // ------------------------------------------------------------------
  if (architectureType === 'luxury_estate') {
    return buildCommunityShot(
      [
        `Professional aerial drone photograph of the ${location} gated community, Dubai, UAE`,
        'large custom-built mansion-style villas, cream and stone facades, flat and low-pitched roofs',
        'oversized landscaped plots with private pools, mature palm trees, manicured lawns',
        'glimpse of a golf course fairway and a lake edge in the background',
        'gated community perimeter, quiet curving internal roads',
      ],
      [
        'golden hour sunlight, long shadows',
        'ultra realistic architectural photography, natural colors, sharp details, slight atmospheric haze',
        'no apartment buildings, no skyscrapers',
        'not CGI, no text, no watermark',
      ]
    );
  }

  // ------------------------------------------------------------------
  // TOWNHOUSES
  // ------------------------------------------------------------------
  if (architectureType === 'townhouse') {
    return buildCommunityShot(
      [
        `Professional aerial drone photograph of the ${location} neighborhood, Dubai, UAE`,
        'modern attached townhouses, contemporary architecture',
        'small front gardens, covered parking',
        'nearby family park and playground visible',
      ],
      [
        'golden hour lighting',
        'realistic architectural photography, natural colors, slight film grain',
        'no high-rise buildings, no commercial towers',
        'not CGI, no text, no watermark',
      ]
    );
  }

  // ------------------------------------------------------------------
  // TOWERS (UNCHANGED)
  // ------------------------------------------------------------------
  return [
    `Real aerial drone photograph of ${location}, Dubai, UAE`,
    'mixed-use residential community, modern high-rise apartment towers, luxury podium with retail promenade',
    'illuminated storefronts, glass curtain wall buildings, busy urban skyline',
    'warm architectural lighting, clean roads and walkways, natural city atmosphere',
    'real estate photography, captured with a DJI Mavic 3 drone, 120m altitude, 35mm equivalent lens',
    'true-to-life colors, slightly imperfect exposure, realistic reflections, faint sensor noise, natural film grain',
    'subtle atmospheric haze, high dynamic range, sharp architectural details',
    'candid documentary photography, not overly symmetrical, not overly polished, editorial photography',
    'no text, no watermark, not CGI, not illustration, not airbrushed, not overly smooth or plastic-looking',
  ].join(', ');
}

function findMatch(normalized, list) {
  return list.some((name) => normalized.includes(name));
}

async function requestImage(prompt) {
  const response = await axios.post(
    IMAGE_API_URL,
    { prompt },
    {
      responseType: 'arraybuffer',
      timeout: 90000,
      headers: {
        'Authorization': `Bearer ${IMAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );
  return response;
}

async function generateCommunityHeaderImage(location, outputDir, filenameHint) {
  if (!IMAGE_API_URL || !IMAGE_API_KEY) {
    console.error('[communityImageGen] IMAGE_API_URL or IMAGE_API_KEY not set in .env -- skipping image generation.');
    return null;
  }

  const prompt = await buildPrompt(location);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[communityImageGen] Requesting image for "${location}" (attempt ${attempt}/${maxAttempts})...`);

    try {
      const response = await requestImage(prompt);

      if (response.status !== 200) {
        const bodyText = Buffer.from(response.data).toString('utf8').slice(0, 300);
        console.error(`[communityImageGen] API returned status ${response.status}: ${bodyText}`);
      } else if (response.data.length < MIN_VALID_IMAGE_BYTES) {
        const bodyText = Buffer.from(response.data).toString('utf8').slice(0, 300);
        console.error(`[communityImageGen] Response too small (${response.data.length} bytes), likely an error: ${bodyText}`);
      } else {
        const contentType = response.headers['content-type'] || '';
        let ext = '.png';
        if (contentType.includes('jpeg')) ext = '.jpg';
        else if (contentType.includes('webp')) ext = '.webp';

        const localPath = path.join(outputDir, `${filenameHint}${ext}`);
        fs.writeFileSync(localPath, response.data);
        console.log(`[communityImageGen] Saved image (${response.data.length} bytes) to ${localPath}`);
        return localPath;
      }
    } catch (err) {
      console.error(`[communityImageGen] Request failed: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      const waitMs = 5000 * attempt;
      console.log(`[communityImageGen] Retrying in ${waitMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  console.error(`[communityImageGen] All ${maxAttempts} attempts failed for "${location}".`);
  return null;
}

module.exports = { generateCommunityHeaderImage };