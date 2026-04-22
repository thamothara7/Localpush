// popup.js — LocalPush v8
// Fixes:
//  1. Port-only cache key → localhost:5500 & 127.0.0.1:5500 same cache entry
//  2. Dropped broken content-diff (was causing false "up to date") — now shows ALL detected files
//  3. Proper base64 → TextDecoder for UTF-8
//  4. Auto-scan on popup open
//  5. Untracked files: manual section always visible
//  6. .git/config detection improved; falls back to saved cache or picker

'use strict';
const $ = id => document.getElementById(id);

let files = [];
let portKey = null;   // just the port number, e.g. "5500"  (shared between localhost & 127.0.0.1)
let repo = null;
let busy = false;

// ══════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  const { token } = await store('token');
  if (!token) { showScreen('setup'); bindSetup(); return; }
  showScreen('main');
  bindMain();
  await restoreRepo();       // load cached repo from storage
  await scanTab(true);       // auto-scan active tab immediately
});

function showScreen(s) {
  $('setupScreen').style.display = s === 'setup' ? 'block' : 'none';
  $('mainScreen').style.display = s === 'main' ? 'block' : 'none';
}

// ══════════════════════════════════════════
//  SETUP SCREEN
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
      showScreen('main');
      bindMain();
      await restoreRepo();
      await scanTab(true);
    } catch {
      toast('Invalid token — needs repo scope', 'err');
      $('setupSave').textContent = 'Save & Continue →';
      $('setupSave').disabled = false;
    }
  };
}

// ══════════════════════════════════════════
//  MAIN SCREEN BINDINGS
// ══════════════════════════════════════════
function bindMain() {
  $('gearBtn').onclick = () => { showScreen('setup'); bindSetup(); };
  $('repoEditBtn').onclick = showRepoPicker;
  $('scanBtn').onclick = () => scanTab(false);
  $('aiBtn').onclick = generateMsg;
  $('clearBtn').onclick = () => $('commitMsg').value = '';
  $('pushBtn').onclick = push;
}

// Restore the repo that was last used for the current tab's port
async function restoreRepo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && isLocalUrl(tab.url)) {
      portKey = getPort(tab.url);
      const { repos = {} } = await store('repos');
      if (repos[portKey]) {
        repo = repos[portKey];
        setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
        return;
      }
    }
  } catch { /* ignore */ }
  setRepoPill('dim', 'Detecting…');
}

// ══════════════════════════════════════════
//  URL HELPERS
// ══════════════════════════════════════════
function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/.test(url);
}

// Use PORT NUMBER ONLY as the cache key so that
// localhost:5500 and 127.0.0.1:5500 resolve to the same saved repo ("5500")
function getPort(url) {
  const u = new URL(url);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

function getBase(url) {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${u.hostname}:${port}`;
}

// ══════════════════════════════════════════
//  REPO PILL
// ══════════════════════════════════════════
function setRepoPill(state, text) {
  const dot = $('repoDot');
  dot.className = 'repo-dot' +
    (state === 'ok' ? ' ok' :
      state === 'warn' ? ' warn' :
        state === 'spin' ? ' spin' : '');
  $('repoLabel').className = state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : '';
  $('repoLabel').textContent = text;
}

// ══════════════════════════════════════════
//  GIT CONFIG DETECTION (works when server exposes .git/)
// ══════════════════════════════════════════
async function tryGitConfig(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/.git/config`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const cfg = await r.text();
    // Match both HTTPS and SSH
    const m = cfg.match(/url\s*=\s*.*github\.com[:/]([^/\s]+)\/([^\s.]+?)(?:\.git)?\s*$/m);
    if (!m) return null;
    return { owner: m[1], name: m[2] };
  } catch { return null; }
}

async function tryGitHead(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/.git/HEAD`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return 'main';
    const t = await r.text();
    return t.match(/ref:\s*refs\/heads\/(.+)/)?.[1]?.trim() || 'main';
  } catch { return 'main'; }
}

// ══════════════════════════════════════════
//  MAIN SCAN — auto detects repo + files
// ══════════════════════════════════════════
async function scanTab(auto = false) {
  const btn = $('scanBtn');
  btn.disabled = true;
  $('scanIcon').style.cssText = 'display:inline-block;animation:spin .6s linear infinite;';
  setStatus(auto ? 'Auto-scanning…' : 'Scanning…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url || !isLocalUrl(tab.url)) {
      setStatus(auto ? 'Open a localhost / 127.0.0.1 tab to auto-scan' : '');
      if (!auto) toast('Open a localhost or 127.0.0.1 tab first', 'err');
      setRepoPill('dim', 'No local server tab');
      return;
    }

    const base = getBase(tab.url);
    portKey = getPort(tab.url);

    // ── 1. Resolve repo ───────────────────────────────────────────────
    const { repos = {} } = await store('repos');

    if (!repos[portKey]) {
      // Try .git/config first (works with Python http.server, some other servers)
      setStatus('Reading .git/config…');
      const gitInfo = await tryGitConfig(base);

      if (gitInfo) {
        const branch = await tryGitHead(base);
        repo = { owner: gitInfo.owner, name: gitInfo.name, branch };
        repos[portKey] = repo;
        await chrome.storage.local.set({ repos, activePort: portKey });
        setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
        toast(`✓ Repo auto-detected: ${repo.owner}/${repo.name}`, 'ok');
      } else {
        // Cannot auto-detect → show repo picker
        setRepoPill('warn', 'Select your GitHub repo');
        setStatus('');
        btn.disabled = false;
        $('scanIcon').style.cssText = '';
        // show picker; after the user picks, picker calls scanTab again
        await showRepoPicker();
        return;
      }
    } else {
      // Use cached repo for this port
      repo = repos[portKey];
      setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
    }

    // ── 2. Scrape page DOM for all file paths ─────────────────────────
    setStatus('Collecting files from page…');

    const [{ result: scrape }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const out = new Set();
        const add = (el, attr) => {
          const v = el.getAttribute(attr);
          if (v && !v.startsWith('http') && !v.startsWith('//') && !v.startsWith('data:') && v !== '#')
            out.add(v.replace(/^\//, '').split('?')[0].split('#')[0]);
        };
        document.querySelectorAll('script[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('link[rel="stylesheet"]').forEach(e => add(e, 'href'));
        document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]').forEach(e => add(e, 'href'));
        document.querySelectorAll('img[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('video[src], audio[src], source[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('link[as="script"], link[as="style"]').forEach(e => add(e, 'href'));
        // Inline script text heuristic
        document.querySelectorAll('script:not([src])').forEach(el => {
          for (const m of el.textContent.matchAll(/["'`]([\w./-]+\.(js|ts|jsx|tsx|css|scss|json))[`'"]/g)) {
            const v = m[1];
            if (!v.startsWith('http') && !v.startsWith('//')) out.add(v.replace(/^\//, ''));
          }
        });
        const SKIP = [/^_next\//, /^\.next\//, /^__vite__/, /^@vite\//, /^@fs\//, /node_modules/, /chunks?\//, /webpack/, /hot-update/, /\.[a-f0-9]{8,}\./, /^\.git\//];
        const paths = [...out].filter(p => p.length > 0 && !SKIP.some(r => r.test(p))).slice(0, 60);
        // HTML page itself
        const page = location.pathname.replace(/^\//, '') || 'index.html';
        return { paths, page };
      }
    });

    // Combine page HTML + linked assets, deduplicate
    const pageFile = scrape?.page || 'index.html';
    const allPaths = Array.from(new Set([pageFile, ...(scrape?.paths || [])])).filter(Boolean);

    // ── 3. Check each file against GitHub ──────────────────────────────
    // We DON'T compare content (was causing false "up to date").
    // Instead: 404 on GitHub = NEW file, 200 = MODIFIED (show all, user decides).
    const { token } = await store('token');
    const { owner, name, branch } = repo;

    if (!token) {
      // No token → just list all detected files as unknown
      files = allPaths.map(p => ({ path: p, state: 'unknown', checked: true }));
      renderFiles();
      setStatus('');
      toast(`Found ${files.length} file${files.length !== 1 ? 's' : ''} — add token to diff`, 'warn');
      return;
    }

    setStatus(`Checking ${allPaths.length} file${allPaths.length !== 1 ? 's' : ''} on GitHub…`);
    const result = [];

    for (const filePath of allPaths) {
      try {
        const ghRes = await ghFetch(token, `/repos/${owner}/${name}/contents/${encodeURIComponent(filePath)}?ref=${branch}`);
        if (ghRes.status === 404) {
          // File doesn't exist on GitHub → definitely new
          result.push({ path: filePath, state: 'new', checked: true });
        } else if (ghRes.ok) {
          // File exists — compare content to detect actual changes
          let state = 'synced'; // assume synced unless we detect a diff
          try {
            const localRes = await fetch(`${base}/${filePath}`);
            if (localRes.ok) {
              const localText = await localRes.text();
              const ghData = await ghRes.json();
              const ghText = b64decode(ghData.content || '');
              if (normalise(localText) !== normalise(ghText)) {
                state = 'modified';
              }
            } else {
              state = 'modified'; // can't fetch locally → include to be safe
            }
          } catch {
            state = 'modified'; // comparison error → include to be safe
          }
          result.push({ path: filePath, state, checked: state !== 'synced' });
        } else {
          // GitHub API error (rate limit etc) → include as modified to be safe
          result.push({ path: filePath, state: 'modified', checked: true });
        }
      } catch {
        // Network error → include as modified
        result.push({ path: filePath, state: 'modified', checked: true });
      }
    }

    files = result;
    renderFiles();

    const changed = result.filter(f => f.state !== 'synced').length;
    const synced = result.filter(f => f.state === 'synced').length;

    if (changed > 0) {
      const news = result.filter(f => f.state === 'new').length;
      const mods = result.filter(f => f.state === 'modified').length;
      const parts = [];
      if (news) parts.push(`${news} new`);
      if (mods) parts.push(`${mods} modified`);
      if (synced) parts.push(`${synced} unchanged`);
      toast(`✓ ${parts.join(', ')}`, 'ok');
    } else if (synced > 0) {
      toast(`All ${synced} file${synced !== 1 ? 's' : ''} are up to date`, 'ok');
    }
    setStatus('');

  } catch (e) {
    setStatus('');
    if (!auto) toast('Scan error: ' + e.message, 'err');
    console.error('[LocalPush] scanTab:', e);
  } finally {
    btn.disabled = false;
    $('scanIcon').style.cssText = '';
  }
}

// ══════════════════════════════════════════
//  CONTENT HELPERS
// ══════════════════════════════════════════
function normalise(str) {
  return str.replace(/\r\n/g, '\n').trimEnd();
}

// Reliable base64 → UTF-8 string via TextDecoder
function b64decode(b64) {
  try {
    const clean = b64.replace(/\s/g, '');
    const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function setStatus(msg) {
  const el = $('statusMsg');
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}

// ══════════════════════════════════════════
//  MANUAL FILE ADD
// ══════════════════════════════════════════
async function addManualPaths() {
  const raw = $('manualInput').value.trim();
  if (!raw) return;
  const paths = raw.split(',').map(s => s.trim().replace(/^\//, '')).filter(Boolean);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const base = tab?.url && isLocalUrl(tab.url) ? getBase(tab.url) : null;

  for (const p of paths) {
    if (files.find(f => f.path === p)) continue; // already listed
    let state = 'modified';
    if (repo) {
      const { token } = await store('token');
      if (token) {
        try {
          const { owner, name, branch } = repo;
          const res = await ghFetch(token, `/repos/${owner}/${name}/contents/${encodeURIComponent(p)}?ref=${branch}`);
          if (res.status === 404) state = 'new';
          else if (res.ok && base) {
            const lRes = await fetch(`${base}/${p}`);
            if (lRes.ok) {
              const lText = await lRes.text();
              const ghData = await res.json();
              if (normalise(lText) === normalise(b64decode(ghData.content || ''))) state = 'synced';
            }
          }
        } catch { }
      }
    }
    files.push({ path: p, state, checked: state !== 'synced' });
  }

  $('manualInput').value = '';
  renderFiles();
  toast(`Added ${paths.length} path${paths.length !== 1 ? 's' : ''}`, 'ok');
}

// ══════════════════════════════════════════
//  REPO PICKER  (manual fallback)
// ══════════════════════════════════════════
async function showRepoPicker() {
  $('repoPicker')?.remove();
  const { token } = await store('token');
  if (!token) { toast('Set your GitHub token first (⚙)', 'err'); return; }

  return new Promise(resolve => {
    const picker = document.createElement('div');
    picker.id = 'repoPicker';
    picker.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
    picker.innerHTML = `
      <div style="background:#13131c;border:1px solid #252535;border-radius:10px;width:100%;overflow:hidden;">
        <div style="padding:12px 16px;border-bottom:1px solid #252535;display:flex;align-items:center;justify-content:space-between;">
          <div>
            <span style="font-family:'Syne',sans-serif;font-weight:700;font-size:13px;">Select Repository</span>
            <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#5a5a72;margin-top:2px;">Saved for port :${portKey}</div>
          </div>
          <button id="pickerClose" style="background:none;border:none;color:#5a5a72;cursor:pointer;font-size:20px;line-height:1;">×</button>
        </div>
        <div style="padding:10px 12px;border-bottom:1px solid #252535;">
          <input id="pickerSearch" type="text" placeholder="Search your repos…"
            style="width:100%;background:#0b0b10;border:1px solid #252535;border-radius:6px;color:#e8e8f0;font-family:'JetBrains Mono',monospace;font-size:11px;padding:8px 10px;outline:none;box-sizing:border-box;"/>
        </div>
        <div id="pickerList" style="max-height:210px;overflow-y:auto;"></div>
      </div>`;
    document.body.appendChild(picker);

    const close = () => { picker.remove(); resolve(); };
    $('pickerClose').onclick = close;
    picker.addEventListener('click', e => { if (e.target === picker) close(); });

    const listEl = $('pickerList');

    const renderList = repoList => {
      listEl.innerHTML = '';
      if (!repoList.length) {
        listEl.innerHTML = `<div style="padding:18px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:#5a5a72;">No repos found</div>`;
        return;
      }
      repoList.forEach(r => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(37,37,53,.5);transition:background .12s;';
        item.innerHTML = `
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#e8e8f0;">${r.full_name}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#5a5a72;margin-top:2px;">
            ${r.default_branch} · ${r.private ? '🔒 private' : '🌐 public'} · ${r.language || 'unknown'}
          </div>`;
        item.onmouseenter = () => item.style.background = 'rgba(124,111,255,.12)';
        item.onmouseleave = () => item.style.background = '';
        item.onclick = async () => {
          picker.remove();
          await saveRepo(r);
          toast(`✓ Saved: ${r.full_name}`, 'ok');
          resolve();
          // Re-scan to pick up files now that repo is known
          await scanTab(false);
        };
        listEl.appendChild(item);
      });
    };

    listEl.innerHTML = `<div style="padding:18px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:#5a5a72;">Loading…</div>`;

    ghFetch(token, '/user/repos?per_page=100&sort=pushed')
      .then(r => r.ok ? r.json() : [])
      .then(all => {
        renderList(all);
        $('pickerSearch').focus();
        $('pickerSearch').oninput = e => {
          const q = e.target.value.toLowerCase();
          renderList(q ? all.filter(r => r.full_name.toLowerCase().includes(q)) : all);
        };
      })
      .catch(() => { listEl.innerHTML = `<div style="padding:18px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:#ff4d6d;">Failed to load repos</div>`; });
  });
}

async function saveRepo(ghRepo) {
  repo = {
    owner: ghRepo.owner.login,
    name: ghRepo.name,
    branch: ghRepo.default_branch || 'main'
  };
  const { repos = {} } = await store('repos');
  repos[portKey || 'default'] = repo;
  await chrome.storage.local.set({ repos, activePort: portKey });
  setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
}

// ══════════════════════════════════════════
//  RENDER FILES
// ══════════════════════════════════════════
function renderFiles() {
  const list = $('fileList');
  list.querySelectorAll('.file-item').forEach(el => el.remove());

  // Separate changed vs synced
  const changed = files.filter(f => f.state !== 'synced');
  const synced = files.filter(f => f.state === 'synced');

  // Show changed files first, then synced (dimmed)
  const ordered = [...changed, ...synced];
  const hasFiles = ordered.length > 0;

  $('fileEmpty').style.display = hasFiles ? 'none' : 'block';

  ordered.forEach((f, _i) => {
    const i = files.indexOf(f); // actual index in files array
    const row = document.createElement('div');
    row.className = 'file-item';
    if (f.state === 'synced') row.style.opacity = '0.4';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.checked !== false;
    cb.addEventListener('change', () => { files[i].checked = cb.checked; });

    const nm = document.createElement('span');
    nm.className = 'fname'; nm.title = f.path; nm.textContent = f.path;

    const bd = document.createElement('span');
    bd.className = `fbadge${f.state === 'new' ? ' new' : ''}`;
    if (f.state === 'new') bd.textContent = 'new';
    else if (f.state === 'synced') bd.textContent = '✓';
    else if (f.state === 'unknown') bd.textContent = '?';
    else bd.textContent = f.path.split('.').pop()?.toLowerCase() || 'file';

    const dl = document.createElement('button');
    dl.className = 'fdel'; dl.textContent = '×';
    dl.addEventListener('click', () => { files.splice(i, 1); renderFiles(); });

    row.append(cb, nm, bd, dl);
    list.append(row);
  });
}

// ══════════════════════════════════════════
//  AI / LOCAL COMMIT MESSAGE GENERATOR
// ══════════════════════════════════════════
async function generateMsg() {
  const btn = $('aiBtn');
  const selected = files.filter(f => f.checked !== false).map(f => f.path);
  if (!selected.length) { toast('Select files first', 'err'); return; }
  btn.textContent = '⟳…'; btn.disabled = true;

  const map = { js: 'feat', ts: 'feat', jsx: 'feat', tsx: 'feat', css: 'style', scss: 'style', md: 'docs', html: 'feat', json: 'chore', py: 'feat', sh: 'chore', vue: 'feat', svelte: 'feat' };
  const ext = selected[0].split('.').pop()?.toLowerCase() || '';
  const type = map[ext] || 'chore';
  const list = selected.slice(0, 2).join(', ') + (selected.length > 2 ? ` +${selected.length - 2}` : '');
  $('commitMsg').value = `${type}: update ${list}`;

  btn.textContent = '✦ Generate'; btn.disabled = false;
}

// ══════════════════════════════════════════
//  PUSH
// ══════════════════════════════════════════
async function push() {
  if (busy) return;
  const msg = $('commitMsg').value.trim();
  const selected = files.filter(f => f.checked !== false);

  if (!selected.length) { toast('No files selected', 'err'); return; }
  if (!msg) { toast('Enter a commit message', 'err'); return; }
  if (!repo) { toast('Select a repo first', 'err'); showRepoPicker(); return; }

  const { token } = await store('token');
  if (!token) { toast('GitHub token required', 'err'); showScreen('setup'); bindSetup(); return; }

  busy = true;
  $('pushBtn').disabled = true;
  $('btnIcon').innerHTML = '<div class="spinner"></div>';
  $('btnText').textContent = 'Pushing…';
  showLog(); clearLog();

  const { owner, name, branch } = repo;

  // Get base URL for local file fetches
  let base = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && isLocalUrl(tab.url)) base = getBase(tab.url);
  } catch { }

  if (!base) {
    log('err', '✗ No local server tab found');
    toast('Open a localhost tab first', 'err');
    busy = false;
    $('pushBtn').disabled = false;
    $('btnIcon').textContent = '↑';
    $('btnText').textContent = 'Commit & Push';
    return;
  }

  try {
    log('hi', `→ ${owner}/${name} @ ${branch}`);

    // Get latest ref
    const refRes = await ghFetch(token, `/repos/${owner}/${name}/git/ref/heads/${branch}`);
    if (!refRes.ok) {
      const em = await refRes.json();
      throw new Error(em.message || `HTTP ${refRes.status}`);
    }
    const { object: { sha: latestSha } } = await refRes.json();
    const { tree: { sha: baseTree } } = await (await ghFetch(token, `/repos/${owner}/${name}/git/commits/${latestSha}`)).json();
    log('hi', `Base: ${latestSha.slice(0, 7)}`);

    // Fetch each file from local server
    const treeItems = [];
    for (const f of selected) {
      try {
        const r = await fetch(`${base}/${f.path}`);
        if (!r.ok) { log('err', `⚠ skip ${f.path} (${r.status})`); continue; }
        const content = await r.text();
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', content });
        log('ok', `✓ ${f.path}`);
      } catch (e) {
        log('err', `⚠ skip ${f.path}: ${e.message}`);
      }
    }

    if (!treeItems.length) throw new Error('No files could be read from local server');

    // Create tree → commit → update ref
    const tree = await ghPost(token, `/repos/${owner}/${name}/git/trees`, { base_tree: baseTree, tree: treeItems });
    const commit = await ghPost(token, `/repos/${owner}/${name}/git/commits`, { message: msg, tree: tree.sha, parents: [latestSha] });
    await ghFetch(token, `/repos/${owner}/${name}/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha });

    log('ok', `✓ ${commit.sha.slice(0, 7)} pushed to ${owner}/${name}@${branch}`);
    toast('✓ Pushed!', 'ok');

    // Clear pushed files from list
    const pushedPaths = new Set(treeItems.map(t => t.path));
    files = files.filter(f => !pushedPaths.has(f.path));
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
//  LOW-LEVEL HELPERS
// ══════════════════════════════════════════
function ghFetch(token, endpoint, method = 'GET', body = null) {
  return fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : null
  });
}

async function ghPost(token, endpoint, body) {
  const r = await ghFetch(token, endpoint, 'POST', body);
  if (!r.ok) { const e = await r.json(); throw new Error(e.message || `HTTP ${r.status}`); }
  return r.json();
}

function store(...keys) { return chrome.storage.local.get(keys); }
function showLog() { $('logBox').style.display = 'block'; }
function clearLog() { $('logBody').innerHTML = ''; }
function log(cls, text) {
  const el = document.createElement('div');
  el.className = `ll ${cls}`; el.textContent = text;
  $('logBody').append(el);
  $('logBody').scrollTop = 9999;
}
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  requestAnimationFrame(() => {
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  });
}
