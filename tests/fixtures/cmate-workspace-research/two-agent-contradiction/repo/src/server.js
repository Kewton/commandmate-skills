'use strict';

const http = require('node:http');
const { openCache } = require('./storage/blob-cache');

const cache = openCache(process.env.CACHE_DIR || '/tmp/node-app-cache');

const server = http.createServer((req, res) => {
  const hit = cache.get(req.url);
  res.writeHead(hit ? 200 : 404, { 'content-type': 'text/plain' });
  res.end(hit || 'miss');
});

server.listen(Number(process.env.PORT || 8080));
