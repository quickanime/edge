'use strict';

const http = require('http');
const path = require('path');
const express = require('express');

const auth = require('./auth');
const api = require('./api');
const realtime = require('./realtime');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Uctan uca sifreleme Web Crypto'ya dayanir; harici kaynak yuklenmez.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/auth', auth.router);
app.use('/api', auth.authenticate, api);

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    return res.status(404).json({ error: 'Bulunamadi.' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Sunucu hatasi.' : err.message });
});

const server = http.createServer(app);
realtime.attach(server);

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Edge ${port} portunda calisiyor -> http://localhost:${port}`);
});
