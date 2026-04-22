// popup.js — LocalPush v6  (content-diff based change detection)
const $ = id => document.getElementById(id);

let files  = [];
let activePort = null;
let repo   = null;
let busy   = false;

// ══════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  const { token } = await store('token');
  if (!token) { showScreen('setup'); bindSetup(); return; }
  showScreen('main'); bindMain(); await loadState();
});

function showScreen(s) {
  $('setupScreen').style.display = s === 'setup' ? 'block' : 'none';
  $('mainScreen').style.display  = s === 'main'  ? 'block' : 'none';
}

// ══════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════
function bindSetup() {
  $('setupEye').onclick = () => {
    const i = $('setupToken');
    i.type = i.type === 'password' ? 'text' : 'password';
  };
  $('setupSave').onclick = async () => {
    const token = $('setupToken').value.trim();
    if (!token) { toast('Paste your GitHub token', 'err'); return; }
    $('setupSave').textContent = 'Verifying…';
    $('setupSave').disabled = true;
    try {
      const r = await ghFetch(token, '/user');
      if (!r.ok) throw new Error();
      await chrome.storage.local.set({ token });
      showScreen('main'); bindMain(); await loadState();
    } catch {
      toast('Invalid token — needs repo scope', 'err');
      $('setupSave').textContent = 'Save & Continue →';
      $('setupSave').disabled = false;
    }
  };
}

// ══════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════
function bindMain() {
  $('manualSection').style.display = 'block';
  $('repoEditBtn').onclick = showRepoPicker;
  $('scanBtn').onclick     = scanTab;
  $('aiBtn').onclick       = generateMsg;
  $('clearBtn').onclick    = () => $('commitMsg').value = '';
  $('pushBtn').onclick     = push;
}

async function loadState() {
  const data = await store('activePort', 'repos');
  activePort = data.activePort || null;
  const repos = data.repos || {};
  if (activePort && repos[activePort]) {
    repo = repos[activePort];
    setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
  } else {
    setRepoPill('dim', 'Scan a tab to detect repo');
  }
  files = [];
  renderFiles();
}

// ══════════════════════════════════════════
//  REPO PILL
// ══════════════════════════════════════════
function setRepoPill(state, text) {
  $('repoDot').className = 'repo-dot' + (state === 'ok' ? ' ok' : state === 'warn' ? ' warn' : state === 'spin' ? ' spin' : '');
  $('repoLabel').className  = state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : '';
  $('repoLabel').textContent = text;
}

// ══════════════════════════════════════════
//  SCAN TAB  — compares local vs GitHub content
// ══════════════════════════════════════════
async function scanTab() {
  const btn = $('scanBtn');
  btn.disabled = true;
  $('scanIcon').style.cssText = 'display:inline-block;animation:spin .6s linear infinite;';
  setStatus('Scanning…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.match(/^https?:\/\/(localhost|127\.0\.0\.1)/)) {
      toast('Switch to a localhost tab first', 'err'); return;
    }

    const port = new URL(tab.url).port || '80';

    // 1. Scrape DOM to get file paths AND document title (for fingerprinting)
    const [{ result: scrapeResult }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const out = new Set();
        const add = (el, attr) => {
          const v = el.getAttribute(attr);
          if (v && !v.startsWith('http') && !v.startsWith('//') && !v.startsWith('data:'))
            out.add(v.replace(/^\//, '').split('?')[0].split('#')[0]);
        };
        document.querySelectorAll('script[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('link[rel=stylesheet]').forEach(e => add(e, 'href'));
        document.querySelectorAll('img[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('link[as=script]').forEach(e => add(e, 'href'));
        document.querySelectorAll('link[as=style]').forEach(e => add(e, 'href'));
        // Also try to find files referenced in inline scripts (basic heuristic)
        document.querySelectorAll('script:not([src])').forEach(el => {
          const matches = el.textContent.matchAll(/["'`]([\w./-]+\.(js|ts|jsx|tsx|css|scss))[`'"]/g);
          for (const m of matches) {
            const v = m[1];
            if (!v.startsWith('http') && !v.startsWith('//')) out.add(v.replace(/^\//, ''));
          }
        });
        const IGNORE = [/^_next\//,/^\.next\//,/^__vite__/,/^@vite\//,/^@fs\//,/node_modules/,/chunks?\//,/webpack/,/hot-update/,/\.[a-f0-9]{8,}\./];
        return {
          paths: [...out].filter(p => p.length > 0 && !IGNORE.some(r => r.test(p))).slice(0, 40),
          title: document.title
        };
      }
    });

    const paths = scrapeResult?.paths || [];

    // 2. Fetch package.json for project name (if exposed)
    let currentProjectName = null;
    try {
      const r = await fetch(`http://localhost:${port}/package.json`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { const pkg = await r.json(); currentProjectName = pkg.name?.replace(/^@[^/]+\//, ''); }
    } catch {}

    const projectFingerprint = currentProjectName || scrapeResult?.title || port;
    window.currentFingerprint = projectFingerprint; // Used by manual picker fallback

    // 3. Resolve repo caching logic: invalidate if fingerprint changed
    const { repos = {} } = await store('repos');
    let cachedRepo = repos[port];

    if (cachedRepo && cachedRepo.fingerprint && cachedRepo.fingerprint !== projectFingerprint) {
      cachedRepo = null; // Project changed! Force redetect.
    }

    if (port !== activePort) {
      activePort = port;
      await chrome.storage.local.set({ activePort });
    }

    if (cachedRepo) {
      repo = cachedRepo;
      setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
    } else {
      repo = null;
      setRepoPill('spin', `Detecting repo on :${port}…`);
      await autoDetectRepo(port, projectFingerprint, currentProjectName);
    }

    if (!repo) { toast('Select a repo first', 'err'); return; }

    // If DOM scan found nothing (compiled app like Next.js/Vite), show manual input
    if (!paths.length) {
      setStatus('');
      showManualInput();
      toast('No source files in DOM — add paths manually', 'warn');
      btn.disabled = false;
      $('scanIcon').style.cssText = '';
      return;
    }

    setStatus(`Checking ${paths.length} file${paths.length > 1 ? 's' : ''} for changes…`);
    const { token } = await store('token');
    const { owner, name, branch } = repo;
    const changed = [];

    for (const filePath of paths) {
      try {
        // 1. Fetch local content
        const localRes = await fetch(`http://localhost:${port}/${filePath}`);
        if (!localRes.ok) continue;
        const localContent = await localRes.text();

        // 2. Fetch GitHub content
        let state = 'modified';
        try {
          const ghRes = await ghFetch(token, `/repos/${owner}/${name}/contents/${encodeURIComponent(filePath)}?ref=${branch}`);
          if (ghRes.status === 404) {
            state = 'new'; // file doesn't exist on GitHub yet
          } else if (ghRes.ok) {
            const ghData = await ghRes.json();
            const ghContent = decodeBase64(ghData.content || '');
            if (normalise(localContent) === normalise(ghContent)) continue; // identical — skip
            state = 'modified';
          } else {
            // GitHub error (rate limit, bad token etc) — include file to be safe
            state = 'modified';
          }
        } catch {
          // Network error talking to GitHub — include file to be safe
          state = 'modified';
        }

        changed.push({ path: filePath, state, checked: true });
      } catch { /* can't fetch locally — skip */ }
    }

    files = changed;
    renderFiles();

    if (changed.length > 0) {
      const mods = changed.filter(f => f.state === 'modified').length;
      const news = changed.filter(f => f.state === 'new').length;
      const parts = [];
      if (mods) parts.push(`${mods} modified`);
      if (news) parts.push(`${news} new`);
      toast(`✓ ${parts.join(', ')}`, 'ok');
    } else {
      toast('Everything up to date ✓', 'ok');
    }
    setStatus('');

  } catch (e) {
    toast('Scan failed: ' + e.message, 'err');
    setStatus('');
  } finally {
    btn.disabled = false;
    $('scanIcon').style.cssText = '';
  }
}

// ── Helpers for content comparison ───────────────────────────────────────
function normalise(str) {
  // Normalise line endings so CRLF vs LF doesn't cause false positives
  return str.replace(/\r\n/g, '\n').trimEnd();
}

function decodeBase64(b64) {
  // GitHub wraps base64 with newlines
  const clean = b64.replace(/\s/g, '');
  try {
    return decodeURIComponent(escape(atob(clean)));
  } catch {
    return atob(clean); // fallback for non-UTF8
  }
}

function setStatus(msg) {
  const el = $('statusMsg');
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}

// ══════════════════════════════════════════
//  MANUAL FILE INPUT (for compiled apps)
// ══════════════════════════════════════════
function showManualInput() {
  $('manualSection').style.display = 'block';
  $('manualInput').focus();
}

async function addManualPaths() {
  const raw = $('manualInput').value.trim();
  if (!raw) return;
  const paths = raw.split(',').map(s => s.trim().replace(/^\//, '')).filter(Boolean);

  if (!repo) { toast('Select a repo first', 'err'); return; }

  const { token } = await store('token');
  const { owner, name, branch } = repo;
  const port = activePort || '80';
  const changed = [];

  for (const filePath of paths) {
    try {
      const localRes = await fetch(`http://localhost:${port}/${filePath}`);
      if (!localRes.ok) { toast(`Can't fetch: ${filePath}`, 'err'); continue; }
      const localContent = await localRes.text();
      let state = 'modified';
      try {
        const ghRes = await ghFetch(token, `/repos/${owner}/${name}/contents/${encodeURIComponent(filePath)}?ref=${branch}`);
        if (ghRes.status === 404) { state = 'new'; }
        else if (ghRes.ok) {
          const ghData = await ghRes.json();
          const ghContent = decodeBase64(ghData.content || '');
          if (normalise(localContent) === normalise(ghContent)) continue;
        }
      } catch {}
      changed.push({ path: filePath, state, checked: true });
    } catch {}
  }

  changed.forEach(f => { if (!files.find(e => e.path === f.path)) files.push(f); });
  $('manualInput').value = '';
  renderFiles();
  if (changed.length) toast(`✓ ${changed.length} changed file${changed.length > 1 ? 's' : ''} added`, 'ok');
  else toast('No changes detected in those files', '');
}

// ══════════════════════════════════════════
//  AUTO DETECT REPO
// ══════════════════════════════════════════
async function autoDetectRepo(port, fingerprint = null, detectedName = null) {
  const { token } = await store('token');
  try {
    let projectName = detectedName;
    if (!projectName) {
      try {
        const r = await fetch(`http://localhost:${port}/package.json`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) { const pkg = await r.json(); projectName = pkg.name?.replace(/^@[^/]+\//, ''); }
      } catch {}
    }

    const { login: username } = await (await ghFetch(token, '/user')).json();
    let matches = [];
    if (projectName) {
      const res = await ghFetch(token, `/search/repositories?q=${encodeURIComponent(projectName)}+user:${username}&per_page=10`);
      if (res.ok) {
        const { items } = await res.json();
        const exact = items.filter(r => r.name.toLowerCase() === projectName.toLowerCase());
        matches = exact.length ? exact : items;
      }
    }

    if (matches.length === 1) {
      await setRepo(matches[0], port, fingerprint || window.currentFingerprint);
      toast(`✓ Repo: ${matches[0].full_name}`, 'ok');
    } else {
      setRepoPill('warn', matches.length > 1 ? `${matches.length} matches — pick one` : 'Pick a repo');
      showRepoPicker(matches.length ? matches : null);
    }
  } catch {
    setRepoPill('warn', 'Detection failed — pick repo');
    showRepoPicker();
  }
}

// ══════════════════════════════════════════
//  REPO PICKER
// ══════════════════════════════════════════
async function showRepoPicker(preloaded = null) {
  $('repoPicker')?.remove();
  const { token } = await store('token');
  const picker = document.createElement('div');
  picker.id = 'repoPicker';
  picker.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.65);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:20px;';
  picker.innerHTML = `
    <div style="background:#13131c;border:1px solid #252535;border-radius:10px;width:100%;overflow:hidden;">
      <div style="padding:12px 16px;border-bottom:1px solid #252535;display:flex;align-items:center;justify-content:space-between;">
        <span style="font-family:'Syne',sans-serif;font-weight:700;font-size:13px;">Select Repository</span>
        <button id="pickerClose" style="background:none;border:none;color:#5a5a72;cursor:pointer;font-size:18px;line-height:1;">×</button>
      </div>
      <div style="padding:10px 12px;border-bottom:1px solid #252535;">
        <input id="pickerSearch" type="text" placeholder="Search repos…"
          style="width:100%;background:#0b0b10;border:1px solid #252535;border-radius:6px;color:#e8e8f0;font-family:'JetBrains Mono',monospace;font-size:11px;padding:7px 10px;outline:none;"/>
      </div>
      <div id="pickerList" style="max-height:200px;overflow-y:auto;"></div>
    </div>`;
  document.body.appendChild(picker);
  $('pickerClose').onclick = () => picker.remove();
  picker.addEventListener('click', e => { if (e.target === picker) picker.remove(); });

  const listEl = $('pickerList');
  const renderList = repos => {
    listEl.innerHTML = '';
    if (!repos.length) { listEl.innerHTML = `<div style="padding:16px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:#5a5a72;">No repos found</div>`; return; }
    repos.forEach(r => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:9px 14px;cursor:pointer;border-bottom:1px solid rgba(37,37,53,.5);transition:background .12s;';
      item.innerHTML = `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#e8e8f0;">${r.full_name}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#5a5a72;margin-top:2px;">${r.default_branch} · ${r.private ? '🔒 private' : '🌐 public'}</div>`;
      item.onmouseenter = () => item.style.background = 'rgba(124,111,255,.1)';
      item.onmouseleave = () => item.style.background = '';
      item.onclick = async () => { picker.remove(); await setRepo(r, activePort, window.currentFingerprint); toast(`✓ Repo set: ${r.full_name}`, 'ok'); };
      listEl.appendChild(item);
    });
  };

  let allRepos = preloaded;
  if (!allRepos) {
    listEl.innerHTML = `<div style="padding:16px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:#5a5a72;">Loading…</div>`;
    try { const r = await ghFetch(token, '/user/repos?per_page=100&sort=pushed'); allRepos = r.ok ? await r.json() : []; }
    catch { allRepos = []; }
  }
  renderList(allRepos);
  $('pickerSearch').focus();
  $('pickerSearch').oninput = e => { const q = e.target.value.toLowerCase(); renderList(q ? allRepos.filter(r => r.full_name.toLowerCase().includes(q)) : allRepos); };
}

async function setRepo(ghRepo, port, fingerprint = null) {
  repo = { owner: ghRepo.owner.login, name: ghRepo.name, branch: ghRepo.default_branch || 'main', fingerprint };
  const { repos = {} } = await store('repos');
  repos[port || activePort || 'default'] = repo;
  await chrome.storage.local.set({ repos });
  setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
}

// ══════════════════════════════════════════
//  RENDER FILES
// ══════════════════════════════════════════
function renderFiles() {
  const list = $('fileList');
  $('fileEmpty').style.display = files.length ? 'none' : 'block';
  list.querySelectorAll('.file-item').forEach(el => el.remove());
  files.forEach((f, i) => {
    const row = document.createElement('div'); row.className = 'file-item';
    const cb  = document.createElement('input'); cb.type = 'checkbox'; cb.checked = f.checked !== false;
    cb.addEventListener('change', () => { files[i].checked = cb.checked; });
    const nm  = document.createElement('span'); nm.className = 'fname'; nm.title = f.path; nm.textContent = f.path;
    const bd  = document.createElement('span');
    bd.className = `fbadge ${f.state === 'new' ? 'new' : ''}`;
    bd.textContent = f.state === 'new' ? 'new' : f.path.split('.').pop().toLowerCase() || '?';
    const dl  = document.createElement('button'); dl.className = 'fdel'; dl.textContent = '×';
    dl.addEventListener('click', () => { files.splice(i, 1); renderFiles(); });
    row.append(cb, nm, bd, dl); list.append(row);
  });
}

// ══════════════════════════════════════════
//  AI COMMIT MESSAGE
// ══════════════════════════════════════════
async function generateMsg() {
  const btn = $('aiBtn');
  const selected = files.filter(f => f.checked !== false).map(f => f.path);
  if (!selected.length) { toast('Select some files first', 'err'); return; }
  btn.textContent = '⟳ Thinking…'; btn.disabled = true;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 80,
        messages: [{ role: 'user', content: `Write a conventional commit message (one line, max 72 chars) for these changed files: ${selected.join(', ')}. Reply with ONLY the message.` }] })
    });
    const d = await r.json();
    const msg = d?.content?.[0]?.text?.trim();
    if (msg) $('commitMsg').value = msg; else throw 0;
  } catch {
    const map = { js:'feat',ts:'feat',jsx:'feat',tsx:'feat',css:'style',scss:'style',md:'docs',html:'feat' };
    const type = map[selected[0].split('.').pop()] || 'chore';
    $('commitMsg').value = `${type}: update ${selected.slice(0,2).join(', ')}${selected.length > 2 ? ` +${selected.length-2}` : ''}`;
  }
  btn.textContent = '✦ Generate'; btn.disabled = false;
}

// ══════════════════════════════════════════
//  PUSH
// ══════════════════════════════════════════
async function push() {
  if (busy) return;
  const msg      = $('commitMsg').value.trim();
  const selected = files.filter(f => f.checked !== false);
  if (!selected.length) { toast('No files selected', 'err'); return; }
  if (!msg)              { toast('Commit message required', 'err'); return; }
  if (!repo)             { toast('Select a repo first', 'err'); showRepoPicker(); return; }

  busy = true;
  $('pushBtn').disabled = true;
  $('btnIcon').innerHTML = '<div class="spinner"></div>';
  $('btnText').textContent = 'Pushing…';
  showLog(); clearLog();

  const { token } = await store('token');
  const { owner, name, branch } = repo;
  const port = activePort || '80';

  try {
    log('hi', `${owner}/${name} @ ${branch}`);

    const refRes = await ghFetch(token, `/repos/${owner}/${name}/git/ref/heads/${branch}`);
    if (!refRes.ok) { const e = await refRes.json(); throw new Error(e.message); }
    const { object: { sha: latestSha } } = await refRes.json();
    const { tree: { sha: baseTree } } = await (await ghFetch(token, `/repos/${owner}/${name}/git/commits/${latestSha}`)).json();
    log('hi', `Tip: ${latestSha.slice(0,7)}`);

    const treeItems = [];
    for (const f of selected) {
      try {
        const r = await fetch(`http://localhost:${port}/${f.path}`);
        if (!r.ok) { log('err', `⚠ skip ${f.path} (${r.status})`); continue; }
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', content: await r.text() });
        log('ok', `✓ ${f.path}`);
      } catch { log('err', `⚠ skip ${f.path}`); }
    }
    if (!treeItems.length) throw new Error('No files could be fetched from localhost');

    const tree   = await ghPost(token, `/repos/${owner}/${name}/git/trees`,  { base_tree: baseTree, tree: treeItems });
    const commit = await ghPost(token, `/repos/${owner}/${name}/git/commits`, { message: msg, tree: tree.sha, parents: [latestSha] });
    await ghFetch(token, `/repos/${owner}/${name}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });

    log('ok', `✓ Pushed [${commit.sha.slice(0,7)}] → ${owner}/${name}@${branch}`);
    toast('✓ Pushed!', 'ok');
    files = [];
    $('commitMsg').value = '';
    renderFiles();

  } catch (e) {
    log('err', `✗ ${e.message}`);
    toast('Push failed — see log', 'err');
  } finally {
    busy = false;
    $('pushBtn').disabled = false;
    $('btnIcon').textContent = '↑';
    $('btnText').textContent = 'Commit & Push';
  }
}

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
function ghFetch(token, endpoint, method = 'GET', body = null) {
  return fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null
  });
}
async function ghPost(token, endpoint, body) {
  const r = await ghFetch(token, endpoint, 'POST', body);
  if (!r.ok) { const e = await r.json(); throw new Error(e.message || `HTTP ${r.status}`); }
  return r.json();
}
function store(...keys) { return chrome.storage.local.get(keys); }
function showLog()  { $('logBox').style.display = 'block'; }
function clearLog() { $('logBody').innerHTML = ''; }
function log(cls, text) {
  const el = document.createElement('div'); el.className = `ll ${cls}`; el.textContent = text;
  $('logBody').append(el); $('logBody').scrollTop = 9999;
}
function toast(msg, type = '') {
  const t = $('toast'); t.textContent = msg; t.className = `toast ${type}`;
  requestAnimationFrame(() => { t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); });
}
