#!/usr/bin/env node

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_TARGET_URL = 'https://alice.wind.com.cn/chat';
const DEFAULT_PAGE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STABLE_MS = 3000;

function printHelp() {
  console.log(
    [
      'Alice Chat Task Runner',
      '',
      'Usage:',
      '  npm run alice:chat',
      '  npm run alice:chat -- --dry-run',
      '  ALICE_INPUT_JSON=./other-task/alice-task/input.example.json npm run alice:chat',
      '  ALICE_PROFILE_IDS=1,2 npm run alice:chat',
      '',
      'Input item:',
      '  { "skillNumber": 1, "prompt": "..." }',
      '  { "skillNumber": 0, "prompt": "..." }  # skip skill selection',
      '',
      'Environment variables:',
      '  ALICE_INPUT_JSON          default ./other-task/alice-task/input.json',
      '  ALICE_PROFILE_IDS         default 1',
      '  ALICE_PROFILE_DIRS        overrides ALICE_PROFILE_IDS',
      '  ALICE_OUTPUT_DIR          default output/alice',
      '  ALICE_TARGET_URL          default https://alice.wind.com.cn/chat',
      '  ALICE_BROWSER_CHANNEL     default chrome',
      '  ALICE_HEADLESS            default false',
      '  ALICE_PAGE_TIMEOUT_MS     default 120000',
      '  ALICE_RESPONSE_TIMEOUT_MS default 600000',
      '  ALICE_STABLE_MS           default 3000',
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

function sanitizeFilePart(input, fallback = 'task') {
  const value = String(input || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return value || fallback;
}

function getEnvConfig() {
  const profileDirs = splitCsv(process.env.ALICE_PROFILE_DIRS).map((p) => path.resolve(PROJECT_ROOT, p));
  const profileIds = splitCsv(process.env.ALICE_PROFILE_IDS);
  const resolvedProfileDirs =
    profileDirs.length > 0
      ? profileDirs
      : (profileIds.length > 0 ? profileIds : ['1']).map((id) =>
          path.join(PROJECT_ROOT, 'browser-profiles', `browser-${id}`)
        );
  const outputDir = path.resolve(PROJECT_ROOT, process.env.ALICE_OUTPUT_DIR || path.join('output', 'alice'));

  return {
    inputJsonPath: path.resolve(
      PROJECT_ROOT,
      process.env.ALICE_INPUT_JSON || './other-task/alice-task/input.json'
    ),
    profileDirs: resolvedProfileDirs,
    outputDir,
    resultsPath: path.join(outputDir, 'results.jsonl'),
    targetUrl: process.env.ALICE_TARGET_URL || DEFAULT_TARGET_URL,
    browserChannel: process.env.ALICE_BROWSER_CHANNEL || 'chrome',
    headless: parseBoolean(process.env.ALICE_HEADLESS, false),
    pageTimeoutMs: Number(process.env.ALICE_PAGE_TIMEOUT_MS || DEFAULT_PAGE_TIMEOUT_MS),
    responseTimeoutMs: Number(process.env.ALICE_RESPONSE_TIMEOUT_MS || DEFAULT_RESPONSE_TIMEOUT_MS),
    stableMs: Number(process.env.ALICE_STABLE_MS || DEFAULT_STABLE_MS),
  };
}

function normalizeTaskItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Task #${index} must be an object`);
  }

  const prompt = String(item.prompt || '').trim();
  if (!prompt) throw new Error(`Task #${index} missing non-empty prompt`);

  const skillNumber = Number(item.skillNumber ?? item.skill ?? item.skillIndex ?? 1);
  if (!Number.isInteger(skillNumber) || skillNumber < 0) {
    throw new Error(`Task #${index} has invalid skillNumber: ${item.skillNumber}`);
  }

  return { index, prompt, skillNumber };
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

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const tasks = items.map((item, i) => normalizeTaskItem(item, i + 1));
  if (tasks.length === 0) throw new Error('Input JSON has no tasks');
  return tasks;
}

function appendJsonl(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function visibleBox(element) {
  const box = await element.boundingBox().catch(() => null);
  return box && box.width > 0 && box.height > 0 ? box : null;
}

async function openAlice(page, config) {
  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
  await page.waitForTimeout(4000);

  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  if (/登录|手机号|验证码|扫码登录|请先登录/.test(bodyText) && !/发送|技能|助手|新建/.test(bodyText)) {
    throw new Error('Alice profile may not be logged in. Run `npm run browser -- 1` and login first.');
  }
}

async function clickIfVisibleByText(page, keywords) {
  const elements = await page.$$('button,[role="button"],a');
  for (const element of elements) {
    const text = ((await element.textContent()) || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!keywords.some((keyword) => text.includes(keyword))) continue;
    if (!(await visibleBox(element))) continue;
    await element.click().catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

async function openSkillListIfNeeded(page) {
  await clickIfVisibleByText(page, ['使用技能', 'Use Skills']);
}

async function selectSkillByNumber(page, skillNumber) {
  if (skillNumber === 0) {
    console.log('[alice] skip skill selection');
    return;
  }

  await openSkillListIfNeeded(page);
  await page.waitForTimeout(1000);

  const exactNumberPattern = new RegExp(`^\\s*${skillNumber}\\s*[\\.、\\)）:]`);
  const numberedClicked = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource);
    const nodes = Array.from(
      document.querySelectorAll('[role="menu"] button,[role="menu"] [role="menuitem"],[role="menu"] li,[role="listitem"]')
    );
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const target = nodes.find((el) => visible(el) && pattern.test((el.textContent || '').trim()));
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, exactNumberPattern.source);

  if (numberedClicked) {
    await page.waitForTimeout(1200);
    return;
  }

  const fallbackClicked = await page.evaluate((targetIndex) => {
    const selectors = [
      '[role="menu"] button',
      '[role="menu"] [role="menuitem"]',
      '[role="menu"] li',
      '[role="menu"] [role="listitem"]',
    ];
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const text = (el.textContent || '').trim();
      if (!text || /搜索技能|Search|清空|Clear/.test(text)) return false;
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (visible(el) && !candidates.includes(el)) candidates.push(el);
      }
      if (candidates.length >= targetIndex) break;
    }
    const target = candidates[targetIndex - 1];
    if (!target) return { ok: false, count: candidates.length };
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { ok: true, count: candidates.length, text: (target.textContent || '').trim().slice(0, 120) };
  }, skillNumber);

  if (!fallbackClicked.ok) {
    throw new Error(`未找到技能编号 ${skillNumber}，当前技能菜单候选项数量: ${fallbackClicked.count}`);
  }

  console.log(`[alice] selected skill fallback #${skillNumber}: ${fallbackClicked.text || ''}`);
  await page.waitForTimeout(1200);
}

async function getPromptInput(page, timeoutMs) {
  const selectors = [
    'textarea[placeholder*="请输入"]',
    'textarea[placeholder*="输入"]',
    'textarea[placeholder*="发消息"]',
    'textarea',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (!element) continue;
      if (await visibleBox(element)) return element;
    }
    await page.waitForTimeout(500);
  }

  throw new Error('未找到 Alice 输入框');
}

async function fillPrompt(page, inputElement, prompt) {
  await inputElement.click({ force: true });
  await page.waitForTimeout(150);

  const tagName = await inputElement.evaluate((el) => (el.tagName || '').toLowerCase());
  const isContentEditable = await inputElement.evaluate((el) => el.isContentEditable === true);

  if (tagName === 'textarea' || tagName === 'input') {
    await inputElement.fill('');
    await inputElement.fill(prompt);
    return;
  }

  if (isContentEditable) {
    await inputElement.evaluate((el, text) => {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, text);
    }, prompt);
    await page.waitForTimeout(200);

    const typedText = await inputElement.evaluate((el) => (el.textContent || '').trim());
    if (typedText.length > 0) return;

    await inputElement.evaluate((el, text) => {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);
    return;
  }

  throw new Error('Alice 输入框不是可编辑元素');
}

async function submitPrompt(page, inputElement) {
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
    const blocked = /停止|暂停|上传|Upload|附件|技能|Skill|历史|新建|清空|Agent|快速问答|Quick|深度研究|Research/;
    const editor = document.querySelector(
      'textarea[placeholder*="请输入"],textarea[placeholder*="输入"],textarea[placeholder*="发消息"],textarea,[role="textbox"][contenteditable="true"],[contenteditable="true"]'
    );
    const editorRect = editor?.getBoundingClientRect();
    const candidates = buttons.filter((button) => {
      const text = (button.textContent || '').trim();
      const aria = button.getAttribute('aria-label') || '';
      const title = button.getAttribute('title') || '';
      const combined = `${text} ${aria} ${title}`;
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (button.disabled || button.getAttribute('aria-disabled') === 'true' || blocked.test(combined)) return false;
      if (/发送|Send|提交|运行|开始|生成/.test(combined)) return true;
      if (!button.querySelector('svg') || rect.width > 80 || rect.height > 80) return false;
      if (!editorRect) return true;
      return rect.left >= editorRect.left && rect.left <= editorRect.right + 20 && Math.abs(rect.top - editorRect.bottom) < 120;
    });
    const target = candidates[candidates.length - 1];
    if (!target) return false;
    target.click();
    return true;
  });

  if (clicked) return;
  await inputElement.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => {});
  await page.waitForTimeout(500);
  await inputElement.press('Enter');
}

async function getAnswerCandidates(page, prompt) {
  return page.evaluate((submittedPrompt) => {
    const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const directNodes = Array.from(
      document.querySelectorAll(
        '[class*="message"],[class*="Message"],[class*="chat"],[class*="Chat"],[class*="answer"],[class*="Answer"],[class*="markdown"],[class*="Markdown"],[data-testid*="message"],[role="article"]'
      )
    )
      .map((el) => normalize(el.textContent))
      .filter(Boolean)
      .filter((text) => text !== submittedPrompt && !text.includes(submittedPrompt));
    const logNodes = Array.from(document.querySelectorAll('[role="log"]'))
      .map((el) => normalize(el.textContent))
      .map((text) => {
        if (!text.includes(submittedPrompt)) return text;
        const afterPrompt = text.split(submittedPrompt).pop() || '';
        return normalize(afterPrompt.replace(/^Alice\s*/i, ''));
      })
      .filter(Boolean)
      .filter((text) => text !== submittedPrompt && !text.includes(submittedPrompt));
    return [...new Set([...directNodes, ...logNodes])];
  }, prompt);
}

async function waitForAnswer(page, prompt, config, baselineCandidates = []) {
  const startedAt = Date.now();
  let lastText = '';
  let lastChangedAt = Date.now();
  const baseline = new Set(baselineCandidates);

  while (Date.now() - startedAt < config.responseTimeoutMs) {
    const state = await page.evaluate((submittedPrompt) => {
      const bodyText = document.body?.innerText || '';
      const directNodes = Array.from(
        document.querySelectorAll(
          '[class*="message"],[class*="Message"],[class*="chat"],[class*="Chat"],[class*="answer"],[class*="Answer"],[class*="markdown"],[class*="Markdown"],[data-testid*="message"],[role="article"]'
        )
      )
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((text) => text !== submittedPrompt && !text.includes(submittedPrompt));
      const logNodes = Array.from(document.querySelectorAll('[role="log"]'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .map((text) => {
          if (!text.includes(submittedPrompt)) return text;
          const afterPrompt = text.split(submittedPrompt).pop() || '';
          return afterPrompt.replace(/^Alice\s*/i, '').replace(/\s+/g, ' ').trim();
        })
        .filter(Boolean)
        .filter((text) => text !== submittedPrompt && !text.includes(submittedPrompt));
      const nodes = [...directNodes, ...logNodes];

      const answerText = nodes.length > 0 ? nodes[nodes.length - 1] : '';
      const generating = /思考中|生成中|回复中|正在|停止生成|Stop generating|loading/i.test(bodyText);
      return { answerText, generating };
    }, prompt);

    if (!state.answerText || baseline.has(state.answerText)) {
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.answerText !== lastText) {
      lastText = state.answerText;
      lastChangedAt = Date.now();
    }

    if (lastText && !state.generating && Date.now() - lastChangedAt >= config.stableMs) {
      return lastText;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`等待 Alice 回答超时：${Math.round(config.responseTimeoutMs / 1000)}s`);
}

function writeMarkdownResult(task, answer, pageUrl, config, profileDir) {
  const fileName = `task-${String(task.index).padStart(3, '0')}-${sanitizeFilePart(task.prompt, 'alice')}.md`;
  const outputPath = path.join(config.outputDir, fileName);
  const content = [
    '# Alice Chat Result',
    '',
    `- task_index: ${task.index}`,
    `- skill_number: ${task.skillNumber}`,
    `- chat_url: ${pageUrl || 'N/A'}`,
    `- profile_dir: ${profileDir || 'N/A'}`,
    `- generated_at: ${new Date().toISOString()}`,
    '',
    '## Prompt',
    '',
    task.prompt,
    '',
    '## Answer',
    '',
    answer || '',
    '',
  ].join('\n');
  fs.writeFileSync(outputPath, content, 'utf8');
  return outputPath;
}

async function runTask(page, task, config, profileDir) {
  await openAlice(page, config);
  await selectSkillByNumber(page, task.skillNumber);
  const inputElement = await getPromptInput(page, config.pageTimeoutMs);
  const baselineCandidates = await getAnswerCandidates(page, task.prompt);
  await fillPrompt(page, inputElement, task.prompt);
  await submitPrompt(page, inputElement);
  const answer = await waitForAnswer(page, task.prompt, config, baselineCandidates);
  const resultPath = writeMarkdownResult(task, answer, page.url(), config, profileDir);
  appendJsonl(config.resultsPath, {
    taskIndex: task.index,
    skillNumber: task.skillNumber,
    prompt: task.prompt,
    answer,
    chatUrl: page.url(),
    profileDir,
    resultPath,
    capturedAt: new Date().toISOString(),
  });
  return resultPath;
}

function printConfig(config, taskCount) {
  console.log('');
  console.log('Alice Chat Task Runner');
  console.log('======================');
  console.log(`Input JSON:      ${config.inputJsonPath}`);
  console.log(`Tasks:           ${taskCount}`);
  console.log(`Profiles:        ${config.profileDirs.length}`);
  console.log(`Profile dirs:    ${config.profileDirs.join(', ')}`);
  console.log(`Target URL:      ${config.targetUrl}`);
  console.log(`Output dir:      ${config.outputDir}`);
  console.log(`Results log:     ${config.resultsPath}`);
  console.log(`Headless:        ${config.headless}`);
  console.log(`Browser channel: ${config.browserChannel}`);
  console.log(`Page timeout:    ${config.pageTimeoutMs}ms`);
  console.log(`Response timeout:${config.responseTimeoutMs}ms`);
  console.log('');
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
  const workerLabel = `[alice-worker-${workerId}]`;
  fs.mkdirSync(profileDir, { recursive: true });

  let context;
  try {
    console.log(`${workerLabel} launch profile: ${profileDir}`);
    context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      channel: config.browserChannel,
    });

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(config.pageTimeoutMs);
    page.setDefaultNavigationTimeout(config.pageTimeoutMs);

    while (true) {
      const task = queue.next();
      if (!task) break;

      console.log(`${workerLabel} start task #${task.index}, skill #${task.skillNumber}`);
      try {
        const resultPath = await runTask(page, task, config, profileDir);
        console.log(`${workerLabel} task #${task.index} saved -> ${resultPath}`);
        results.push({ index: task.index, ok: true });
      } catch (err) {
        console.error(`${workerLabel} task #${task.index} failed: ${err.message}`);
        results.push({ index: task.index, ok: false, error: err.message });
      }
    }
  } finally {
    if (context) await context.close();
  }
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
    failed.forEach((item) => console.log(`  - #${item.index}: ${item.error}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
