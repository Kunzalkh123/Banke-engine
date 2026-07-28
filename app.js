// app.js
require('dotenv').config();
// app.js
const express = require('express');
const path = require('path');
const communityHeaderRoute = require('./routes/communityHeader.route');
const portfolioBrochureRoute = require('./routes/portfolioBrochure.route');

const app = express();
// `type: () => true` forces express.json() to attempt parsing every
// request body as JSON regardless of the Content-Type header the client
// sent (or forgot to send). Some clients (Postmate, in this case) don't
// reliably set `Content-Type: application/json`, and without this,
// express.json() silently skips parsing -- leaving req.body as {} and
// making a perfectly valid JSON body look "missing" downstream.
app.use(express.json({ limit: '10mb', type: () => true }));

// Serve AI-generated header images (e.g. /generated/al-furjan-abc123.png)
app.use('/generated', express.static(path.join(__dirname, 'public', 'generated'))); // NEW

// Serve generated brochure PDFs as forced downloads -- without this header
// most browsers open PDFs in an inline viewer instead of downloading them,
// which defeats the point of handing back a clickable download link.
app.use('/brochures', express.static(path.join(__dirname, 'public', 'brochures'), {
  setHeaders: (res, filePath) => {
    if (path.extname(filePath).toLowerCase() === '.pdf') {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    }
  },
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use(communityHeaderRoute);
app.use(portfolioBrochureRoute);

const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;

const server = app.listen(PORT, () => console.log(`Engine active on http://localhost:${PORT}`));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (!process.env.PORT) {
      console.warn(`Port ${PORT} is already in use. Starting on a random available port instead...`);
      app.listen(0, function () {
        console.log(`Engine active on http://localhost:${this.address().port}`);
      });
      return;
    }

    console.error(`Port ${PORT} is already in use. Set a different PORT or stop the process using it.`);
    process.exit(1);
  }

  console.error(err);
  process.exit(1);
});