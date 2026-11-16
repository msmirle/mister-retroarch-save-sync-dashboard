'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadConfig } = require('./config');
const { scan } = require('./scanner');
const { DeletionError, planDeletion, deletePlanned, listedFiles } = require('./deletion');

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
  ['/icons/apple-touch-icon.png', ['icons/apple-touch-icon.png', 'image/png']],
]);
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

async function createDashboard(config, { scanSaves = scan, deleteSaves = deletePlanned, logger = console } = {}) {
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [name, contentType]]) => [
    route, { body: await fs.readFile(path.join(__dirname, '..', 'public', name)), contentType },
  ])));
  let snapshot = null;
  let activeScan = null;
  let scanError = null;
  let lastFailureAt = null;
  let activeDeletion = null;
  const deletionPlans = new Map();

  function refresh() {
    if (activeDeletion) return activeDeletion;
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
    return {
      snapshot, scanning: activeScan !== null, scanError, lastFailureAt,
      deletionEnabled: config.allowSaveDelete === true,
      deleting: activeDeletion !== null,
    };
  }
  function json(response, status, value, head = false) {
    response.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    response.end(head ? undefined : JSON.stringify(value));
  }
  async function deletionRequest(request) {
    if (config.allowSaveDelete !== true) throw new DeletionError(403, 'Save deletion is disabled on this server.');
    const origin = request.headers.origin;
    if (![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(origin)
      || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
      throw new DeletionError(403, 'Same-origin requests are required for save deletion.');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      throw new DeletionError(415, 'Save deletion requires application/json.');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size <= 8192) chunks.push(chunk);
    }
    if (size > 8192) throw new DeletionError(413, 'Deletion request is too large.');
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new DeletionError(400, 'Invalid JSON deletion request.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new DeletionError(400, 'A JSON object is required.');
    }
    return body;
  }
  const server = http.createServer(async (request, response) => {
    const head = request.method === 'HEAD';
    const route = request.url.split('?')[0];
    try {
      if (request.method === 'POST' && (route === '/api/delete/preview' || route === '/api/delete')) {
        const body = await deletionRequest(request);
        if (activeDeletion) throw new DeletionError(409, 'Another deletion is in progress. Refresh before retrying.');
        for (const [token, plan] of deletionPlans) {
          if (plan.expiresAt <= Date.now()) deletionPlans.delete(token);
        }
        if (route === '/api/delete/preview') {
          if (deletionPlans.size >= 100) throw new DeletionError(429, 'Too many pending confirmations. Try again in five minutes.');
          const plan = await planDeletion(config, body.platform, body.game);
          if (deletionPlans.size >= 100) throw new DeletionError(429, 'Too many pending confirmations. Try again in five minutes.');
          const token = randomUUID();
          const expiresAt = Date.now() + 5 * 60 * 1000;
          deletionPlans.set(token, { ...plan, expiresAt });
          json(response, 200, { token, expiresAt, platform: plan.platform, game: plan.name, files: listedFiles(plan.targets) });
        } else {
          const plan = deletionPlans.get(body.token);
          if (!plan || body.confirm !== plan.name) {
            throw new DeletionError(409, 'Confirmation expired or does not match. Review a new deletion confirmation.');
          }
          deletionPlans.delete(body.token);
          activeDeletion = (async () => {
            if (activeScan) await activeScan;
            return deleteSaves(config, plan);
          })();
          let result;
          try {
            result = await activeDeletion;
          } finally {
            activeDeletion = null;
            await refresh();
          }
          const remaining = snapshot?.platforms.find((entry) => entry.id === plan.platform)?.games
            .find((game) => game.name.toLowerCase() === plan.name.toLowerCase());
          let error = null;
          if (result.failed.length) error = 'Some save files could not be deleted. Review the per-file errors before retrying.';
          else if (scanError) error = 'Files were removed, but the follow-up scan failed. Their current absence could not be verified.';
          else if (remaining) error = 'Save files still exist or were recreated by another writer. Refresh and review before retrying.';
          if (error) logger.error('Save deletion incomplete:', { error, ...result });
          json(response, error ? 409 : 200, { ...state(), ...result, error });
        }
      } else if (request.method === 'POST' && route === '/api/refresh') {
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
        response.setHeader('Allow', ['/api/refresh', '/api/delete', '/api/delete/preview'].includes(route) ? 'POST' : 'GET, HEAD');
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
      request.resume();
      if (!response.headersSent) {
        json(response, error instanceof DeletionError ? error.status : 500, {
          error: error instanceof DeletionError ? error.message : 'Dashboard request failed; check server logs',
        });
      }
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await refresh();
  const interval = setInterval(() => { if (!activeDeletion) refresh(); }, config.refreshSeconds * 1000);
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
    console.log(`Save dashboard listening on ${config.host}:${server.address().port} (deletion ${config.allowSaveDelete ? 'enabled' : 'disabled'})`);
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
