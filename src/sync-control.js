'use strict';

const http = require('node:http');
const https = require('node:https');
const { timingSafeEqual } = require('node:crypto');

class SyncControlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('SYNC_CONTROL_TOKEN must be 64 hexadecimal characters; generate it with openssl rand -hex 32');
  }
}

function loadSyncControlConfig(env) {
  if (!env.SYNC_CONTROL_URL) return null;
  const url = new URL(env.SYNC_CONTROL_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SYNC_CONTROL_URL must be an HTTP(S) origin without credentials or a path');
  }
  validateToken(env.SYNC_CONTROL_TOKEN);
  return { url: url.origin, token: env.SYNC_CONTROL_TOKEN };
}

function requestJson(options, label, { timeout = 25_000, allowMissing = false } = {}) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === 'https:' ? https : http;
    const request = transport.request(options, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new SyncControlError(502, `${label} response is too large.`));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        let body = null;
        try {
          if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          if (!(error instanceof SyntaxError)) { reject(error); return; }
          reject(new SyncControlError(502, `${label} returned invalid JSON.`));
          return;
        }
        const status = response.statusCode;
        if ((status < 200 || status >= 300) && !(allowMissing && status === 404)) {
          reject(new SyncControlError(502, `${label} returned HTTP ${status}: ${body?.message || body?.error || 'request failed'}`));
        } else resolve({ status, body });
      });
    });
    request.setTimeout(timeout, () => request.destroy(new SyncControlError(502, `${label} timed out. Its current state is unknown.`)));
    request.on('error', (error) => reject(error instanceof SyncControlError ? error
      : new SyncControlError(502, `${label} request failed (${error.code || error.message}).`)));
    request.end();
  });
}

function createSyncClient({ url, token }) {
  validateToken(token);
  async function call(route, method = 'GET', expectedId) {
    const target = new URL(route, url);
    const { body } = await requestJson({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      path: target.pathname, method,
      headers: { Authorization: `Bearer ${token}`, ...(expectedId ? { 'If-Match': expectedId } : {}) },
    }, 'Sync control', { timeout: method === 'GET' ? 5000 : 25_000 });
    if (!body || !['on', 'off', 'paused', 'restarting', 'missing'].includes(body.state)
      || (body.state !== 'missing' && !/^[a-f0-9]{64}$/i.test(body.id || ''))
      || typeof body.container !== 'string') {
      throw new SyncControlError(502, 'Sync control returned an invalid container status.');
    }
    return body;
  }
  return {
    status: () => call('/status'),
    async setEnabled(enabled, expectedId) {
      const current = await call(enabled ? '/on' : '/off', 'POST', expectedId);
      if (current.state !== (enabled ? 'on' : 'off') || (expectedId && current.id !== expectedId)) {
        throw new SyncControlError(502, 'The requested sync state could not be verified.');
      }
      return current;
    },
  };
}

function createSyncControl({ token, containerName = 'mister-retroarch-save-sync', socketPath = '/var/run/docker.sock', logger = console }) {
  validateToken(token);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) throw new Error('Invalid SYNC_CONTAINER_NAME');
  const authorization = Buffer.from(`Bearer ${token}`);
  let changing = false;
  const docker = (route, method = 'GET', allowMissing = false) => requestJson({
    socketPath, path: route, method,
  }, 'Docker', { timeout: 20_000, allowMissing });

  async function status() {
    const result = await docker(`/containers/${encodeURIComponent(containerName)}/json`, 'GET', true);
    if (result.status === 404) return { state: 'missing', id: null, container: containerName };
    const info = result.body;
    if (!/^[a-f0-9]{64}$/i.test(info?.Id || '') || typeof info.State?.Running !== 'boolean'
      || typeof info.State.Paused !== 'boolean' || typeof info.State.Restarting !== 'boolean') {
      throw new SyncControlError(502, 'Docker returned an invalid container status.');
    }
    if (process.env.HOSTNAME && info.Id.startsWith(process.env.HOSTNAME)) {
      throw new SyncControlError(409, 'The sync helper cannot control itself.');
    }
    return {
      state: info.State.Paused ? 'paused' : info.State.Restarting ? 'restarting' : info.State.Running ? 'on' : 'off',
      id: info.Id,
      container: containerName,
    };
  }

  function json(response, code, body, head) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(head ? undefined : JSON.stringify(body));
  }
  const server = http.createServer(async (request, response) => {
    const route = request.url.split('?')[0];
    const head = request.method === 'HEAD';
    request.resume();
    try {
      if (route === '/healthz' && (request.method === 'GET' || head)) {
        json(response, 200, { ready: true }, head);
        return;
      }
      const supplied = Buffer.from(request.headers.authorization || '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        throw new SyncControlError(401, 'Unauthorized.');
      }
      if (route === '/status' && (request.method === 'GET' || head)) {
        json(response, 200, await status(), head);
      } else if (['/on', '/off'].includes(route) && request.method === 'POST') {
        if (changing) throw new SyncControlError(409, 'Another sync control operation is in progress.');
        changing = true;
        try {
          const before = await status();
          if (before.state === 'missing') throw new SyncControlError(404, 'The configured sync container was not found.');
          if (request.headers['if-match'] && request.headers['if-match'] !== before.id) {
            throw new SyncControlError(409, 'The sync container changed. Refresh before retrying.');
          }
          if (before.state === 'restarting') throw new SyncControlError(409, 'The sync container is restarting. Wait before retrying.');
          const enabled = route === '/on';
          const base = `/containers/${before.id}`;
          if (before.state === 'paused') await docker(`${base}/unpause`, 'POST');
          if (enabled && before.state === 'off') await docker(`${base}/start`, 'POST');
          if (!enabled && before.state !== 'off') await docker(`${base}/stop?t=10`, 'POST');
          const after = await status();
          if (after.id !== before.id || after.state !== (enabled ? 'on' : 'off')) {
            throw new SyncControlError(409, 'The requested sync state could not be verified.');
          }
          json(response, 200, after);
        } finally {
          changing = false;
        }
      } else {
        const known = ['/status', '/on', '/off'].includes(route);
        if (known) response.setHeader('Allow', route === '/status' ? 'GET, HEAD' : 'POST');
        json(response, known ? 405 : 404, { error: known ? 'Method not allowed.' : 'Not found.' }, head);
      }
    } catch (error) {
      logger.error('Sync control request failed:', error);
      json(response, error instanceof SyncControlError ? error.status : 500, {
        error: error instanceof SyncControlError ? error.message : 'Sync control failed; check helper logs.',
      }, head);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server };
}

function main() {
  const port = Number(process.env.PORT || 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid sync control PORT');
  const { server } = createSyncControl({
    token: process.env.SYNC_CONTROL_TOKEN,
    containerName: process.env.SYNC_CONTAINER_NAME,
    socketPath: process.env.DOCKER_SOCKET_PATH,
  });
  server.on('error', (error) => { console.error('Sync helper failed:', error); process.exitCode = 1; });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Private sync helper listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('Cannot start sync helper:', error); process.exitCode = 1; }
}

module.exports = { SyncControlError, loadSyncControlConfig, createSyncClient, createSyncControl };
