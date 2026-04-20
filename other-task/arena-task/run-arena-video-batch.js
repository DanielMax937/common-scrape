#!/usr/bin/env node

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_TARGET_URL = 'https://arena.ai/video';
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;
const DEFAULT_PAGE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_EXPECTED_DOWNLOADS = 2;
const DEFAULT_IDLE_EXIT_MS = 0;
const DEFAULT_PRESERVE_PROFILES = true;

function splitCsv(input) {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBoolean(input, defaultValue = false) {
  if (input === undefined || input === null || input === '') return defaultValue;
  const v = String(input).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function getEnvConfig() {
  const inputJson = process.env.ARENA_INPUT_JSON;
  if (!inputJson) {
    throw new Error('Missing ARENA_INPUT_JSON environment variable');
  }

  const profileDirs = splitCsv(process.env.ARENA_PROFILE_DIRS).map((p) => path.resolve(PROJECT_ROOT, p));
  const profileIds = splitCsv(process.env.ARENA_PROFILE_IDS);

  let resolvedProfileDirs = profileDirs;
  if (resolvedProfileDirs.length === 0) {
    const ids = profileIds.length > 0 ? profileIds : ['1'];
    resolvedProfileDirs = ids.map((id) => path.join(PROJECT_ROOT, 'browser-profiles', `browser-${id}`));
  }

  const outputDir = path.join(PROJECT_ROOT, 'videooutput');
  const downloadLinksPath = path.join(outputDir, 'download-links.jsonl');

  return {
    inputJsonPath: path.resolve(PROJECT_ROOT, inputJson),
    profileDirs: resolvedProfileDirs,
    targetUrl: process.env.ARENA_TARGET_URL || DEFAULT_TARGET_URL,
    outputDir,
    downloadLinksPath,
    browserChannel: process.env.ARENA_BROWSER_CHANNEL || 'chrome',
    headless: parseBoolean(process.env.ARENA_HEADLESS, false),
    maxWaitMs: Number(process.env.ARENA_MAX_WAIT_MS || DEFAULT_MAX_WAIT_MS),
    pollIntervalMs: Number(process.env.ARENA_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    pageTimeoutMs: Number(process.env.ARENA_PAGE_TIMEOUT_MS || DEFAULT_PAGE_TIMEOUT_MS),
    expectedDownloads: Number(process.env.ARENA_EXPECTED_DOWNLOADS || DEFAULT_EXPECTED_DOWNLOADS),
    idleExitMs: Number(process.env.ARENA_IDLE_EXIT_MS || DEFAULT_IDLE_EXIT_MS),
    preserveProfiles: parseBoolean(process.env.ARENA_PRESERVE_PROFILES, DEFAULT_PRESERVE_PROFILES),
  };
}

function appendDownloadRecord(downloadLinksPath, record) {
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(downloadLinksPath, line, 'utf8');
}

function normalizeAttachments(item) {
  if (Array.isArray(item.attachments)) return item.attachments;
  if (Array.isArray(item.files)) return item.files;
  if (typeof item.attachment === 'string' && item.attachment.trim()) return [item.attachment.trim()];
  if (typeof item.attachments === 'string' && item.attachments.trim()) return [item.attachments.trim()];
  return [];
}

function loadTasks(inputJsonPath) {
  if (!fs.existsSync(inputJsonPath)) {
    throw new Error(`Input JSON not found: ${inputJsonPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse JSON file: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Input JSON must be an array of task items');
  }

  const inputDir = path.dirname(inputJsonPath);
  const tasks = parsed.map((item, i) => {
    const prompt = item && typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!prompt) {
      throw new Error(`Task #${i + 1} missing non-empty prompt`);
    }

    const rawAttachments = normalizeAttachments(item);
    const selectedAttachments = rawAttachments.length > 1 ? [rawAttachments[0]] : rawAttachments;
    const attachments = selectedAttachments.map((p) => path.resolve(inputDir, p));
    attachments.forEach((filePath) => {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Task #${i + 1} attachment not found: ${filePath}`);
      }
    });

    return {
      index: i + 1,
      prompt,
      attachments,
    };
  });

  if (tasks.length === 0) {
    throw new Error('Input JSON has no tasks');
  }

  return tasks;
}

function createDownloadCollector(page, timeoutMs, expectedCount = 1) {
  let timer = null;
  let settled = false;
  let resolver = null;
  let handler = null;
  const downloads = [];

  const finalize = (resolve) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (handler) page.off('download', handler);
    resolve(downloads);
  };

  const promise = new Promise((resolve) => {
    resolver = resolve;
    handler = (download) => {
      if (settled) return;
      downloads.push(download);
      if (downloads.length >= expectedCount) finalize(resolve);
    };

    page.on('download', handler);

    timer = setTimeout(() => {
      finalize(resolve);
    }, timeoutMs);
  });

  const cancel = () => {
    finalize(resolver);
  };

  return { promise, cancel };
}

async function safeClickGotIt(page) {
  const gotIt = page.getByRole('button', { name: /^Got it$/i }).first();
  try {
    if (await gotIt.isVisible({ timeout: 1000 })) {
      await gotIt.click();
    }
  } catch (_) {
    // ignore
  }
}

async function openNewVideoComposer(page, targetUrl, pageTimeoutMs) {
  if (!page.url().includes('/video')) {
    const newChat = page.locator('a[href="/video"]').first();
    if (await newChat.count()) {
      try {
        await newChat.click({ timeout: pageTimeoutMs });
      } catch (_) {
        // ignore and fallback to goto
      }
    }
  }

  if (!page.url().includes('/video')) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  }

  await safeClickGotIt(page);
  await page.waitForTimeout(800);
}

async function uploadAttachments(page, attachments, pageTimeoutMs) {
  if (!attachments || attachments.length === 0) return;

  const addFilesButton = page.getByRole('button', { name: /Add files|Add file/i }).first();
  await addFilesButton.waitFor({ state: 'visible', timeout: pageTimeoutMs });

  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: pageTimeoutMs });
  await addFilesButton.click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(attachments);

  await page.waitForTimeout(1200);
}

async function fillPrompt(page, prompt, pageTimeoutMs) {
  const textarea = page.locator('textarea[placeholder*="Describe your video"]').first();
  await textarea.waitFor({ state: 'visible', timeout: pageTimeoutMs });
  await textarea.fill('');
  await textarea.fill(prompt);
}

async function clickSubmit(page) {
  const textarea = page.locator('textarea[placeholder*="Describe your video"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 10000 });

  // Some Arena builds only enable submit after the latest input event.
  await textarea.focus();

  const clicked = await page.evaluate(() => {
    const textareaNode = document.querySelector('textarea[placeholder*="Describe your video"]');
    if (!textareaNode) return false;

    const form = textareaNode.closest('form');
    const host = form || textareaNode.closest('div') || document;

    const isBlockedButton = (btn) => {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const combined = `${text} ${aria} ${title}`;
      return (
        combined.includes('add file') ||
        combined.includes('add files') ||
        combined.includes('upload') ||
        combined.includes('got it') ||
        combined.includes('edit') ||
        combined === 'video'
      );
    };

    const isLikelySubmit = (btn) => {
      if (btn.disabled) return false;
      if (isBlockedButton(btn)) return false;

      const typeAttr = (btn.getAttribute('type') || '').toLowerCase();
      if (typeAttr === 'submit') return true;

      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const combined = `${text} ${aria} ${title}`;
      if (combined.includes('submit') || combined.includes('generate') || combined.includes('create')) return true;

      // Icon-only action button near composer is often the submit trigger.
      return btn.querySelector('svg') !== null;
    };

    const allButtons = Array.from(host.querySelectorAll('button'));
    const candidates = allButtons.filter(isLikelySubmit);
    if (candidates.length === 0) return false;

    const button = candidates[candidates.length - 1];
    button.click();
    return true;
  });

  if (clicked) return;

  // Fallback: many composers support Cmd/Ctrl+Enter for submit.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await textarea.press(`${modifier}+Enter`);
}

async function tryDownloadFromCurrentChat(page, downloadTimeoutMs, expectedCount) {
  const collector = createDownloadCollector(page, downloadTimeoutMs, expectedCount);

  const clickedCount = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const candidates = [];

    const editButtons = buttons.filter((btn) => (btn.textContent || '').trim() === 'Edit');
    for (const edit of editButtons) {
      const candidate = edit.previousElementSibling;
      if (candidate && candidate.tagName === 'BUTTON' && !candidate.disabled) {
        candidates.push(candidate);
      }
    }

    const directDownloads = Array.from(document.querySelectorAll('button,a')).filter((el) => {
      const text = (el.textContent || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      return text.includes('download') || aria.includes('download') || title.includes('download');
    });

    for (const el of directDownloads) {
      candidates.push(el);
    }

    const uniqueTargets = Array.from(new Set(candidates));
    let clicked = 0;
    for (const target of uniqueTargets) {
      if (target.disabled) continue;
      try {
        target.click();
        clicked += 1;
      } catch (_) {
        // ignore individual click failures
      }
    }

    return clicked;
  });

  if (!clickedCount) {
    collector.cancel();
    return [];
  }

  return collector.promise;
}

async function submitAndCollectUrls(page, task, config, workerLabel) {
  await openNewVideoComposer(page, config.targetUrl, config.pageTimeoutMs);
  await fillPrompt(page, task.prompt, config.pageTimeoutMs);
  await uploadAttachments(page, task.attachments, config.pageTimeoutMs);

  await clickSubmit(page);

  try {
    await page.waitForURL(/\/c\//, { timeout: config.pageTimeoutMs });
  } catch (_) {
    // Some sessions may stay on /video; continue polling on current page.
  }

  const startTime = Date.now();
  const deadline = startTime + config.maxWaitMs;
  const collectedDownloads = [];

  while (Date.now() < deadline) {
    await safeClickGotIt(page);

    const remaining = Math.max(config.expectedDownloads - collectedDownloads.length, 1);
    const downloads = await tryDownloadFromCurrentChat(page, 12000, remaining);
    if (downloads.length > 0) {
      collectedDownloads.push(...downloads);
    }

    if (collectedDownloads.length >= config.expectedDownloads) {
      for (let i = 0; i < config.expectedDownloads; i += 1) {
        const download = collectedDownloads[i];
        const suggested = download.suggestedFilename() || `video-${i + 1}.mp4`;
        const downloadUrl = typeof download.url === 'function' ? download.url() : null;
        const record = {
          taskIndex: task.index,
          resultIndex: i + 1,
          prompt: task.prompt,
          suggestedFilename: suggested,
          downloadUrl,
          capturedAt: new Date().toISOString(),
        };
        appendDownloadRecord(config.downloadLinksPath, record);
        console.log(`${workerLabel} Task #${task.index} URL #${i + 1} captured -> ${downloadUrl || 'null'}`);
      }
      return;
    }

    console.log(
      `${workerLabel} Task #${task.index} waiting... (${Math.round((Date.now() - startTime) / 1000)}s, downloads ${
        collectedDownloads.length
      }/${config.expectedDownloads})`
    );
    await page.waitForTimeout(config.pollIntervalMs);
  }

  throw new Error(
    `Task #${task.index} timed out after ${Math.round(config.maxWaitMs / 1000)}s (downloads ${collectedDownloads.length}/${config.expectedDownloads})`
  );
}

async function createWorker(profileDir, workerId, queue, config, results) {
  const workerLabel = `[worker-${workerId}]`;
  const launchOptions = {
    headless: config.headless,
    acceptDownloads: true,
    channel: config.browserChannel,
  };

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  if (!config.preserveProfiles) {
    throw new Error('ARENA_PRESERVE_PROFILES=false is not supported. Profiles must stay persistent.');
  }

  let context;
  try {
    console.log(`${workerLabel} launch profile: ${profileDir}`);
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(config.pageTimeoutMs);
    page.setDefaultNavigationTimeout(config.pageTimeoutMs);
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
    let idleStart = null;

    while (true) {
      const task = queue.next();
      if (!task) {
        if (idleStart === null) {
          idleStart = Date.now();
          console.log(`${workerLabel} idle: waiting for tasks`);
        }

        if (config.idleExitMs > 0 && Date.now() - idleStart >= config.idleExitMs) {
          console.log(`${workerLabel} idle timeout reached (${config.idleExitMs}ms), closing`);
          break;
        }

        await page.waitForTimeout(1000);
        continue;
      }

      idleStart = null;

      console.log(`${workerLabel} start task #${task.index}`);
      try {
        await submitAndCollectUrls(page, task, config, workerLabel);
        results.push({ index: task.index, ok: true });
      } catch (err) {
        results.push({ index: task.index, ok: false, error: err.message });
        console.error(`${workerLabel} task #${task.index} failed: ${err.message}`);
      }
    }
  } finally {
    if (context) {
      await context.close();
    }
  }
}

function createTaskQueue(tasks) {
  let pointer = 0;
  return {
    next() {
      if (pointer >= tasks.length) return null;
      const task = tasks[pointer];
      pointer += 1;
      return task;
    },
  };
}

function printConfig(config, taskCount) {
  console.log('');
  console.log('Arena Video Batch Runner');
  console.log('========================');
  console.log(`Input JSON:      ${config.inputJsonPath}`);
  console.log(`Tasks:           ${taskCount}`);
  console.log(`Profiles:        ${config.profileDirs.length}`);
  console.log(`Target URL:      ${config.targetUrl}`);
  console.log(`Output dir:      ${config.outputDir}`);
  console.log(`Links log:       ${config.downloadLinksPath}`);
  console.log(`Headless:        ${config.headless}`);
  console.log(`Browser channel: ${config.browserChannel}`);
  console.log(`Page timeout:    ${config.pageTimeoutMs}ms`);
  console.log(`URLs/task:       ${config.expectedDownloads}`);
  console.log(`Idle exit ms:    ${config.idleExitMs} (0 means never)`);
  console.log(`Profiles:        persistent (no cleanup)`);
  console.log('');
}

async function main() {
  const config = getEnvConfig();
  const tasks = loadTasks(config.inputJsonPath);

  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.writeFileSync(config.downloadLinksPath, '', 'utf8');
  printConfig(config, tasks.length);

  const queue = createTaskQueue(tasks);
  const results = [];

  await Promise.all(
    config.profileDirs.map((profileDir, i) => createWorker(profileDir, i + 1, queue, config, results))
  );

  const successCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).sort((a, b) => a.index - b.index);

  console.log('');
  console.log('Run Summary');
  console.log('===========');
  console.log(`Success: ${successCount}/${tasks.length}`);

  if (failed.length > 0) {
    console.log('Failed tasks:');
    failed.forEach((f) => {
      console.log(`  - #${f.index}: ${f.error}`);
    });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
