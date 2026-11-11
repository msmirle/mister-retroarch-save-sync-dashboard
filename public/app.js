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
        row.append(cell, fileList(game.retroarch), fileList(game.mister));
        tbody.append(row);
      }
      table.append(caption, thead, tbody);
      scroll.append(table);
      section.append(scroll);
    }
    results.append(section);
  }
}

async function load(manual = false) {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  $('refresh').textContent = manual ? 'Scanning...' : 'Refresh now';
  try {
    const response = await fetch(manual ? '/api/refresh' : '/api/status', {
      method: manual ? 'POST' : 'GET',
      cache: 'no-store',
    });
    const data = await response.json();
    if (data.snapshot) {
      const changed = latest?.snapshot?.completedAt !== data.snapshot.completedAt
        || latest?.scanning !== data.scanning;
      latest = data;
      if (changed) render();
    }
    if (!response.ok || data.scanError) throw new Error(data.scanError || `Server returned HTTP ${response.status}`);
    $('connection-error').hidden = true;
  } catch (error) {
    $('connection-error').textContent = `Unable to verify current saves: ${error.message}. `
      + (latest ? 'Showing the last completed scan, which may be stale.' : 'No scan is available.');
    $('connection-error').hidden = false;
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
    $('refresh').textContent = 'Refresh now';
  }
}

$('refresh').addEventListener('click', () => load(true));
$('search').addEventListener('input', render);
$('status').addEventListener('change', render);
load();
setInterval(() => load(), 5000);
