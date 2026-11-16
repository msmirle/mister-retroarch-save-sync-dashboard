'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { collect } = require('./scanner');

class DeletionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function inspectTarget(root, file) {
  const parts = file.path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
    throw new DeletionError(409, 'Unsafe save path; no files were deleted.');
  }
  const absolutePath = path.join(root, ...parts);
  const versions = [];
  let current = root;
  for (let index = 0; index <= parts.length; index += 1) {
    const stat = await fs.lstat(current, { bigint: true });
    const last = index === parts.length;
    if (stat.isSymbolicLink() || !(last ? stat.isFile() : stat.isDirectory())) {
      throw new DeletionError(409, 'Save paths must be regular files and directories, without symlinks.');
    }
    versions.push(last
      ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      : `${stat.dev}:${stat.ino}`);
    if (!last) current = path.join(current, parts[index]);
  }
  await fs.access(path.dirname(absolutePath), fs.constants.W_OK);
  return {
    side: file.side,
    path: file.path,
    absolutePath,
    version: versions.join('|'),
  };
}

async function planDeletion(config, platformId, name) {
  if (config.allowSaveDelete !== true) throw new DeletionError(403, 'Save deletion is disabled on this server.');
  if (typeof platformId !== 'string' || typeof name !== 'string' || !name) {
    throw new DeletionError(400, 'A platform and game name are required.');
  }
  const platform = config.platforms.find((entry) => entry.id === platformId);
  if (!platform) throw new DeletionError(400, 'Unknown platform.');
  const issues = [];
  const files = [
    ...await collect(config.retroarchRoot, 'retroarch', platform, config, issues),
    ...await collect(config.misterRoot, 'mister', platform, config, issues),
  ].filter((file) => file.game.toLowerCase() === name.toLowerCase());
  if (issues.some((issue) => issue.code !== 'MISSING_DIRECTORY')) {
    throw new DeletionError(409, 'Cannot safely list all platform saves. Resolve directory or symlink issues before deleting.');
  }
  if (!files.length) throw new DeletionError(404, 'No saves remain for this game.');
  let targets;
  try {
    targets = await Promise.all(files.map((file) => inspectTarget(
      file.side === 'retroarch' ? config.retroarchRoot : config.misterRoot, file,
    )));
  } catch (error) {
    if (error instanceof DeletionError) throw error;
    if (!['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR'].includes(error.code)) throw error;
    throw new DeletionError(409, `Cannot prepare deletion (${error.code}). Check save-directory write permissions and refresh.`);
  }
  targets.sort((a, b) => a.side.localeCompare(b.side) || a.path.localeCompare(b.path));
  return { platform: platformId, name, targets };
}

function listedFiles(targets) {
  return targets.map(({ side, path: filePath }) => ({ side, path: filePath }));
}

async function deletePlanned(config, plan, { unlink = fs.unlink } = {}) {
  const current = await planDeletion(config, plan.platform, plan.name);
  if (JSON.stringify(current.targets) !== JSON.stringify(plan.targets)) {
    throw new DeletionError(409, 'The save files changed after confirmation was opened. No files were deleted; review a new confirmation.');
  }
  // Submit every unlink before waiting; separate filesystems cannot provide an atomic paired deletion.
  const outcomes = await Promise.allSettled(plan.targets.map((target) => unlink(target.absolutePath)));
  const deleted = [];
  const failed = [];
  outcomes.forEach((outcome, index) => {
    const file = listedFiles([plan.targets[index]])[0];
    if (outcome.status === 'fulfilled') deleted.push(file);
    else failed.push({ ...file, error: outcome.reason.message });
  });
  return { deleted, failed };
}

module.exports = { DeletionError, planDeletion, deletePlanned, listedFiles };
