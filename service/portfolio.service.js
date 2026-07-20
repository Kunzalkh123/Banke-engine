// services/portfolio.service.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { generateDescription, generateHeader, generateStats } = require('./ai.service');
const { generateCommunityHeaderImage } = require('./communityImageGen.service');

const DEFAULTS = {
  agencyName: 'Al Furjan',
  logoUrl: path.join(__dirname, '..', 'assets', 'Banke_full_logo_white_01.png'),
  headerImage: null,
  header: {
    eyebrow: '',
    headlinePlain: '',
    headlineEmphasis: '',
  },
  stats: [],
  description: '',
  portfolioEyebrow: 'PORTFOLIO',
  portfolioTitle: 'Current listings',
};

function formatPrice(item) {
  if (!item.price) return '';
  const amount = `AED ${Number(item.price).toLocaleString()}`;
  const freq = item.frequency ? item.frequency.toLowerCase() : 'sale';
  return `${amount} / ${freq}`;
}

async function resolveLocalImage(imagePath, outputDir, filenameHint) {
  if (!imagePath) return null;

  const isRemote = /^https?:\/\//i.test(imagePath);

  if (!isRemote) {
    const absolute = path.isAbsolute(imagePath) ? imagePath : path.join(outputDir, imagePath);
    const exists = fs.existsSync(absolute);
    console.log(`[portfolio.service] Local image check: ${absolute} -- exists: ${exists}`);
    return exists ? absolute : null;
  }

  try {
    const response = await axios.get(imagePath, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    const contentType = response.headers['content-type'] || '';
    let ext = path.extname(new URL(imagePath).pathname);
    if (!ext) {
      if (contentType.includes('png')) ext = '.png';
      else if (contentType.includes('webp')) ext = '.webp';
      else ext = '.jpg';
    }
    const localPath = path.join(outputDir, `${filenameHint}${ext}`);
    fs.writeFileSync(localPath, response.data);
    return localPath;
  } catch (err) {
    console.error(`[portfolio.service] FAILED to download image from ${imagePath}:`, err.message);
    return null;
  }
}

function normalizePortfolioBrochure(rawJson) {
  const record = rawJson.record || {};
  const location = record.location || 'Community';

  const listings = (record.listings || []).map((item) => {
    const primaryImage = item.images?.[0]?.url || null;
    return {
      locationBadge: (item.property_location || location).toUpperCase(),
      priceBadge: formatPrice(item),
      title: item.title || '',
      beds: item.beds || 0,
      baths: item.baths || 0,
      areaSqft: item.build_up_area || 0,
      imageUrl: primaryImage,
      viewUrl: item.public_url || item.listingUrl || item.url || '#',
      enquireEmail: record.enquireEmail || record.agent_details?.email || '',
    };
  });

  const agentDetails = record.agent_details || null;
  const agent = agentDetails
    ? {
        name: (agentDetails.name || agentDetails.full_name || '').replace(/\s+/g, ' ').trim(),
        jobTitle: agentDetails.job_title || agentDetails.title || '',
        mobile: agentDetails.mobile || agentDetails.phone || '',
        email: agentDetails.email || '',
        photoUrl: agentDetails.photo || agentDetails.photo_url || agentDetails.image || null,
      }
    : null;

  const manualHeader = record.header || {};

  return {
    agencyName: record.agencyName || DEFAULTS.agencyName,
    logoUrl: record.logoUrl || DEFAULTS.logoUrl,
    headerImage: record.headerImage || DEFAULTS.headerImage,
    location,
    header: manualHeader,
    stats: record.stats || DEFAULTS.stats,
    description: record.description || DEFAULTS.description,
    portfolioEyebrow: record.portfolioEyebrow || DEFAULTS.portfolioEyebrow,
    portfolioTitle: record.portfolioTitle || DEFAULTS.portfolioTitle,
    listings,
    agent,
    _rawListings: record.listings || [],
  };
}

async function buildPortfolioBrochureData(rawJson, outputDir) {
  const data = normalizePortfolioBrochure(rawJson);

  const slug = (data.location || 'brochure').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const headerIsComplete =
    data.header.eyebrow && data.header.headlinePlain && data.header.headlineEmphasis;

  let headerImagePath;
  if (data.headerImage) {
    headerImagePath = await resolveLocalImage(data.headerImage, outputDir, `${slug}-header`);
  } else {
    headerImagePath = await generateCommunityHeaderImage(data.location, outputDir, `${slug}-header`);
  }

  const logoPath = await resolveLocalImage(data.logoUrl, outputDir, `${slug}-logo`);

  const aiDescription = await generateDescription({
    location: data.location,
    agencyName: data.agencyName,
    listings: data._rawListings,
    fallback: data.description,
  });

  const aiHeader = headerIsComplete
    ? data.header
    : await generateHeader({
        location: data.location,
        agencyName: data.agencyName,
        listings: data._rawListings,
        fallback: null,
      });

  const stats = data.stats.length
    ? data.stats
    : await generateStats({ location: data.location, listings: data._rawListings });

  delete data._rawListings;

  return {
    ...data,
    description: aiDescription,
    header: { ...aiHeader, ...data.header },
    stats,
    headerImagePath,
    logoPath,
  };
}

module.exports = { normalizePortfolioBrochure, buildPortfolioBrochureData };