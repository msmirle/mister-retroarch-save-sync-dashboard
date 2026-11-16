'use strict';

const LABELS = {
  identical: 'Contents match',
  equivalent: 'Contents match (format differs)',
  different: 'Different contents',
  missing: 'Missing counterpart',
  error: 'Read / format error',
  ambiguous: 'Ambiguous names',
};
const ATTENTION = new Set(['different', 'missing', 'error', 'ambiguous']);
let latest = null;
let selectedPlatform = 'all';
let refreshing = false;
let deletionBusy = false;
let pendingDeletion = null;
let syncBusy = false;
let syncState = { configured: false, state: 'unknown', busy: false };
const $ = (id) => document.getElementById(id);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function timestamp(value) {
  return value ? new Date(value).toLocaleString() : 'unknown';
}

function updateControls() {
  for (const button of document.querySelectorAll('.delete-save')) {
    button.disabled = refreshing || deletionBusy || syncBusy || latest?.deleting || syncState.busy
      || (syncState.configured && !['on', 'off'].includes(syncState.state)) || !$('connection-error').hidden;
  }
  $('sync-toggle').disabled = refreshing || deletionBusy || syncBusy || syncState.busy
    || !['on', 'off', 'paused'].includes(syncState.state) || !$('connection-error').hidden;
}

function renderSync(sync) {
  syncState = sync;
  const labels = {
    on: 'On', off: 'Off', paused: 'Paused externally', restarting: 'Restarting',
    missing: 'Container not found', unavailable: 'Unavailable', unknown: 'Checking...',
    'not-configured': 'Not connected',
  };
  $('sync-status').textContent = `Sync service: ${labels[sync.state] || 'Unknown'}`;
  $('sync-status').dataset.state = sync.state;
  $('sync-detail').textContent = !sync.configured
    ? 'Connect the optional sync-control helper to enable status and on/off controls.'
    : sync.busy ? 'A sync control or save deletion operation is in progress.'
      : 'Controls the existing sync container. Automatically pauses it during save deletion.';
  $('sync-toggle').hidden = !sync.configured;
  $('sync-toggle').textContent = sync.state === 'on' ? 'Turn sync off' : 'Turn sync on';
  $('sync-toggle').setAttribute('aria-checked', String(sync.state === 'on'));
  $('sync-error').textContent = sync.error || '';
  $('sync-error').hidden = !sync.error;
  updateControls();
}

async function toggleSync() {
  syncBusy = true;
  $('sync-action-error').hidden = true;
  updateControls();
  try {
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: syncState.state !== 'on' }),
      cache: 'no-store',
    });
    const data = await response.json();
    if (data.sync) renderSync(data.sync);
    if (!response.ok) throw new Error(data.error || data.sync?.error || `Server returned HTTP ${response.status}`);
  } catch (error) {
    $('sync-action-error').textContent = `The sync change could not be verified: ${error.message}`;
    $('sync-action-error').hidden = false;
  } finally {
    syncBusy = false;
    await load();
    updateControls();
  }
}

function deletionNotice(message, error = false) {
  $('delete-result').textContent = message;
  $('delete-result').classList.toggle('error', error);
  $('delete-result').hidden = false;
  $('delete-result').scrollIntoView({ block: 'nearest' });
}

async function previewDeletion(platform, game) {
  deletionBusy = true;
  updateControls();
  try {
    const response = await fetch('/api/delete/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, game }),
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);
    pendingDeletion = data;
    $('delete-title').textContent = `Delete saves: ${data.game}`;
    $('delete-files').replaceChildren(...data.files.map((file) => element('li',
      `${file.side === 'retroarch' ? 'RetroArch' : 'MiSTer'}: ${file.path}`)));
    $('delete-confirm-label').textContent = `Type "${data.game}" to confirm`;
    $('delete-confirm').value = '';
    $('delete-submit').disabled = true;
    $('delete-warning').textContent = syncState.configured
      ? 'Permanently delete every listed file. This cannot be undone. Close the game first. '
        + 'The sync service is stopped before deletion and restarted after success only if it was previously on. '
        + 'Other devices can still recreate saves.'
      : 'Permanently delete every listed file. This cannot be undone. Close the game first. '
        + 'Removals are submitted together, but an active game or sync job can recreate files.';
    $('delete-dialog').showModal();
  } catch (error) {
    deletionNotice(`Cannot prepare deletion: ${error.message}`, true);
  } finally {
    deletionBusy = false;
    updateControls();
  }
}

async function confirmDeletion(event) {
  event.preventDefault();
  if (!pendingDeletion || $('delete-confirm').value !== pendingDeletion.game) {
    deletionNotice('Enter the exact game name to confirm deletion.', true);
    return;
  }
  const { token, game } = pendingDeletion;
  $('delete-dialog').close();
  deletionBusy = true;
  updateControls();
  deletionNotice(syncState.configured ? 'Pausing sync and deleting all listed save copies...' : 'Deleting all listed save copies...');
  if (syncState.configured) {
    $('sync-status').textContent = 'Sync service: coordinating deletion...';
    $('sync-detail').textContent = 'Waiting for deletion and verification before restoring the previous sync state.';
  }
  try {
    const response = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, confirm: game }),
      cache: 'no-store',
    });
    const data = await response.json();
    if (data.sync) renderSync(data.sync);
    if (data.snapshot) {
      latest = data;
      render();
    }
    if (!response.ok || data.error) {
      const failures = (data.failed || []).map((file) => `${file.side}: ${file.path}: ${file.error}`).join('; ');
      throw new Error([data.error || `Server returned HTTP ${response.status}`, failures].filter(Boolean).join(' '));
    }
    deletionNotice(`Deleted all ${data.deleted.length} listed save files for "${game}".`);
  } catch (error) {
    deletionNotice(`Deletion could not be fully verified: ${error.message} Refresh before retrying.`, true);
  } finally {
    deletionBusy = false;
    await load();
    updateControls();
  }
}

function fileList(files) {
  const cell = element('td');
  if (!files.length) {
    cell.append(element('p', 'Not found', 'muted'));
    return cell;
  }
  for (const file of files) {
    const block = element('div', undefined, 'file');
    block.append(element('div', file.path, 'file-path'));
    const meta = [
      file.size === null ? 'size unknown' : `${file.size.toLocaleString()} bytes`,
      timestamp(file.modifiedAt),
    ].join(' | ');
    block.append(element('div', meta, 'file-meta'));
    const diagnostics = element('details', undefined, 'diagnostics');
    diagnostics.append(element('summary', 'File diagnostics'));
    diagnostics.append(element('code', `Raw CRC32 ${file.crc32 || 'unavailable'}`));
    block.append(diagnostics);
    if (file.error) block.append(element('p', file.error, 'file-error'));
    cell.append(block);
  }
  return cell;
}

function render() {
  if (!latest?.snapshot) return;
  $('access-mode').textContent = latest.deletionEnabled ? 'DELETION ENABLED' : 'READ ONLY';
  $('access-mode').classList.toggle('deletion-enabled', latest.deletionEnabled === true);
  $('intro').textContent = latest.deletionEnabled ? 'Compare saves, or delete all copies of a game.' : 'Check your saves. Never change them.';
  const snapshot = latest.snapshot;
  const total = Object.values(snapshot.summary).reduce((a, b) => a + b, 0);
  $('scan-info').textContent = `${total} games | Last completed: ${timestamp(snapshot.completedAt)} | `
    + `${snapshot.durationMs.toLocaleString()} ms | Automatic scan every ${snapshot.refreshSeconds}s`
    + (latest.scanning ? ' | Scanning...' : '');
  const summary = $('summary');
  summary.replaceChildren();
  for (const [status, label] of Object.entries(LABELS)) {
    const card = element('div', undefined, `stat ${status}`);
    card.append(element('strong', snapshot.summary[status].toLocaleString()), element('span', label));
    summary.append(card);
  }
  const nav = $('platforms');
  nav.replaceChildren();
  for (const platform of [{ id: 'all', label: 'All platforms' }, ...snapshot.platforms]) {
    const button = element('button', platform.label, selectedPlatform === platform.id ? 'selected' : '');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedPlatform === platform.id));
    button.addEventListener('click', () => { selectedPlatform = platform.id; render(); });
    nav.append(button);
  }
  const query = $('search').value.toLowerCase().trim();
  const status = $('status').value;
  const results = $('results');
  results.replaceChildren();
  for (const platform of snapshot.platforms) {
    if (selectedPlatform !== 'all' && selectedPlatform !== platform.id) continue;
    const section = element('section', undefined, 'platform-section');
    section.append(element('h2', platform.label));
    for (const issue of platform.issues) {
      section.append(element('p', `${issue.side === 'retroarch' ? 'RetroArch' : 'MiSTer'}: ${issue.path} - ${issue.message}`, 'notice'));
    }
    const games = platform.games.filter((game) => {
      const text = [game.name, ...game.retroarch.map((file) => file.path), ...game.mister.map((file) => file.path)]
        .join('\n').toLowerCase();
      return (!query || text.includes(query))
        && (status === 'all' || game.status === status
          || (status === 'matching' && !ATTENTION.has(game.status))
          || (status === 'attention' && ATTENTION.has(game.status)));
    });
    section.append(element('p', `${games.length} of ${platform.games.length} games shown`, 'muted'));
    if (!games.length) {
      section.append(element('p', platform.issues.length
        ? 'No saves shown. Resolve the directory issues above or adjust filters.'
        : 'No saves found, or no games match these filters.', 'empty'));
    } else {
      const scroll = element('div', undefined, 'table-scroll');
      const table = element('table');
      const caption = element('caption', `${platform.label} save comparisons`, 'sr-only');
      const thead = element('thead');
      const headings = element('tr');
      for (const title of ['Game / comparison', 'RetroArch .srm', 'MiSTer .sav']) {
        const th = element('th', title);
        th.scope = 'col';
        headings.append(th);
      }
      thead.append(headings);
      const tbody = element('tbody');
      for (const game of games) {
        const row = element('tr');
        const cell = element('td');
        cell.append(element('strong', game.name, 'game-name'));
        cell.append(element('span', LABELS[game.status], `badge ${game.status}`));
        cell.append(element('p', game.detail, 'detail'));
        if (latest.deletionEnabled) {
          const button = element('button', 'Delete saves...', 'delete-save danger');
          button.type = 'button';
          button.addEventListener('click', () => previewDeletion(platform.id, game.name));
          cell.append(button);
        }
        row.append(cell, fileList(game.retroarch), fileList(game.mister));
        tbody.append(row);
      }
      table.append(caption, thead, tbody);
      scroll.append(table);
      section.append(scroll);
    }
    results.append(section);
  }
  updateControls();
}

async function load(manual = false) {
  if (refreshing || deletionBusy || syncBusy) return;
  refreshing = true;
  $('refresh').disabled = true;
  $('refresh').textContent = manual ? 'Scanning...' : 'Refresh now';
  updateControls();
  try {
    const response = await fetch(manual ? '/api/refresh' : '/api/status', {
      method: manual ? 'POST' : 'GET',
      cache: 'no-store',
    });
    const data = await response.json();
    if (data.sync) renderSync(data.sync);
    if (data.snapshot) {
      const changed = latest?.snapshot?.completedAt !== data.snapshot.completedAt
        || latest?.scanning !== data.scanning || latest?.deletionEnabled !== data.deletionEnabled
        || latest?.deleting !== data.deleting;
      latest = data;
      if (changed) render();
    }
    if (!response.ok || data.scanError) throw new Error(data.scanError || `Server returned HTTP ${response.status}`);
    $('connection-error').hidden = true;
  } catch (error) {
    $('connection-error').textContent = `Unable to verify current saves: ${error.message}. `
      + (latest ? 'Showing the last completed scan, which may be stale.' : 'No scan is available.');
    $('connection-error').hidden = false;
    renderSync({ ...syncState, state: 'unavailable', error: 'Cannot verify sync status while the dashboard connection is unavailable.' });
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
    $('refresh').textContent = 'Refresh now';
    updateControls();
  }
}

$('delete-form').addEventListener('submit', confirmDeletion);
$('sync-toggle').addEventListener('click', toggleSync);
$('delete-confirm').addEventListener('input', () => {
  $('delete-submit').disabled = !pendingDeletion || $('delete-confirm').value !== pendingDeletion.game;
});
$('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
$('delete-dialog').addEventListener('close', () => { pendingDeletion = null; });
$('refresh').addEventListener('click', () => load(true));
$('search').addEventListener('input', render);
$('status').addEventListener('change', render);
load();
setInterval(() => load(), 5000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error) => {
      console.error('App installation support failed:', error);
      $('install-error').textContent = 'App installation and offline support could not start. '
        + 'The dashboard still works online. Reload to retry.';
      $('install-error').hidden = false;
    });
  });
}
