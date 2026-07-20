// app.js
require('dotenv').config();
// app.js
const express = require('express');
const path = require('path');
const communityHeaderRoute = require('./routes/communityHeader.route');
const portfolioBrochureRoute = require('./routes/portfolioBrochure.route');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve AI-generated header images (e.g. /generated/al-furjan-abc123.png)
app.use('/generated', express.static(path.join(__dirname, 'public', 'generated'))); // NEW
app.use(express.static(path.join(__dirname, 'public')));


app.use(communityHeaderRoute);
app.use(portfolioBrochureRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine active on http://localhost:${PORT}`));