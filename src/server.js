'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('./config');
const { scan } = require('./scanner');

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

async function createDashboard(config, { scanSaves = scan, logger = console } = {}) {
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [name, contentType]]) => [
    route, { body: await fs.readFile(path.join(__dirname, '..', 'public', name)), contentType },
  ])));
  let snapshot = null;
  let activeScan = null;
  let scanError = null;
  let lastFailureAt = null;

  function refresh() {
    if (!activeScan) {
      activeScan = Promise.resolve().then(() => scanSaves(config)).then((result) => {
        snapshot = result;
        scanError = null;
        lastFailureAt = null;
      }).catch((error) => {
        scanError = error.message;
        lastFailureAt = new Date().toISOString();
        logger.error('Save scan failed:', error);
      }).finally(() => { activeScan = null; });
    }
    return activeScan;
  }
  function state() {
    return { snapshot, scanning: activeScan !== null, scanError, lastFailureAt };
  }
  function json(response, status, value, head = false) {
    response.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    response.end(head ? undefined : JSON.stringify(value));
  }
  const server = http.createServer(async (request, response) => {
    const head = request.method === 'HEAD';
    const route = request.url.split('?')[0];
    try {
      if (request.method === 'POST' && route === '/api/refresh') {
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`)
          || request.headers['sec-fetch-site'] === 'cross-site') {
          json(response, 403, { error: 'Cross-origin refresh is not allowed' });
          return;
        }
        request.resume();
        await refresh();
        json(response, scanError ? 503 : 200, state());
      } else if (request.method !== 'GET' && !head) {
        response.setHeader('Allow', route === '/api/refresh' ? 'POST' : 'GET, HEAD');
        json(response, 405, { error: 'Method not allowed' });
      } else if (route === '/api/status') {
        json(response, snapshot ? 200 : 503, state(), head);
      } else if (route === '/healthz') {
        json(response, snapshot && !scanError ? 200 : 503, {
          ready: snapshot !== null && !scanError,
          lastScan: snapshot?.completedAt || null,
          scanError,
        }, head);
      } else if (assets.has(route)) {
        const asset = assets.get(route);
        response.writeHead(200, { ...HEADERS, 'Content-Type': asset.contentType });
        response.end(head ? undefined : asset.body);
      } else {
        json(response, 404, { error: 'Not found' }, head);
      }
    } catch (error) {
      logger.error('Dashboard request failed:', error);
      if (!response.headersSent) json(response, 500, { error: 'Dashboard request failed; check server logs' });
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await refresh();
  const interval = setInterval(refresh, config.refreshSeconds * 1000);
  interval.unref();
  server.on('close', () => clearInterval(interval));
  return { server, refresh, state };
}

async function main() {
  const config = await loadConfig();
  const { server } = await createDashboard(config);
  server.on('error', (error) => {
    console.error('Dashboard server failed:', error);
    process.exitCode = 1;
    server.close();
  });
  server.listen(config.port, config.host, () => {
    console.log(`Read-only save dashboard listening on ${config.host}:${server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Cannot start dashboard:', error);
    process.exitCode = 1;
  });
}

module.exports = { createDashboard };
