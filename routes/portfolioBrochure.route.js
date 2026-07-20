// routes/portfolioBrochure.route.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const puppeteer = require('puppeteer');

const { buildPortfolioBrochureData } = require('../services/portfolio.service');

const router = express.Router();
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function toDataUri(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const buffer = fs.readFileSync(filePath);
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

router.post('/api/brochure/portfolio', async (req, res) => {
  try {
    const brochureData = await buildPortfolioBrochureData(req.body, OUTPUT_DIR);

    const templateSrc = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'brochure-portfolio.template.html'),
      'utf8'
    );
    const template = handlebars.compile(templateSrc);

    const html = template({
      ...brochureData,
      headerImagePath: brochureData.headerImagePath ? toDataUri(brochureData.headerImagePath) : '',
      logoPath: brochureData.logoPath ? toDataUri(brochureData.logoPath) : null,
    });

    // Webpage mode: return the rendered HTML directly, no PDF conversion.
    // Much faster since it skips Puppeteer entirely.
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    if (req.query.debug === 'html') {
      const safeName = (brochureData.location || 'brochure').replace(/\s+/g, '-');
      fs.writeFileSync(path.join(OUTPUT_DIR, `${safeName}-debug.html`), html);
    }

    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const bodyHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    const pdfBuffer = await page.pdf({
      width: '794px',
      height: `${bodyHeight}px`,
      printBackground: true,
    });
    await browser.close();

    const safeName = (brochureData.location || 'brochure').replace(/\s+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-portfolio.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;