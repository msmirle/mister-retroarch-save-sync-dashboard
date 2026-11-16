'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createSyncControl, createSyncClient, loadSyncControlConfig } = require('../src/sync-control');

async function listen(t, server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    if (socketPath) server.listen(socketPath, resolve);
    else server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  return socketPath || `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-helper-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\sync-helper-${randomUUID()}` : path.join(root, 'docker.sock');
  const calls = [];
  const state = {
    Id: 'a'.repeat(64), State: { Running: true, Paused: false, Restarting: false },
    missing: false, denyStop: false, ignoreStop: false,
  };
  const engine = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/containers/sync-target/json') {
      response.writeHead(state.missing ? 404 : 200);
      response.end(JSON.stringify(state.missing ? { message: 'not found' } : state));
    } else if (request.method === 'POST' && request.url.startsWith(`/containers/${state.Id}/`)) {
      if (request.url.endsWith('/stop?t=10') && state.denyStop) {
        response.writeHead(500);
        response.end('{"message":"test stop denied"}');
        return;
      }
      if (request.url.endsWith('/stop?t=10') && !state.ignoreStop) state.State.Running = false;
      if (request.url.endsWith('/start')) state.State.Running = true;
      if (request.url.endsWith('/unpause')) state.State.Paused = false;
      response.writeHead(204);
      response.end();
    } else {
      response.writeHead(404);
      response.end('{"message":"unexpected Docker request"}');
    }
  });
  await listen(t, engine, socketPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  const { server } = createSyncControl({ token, containerName: 'sync-target', socketPath, logger: { error() {} } });
  const url = await listen(t, server);
  return { calls, state, token, url, client: createSyncClient({ url, token }) };
}

test('sync helper authenticates requests and never forwards arbitrary Docker routes or targets', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/status`)).status, 401);
  assert.equal((await fetch(`${f.url}/off`, { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.deepEqual(f.calls, []);
  const headers = { Authorization: `Bearer ${f.token}` };
  assert.equal((await fetch(`${f.url}/containers/other/stop`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${f.url}/status`, { method: 'DELETE', headers })).status, 405);
  assert.deepEqual(f.calls, []);
  const result = await fetch(`${f.url}/off?container=other`, {
    method: 'POST', headers, body: JSON.stringify({ container: 'other' }),
  });
  assert.equal(result.status, 200);
  assert.ok(f.calls.every((call) => call.path.includes('sync-target') || call.path.includes(f.state.Id)));
  assert.ok(f.calls.some((call) => call.path.endsWith('/stop?t=10')));
  const status = await result.json();
  assert.equal(status.state, 'off');
  assert.equal('State' in status, false);
  assert.equal('token' in status, false);
});

test('sync helper verifies stop/start and idempotent operations, including an externally paused container', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client.status()).state, 'on');
  assert.equal((await f.client.setEnabled(false, f.state.Id)).state, 'off');
  assert.equal((await f.client.setEnabled(false, f.state.Id)).state, 'off');
  assert.equal(f.calls.filter((call) => call.path.endsWith('/stop?t=10')).length, 1);
  assert.equal((await f.client.setEnabled(true, f.state.Id)).state, 'on');
  f.state.State.Paused = true;
  assert.equal((await f.client.status()).state, 'paused');
  assert.equal((await f.client.setEnabled(false, f.state.Id)).state, 'off');
  assert.ok(f.calls.some((call) => call.path.endsWith('/unpause')));
});

test('sync helper refuses replaced containers, Docker errors, and unverified stop results', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.setEnabled(false, 'b'.repeat(64)), /container changed/);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  f.state.denyStop = true;
  await assert.rejects(f.client.setEnabled(false, f.state.Id), /stop denied/);
  f.state.denyStop = false;
  f.state.ignoreStop = true;
  await assert.rejects(f.client.setEnabled(false, f.state.Id), /could not be verified/);
  f.state.missing = true;
  assert.equal((await f.client.status()).state, 'missing');
  await assert.rejects(f.client.setEnabled(true), /not found/);
});

test('sync client configuration requires a strong secret and a plain HTTP(S) origin', () => {
  const token = randomBytes(32).toString('hex');
  assert.equal(loadSyncControlConfig({}), null);
  assert.deepEqual(loadSyncControlConfig({ SYNC_CONTROL_URL: 'http://sync-control:8090', SYNC_CONTROL_TOKEN: token }),
    { url: 'http://sync-control:8090', token });
  for (const url of ['file:///tmp/socket', 'http://name:password@sync-control:8090', 'http://sync-control:8090/other']) {
    assert.throws(() => loadSyncControlConfig({ SYNC_CONTROL_URL: url, SYNC_CONTROL_TOKEN: token }), /SYNC_CONTROL_URL/);
  }
  assert.throws(() => loadSyncControlConfig({ SYNC_CONTROL_URL: 'http://sync-control:8090', SYNC_CONTROL_TOKEN: 'short' }), /SYNC_CONTROL_TOKEN/);
});
