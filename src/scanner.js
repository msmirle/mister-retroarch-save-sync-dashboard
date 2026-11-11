'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MAX_SAVE_BYTES = 16 * 1024 * 1024;
const STATUSES = ['identical', 'equivalent', 'different', 'missing', 'error', 'ambiguous'];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function paddedEquivalent(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.subarray(0, short.length).equals(short)) return false;
  const tail = long.subarray(short.length);
  return !tail.length || ((tail[0] === 0 || tail[0] === 255) && tail.every((byte) => byte === tail[0]));
}

function counts() {
  return Object.fromEntries(STATUSES.map((status) => [status, 0]));
}

async function readSave(file, platform) {
  let handle;
  try {
    handle = await fs.open(file.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Not a regular save file');
    file.size = Number(before.size);
    file.modifiedAt = new Date(Number(before.mtimeMs)).toISOString();
    if (before.size > BigInt(MAX_SAVE_BYTES)) throw new Error('Save exceeds the 16 MiB comparison limit');
    const data = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(file.absolutePath, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev) {
      throw new Error('Save changed during this scan; wait for the next refresh');
    }
    file.crc32 = crc32(data);
    if (!data.length) throw new Error('Save is empty; it cannot be verified');
    if (file.side === 'retroarch' && platform.discriminate && !platform.discriminate(data)) {
      throw new Error('Not recognized as Genesis data by upstream; may be a Master System or Game Gear save');
    }
    const raw = platform.adapter.toRaw(file.side, data);
    return { data, raw };
  } catch (error) {
    file.error = error.message;
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

async function resolveLocation(root, directory) {
  let current = root;
  for (const segment of directory.split('/')) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const matches = entries.filter((entry) => entry.name.toLowerCase() === segment.toLowerCase());
    if (matches.length > 1) throw new Error(`Ambiguous case-insensitive directory: ${directory}`);
    if (!matches.length) return null;
    if (!matches[0].isDirectory()) throw new Error(`Not a regular directory (symlinks are not followed): ${directory}`);
    current = path.join(current, matches[0].name);
  }
  return current;
}

async function collect(root, side, platform, config, issues) {
  const files = [];
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory()) throw new Error('Root is not a regular directory; symlinks are not followed');
    await fs.access(root, constants.R_OK);
  } catch (error) {
    issues.push({ side, path: root, message: `Cannot read save root: ${error.message}` });
    return files;
  }

  async function walk(directory, location) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      issues.push({ side, path: path.relative(root, directory), message: error.message });
      return;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (config.ignore.includes(lower) || config.ignoreSubstrings.some((part) => lower.includes(part))) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({ side, path: path.relative(root, absolutePath), message: 'Symlink skipped; target is not inspected' });
      } else if (entry.isDirectory()) {
        await walk(absolutePath, location);
      } else if (path.extname(lower) === (side === 'retroarch' ? '.srm' : '.sav')) {
        const game = entry.name.slice(0, -4);
        const file = {
          absolutePath, side, location, game,
          path: path.relative(root, absolutePath).split(path.sep).join('/'),
          size: null, modifiedAt: null, crc32: null, error: null,
        };
        if (!entry.isFile()) file.error = 'Not a regular save file';
        files.push(file);
      }
    }
  }

  for (const location of platform[side]) {
    try {
      const directory = await resolveLocation(root, location);
      if (!directory) {
        issues.push({ side, path: location, message: 'Configured save directory is missing' });
      } else {
        await walk(directory, location);
      }
    } catch (error) {
      issues.push({ side, path: location, message: error.message });
    }
  }
  return files;
}

async function compareGame(files, platform) {
  files.sort((a, b) => a.side.localeCompare(b.side) || a.path.localeCompare(b.path));
  const loaded = new Map();
  for (const file of files) {
    if (!file.error) loaded.set(file, await readSave(file, platform));
  }
  const retroarch = files.filter((file) => file.side === 'retroarch');
  const mister = files.filter((file) => file.side === 'mister');
  const game = {
    name: files[0].game,
    status: 'identical',
    detail: 'Save contents match byte-for-byte in every paired copy.',
    retroarch,
    mister,
  };
  const seen = new Set();
  const duplicate = files.some((file) => {
    const key = `${file.side}:${file.location.toLowerCase()}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  if (files.some((file) => file.error)) {
    game.status = 'error';
    game.detail = 'At least one file could not be verified. See the file error below.';
  } else if (duplicate) {
    game.status = 'ambiguous';
    game.detail = 'Multiple files have this game name within the same core/platform folder. Pairing is ambiguous.';
  } else if (!retroarch.length || !mister.length) {
    game.status = 'missing';
    game.detail = `No ${retroarch.length ? 'MiSTer .sav' : 'RetroArch .srm'} counterpart found.`;
  } else {
    for (const ra of retroarch) {
      for (const mi of mister) {
        const a = loaded.get(ra);
        const b = loaded.get(mi);
        if (a.data.equals(b.data)) continue;
        try {
          const equivalent = a.raw.equals(b.raw) || (platform.id !== 'snes'
            && (paddedEquivalent(a.raw, b.raw)
              || paddedEquivalent(platform.adapter.fromRaw('mister', a.raw), b.data)));
          if (!equivalent) {
            game.status = 'different';
            game.detail = 'Save-data bytes differ after accounting for this platform\'s format and padding.';
          } else if (game.status === 'identical') {
            game.status = 'equivalent';
            game.detail = 'Save contents match byte-for-byte after accounting for format or padding differences.';
          }
        } catch (error) {
          game.status = 'error';
          game.detail = `Upstream conversion failed: ${error.message}`;
          break;
        }
      }
      if (game.status === 'error') break;
    }
  }
  for (const file of files) {
    delete file.absolutePath;
    delete file.game;
  }
  return game;
}

async function scan(config) {
  const start = performance.now();
  const result = {
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    refreshSeconds: config.refreshSeconds,
    summary: counts(),
    platforms: [],
  };
  for (const platform of config.platforms) {
    const issues = [];
    const files = [
      ...await collect(config.retroarchRoot, 'retroarch', platform, config, issues),
      ...await collect(config.misterRoot, 'mister', platform, config, issues),
    ];
    const grouped = new Map();
    for (const file of files) {
      const key = file.game.toLowerCase();
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(file);
    }
    const games = [];
    const summary = counts();
    for (const key of [...grouped.keys()].sort()) {
      const game = await compareGame(grouped.get(key), platform);
      games.push(game);
      summary[game.status] += 1;
      result.summary[game.status] += 1;
    }
    result.platforms.push({ id: platform.id, label: platform.label, summary, issues, games });
  }
  result.completedAt = new Date().toISOString();
  result.durationMs = Math.round(performance.now() - start);
  return result;
}

module.exports = { crc32, paddedEquivalent, scan };
