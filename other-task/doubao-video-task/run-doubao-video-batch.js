#!/usr/bin/env node

const { chromium } = require('patchright');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
require('dotenv').config();

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_TARGET_URL = 'https://www.doubao.com/chat/';
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;
const DEFAULT_PAGE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_MAX_RETRIES = 3;

function printHelp() {
  console.log(
    [
      'Doubao Video Batch Runner',
      '',
      'Usage:',
      '  npm run doubao:video',
      '  npm run doubao:video -- --dry-run',
      '  DOUBAO_VIDEO_INPUT_JSON=./other-task/doubao-video-task/input.example.json npm run doubao:video',
      '  DOUBAO_VIDEO_PROFILE_IDS=1,2 npm run doubao:video',
      '',
      'Required before running:',
      '  npm run browser -- 1',
      '  Log in to https://www.doubao.com/chat/ with that profile.',
      '',
      'Environment variables:',
      '  DOUBAO_VIDEO_INPUT_JSON       default ./other-task/doubao-video-task/input.json',
      '  DOUBAO_VIDEO_PROFILE_IDS      default 1',
      '  DOUBAO_VIDEO_PROFILE_DIRS     overrides profile ids',
      '  DOUBAO_VIDEO_OUTPUT_DIR       default videooutput/doubao',
      '  DOUBAO_VIDEO_TARGET_URL       default https://www.doubao.com/chat/',
      '  DOUBAO_VIDEO_HEADLESS         default false',
      '  DOUBAO_VIDEO_MAX_WAIT_MS      default 1800000',
      '  DOUBAO_VIDEO_POLL_INTERVAL_MS default 10000',
      '  DOUBAO_VIDEO_PAGE_TIMEOUT_MS  default 120000',
      '  DOUBAO_VIDEO_MAX_RETRIES      default 3',
    ].join('\n')
  );
}

function splitCsv(input) {
  if (!input) return [];
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBoolean(input, defaultValue = false) {
  if (input === undefined || input === null || input === '') return defaultValue;
  const value = String(input).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function sanitizeFilePart(input, fallback = 'video') {
  const value = String(input || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return value || fallback;
}

function getEnvConfig() {
  const inputJsonPath = path.resolve(
    PROJECT_ROOT,
    process.env.DOUBAO_VIDEO_INPUT_JSON || './other-task/doubao-video-task/input.json'
  );
  const profileDirs = splitCsv(process.env.DOUBAO_VIDEO_PROFILE_DIRS).map((p) => path.resolve(PROJECT_ROOT, p));
  const profileIds = splitCsv(process.env.DOUBAO_VIDEO_PROFILE_IDS);
  const resolvedProfileDirs =
    profileDirs.length > 0
      ? profileDirs
      : (profileIds.length > 0 ? profileIds : ['1']).map((id) =>
          path.join(PROJECT_ROOT, 'browser-profiles', `browser-${id}`)
        );

  const outputDir = path.resolve(
    PROJECT_ROOT,
    process.env.DOUBAO_VIDEO_OUTPUT_DIR || path.join('videooutput', 'doubao')
  );

  return {
    inputJsonPath,
    profileDirs: resolvedProfileDirs,
    targetUrl: process.env.DOUBAO_VIDEO_TARGET_URL || DEFAULT_TARGET_URL,
    outputDir,
    resultsPath: path.join(outputDir, 'results.jsonl'),
    profileUrlsPath: path.join(outputDir, 'profile-urls.jsonl'),
    browserChannel: process.env.DOUBAO_VIDEO_BROWSER_CHANNEL || 'chrome',
    headless: parseBoolean(process.env.DOUBAO_VIDEO_HEADLESS, false),
    maxWaitMs: Number(process.env.DOUBAO_VIDEO_MAX_WAIT_MS || DEFAULT_MAX_WAIT_MS),
    pollIntervalMs: Number(process.env.DOUBAO_VIDEO_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS),
    pageTimeoutMs: Number(process.env.DOUBAO_VIDEO_PAGE_TIMEOUT_MS || DEFAULT_PAGE_TIMEOUT_MS),
    maxRetries: Number(process.env.DOUBAO_VIDEO_MAX_RETRIES || DEFAULT_MAX_RETRIES),
  };
}

function normalizeTaskItem(item, index, inputDir) {
  if (typeof item === 'string') {
    const prompt = item.trim();
    if (!prompt) throw new Error(`Task #${index} has empty prompt`);
    return { index, prompt, imagePaths: [], ratio: '16:9' };
  }

  if (!item || typeof item !== 'object') {
    throw new Error(`Task #${index} must be a string or object`);
  }

  const prompt = String(item.prompt || '').trim();
  if (!prompt) throw new Error(`Task #${index} missing non-empty prompt`);

  const rawImages = Array.isArray(item.imagePaths)
    ? item.imagePaths
    : Array.isArray(item.images)
      ? item.images
      : Array.isArray(item.attachments)
        ? item.attachments
        : [];

  const imagePaths = rawImages.map((p) => path.resolve(inputDir, String(p).trim())).filter(Boolean);
  imagePaths.forEach((filePath) => {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Task #${index} image not found: ${filePath}`);
    }
  });

  return {
    index,
    prompt,
    imagePaths,
    ratio: String(item.ratio || '16:9').trim() || '16:9',
  };
}

function loadTasks(inputJsonPath) {
  if (!fs.existsSync(inputJsonPath)) {
    throw new Error(`Input JSON not found: ${inputJsonPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse input JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Input JSON must be an array');
  }

  const inputDir = path.dirname(inputJsonPath);
  const tasks = parsed.map((item, i) => normalizeTaskItem(item, i + 1, inputDir));
  if (tasks.length === 0) throw new Error('Input JSON has no tasks');
  return tasks;
}

function appendJsonl(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function findVisibleButtonByText(page, keyword) {
  const buttons = await page.$$('button,[role="button"]');
  for (const button of buttons) {
    const text = ((await button.textContent()) || '').replace(/\s+/g, ' ').trim();
    if (!text.includes(keyword)) continue;
    const box = await button.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) return button;
  }
  return null;
}

async function assertLoggedIn(page) {
  const loginButton = await page.$('[data-testid="to_login_button"]');
  if (loginButton) {
    throw new Error('Doubao profile is not logged in. Run `npm run browser -- <profileId>` and login first.');
  }
}

async function openFreshDoubaoChat(page, config) {
  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
  await page.waitForTimeout(4000);
  await assertLoggedIn(page);

  const createButton = await page.$('[data-testid="create_conversation_button"]');
  if (createButton) {
    await createButton.click();
    await page.waitForTimeout(2500);
  }
}

async function enableVideoGeneration(page) {
  let videoButton = await findVisibleButtonByText(page, '视频生成');
  if (!videoButton) {
    const moreButton = await findVisibleButtonByText(page, '更多');
    if (moreButton) {
      await moreButton.click();
      await page.waitForTimeout(1000);
      videoButton = await findVisibleButtonByText(page, '视频生成');
    }
  }

  if (!videoButton) {
    throw new Error('未找到豆包「视频生成」入口');
  }

  await videoButton.click();
  await page.waitForTimeout(1000);
}

async function getComposerInput(page, timeoutMs) {
  const selectors = [
    '#input-engine-container [role="textbox"][contenteditable="true"][data-slate-editor="true"]',
    '#input-engine-container [role="textbox"][contenteditable="true"]',
    '#input-engine-container [data-slate-editor="true"]',
    '[role="textbox"][contenteditable="true"][data-slate-editor="true"]',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea[placeholder*="描述你想生成的视频"]',
    'textarea[placeholder*="添加照片"]',
    'textarea[placeholder*="发消息"]',
    'textarea.semi-input-textarea',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (!element) continue;
      const box = await element.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return element;
    }
    await page.waitForTimeout(500);
  }

  throw new Error('未找到豆包视频输入框');
}

async function fillComposerInput(page, inputElement, prompt) {
  await inputElement.click({ force: true });
  await page.waitForTimeout(150);

  const tagName = await inputElement.evaluate((el) => (el.tagName || '').toLowerCase());
  const isContentEditable = await inputElement.evaluate((el) => el.isContentEditable === true);

  if (tagName === 'textarea') {
    await inputElement.fill('');
    await inputElement.fill(prompt);
    return;
  }

  if (isContentEditable) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(prompt, { delay: 10 });
    await page.waitForTimeout(300);

    const textAfterType = await inputElement.evaluate((el) => (el.textContent || '').trim());
    if (textAfterType.length > 0) return;

    await inputElement.evaluate((el, text) => {
      el.focus();
      const firstText = el.querySelector('[data-slate-string="true"]');
      if (firstText) firstText.textContent = text;
      else el.textContent = text;
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);
    return;
  }

  throw new Error('豆包输入框不是 textarea 或 contenteditable');
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

async function pasteImage(page, imagePath) {
  const base64 = fs.readFileSync(imagePath).toString('base64');
  return page.evaluate(
    ({ b64, type, fileName }) => {
      const selectors = [
        '#input-engine-container [role="textbox"][contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea[placeholder*="描述你想生成的视频"]',
        'textarea[placeholder*="添加照片"]',
        'textarea[placeholder*="发消息"]',
        'textarea.semi-input-textarea',
      ];
      const target = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
      if (!target) return { ok: false, reason: 'target_not_found' };

      target.focus();
      const byteString = atob(b64);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);

      const file = new File([new Blob([bytes], { type })], fileName, { type });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      try {
        const event = new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
      } catch (_) {
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
        target.dispatchEvent(event);
      }

      return { ok: true };
    },
    { b64: base64, type: inferMimeType(imagePath), fileName: path.basename(imagePath) }
  );
}

async function uploadImagesIfAny(page, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return;

  let pastedCount = 0;
  for (const imagePath of imagePaths) {
    const result = await pasteImage(page, imagePath);
    if (result && result.ok) {
      pastedCount += 1;
      await page.waitForTimeout(800);
    }
  }

  if (pastedCount === 0) {
    throw new Error('参考图粘贴失败：未找到可用输入框或粘贴事件未生效');
  }
}

async function selectRatio(page, ratio) {
  const targetRatio = String(ratio || '').trim();
  if (!targetRatio) return;

  const ratioButton = await findVisibleButtonByText(page, '比例');
  if (!ratioButton) return;

  await ratioButton.click();
  await page.waitForTimeout(300);

  const normalizedTarget = targetRatio.replace(/\s+/g, '').replace('：', ':');
  const clicked = await page.evaluate((target) => {
    const popup = document.querySelector('[data-radix-menu-content][data-state="open"]') || document;
    const items = Array.from(popup.querySelectorAll('[role="menuitem"],button,[role="button"]'));
    const match = items.find((item) => {
      const text = (item.textContent || '').replace(/\s+/g, '').replace('：', ':').trim();
      return text === target;
    });
    if (!match) return false;
    match.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, normalizedTarget);

  if (!clicked) {
    console.warn(`[doubao] ratio option not found: ${targetRatio}`);
  }
  await page.waitForTimeout(300);
}

async function submitPrompt(page, task, config) {
  await enableVideoGeneration(page);
  const inputElement = await getComposerInput(page, config.pageTimeoutMs);
  await fillComposerInput(page, inputElement, task.prompt);
  await uploadImagesIfAny(page, task.imagePaths);
  await selectRatio(page, task.ratio);
  await inputElement.click({ force: true });
  await page.waitForTimeout(150);
  await inputElement.press('Enter');
  await page.waitForTimeout(5000);
}

async function downloadByUrl(url, outputPath) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(true)));
      file.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(30000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function downloadGeneratedVideo(page, videoUrl, outputPath) {
  if (videoUrl && /^https?:\/\//.test(videoUrl)) {
    const downloaded = await downloadByUrl(videoUrl, outputPath);
    if (downloaded) return outputPath;
  }

  const downloadButton = await page.$('button:has-text("下载"), button:has-text("保存"), [role="button"]:has-text("下载")');
  if (!downloadButton) return null;

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await downloadButton.click();
  const download = await downloadPromise;
  await download.saveAs(outputPath);
  return outputPath;
}

async function waitForVideoAndDownload(page, task, config, workerLabel) {
  const startedAt = Date.now();
  const outputPath = path.join(
    config.outputDir,
    `${String(task.index).padStart(3, '0')}-${sanitizeFilePart(task.prompt)}-${Date.now()}.mp4`
  );

  while (Date.now() - startedAt < config.maxWaitMs) {
    const status = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const video = document.querySelector('video');
      const source = video ? video.querySelector('source') : null;
      const videoUrl = (video && video.src) || (source && source.src) || '';
      const anchor = document.querySelector('a[download],a[href*=".mp4"],a[href*="video"]');
      const button = Array.from(document.querySelectorAll('button,[role="button"]')).find((el) => {
        const content = (el.textContent || '').trim();
        if (/下载电脑版/.test(content)) return false;
        return /下载视频|保存视频|导出视频|下载结果|保存结果|导出结果|下载/.test(content);
      });
      return {
        done: !!videoUrl || !!anchor || !!button,
        generating: /生成中|渲染中|排队中|预计|处理中/.test(text),
        videoUrl: videoUrl || (anchor ? anchor.getAttribute('href') || '' : ''),
        hasDownloadButton: !!button,
      };
    });

    if (status.done) {
      const downloadedPath = await downloadGeneratedVideo(page, status.videoUrl, outputPath);
      if (!downloadedPath) throw new Error('视频已生成，但下载失败');
      return { downloadPath: downloadedPath, videoUrl: status.videoUrl || '' };
    }

    console.log(`${workerLabel} task #${task.index} waiting video... ${Math.round((Date.now() - startedAt) / 1000)}s`);
    await page.waitForTimeout(config.pollIntervalMs);
  }

  throw new Error(`视频生成超时：${Math.round(config.maxWaitMs / 1000)}s`);
}

function writeVideoRecordMarkdown(task, result, pageUrl, config, profileDir) {
  const parsed = path.parse(result.downloadPath);
  const mdPath = path.join(parsed.dir, `${parsed.name}.md`);
  const content = [
    '# Doubao Video Download Record',
    '',
    `- prompt: ${task.prompt}`,
    `- chat_url: ${pageUrl || 'N/A'}`,
    `- video_path: ${result.downloadPath}`,
    `- video_path_relative: ${path.relative(PROJECT_ROOT, result.downloadPath)}`,
    `- video_url: ${result.videoUrl || 'N/A'}`,
    `- task_index: ${task.index}`,
    `- profile_dir: ${profileDir}`,
    `- ratio: ${task.ratio}`,
    `- generated_at: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, content, 'utf8');
  return mdPath;
}

async function runTask(page, task, config, workerLabel, profileDir) {
  await openFreshDoubaoChat(page, config);
  await submitPrompt(page, task, config);

  const pageUrl = page.url();
  appendJsonl(config.profileUrlsPath, {
    taskIndex: task.index,
    prompt: task.prompt.slice(0, 500),
    profileDir,
    url: pageUrl,
    capturedAt: new Date().toISOString(),
  });

  const result = await waitForVideoAndDownload(page, task, config, workerLabel);
  const recordPath = writeVideoRecordMarkdown(task, result, pageUrl, config, profileDir);
  appendJsonl(config.resultsPath, {
    taskIndex: task.index,
    prompt: task.prompt,
    profileDir,
    chatUrl: pageUrl,
    videoPath: result.downloadPath,
    videoUrl: result.videoUrl,
    recordPath,
    capturedAt: new Date().toISOString(),
  });
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

async function createWorker(profileDir, workerId, queue, config, results) {
  const workerLabel = `[doubao-worker-${workerId}]`;
  const launchOptions = {
    headless: config.headless,
    acceptDownloads: true,
    channel: config.browserChannel,
  };

  fs.mkdirSync(profileDir, { recursive: true });

  let context;
  try {
    console.log(`${workerLabel} launch profile: ${profileDir}`);
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(config.pageTimeoutMs);
    page.setDefaultNavigationTimeout(config.pageTimeoutMs);

    while (true) {
      const task = queue.next();
      if (!task) break;

      console.log(`${workerLabel} start task #${task.index}`);
      let lastError = null;
      for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        try {
          if (attempt > 0) {
            console.log(`${workerLabel} retry task #${task.index}, attempt ${attempt}/${config.maxRetries}`);
          }
          await runTask(page, task, config, workerLabel, profileDir);
          results.push({ index: task.index, ok: true });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          console.error(`${workerLabel} task #${task.index} attempt ${attempt + 1} failed: ${err.message}`);
          await page.waitForTimeout(15000);
        }
      }

      if (lastError) {
        results.push({ index: task.index, ok: false, error: lastError.message });
      }
    }
  } finally {
    if (context) await context.close();
  }
}

function printConfig(config, taskCount) {
  console.log('');
  console.log('Doubao Video Batch Runner');
  console.log('=========================');
  console.log(`Input JSON:      ${config.inputJsonPath}`);
  console.log(`Tasks:           ${taskCount}`);
  console.log(`Profiles:        ${config.profileDirs.length}`);
  console.log(`Target URL:      ${config.targetUrl}`);
  console.log(`Output dir:      ${config.outputDir}`);
  console.log(`Results log:     ${config.resultsPath}`);
  console.log(`Profile URL log: ${config.profileUrlsPath}`);
  console.log(`Headless:        ${config.headless}`);
  console.log(`Browser channel: ${config.browserChannel}`);
  console.log(`Page timeout:    ${config.pageTimeoutMs}ms`);
  console.log(`Max wait:        ${config.maxWaitMs}ms`);
  console.log(`Retries:         ${config.maxRetries}`);
  console.log('');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const config = getEnvConfig();
  const tasks = loadTasks(config.inputJsonPath);

  if (process.argv.includes('--dry-run')) {
    printConfig(config, tasks.length);
    console.log('Dry run only. Browser was not launched.');
    return;
  }

  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.writeFileSync(config.resultsPath, '', 'utf8');
  fs.writeFileSync(config.profileUrlsPath, '', 'utf8');
  printConfig(config, tasks.length);

  const queue = createTaskQueue(tasks);
  const results = [];
  await Promise.all(config.profileDirs.map((profileDir, i) => createWorker(profileDir, i + 1, queue, config, results)));

  const successCount = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok).sort((a, b) => a.index - b.index);

  console.log('');
  console.log('Run Summary');
  console.log('===========');
  console.log(`Success: ${successCount}/${tasks.length}`);
  if (failed.length > 0) {
    console.log('Failed tasks:');
    failed.forEach((item) => console.log(`  - #${item.index}: ${item.error}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
