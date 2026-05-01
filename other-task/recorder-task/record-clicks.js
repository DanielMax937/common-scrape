#!/usr/bin/env node

/**
 * Click Recorder
 *
 * Opens a site in a real Chrome browser, records every click the user makes
 * (CSS selector + delay since previous action), then writes a replayable
 * task JSON when the browser is closed or Ctrl+C is pressed.
 *
 * Usage:
 *   node other-task/recorder-task/record-clicks.js <url> [options]
 *   node other-task/recorder-task/record-clicks.js https://example.com
 *   node other-task/recorder-task/record-clicks.js https://example.com --profile 1
 *   node other-task/recorder-task/record-clicks.js https://example.com --output my-task.json
 *   node other-task/recorder-task/record-clicks.js https://example.com --name "login-flow"
 */

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// CSS selector generator (injected into the page)
// ---------------------------------------------------------------------------

const INJECTED_RECORDER_SCRIPT = `
(() => {
  if (window.__clickRecorderInstalled) return;
  window.__clickRecorderInstalled = true;
  window.__recordedClicks = window.__recordedClicks || [];

  function escapeCSS(value) {
    return CSS.escape ? CSS.escape(value) : value.replace(/([\\\\!"#$%&'()*+,./:;<=>?@[\\]^\`{|}~])/g, '\\\\$1');
  }

  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // 1. id
    if (el.id) {
      const sel = '#' + escapeCSS(el.id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 2. data-testid / data-id / name
    for (const attr of ['data-testid', 'data-id', 'name']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(val) + ']';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 3. unique class combination on same tag
    if (el.classList && el.classList.length > 0) {
      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList)
        .filter(c => !/^[0-9]/.test(c) && c.length < 60 && !/[:\\\\[\\]]/.test(c));
      if (classes.length > 0) {
        const sel = tag + '.' + classes.map(c => escapeCSS(c)).join('.');
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 4. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const sel = el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 5. link href + text combo
    if (el.tagName === 'A' && el.href) {
      try {
        const href = new URL(el.href).pathname;
        const sel = 'a[href=' + JSON.stringify(href) + ']';
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
    }

    // 6. button/input with type + visible text
    if ((el.tagName === 'BUTTON' || el.tagName === 'INPUT') && el.type) {
      const text = (el.textContent || '').trim().slice(0, 40);
      if (text) {
        // We'll use an xpath-style fallback in the path builder below
      }
    }

    // 7. Build a path with nth-child
    return buildNthChildPath(el);
  }

  function buildNthChildPath(target) {
    const parts = [];
    let el = target;
    while (el && el !== document.body && el !== document.documentElement) {
      const tag = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (!parent) { parts.unshift(tag); break; }

      // Try id shortcut
      if (el.id) {
        parts.unshift('#' + escapeCSS(el.id));
        break;
      }

      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      if (siblings.length === 1) {
        parts.unshift(tag);
      } else {
        const index = siblings.indexOf(el) + 1;
        parts.unshift(tag + ':nth-child(' + (Array.from(parent.children).indexOf(el) + 1) + ')');
      }
      el = parent;
    }
    return parts.join(' > ');
  }

  // Find the most meaningful clickable ancestor
  function findClickTarget(el) {
    let node = el;
    const maxDepth = 5;
    let depth = 0;
    while (node && node !== document.body && depth < maxDepth) {
      const tag = node.tagName.toLowerCase();
      if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return node;
      if (node.getAttribute('role') === 'button' || node.getAttribute('role') === 'link') return node;
      if (node.getAttribute('onclick') || node.getAttribute('tabindex')) return node;
      if (node.classList && (
        Array.from(node.classList).some(c => /btn|button|click|link|tab|menu-item|nav-item/i.test(c))
      )) return node;
      node = node.parentElement;
      depth++;
    }
    return el;
  }

  document.addEventListener('click', (e) => {
    const target = findClickTarget(e.target);
    const selector = getSelector(target);
    if (!selector) return;

    const text = (target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const tagName = target.tagName.toLowerCase();
    const now = Date.now();

    window.__recordedClicks.push({
      selector,
      text,
      tagName,
      timestamp: now,
      url: location.href,
    });

    // Visual feedback
    const badge = document.createElement('div');
    badge.textContent = '● REC ' + window.__recordedClicks.length;
    Object.assign(badge.style, {
      position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647',
      background: '#e53e3e', color: '#fff', padding: '4px 10px',
      borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace',
      pointerEvents: 'none', opacity: '1', transition: 'opacity 0.8s',
    });
    document.body.appendChild(badge);
    setTimeout(() => { badge.style.opacity = '0'; }, 600);
    setTimeout(() => { badge.remove(); }, 1400);
  }, true);

  // Persistent banner
  const banner = document.createElement('div');
  banner.id = '__click-recorder-banner';
  banner.textContent = '🔴 Recording clicks — close browser or press Ctrl+C to save';
  Object.assign(banner.style, {
    position: 'fixed', bottom: '0', left: '0', width: '100%', zIndex: '2147483647',
    background: '#1a202c', color: '#fff', padding: '6px 16px',
    fontSize: '13px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    textAlign: 'center', pointerEvents: 'none',
  });
  document.body.appendChild(banner);
})();
`;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log([
      'Click Recorder',
      '',
      'Records your clicks in a browser and generates a replayable task JSON.',
      '',
      'Usage:',
      '  node other-task/recorder-task/record-clicks.js <url> [options]',
      '',
      'Options:',
      '  --profile <id>    Browser profile to use (default: 1)',
      '  --output <path>   Output JSON file path (auto-generated if omitted)',
      '  --name <name>     Task name (default: derived from URL)',
      '  --help, -h        Show this help',
      '',
      'Examples:',
      '  node other-task/recorder-task/record-clicks.js https://example.com',
      '  node other-task/recorder-task/record-clicks.js https://example.com --profile 2 --name "login-flow"',
      '',
      'The generated task can be replayed with:',
      '  node other-task/recorder-task/replay-task.js <task.json>',
    ].join('\n'));
    process.exit(0);
  }

  const url = args[0];
  if (!/^https?:\/\//i.test(url)) {
    console.error(`❌ First argument must be a URL starting with http:// or https://`);
    process.exit(1);
  }

  let profileId = '1';
  let outputPath = '';
  let taskName = '';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--profile' && args[i + 1]) { profileId = args[++i]; continue; }
    if (args[i] === '--output' && args[i + 1]) { outputPath = args[++i]; continue; }
    if (args[i] === '--name' && args[i + 1]) { taskName = args[++i]; continue; }
  }

  if (!taskName) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      taskName = hostname.replace(/\./g, '-');
    } catch {
      taskName = 'recorded-task';
    }
  }

  if (!outputPath) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = taskName.replace(/[^a-zA-Z0-9_-]/g, '_');
    outputPath = path.join(PROJECT_ROOT, 'output', 'recorder', `${safeName}-${ts}.json`);
  } else {
    outputPath = path.resolve(outputPath);
  }

  return { url, profileId, outputPath, taskName };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { url, profileId, outputPath, taskName } = parseArgs();

  const profileDir = path.join(PROJECT_ROOT, 'browser-profiles', `browser-${profileId}`);
  if (!fs.existsSync(profileDir)) {
    console.error(`❌ Browser profile not found: ${profileDir}`);
    console.error(`   Run \`npm run browser ${profileId}\` first to create and log in.`);
    process.exit(1);
  }

  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          🔴 Click Recorder                               ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  URL:       ${url.slice(0, 46).padEnd(46)} ║`);
  console.log(`║  Profile:   ${String(profileId).padEnd(46)} ║`);
  console.log(`║  Task name: ${taskName.slice(0, 46).padEnd(46)} ║`);
  console.log(`║  Output:    ${outputPath.slice(-46).padEnd(46)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('🚀 Launching browser...');

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });

  let saved = false;

  async function collectAndSave() {
    if (saved) return;
    saved = true;

    let allClicks = [];
    try {
      const pages = context.pages();
      for (const p of pages) {
        try {
          const clicks = await Promise.race([
            p.evaluate(() => window.__recordedClicks || []),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ]);
          allClicks = allClicks.concat(clicks);
        } catch {}
      }
    } catch {}

    if (allClicks.length === 0) {
      console.log('\n⚠️  No clicks recorded.');
      return;
    }

    // Sort by timestamp and compute delays
    allClicks.sort((a, b) => a.timestamp - b.timestamp);
    const baseTime = allClicks[0].timestamp;
    const actions = allClicks.map((click, i) => {
      const delayMs = i === 0 ? 0 : click.timestamp - allClicks[i - 1].timestamp;
      return {
        type: 'click',
        selector: click.selector,
        delayMs,
        text: click.text || '',
        tagName: click.tagName || '',
        url: click.url || '',
      };
    });

    const task = {
      version: 1,
      name: taskName,
      url,
      recordedAt: new Date().toISOString(),
      totalActions: actions.length,
      totalDurationMs: allClicks[allClicks.length - 1].timestamp - baseTime,
      actions,
    };

    fs.writeFileSync(outputPath, JSON.stringify(task, null, 2), 'utf8');
    console.log(`\n✅ Saved ${actions.length} actions -> ${outputPath}`);
    console.log(`   Replay with: node other-task/recorder-task/replay-task.js ${outputPath}`);
  }

  // Inject recorder into every page (including new ones)
  async function injectRecorder(page) {
    try {
      await page.evaluate(INJECTED_RECORDER_SCRIPT);
    } catch {}
  }

  // Handle new pages opened during recording
  context.on('page', async (page) => {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await injectRecorder(page);
    // Re-inject on navigation
    page.on('load', () => injectRecorder(page));
  });

  // Navigate and inject
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await injectRecorder(page);
  // Re-inject on navigation within the same tab
  page.on('load', () => injectRecorder(page));

  console.log('');
  console.log('✅ Recording started!');
  console.log('   👆 Click around on the page — all clicks are being recorded');
  console.log('   🛑 Close the browser or press Ctrl+C to stop and save');
  console.log('');

  // Wait for browser to close
  const closePromise = new Promise((resolve) => {
    context.on('close', resolve);
  });

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n🛑 Stopping recorder...');
    await collectAndSave();
    await context.close().catch(() => {});
    process.exit(0);
  });

  await closePromise;
  await collectAndSave();
}

main().catch((err) => {
  console.error(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
