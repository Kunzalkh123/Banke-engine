// brochure.js
//
// Usage: node brochure.js "Location Name"
//
// Reuses payload.json as a template -- listings, agent, and stats stay
// exactly the same -- but generates a brand new AI header image, headline,
// and description for whatever location you type in.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const puppeteer = require('puppeteer');
const { buildPortfolioBrochureData } = require('./services/portfolio.service');

const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function toDataUri(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    console.error(`[brochure.js] toDataUri: file does not exist at ${filePath}`);
    return null;
  }
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const buffer = fs.readFileSync(filePath);
  console.log(`[brochure.js] Embedded ${filePath} as base64 (${buffer.length} bytes)`);
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

async function main() {
  const newLocation = process.argv.slice(2).join(' ').trim();
  if (!newLocation) {
    console.error('Usage: node brochure.js "Location Name"');
    process.exit(1);
  }

  const rawPayload = fs.readFileSync(path.join(__dirname, 'payload.json'), 'utf8').replace(/^\uFEFF/, '');
  const templatePayload = JSON.parse(rawPayload);

  templatePayload.record.location = newLocation;
  delete templatePayload.record.headerImage;
  delete templatePayload.record.header;
  delete templatePayload.record.description;

  console.log(`Generating brochure for "${newLocation}"...`);
  const brochureData = await buildPortfolioBrochureData(templatePayload, OUTPUT_DIR);

  console.log(`[brochure.js] headerImagePath from buildPortfolioBrochureData: ${brochureData.headerImagePath}`);

  const templateSrc = fs.readFileSync(
    path.join(__dirname, 'templates', 'brochure-portfolio.template.html'),
    'utf8'
  );
  const template = handlebars.compile(templateSrc);

  const headerImageDataUri = toDataUri(brochureData.headerImagePath);
  const logoDataUri = toDataUri(brochureData.logoPath);

  console.log(`[brochure.js] headerImageDataUri is ${headerImageDataUri ? 'SET (' + headerImageDataUri.length + ' chars)' : 'NULL'}`);

  const html = template({
    ...brochureData,
    headerImagePath: headerImageDataUri || '',
    logoPath: logoDataUri,
  });

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123 });
 await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
  const bodyHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const pdfBuffer = await page.pdf({ width: '794px', height: `${bodyHeight}px`, printBackground: true });
  await browser.close();

  const safeName = newLocation.replace(/\s+/g, '-');
  const outPath = path.join(__dirname, `${safeName}-portfolio.pdf`);
  fs.writeFileSync(outPath, pdfBuffer);

  console.log(`Done! Saved to ${outPath}`);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});