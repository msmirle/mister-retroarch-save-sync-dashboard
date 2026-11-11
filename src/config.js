'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const PLATFORMS = {
  nes: 'NES',
  snes: 'SNES',
  genesis: 'Genesis / Mega Drive',
};

function integer(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return result;
}

function list(value, fallback) {
  return (value === undefined ? fallback : value).split(',').map((s) => s.trim()).filter(Boolean);
}

function safeDirectory(value) {
  return typeof value === 'string' && value.length > 0
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.includes('\\') && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

async function loadConfig(env = process.env) {
  const moduleRoot = path.resolve(env.SYNC_MODULE_ROOT || '/app/src');
  const { DEFAULT_MAPPING } = require(path.join(moduleRoot, 'mapping.js'));
  const { adapters, discriminators } = require(path.join(moduleRoot, 'converters.js'));
  const mapping = env.MAPPING_FILE
    ? JSON.parse(await fs.readFile(env.MAPPING_FILE, 'utf8'))
    : DEFAULT_MAPPING;
  if (!mapping || !mapping.systems) throw new Error('Mapping must contain a systems object');

  const systems = [...new Set(list(env.SYSTEMS, 'nes,snes,genesis').map((s) => s.toLowerCase()))];
  const cores = list(env.RETROARCH_CORES, 'Mesen,Snes9x,Genesis Plus GX').map((s) => s.toLowerCase());
  if (!systems.length || !cores.length) throw new Error('SYSTEMS and RETROARCH_CORES cannot be empty');
  const knownCores = new Set(Object.values(mapping.systems).flatMap((def) => def.retroarch || [])
    .map((core) => core.toLowerCase()));
  for (const core of cores) {
    if (!knownCores.has(core)) throw new Error(`Unknown RetroArch core: ${core}`);
  }

  const platforms = systems.map((id) => {
    if (!PLATFORMS[id]) throw new Error(`Unsupported dashboard platform: ${id}`);
    const def = mapping.systems[id];
    if (!def || !Array.isArray(def.retroarch) || !Array.isArray(def.mister)
      || !def.retroarch.every(safeDirectory) || !def.mister.every(safeDirectory)) {
      throw new Error(`Invalid directory mapping for ${id}`);
    }
    if (!def.retroarchExts?.includes('srm') || !def.misterExts?.includes('sav')) {
      throw new Error(`Mapping for ${id} must support .srm and .sav`);
    }
    const retroarch = def.retroarch.filter((core) => cores.includes(core.toLowerCase()));
    if (!retroarch.length || !def.mister.length) throw new Error(`No configured save locations for ${id}`);
    const adapter = adapters[id];
    if (typeof adapter?.toRaw !== 'function' || typeof adapter?.fromRaw !== 'function') {
      throw new Error(`Upstream conversion API is unavailable for ${id}`);
    }
    const discriminate = def.discriminate ? discriminators[def.discriminate] : null;
    if (def.discriminate && typeof discriminate !== 'function') {
      throw new Error(`Unknown discriminator for ${id}: ${def.discriminate}`);
    }
    return { id, label: PLATFORMS[id], retroarch, mister: def.mister, adapter, discriminate };
  });

  return {
    host: env.HOST || '0.0.0.0',
    port: integer(env.PORT, 8080, 0, 65535, 'PORT'),
    refreshSeconds: integer(env.REFRESH_SECONDS, 60, 5, 86400, 'REFRESH_SECONDS'),
    retroarchRoot: path.resolve(env.RETROARCH_ROOT || '/retroarch', 'saves'),
    misterRoot: path.resolve(env.MISTER_SAVES || '/mister/saves'),
    platforms,
    ignore: (mapping.ignore || DEFAULT_MAPPING.ignore || []).map((s) => s.toLowerCase()),
    ignoreSubstrings: (mapping.ignoreSubstrings || DEFAULT_MAPPING.ignoreSubstrings || [])
      .map((s) => s.toLowerCase()),
  };
}

module.exports = { loadConfig };
