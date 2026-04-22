import re

with open('popup.js', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    const port = new URL(tab.url).port || '80';

    // New port — resolve repo
    if (port !== activePort) {
      activePort = port;
      await chrome.storage.local.set({ activePort });
      const { repos = {} } = await store('repos');
      if (repos[port]) {
        repo = repos[port];
        setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
      } else {
        repo = null;
        setRepoPill('spin', `Detecting repo on :${port}…`);
        await autoDetectRepo(port);
      }
    }

    if (!repo) { toast('Select a repo first', 'err'); return; }

    // Scrape paths from page DOM
    const [{ result: rawPaths }] = await chrome.scripting.executeScript({
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
          const matches = el.textContent.matchAll(/["'\`]([\w./-]+\.(js|ts|jsx|tsx|css|scss))[`'"]/g);
          for (const m of matches) {
            const v = m[1];
            if (!v.startsWith('http') && !v.startsWith('//')) out.add(v.replace(/^\//, ''));
          }
        });
        const IGNORE = [/^_next\//,/^\.next\//,/^__vite__/,/^@vite\//,/^@fs\//,/node_modules/,/chunks?\//,/webpack/,/hot-update/,/\.[a-f0-9]{8,}\./];
        return [...out].filter(p => p.length > 0 && !IGNORE.some(r => r.test(p))).slice(0, 40);
      }
    });

    const paths = rawPaths || [];"""

replacement = """    const port = new URL(tab.url).port || '80';

    // 1. Scrape DOM first to get paths and fingerprint title
    const [{ result: scrapeResult }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const out = new Set();
        const add = (el, attr) => {
          const v = el.getAttribute(attr);
          if (v && !v.startsWith('http') && !v.startsWith('//') && !v.startsWith('data:'))
            out.add(v.replace(/^\\//, '').split('?')[0].split('#')[0]);
        };
        document.querySelectorAll('script[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('link[rel=stylesheet]').forEach(e => add(e, 'href'));
        document.querySelectorAll('img[src]').forEach(e => add(e, 'src'));
        document.querySelectorAll('link[as=script]').forEach(e => add(e, 'href'));
        document.querySelectorAll('link[as=style]').forEach(e => add(e, 'href'));
        document.querySelectorAll('script:not([src])').forEach(el => {
          const matches = el.textContent.matchAll(/["'\`]([\\w./-]+\\.(js|ts|jsx|tsx|css|scss))[\`'"]/g);
          for (const m of matches) {
            const v = m[1];
            if (!v.startsWith('http') && !v.startsWith('//')) out.add(v.replace(/^\\//, ''));
          }
        });
        const IGNORE = [/^_next\\//,/^\\.next\\//,/^__vite__/,/^@vite\\//,/^@fs\\//,/node_modules/,/chunks?\\//,/webpack/,/hot-update/,/\\.[a-f0-9]{8,}\\./];
        return {
          paths: [...out].filter(p => p.length > 0 && !IGNORE.some(r => r.test(p))).slice(0, 40),
          title: document.title
        };
      }
    });

    const paths = scrapeResult?.paths || [];

    // 2. Fetch package.json name to fingerprint project
    let currentProjectName = null;
    try {
      const r = await fetch(`http://localhost:${port}/package.json`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { const pkg = await r.json(); currentProjectName = pkg.name?.replace(/^@[^/]+\\//, ''); }
    } catch {}

    const projectFingerprint = currentProjectName || scrapeResult?.title || port;

    // 3. Resolve repo caching logic
    const { repos = {} } = await store('repos');
    let cachedRepo = repos[port];

    if (cachedRepo && cachedRepo.fingerprint && cachedRepo.fingerprint !== projectFingerprint) {
      cachedRepo = null; // project changed! force redetect
    }

    activePort = port;
    await chrome.storage.local.set({ activePort });

    if (cachedRepo) {
      repo = cachedRepo;
      setRepoPill('ok', `${repo.owner}/${repo.name}  [${repo.branch}]`);
    } else {
      repo = null;
      setRepoPill('spin', `Detecting repo on :${port}…`);
      await autoDetectRepo(port, projectFingerprint, currentProjectName);
    }

    if (!repo) {
       toast('Select a repo first', 'err'); 
       return; 
    }"""

if target in content:
    with open('popup.js', 'w', encoding='utf-8') as f:
        f.write(content.replace(target, replacement))
    print("Replace successful!")
else:
    print("Target string not found. Please check.")
