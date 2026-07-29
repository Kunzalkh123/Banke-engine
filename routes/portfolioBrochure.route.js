// routes/portfolioBrochure.route.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const handlebars = require('handlebars');
const puppeteer = require('puppeteer');

const { buildPortfolioBrochureData } = require('../service/portfolio.service');

const router = express.Router();
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// PDFs saved here are served as downloadable links via app.js's static
// middleware (see the /brochures setHeaders override there).
const BROCHURES_DIR = path.join(__dirname, '..', 'public', 'brochures');
if (!fs.existsSync(BROCHURES_DIR)) fs.mkdirSync(BROCHURES_DIR, { recursive: true });

function toDataUri(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const buffer = fs.readFileSync(filePath);
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

// --- Serialization queue -------------------------------------------------
// Every brochure generation fires several Groq calls (classification, image
// relevance checks, description, header, stats) plus a Shutterstock search.
// Two requests running concurrently double up on both APIs at once, which is
// what was tripping Groq's rate limit and Shutterstock's timeouts. This
// queue guarantees only one generation runs at a time -- everything else
// waits its turn instead of racing.
let queueTail = Promise.resolve();
let queueLength = 0;

function enqueue(task) {
  queueLength++;
  const position = queueLength;
  if (position > 1) {
    console.log(`[portfolioBrochure.route] Request queued (position ${position}); waiting for ${position - 1} request(s) ahead of it...`);
  }

  const run = queueTail.then(async () => {
    console.log(`[portfolioBrochure.route] Starting queued request (${queueLength - position} still waiting behind it).`);
    try {
      return await task();
    } finally {
      queueLength--;
    }
  });

  // Keep the chain alive even if this task throws, so the next queued
  // request still runs instead of getting stuck behind a rejected promise.
  queueTail = run.catch(() => {});

  return run;
}

router.post('/api/brochure/portfolio', async (req, res) => {
  const location = req.body?.record?.location;
  const listingCount = Array.isArray(req.body?.record?.listings) ? req.body.record.listings.length : 0;
  const hasManualHeader = Boolean(
    req.body?.record?.header?.eyebrow &&
    req.body?.record?.header?.headlinePlain &&
    req.body?.record?.header?.headlineEmphasis
  );
  const hasManualHeaderImage = Boolean(req.body?.record?.headerImage);

  // Log exactly what arrived, before anything else runs -- this is the
  // single fastest way to tell "wrong request body" apart from "code bug"
  // when a brochure doesn't come out the way it was expected to.
  console.log(
    `[portfolioBrochure.route] Received request -- location: "${location || '(missing)'}", listings: ${listingCount}, ` +
    `manual header: ${hasManualHeader}, manual headerImage: ${hasManualHeaderImage}`
  );

  if (!location || !location.trim()) {
    console.error('[portfolioBrochure.route] Rejected: record.location is required.');
    return res.status(400).json({
      error: 'record.location is required. The brochure will not be generated without it (no silent "Community" fallback).',
    });
  }

  if (listingCount === 0) {
    console.warn(`[portfolioBrochure.route] Warning: record.listings is empty for "${location}" -- the portfolio section will render with no listings.`);
  }

  try {
    await enqueue(() => generateBrochure(req, res, location));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

async function generateBrochure(req, res, location) {
  const brochureData = await buildPortfolioBrochureData(req.body, OUTPUT_DIR);

  console.log(`[portfolioBrochure.route] Header image source for "${location}": ${brochureData.headerImageSource}`);

  const templateSrc = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'brochure-portfolio.template.html'),
    'utf8'
  );
  const template = handlebars.compile(templateSrc);

  const listingsWithDataUris = (brochureData.listings || []).map((listing) => ({
    ...listing,
    imageUrl: listing.imageUrl ? toDataUri(listing.imageUrl) : null,
  }));

  const html = template({
    ...brochureData,
    headerImagePath: brochureData.headerImagePath ? toDataUri(brochureData.headerImagePath) : '',
    logoPath: brochureData.logoPath ? toDataUri(brochureData.logoPath) : null,
    listings: listingsWithDataUris,
  });

  if (req.query.debug === 'html') {
    const safeName = (brochureData.location || 'brochure').replace(/\s+/g, '-');
    fs.writeFileSync(path.join(OUTPUT_DIR, `${safeName}-debug.html`), html);
  }

  // Webpage mode: return the rendered HTML directly, no PDF conversion.
  // Much faster since it skips Puppeteer entirely.
  if (req.query.format === 'html') {
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    return;
  }

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123 });
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });

  const bodyHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  const pdfBuffer = await page.pdf({
    width: '794px',
    height: `${bodyHeight}px`,
    printBackground: true,
  });
  await browser.close();

  const safeName = (brochureData.location || 'brochure').replace(/\s+/g, '-');

  // Unique filename per generation so repeat/regenerated brochures for the
  // same location don't clash or get served stale from a browser cache.
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const filename = `${safeName}-portfolio-${uniqueId}.pdf`;
  const filePath = path.join(BROCHURES_DIR, filename);
  fs.writeFileSync(filePath, pdfBuffer);

  const downloadUrl = `${req.protocol}://${req.get('host')}/brochures/${filename}`;
  console.log(`[portfolioBrochure.route] Done: ${downloadUrl}`);
  res.json({ url: downloadUrl, filename, headerImageSource: brochureData.headerImageSource, listingCount: brochureData.listings?.length ?? 0 });
}

module.exports = router;