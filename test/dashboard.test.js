'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadConfig } = require('../src/config');
const { crc32, scan } = require('../src/scanner');
const { createDashboard } = require('../src/server');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'save-dashboard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    SYNC_MODULE_ROOT: process.env.SYNC_MODULE_ROOT,
    RETROARCH_ROOT: path.join(root, 'retroarch'),
    MISTER_SAVES: path.join(root, 'mister'),
    ...options,
  };
  const config = await loadConfig(env);
  const originals = new Map();
  async function write(side, relative, data) {
    const target = path.join(side === 'retroarch' ? config.retroarchRoot : config.misterRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    const stat = await fs.stat(target);
    originals.set(target, { data: Buffer.from(data), mtimeMs: stat.mtimeMs });
    return target;
  }
  for (const platform of config.platforms) {
    for (const side of ['retroarch', 'mister']) {
      for (const directory of platform[side]) {
        await fs.mkdir(path.join(side === 'retroarch' ? config.retroarchRoot : config.misterRoot, directory), { recursive: true });
      }
    }
  }
  async function unchanged() {
    for (const [target, original] of originals) {
      assert.deepEqual(await fs.readFile(target), original.data, `${target} contents changed`);
      assert.equal((await fs.stat(target)).mtimeMs, original.mtimeMs, `${target} timestamp changed`);
    }
  }
  return { root, config, write, unchanged };
}

function platform(result, id) {
  return result.platforms.find((entry) => entry.id === id);
}

test('CRC32 uses the IEEE vector, detects byte differences, and preserves saves', async (t) => {
  const f = await fixture(t);
  await f.write('retroarch', 'Mesen/Zelda.srm', Buffer.from('123456789'));
  await f.write('mister', 'NES/zelda.SAV', Buffer.from('123456789'));
  await f.write('retroarch', 'Snes9x/Zelda.srm', Buffer.from('different SNES contents'));
  await f.write('mister', 'SNES/Zelda.sav', Buffer.from('123456789'));
  const result = await scan(f.config);
  const nes = platform(result, 'nes').games[0];
  assert.equal(nes.status, 'identical');
  assert.equal(nes.retroarch[0].crc32, 'CBF43926');
  assert.equal(nes.mister[0].crc32, 'CBF43926');
  assert.equal(platform(result, 'snes').games[0].status, 'different');
  assert.equal(result.summary.identical, 1);
  assert.equal(result.summary.different, 1);
  assert.equal('absolutePath' in nes.retroarch[0], false);
  assert.equal(crc32(Buffer.alloc(0)), '00000000');
  await f.unchanged();
});

test('a CRC32 collision never counts as identical save contents', async (t) => {
  const f = await fixture(t);
  const a = Buffer.from('plumless');
  const b = Buffer.from('buckeroo');
  assert.equal(crc32(a), crc32(b));
  await f.write('retroarch', 'Snes9x/Collision.srm', a);
  await f.write('mister', 'SNES/Collision.sav', b);
  assert.equal(platform(await scan(f.config), 'snes').games[0].status, 'different');
});

test('SNES data must match exactly; an extra uniform tail is not assumed to be padding', async (t) => {
  const f = await fixture(t);
  const data = Buffer.alloc(8192, 0x37);
  await f.write('retroarch', 'Snes9x/Game.srm', data);
  await f.write('mister', 'SNES/Game.sav', Buffer.concat([data, Buffer.alloc(8192)]));
  assert.equal(platform(await scan(f.config), 'snes').games[0].status, 'different');
});

test('actual upstream NES padding and Genesis conversion produce equivalent data, not raw matches', async (t) => {
  const f = await fixture(t);
  const nes = f.config.platforms.find((entry) => entry.id === 'nes');
  const genesis = f.config.platforms.find((entry) => entry.id === 'genesis');
  const nesRaw = Buffer.alloc(8192, 0x37);
  await f.write('retroarch', 'Mesen/NES game.srm', nesRaw);
  await f.write('mister', 'NES/NES game.sav', nes.adapter.fromRaw('mister', nesRaw));
  const genesisRaw = Buffer.alloc(2048);
  for (let index = 1; index < genesisRaw.length; index += 2) genesisRaw[index] = (index % 199) + 1;
  const genesisMister = genesis.adapter.fromRaw('mister', genesisRaw);
  await f.write('retroarch', 'Genesis Plus GX/Sonic.srm', genesisRaw);
  await f.write('mister', 'Genesis/Sonic.sav', genesisMister);
  await f.write('mister', 'MegaDrive/Sonic.sav', genesisMister);
  const result = await scan(f.config);
  assert.equal(result.summary.equivalent, 2);
  for (const id of ['nes', 'genesis']) {
    const game = platform(result, id).games[0];
    assert.equal(game.status, 'equivalent');
    assert.notEqual(game.retroarch[0].crc32, game.mister[0].crc32);
  }
  const changed = Buffer.from(genesisMister);
  changed[30] ^= 0x7f;
  await f.write('mister', 'MegaDrive/Sonic.sav', changed);
  assert.equal(platform(await scan(f.config), 'genesis').games[0].status, 'different',
    'a divergent alias copy must not be hidden by a matching first copy');
  await f.unchanged();
});

test('subfolders pair by basename, while duplicate names within a location are ambiguous', async (t) => {
  const f = await fixture(t);
  await f.write('retroarch', 'Mesen/RPG/Zelda.srm', Buffer.from('save'));
  await f.write('mister', 'NES/zelda.sav', Buffer.from('save'));
  assert.equal(platform(await scan(f.config), 'nes').games[0].status, 'identical');
  await f.write('mister', 'NES/Other/ZELDA.sav', Buffer.from('save'));
  const game = platform(await scan(f.config), 'nes').games[0];
  assert.equal(game.status, 'ambiguous');
  assert.equal(game.mister.length, 2);
  await f.unchanged();
});

test('all configured core copies are compared and uniform padding is not arbitrary ignored data', async (t) => {
  const f = await fixture(t, { RETROARCH_CORES: 'Mesen,FCEUmm,Snes9x,Genesis Plus GX' });
  const original = Buffer.from('save data');
  await f.write('retroarch', 'Mesen/Game.srm', original);
  await f.write('retroarch', 'FCEUmm/Game.srm', original);
  await f.write('mister', 'NES/Game.sav', Buffer.concat([original, Buffer.alloc(30, 0xff)]));
  assert.equal(platform(await scan(f.config), 'nes').games[0].status, 'equivalent');
  await f.write('retroarch', 'FCEUmm/Game.srm', Buffer.concat([original, Buffer.from([0, 0xff])]));
  assert.equal(platform(await scan(f.config), 'nes').games[0].status, 'different');
});

test('missing counterparts, empty files, oversized files, and exclusions are visible and never repaired', async (t) => {
  const f = await fixture(t);
  await f.write('retroarch', 'Mesen/Only RA.srm', Buffer.from('save'));
  await f.write('mister', 'SNES/Only MiSTer.sav', Buffer.from('save'));
  await f.write('retroarch', 'Mesen/Empty.srm', Buffer.alloc(0));
  await f.write('mister', 'NES/Empty.sav', Buffer.alloc(0));
  await f.write('retroarch', 'Mesen/Game_bak.srm', Buffer.from('ignored'));
  await f.write('mister', 'NES/Not a save.state', Buffer.from('ignored'));
  const oversized = await f.write('retroarch', 'Mesen/Huge.srm', Buffer.from('save'));
  await fs.truncate(oversized, 16 * 1024 * 1024 + 1);
  const result = await scan(f.config);
  assert.equal(result.summary.missing, 2);
  assert.equal(result.summary.error, 2);
  assert.equal(platform(result, 'nes').games.length, 3);
  assert.match(platform(result, 'nes').games.find((game) => game.name === 'Empty').retroarch[0].error, /empty/);
  assert.match(platform(result, 'nes').games.find((game) => game.name === 'Huge').retroarch[0].error, /16 MiB/);
  await assert.rejects(fs.stat(path.join(f.config.misterRoot, 'NES', 'Only RA.sav')), { code: 'ENOENT' });
});

test('missing roots/directories are scan issues, not healthy empty platforms', async (t) => {
  const f = await fixture(t);
  await fs.rmdir(path.join(f.config.misterRoot, 'SNES'));
  const result = await scan(f.config);
  assert.match(platform(result, 'snes').issues[0].message, /missing/);
  f.config.retroarchRoot = path.join(f.root, 'does-not-exist');
  const inaccessible = await scan(f.config);
  assert.ok(inaccessible.platforms.every((entry) => entry.issues.some((issue) => /Cannot read save root/.test(issue.message))));
});

test('directory names resolve case-insensitively and symlinks are reported without following them', {
  skip: process.platform === 'win32' ? 'Symlink creation requires Windows privileges; exercised in Linux CI' : false,
}, async (t) => {
  const f = await fixture(t);
  await fs.rename(path.join(f.config.misterRoot, 'NES'), path.join(f.config.misterRoot, 'nes'));
  await f.write('retroarch', 'Mesen/Match.srm', Buffer.from('save'));
  await f.write('mister', 'nes/Match.sav', Buffer.from('save'));
  const outside = path.join(f.root, 'outside.sav');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(f.config.misterRoot, 'nes', 'Link.sav'));
  const result = await scan(f.config);
  assert.equal(platform(result, 'nes').games[0].status, 'identical');
  assert.equal(platform(result, 'nes').games.length, 1);
  assert.match(platform(result, 'nes').issues[0].message, /Symlink skipped/);
});

test('unreadable saves produce explicit file errors', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'Requires non-root Linux permissions' : false,
}, async (t) => {
  const f = await fixture(t);
  const target = await f.write('retroarch', 'Mesen/Unreadable.srm', Buffer.from('save'));
  await f.write('mister', 'NES/Unreadable.sav', Buffer.from('save'));
  await fs.chmod(target, 0);
  let game;
  try {
    game = platform(await scan(f.config), 'nes').games[0];
  } finally {
    await fs.chmod(target, 0o600);
  }
  assert.equal(game.status, 'error');
  assert.match(game.retroarch[0].error, /EACCES/);
});

test('non-Genesis data and upstream conversion failures stay unverified', async (t) => {
  const f = await fixture(t);
  const sms = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 2 ? 0x43 : 0x42));
  await f.write('retroarch', 'Genesis Plus GX/SMS game.srm', sms);
  await f.write('mister', 'Genesis/SMS game.sav', Buffer.alloc(8192, 0x42));
  let game = platform(await scan(f.config), 'genesis').games[0];
  assert.equal(game.status, 'error');
  assert.match(game.retroarch[0].error, /Not recognized as Genesis/);
  await f.write('retroarch', 'Mesen/Failed.srm', Buffer.from('save'));
  await f.write('mister', 'NES/Failed.sav', Buffer.from('save'));
  f.config.platforms.find((entry) => entry.id === 'nes').adapter = {
    toRaw() { throw new Error('test conversion failure'); },
    fromRaw() { throw new Error('test conversion failure'); },
  };
  game = platform(await scan(f.config), 'nes').games[0];
  assert.equal(game.status, 'error');
  assert.match(game.mister[0].error, /test conversion failure/);
});

test('invalid configuration and unsafe mapping paths fail explicitly', async (t) => {
  const f = await fixture(t);
  const base = { SYNC_MODULE_ROOT: process.env.SYNC_MODULE_ROOT };
  await assert.rejects(loadConfig({ ...base, SYSTEMS: 'n64' }), /Unsupported dashboard platform/);
  await assert.rejects(loadConfig({ ...base, RETROARCH_CORES: 'Typo' }), /Unknown RetroArch core/);
  await assert.rejects(loadConfig({ ...base, REFRESH_SECONDS: 'NaN' }), /REFRESH_SECONDS/);
  const mapping = path.join(f.root, 'mapping.json');
  await fs.writeFile(mapping, '{"systems":{"nes":{"retroarch":["../outside"],"mister":["NES"]}}}');
  await assert.rejects(loadConfig({ ...base, MAPPING_FILE: mapping, SYSTEMS: 'nes', RETROARCH_CORES: '../outside' }), /Invalid directory mapping/);
  await fs.writeFile(mapping, '{broken JSON');
  await assert.rejects(loadConfig({ ...base, MAPPING_FILE: mapping }), SyntaxError);
});

async function listen(t, dashboard) {
  await new Promise((resolve) => dashboard.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    dashboard.server.close((error) => error ? reject(error) : resolve());
    dashboard.server.closeIdleConnections();
  }));
  return `http://127.0.0.1:${dashboard.server.address().port}`;
}

test('HTTP refresh rescans, restricts methods/origins/paths, and never modifies saves', async (t) => {
  const f = await fixture(t);
  await f.write('retroarch', 'Mesen/Example.srm', Buffer.from('first'));
  await f.write('mister', 'NES/Example.sav', Buffer.from('first'));
  const dashboard = await createDashboard(f.config);
  const url = await listen(t, dashboard);
  const page = await fetch(url);
  assert.match(await page.text(), /Save dashboard/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url}/app.js`)).status, 200);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  let state = await (await fetch(`${url}/api/status`)).json();
  assert.equal(state.snapshot.summary.identical, 1);
  await f.write('mister', 'NES/Example.sav', Buffer.from('new save'));
  state = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
  assert.equal(state.snapshot.summary.different, 1);
  assert.equal((await fetch(`${url}/api/refresh`, { method: 'POST', headers: { Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await fetch(`${url}/api/status`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${url}/LICENSE`)).status, 404);
  assert.equal((await fetch(`${url}/%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${url}/api/status`, { method: 'HEAD' })).status, 200);
  await f.unchanged();
});

test('concurrent refreshes share a scan and failures retain a visibly stale snapshot', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const errors = [];
  const dashboard = await createDashboard(f.config, {
    async scanSaves() {
      calls += 1;
      if (calls === 2) await gate;
      if (calls === 3) throw new Error('test scan failure');
      return scan(f.config);
    },
    logger: { error: (...args) => errors.push(args) },
  });
  const url = await listen(t, dashboard);
  const first = dashboard.refresh();
  const second = dashboard.refresh();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 2);
  const successful = dashboard.state().snapshot;
  const failure = await fetch(`${url}/api/refresh`, { method: 'POST' });
  assert.equal(failure.status, 503);
  const state = await failure.json();
  assert.equal(state.snapshot.completedAt, successful.completedAt);
  assert.equal(state.scanError, 'test scan failure');
  assert.ok(state.lastFailureAt);
  assert.equal(errors.length, 1);
  assert.equal((await fetch(`${url}/healthz`)).status, 503);
  await dashboard.refresh();
  assert.equal(dashboard.state().scanError, null);
});

test('server periodically refreshes without browser requests', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let refreshed;
  const nextScan = new Promise((resolve) => { refreshed = resolve; });
  const dashboard = await createDashboard({ ...f.config, refreshSeconds: 0.02 }, {
    async scanSaves() {
      const result = await scan(f.config);
      if (++calls === 2) refreshed();
      return result;
    },
  });
  await listen(t, dashboard);
  await Promise.race([
    nextScan,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Periodic refresh did not run')), 2000);
      timeout.unref();
    }),
  ]);
  assert.ok(calls >= 2);
});
