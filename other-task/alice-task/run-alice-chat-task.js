#!/usr/bin/env node

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');
const { loadProxyConfig } = require('../../proxy-utils');
require('dotenv').config();

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_TARGET_URL = 'https://alice.wind.com.cn/chat';
const DEFAULT_PAGE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STABLE_MS = 3000;
let clipboardLock = Promise.resolve();

const BUILTIN_VARIABLE_SOURCES = {
  'builtin:a_share_stock_names': [
    '贵州茅台',
    '宁德时代',
    '比亚迪',
    '招商银行',
    '中国平安',
    '五粮液',
    '美的集团',
    '长江电力',
    '紫金矿业',
    '中际旭创',
    '工业富联',
    '海康威视',
  ],
  'builtin:futures_product_names': [
    '沪铜',
    '螺纹钢',
    '铁矿石',
    '焦煤',
    '焦炭',
    '原油',
    '黄金',
    '白银',
    '豆粕',
    '棕榈油',
    'PTA',
    '玻璃',
  ],
};

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
      'Batch input:',
      '  {',
      '    "assignment": { "profileSource": "env", "strategy": "perBrowserSequential", "tasksPerBrowser": 2 },',
      '    "variables": { "stock": { "type": "randomChoice", "source": "builtin:a_share_stock_names" } },',
      '    "taskTemplates": [{ "skillNumber": 2, "prompt": "请分析A股股票：{{stock}}" }]',
      '  }',
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
      '  ALICE_TASK_TIMEOUT_MS     default 600000',
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

function getProfileConfigs() {
  const profileDirs = splitCsv(process.env.ALICE_PROFILE_DIRS).map((p, i) => ({
    id: `dir-${i + 1}`,
    dir: path.resolve(PROJECT_ROOT, p),
  }));
  const profileIds = splitCsv(process.env.ALICE_PROFILE_IDS);
  if (profileDirs.length > 0) return profileDirs;

  return (profileIds.length > 0 ? profileIds : ['1']).map((id) => ({
    id,
    dir: path.join(PROJECT_ROOT, 'browser-profiles', `browser-${id}`),
  }));
}

function getEnvConfig() {
  const requestedProfiles = getProfileConfigs();
  const profiles = requestedProfiles.filter((profile) => {
    try {
      return fs.statSync(profile.dir).isDirectory();
    } catch (_) {
      return false;
    }
  });
  const skippedProfiles = requestedProfiles.filter(
    (requested) => !profiles.some((profile) => profile.dir === requested.dir)
  );
  if (profiles.length === 0) {
    throw new Error(
      `No usable Alice browser profiles. Requested: ${requestedProfiles.map((profile) => profile.dir).join(', ')}`
    );
  }
  const baseOutputDir = path.resolve(PROJECT_ROOT, process.env.ALICE_OUTPUT_DIR || path.join('output', 'alice'));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputDir = path.join(baseOutputDir, timestamp);

  return {
    inputJsonPath: path.resolve(
      PROJECT_ROOT,
      process.env.ALICE_INPUT_JSON || './other-task/alice-task/input.json'
    ),
    profiles,
    skippedProfiles,
    outputDir,
    resultsPath: path.join(outputDir, 'results.jsonl'),
    targetUrl: process.env.ALICE_TARGET_URL || DEFAULT_TARGET_URL,
    browserChannel: process.env.ALICE_BROWSER_CHANNEL || 'chrome',
    headless: parseBoolean(process.env.ALICE_HEADLESS, false),
    pageTimeoutMs: Number(process.env.ALICE_PAGE_TIMEOUT_MS || DEFAULT_PAGE_TIMEOUT_MS),
    responseTimeoutMs: Number(process.env.ALICE_RESPONSE_TIMEOUT_MS || DEFAULT_RESPONSE_TIMEOUT_MS),
    taskTimeoutMs: Number(process.env.ALICE_TASK_TIMEOUT_MS || process.env.ALICE_RESPONSE_TIMEOUT_MS || DEFAULT_TASK_TIMEOUT_MS),
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

  return {
    index,
    prompt,
    skillNumber,
    name: item.name || `task-${index}`,
    profileId: item.profileId || null,
    profileDir: item.profileDir || null,
  };
}

function pickRandomChoice(source, usedValues) {
  const values = BUILTIN_VARIABLE_SOURCES[source];
  if (!values || values.length === 0) {
    throw new Error(`Unknown or empty randomChoice source: ${source}`);
  }

  const used = usedValues.get(source) || new Set();
  const candidates = values.filter((value) => !used.has(value));
  const pool = candidates.length > 0 ? candidates : values;
  const value = pool[Math.floor(Math.random() * pool.length)];
  used.add(value);
  usedValues.set(source, used);
  return value;
}

function resolveVariables(variableSpecs, usedValues) {
  const values = {};
  for (const [name, spec] of Object.entries(variableSpecs || {})) {
    if (!spec || typeof spec !== 'object') throw new Error(`Variable "${name}" must be an object`);
    if (spec.type !== 'randomChoice') throw new Error(`Variable "${name}" has unsupported type: ${spec.type}`);
    values[name] = pickRandomChoice(spec.source, spec.uniquePerRun === false ? new Map() : usedValues);
  }
  return values;
}

function getPromptVariableNames(template) {
  const names = new Set();
  String(template || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => {
    names.add(name);
    return match;
  });
  return names;
}

function resolvePromptVariables(template, variableSpecs, usedValues) {
  const names = getPromptVariableNames(template);
  const scopedSpecs = {};
  for (const name of names) {
    if (!(name in (variableSpecs || {}))) throw new Error(`Prompt references unknown variable: ${name}`);
    scopedSpecs[name] = variableSpecs[name];
  }
  return resolveVariables(scopedSpecs, usedValues);
}

function renderPrompt(template, variables) {
  return String(template || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name) => {
    if (!(name in variables)) throw new Error(`Prompt references unknown variable: ${name}`);
    return variables[name];
  });
}

function expandBatchPlan(parsed, profiles) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Array.isArray(parsed.taskTemplates)) return null;

  const assignment = parsed.assignment || {};
  const strategy = assignment.strategy || 'perBrowserSequential';
  if (assignment.profileSource && assignment.profileSource !== 'env') {
    throw new Error(`Unsupported assignment.profileSource: ${assignment.profileSource}`);
  }
  if (strategy !== 'perBrowserSequential') {
    throw new Error(`Unsupported assignment.strategy: ${strategy}`);
  }

  const taskTemplates = parsed.taskTemplates;
  if (taskTemplates.length === 0) throw new Error('Batch input has no taskTemplates');

  const tasksPerBrowser = Number(assignment.tasksPerBrowser || taskTemplates.length);
  if (!Number.isInteger(tasksPerBrowser) || tasksPerBrowser <= 0) {
    throw new Error(`Invalid assignment.tasksPerBrowser: ${assignment.tasksPerBrowser}`);
  }

  const usedValues = new Map();
  let taskIndex = 1;
  return profiles.map((profile) => {
    const tasks = [];
    for (let i = 0; i < tasksPerBrowser; i += 1) {
      const template = taskTemplates[i % taskTemplates.length];
      const variables = resolvePromptVariables(template.prompt, parsed.variables || {}, usedValues);
      const task = normalizeTaskItem(
        {
          ...template,
          prompt: renderPrompt(template.prompt, variables),
          profileId: profile.id,
          profileDir: profile.dir,
          name: template.name || `task-${i + 1}`,
        },
        taskIndex
      );
      task.variables = variables;
      tasks.push(task);
      taskIndex += 1;
    }
    return { profile, tasks };
  });
}

function assignFlatTasks(tasks, profiles) {
  return profiles.map((profile) => ({ profile, tasks: [] })).map((item, index, groups) => {
    for (let i = index; i < tasks.length; i += groups.length) {
      groups[index].tasks.push({ ...tasks[i], profileId: item.profile.id, profileDir: item.profile.dir });
    }
    return item;
  });
}

function loadTaskPlan(inputJsonPath, profiles) {
  if (!fs.existsSync(inputJsonPath)) {
    throw new Error(`Input JSON not found: ${inputJsonPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse input JSON: ${err.message}`);
  }

  const batchPlan = expandBatchPlan(parsed, profiles);
  if (batchPlan) {
    const taskCount = batchPlan.reduce((sum, group) => sum + group.tasks.length, 0);
    if (taskCount === 0) throw new Error('Input JSON has no tasks');
    return batchPlan;
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const tasks = items.map((item, i) => normalizeTaskItem(item, i + 1));
  if (tasks.length === 0) throw new Error('Input JSON has no tasks');
  return assignFlatTasks(tasks, profiles);
}

function appendJsonl(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function withClipboardLock(fn) {
  const previous = clipboardLock;
  let release;
  clipboardLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function visibleBox(element) {
  const box = await element.boundingBox().catch(() => null);
  return box && box.width > 0 && box.height > 0 ? box : null;
}

async function openAlice(page, config) {
  await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
  await page.waitForTimeout(4000);

  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const onSigninPage = /\/signin\b/.test(page.url());
  const loginText = /登录|手机号|验证码|扫码登录|请先登录|Sign in|Phone Number|SMS Code|Send Code|Login/i.test(bodyText);
  const appText = /发送|技能|助手|新建|Send|Use Skills|Quick Chat|Deep Research|New Chat/i.test(bodyText);
  if (onSigninPage || (loginText && !appText)) {
    throw new Error('Alice profile is not logged in. Run `npm run browser -- <profile-id>` and login to Alice first.');
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const openMenu = document.querySelector('[role="menu"][data-state="open"],[data-slot="dropdown-menu-content"][data-state="open"]');
      if (openMenu && visible(openMenu)) return { open: true, clicked: false };

      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
      const button = buttons.find((el) => visible(el) && /使用技能|Use Skills/i.test(el.textContent || el.getAttribute('aria-label') || ''));
      if (!button) return { open: false, clicked: false };

      const rect = button.getBoundingClientRect();
      const options = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      button.dispatchEvent(new PointerEvent('pointerdown', options));
      button.dispatchEvent(new MouseEvent('mousedown', options));
      button.dispatchEvent(new MouseEvent('mouseup', options));
      button.dispatchEvent(new MouseEvent('click', options));
      return { open: false, clicked: true };
    });

    if (state.open) return;
    if (!state.clicked) {
      await clickIfVisibleByText(page, ['使用技能', 'Use Skills']);
    }
    await page.waitForTimeout(800);

    const opened = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"][data-state="open"],[data-slot="dropdown-menu-content"][data-state="open"]');
      if (!menu) return false;
      const rect = menu.getBoundingClientRect();
      const style = window.getComputedStyle(menu);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (opened) return;
  }

  throw new Error('技能选择器未打开');
}

async function selectSkillByNumber(page, skillNumber) {
  if (skillNumber === 0) {
    console.log('[alice] skip skill selection');
    return;
  }

  await openSkillListIfNeeded(page);
  await page.waitForTimeout(1000);

  const communityClicked = await page.evaluate((targetIndex) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const clickNode = (node) => {
      const rect = node.getBoundingClientRect();
      const options = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      node.dispatchEvent(new PointerEvent('pointerdown', options));
      node.dispatchEvent(new MouseEvent('mousemove', options));
      node.dispatchEvent(new MouseEvent('mousedown', options));
      node.dispatchEvent(new MouseEvent('mouseup', options));
      node.dispatchEvent(new MouseEvent('click', options));
    };

    const menu = document.querySelector('[role="menu"][data-state="open"],[data-slot="dropdown-menu-content"][data-state="open"]');
    if (!menu || !visible(menu)) return { ok: false, count: 0, error: '技能选择器未打开' };

    const scroller = Array.from(menu.querySelectorAll('*')).find((el) => el.scrollHeight > el.clientHeight + 20) || menu;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);

    const findCommunityItems = () => {
      const headers = Array.from(menu.querySelectorAll('p,div,span')).filter((el) =>
        visible(el) && /^(社区技能|Community Skills)$/i.test(normalize(el.textContent))
      );
      const header = headers[0];
      if (!header) return [];
      const section = header.parentElement;
      if (!section) return [];
      return Array.from(section.querySelectorAll('div.cursor-pointer,[role="menuitem"],button'))
        .filter((el) => visible(el))
        .filter((el) => {
          const text = normalize(el.textContent);
          if (!text || text === '社区技能') return false;
          if (/添加更多技能|Add more/i.test(text)) return false;
          return !Array.from(el.children).some((child) => normalize(child.textContent) === text);
        });
    };

    for (let top = 0; top <= maxScrollTop + 1; top += Math.max(80, scroller.clientHeight / 2)) {
      scroller.scrollTop = top;
      const items = findCommunityItems();
      if (items.length >= targetIndex) {
        const target = items[targetIndex - 1];
        const text = normalize(target.textContent).slice(0, 160);
        clickNode(target);
        return { ok: true, count: items.length, text };
      }
    }

    scroller.scrollTop = maxScrollTop;
    const items = findCommunityItems();
    return {
      ok: false,
      count: items.length,
      error: `社区技能数量不足，目标编号 ${targetIndex}，当前可见数量 ${items.length}`,
    };
  }, skillNumber);

  if (!communityClicked.ok) {
    throw new Error(communityClicked.error || `未找到社区技能编号 ${skillNumber}`);
  }

  console.log(`[alice] selected community skill #${skillNumber}: ${communityClicked.text || ''}`);
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

async function readClipboardText(page) {
  return page
    .evaluate(async () => {
      if (!navigator.clipboard || !navigator.clipboard.readText) return '';
      return navigator.clipboard.readText();
    })
    .catch(() => '');
}

async function waitForCompletedAnswerAndCopy(page, prompt, config, baselineCandidates = []) {
  const startedAt = Date.now();
  let lastText = '';
  let lastChangedAt = Date.now();
  const baseline = new Set(baselineCandidates);
  const timeoutMs = config.taskTimeoutMs || config.responseTimeoutMs;

  while (Date.now() - startedAt < timeoutMs) {
    const state = await page.evaluate((submittedPrompt) => {
      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (el) => normalize(el.textContent);
      const isCopyButton = (button) => {
        const svgClass = Array.from(button.querySelectorAll('svg'))
          .map((svg) => svg.getAttribute('class') || '')
          .join(' ');
        const label = normalize(
          `${button.textContent || ''} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${
            button.getAttribute('data-testid') || ''
          } ${button.className || ''} ${svgClass}`
        );
        const nearbyText = normalize(button.parentElement?.textContent || '');
        if (nearbyText.includes(submitted) || /^Using\s+["“].*skill\s*:/i.test(nearbyText)) return false;
        return /复制|Copy|copy/i.test(label) && visible(button) && !button.disabled;
      };
      const bodyText = document.body?.innerText || '';
      const submitted = normalize(submittedPrompt);
      const candidateElements = Array.from(
        document.querySelectorAll(
          '[class*="message"],[class*="Message"],[class*="chat"],[class*="Chat"],[class*="answer"],[class*="Answer"],[class*="markdown"],[class*="Markdown"],[data-testid*="message"],[role="article"],[role="log"]'
        )
      )
        .filter(visible)
        .map((el) => {
          let text = textOf(el);
          if (text.includes(submitted)) {
            text = normalize(text.split(submitted).pop() || '');
            text = normalize(text.replace(/^Alice\s*/i, ''));
          }
          return { el, text };
        })
        .filter(Boolean)
        .filter((item) => item.text && item.text !== submitted && !item.text.includes(submitted));

      const candidate = candidateElements[candidateElements.length - 1];
      const answerText = candidate ? candidate.text : '';
      const generating = /思考中|生成中|回复中|正在|停止生成|Stop generating|loading/i.test(bodyText);
      let hasCopyButton = false;

      if (candidate) {
        const root =
          candidate.el.closest('[role="article"],[class*="message"],[class*="Message"],[class*="answer"],[class*="Answer"]') ||
          candidate.el;
        const rootButtons = Array.from(root.querySelectorAll('button,[role="button"]'));
        hasCopyButton = rootButtons.some(isCopyButton);

        if (!hasCopyButton) {
          const answerRect = candidate.el.getBoundingClientRect();
          const nearbyButtons = Array.from(document.querySelectorAll('button,[role="button"]')).filter((button) => {
            if (!isCopyButton(button)) return false;
            const rect = button.getBoundingClientRect();
            return rect.top >= answerRect.top - 20 && rect.top <= answerRect.bottom + 220;
          });
          hasCopyButton = nearbyButtons.length > 0;
        }
      }

      return { answerText, generating, hasCopyButton };
    }, prompt);

    if (!state.answerText || baseline.has(state.answerText)) {
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.answerText !== lastText) {
      lastText = state.answerText;
      lastChangedAt = Date.now();
    }

    if (lastText && !state.generating && state.hasCopyButton && Date.now() - lastChangedAt >= config.stableMs) {
      const copied = await withClipboardLock(async () => {
        const copyResult = await page.evaluate((submittedPrompt) => {
          const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const submitted = normalize(submittedPrompt);
          const isCopyButton = (button) => {
            const svgClass = Array.from(button.querySelectorAll('svg'))
              .map((svg) => svg.getAttribute('class') || '')
              .join(' ');
            const label = normalize(
              `${button.textContent || ''} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${
                button.getAttribute('data-testid') || ''
              } ${button.className || ''} ${svgClass}`
            );
            const nearbyText = normalize(button.parentElement?.textContent || '');
            if (nearbyText.includes(submitted) || /^Using\s+["“].*skill\s*:/i.test(nearbyText)) return false;
            return /复制|Copy|copy/i.test(label) && visible(button) && !button.disabled;
          };
          const candidateElements = Array.from(
            document.querySelectorAll(
              '[class*="message"],[class*="Message"],[class*="chat"],[class*="Chat"],[class*="answer"],[class*="Answer"],[class*="markdown"],[class*="Markdown"],[data-testid*="message"],[role="article"],[role="log"]'
            )
          )
            .filter(visible)
            .map((el) => {
              let text = normalize(el.textContent);
              if (text.includes(submitted)) {
                text = normalize(text.split(submitted).pop() || '');
                text = normalize(text.replace(/^Alice\s*/i, ''));
              }
              return { el, text };
            })
            .filter((item) => item.text && item.text !== submitted && !item.text.includes(submitted));
          const candidate = candidateElements[candidateElements.length - 1];
          if (!candidate) return { ok: false, error: 'answer candidate disappeared' };

          const root =
            candidate.el.closest('[role="article"],[class*="message"],[class*="Message"],[class*="answer"],[class*="Answer"]') ||
            candidate.el;
          let buttons = Array.from(root.querySelectorAll('button,[role="button"]')).filter(isCopyButton);
          if (buttons.length === 0) {
            const answerRect = candidate.el.getBoundingClientRect();
            buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter((button) => {
              if (!isCopyButton(button)) return false;
              const rect = button.getBoundingClientRect();
              return rect.top >= answerRect.top - 20 && rect.top <= answerRect.bottom + 220;
            });
          }
          const button = buttons[buttons.length - 1];
          if (!button) return { ok: false, error: 'copy button not found' };
          button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
          button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true, answerText: candidate.text };
        }, prompt);

        if (!copyResult.ok) return { ok: false, error: copyResult.error };
        await page.waitForTimeout(500);
        const clipboardText = (await readClipboardText(page)).trim();
        if (!clipboardText) return { ok: false, error: '剪贴板内容为空或无法读取' };
        const promptSubmissionPattern = /^Using\s+["“].*skill\s*:/i;
        const copiedUserPrompt =
          clipboardText === prompt ||
          (promptSubmissionPattern.test(clipboardText) && clipboardText.includes(prompt) && clipboardText.length < prompt.length + 100);
        if (copiedUserPrompt) {
          return { ok: false, error: '复制到了用户消息，继续等待回答复制按钮' };
        }
        return {
          ok: true,
          answer: clipboardText,
          visibleAnswer: copyResult.answerText,
          copiedFromClipboard: true,
        };
      });

      if (copied.ok) return copied;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`等待 Alice 回答或复制按钮超时：${Math.round(timeoutMs / 1000)}s`);
}

function writeMarkdownResult(task, answer, pageUrl, config, profile) {
  const fileName = `task-${String(task.index).padStart(3, '0')}-${sanitizeFilePart(task.prompt, 'alice')}.md`;
  const outputPath = path.join(config.outputDir, fileName);
  const content = [
    '# Alice Chat Result',
    '',
    `- task_index: ${task.index}`,
    `- skill_number: ${task.skillNumber}`,
    `- chat_url: ${pageUrl || 'N/A'}`,
    `- profile_id: ${profile?.id || task.profileId || 'N/A'}`,
    `- profile_dir: ${profile?.dir || task.profileDir || 'N/A'}`,
    `- copied_from_clipboard: true`,
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

async function runTask(page, task, config, profile) {
  await openAlice(page, config);
  await selectSkillByNumber(page, task.skillNumber);
  const inputElement = await getPromptInput(page, config.pageTimeoutMs);
  const baselineCandidates = await getAnswerCandidates(page, task.prompt);
  await fillPrompt(page, inputElement, task.prompt);
  await submitPrompt(page, inputElement);
  const copied = await waitForCompletedAnswerAndCopy(page, task.prompt, config, baselineCandidates);
  const resultPath = writeMarkdownResult(task, copied.answer, page.url(), config, profile);
  appendJsonl(config.resultsPath, {
    taskIndex: task.index,
    taskName: task.name,
    ok: true,
    skillNumber: task.skillNumber,
    prompt: task.prompt,
    answer: copied.answer,
    copiedFromClipboard: copied.copiedFromClipboard,
    chatUrl: page.url(),
    profileId: profile?.id || task.profileId,
    profileDir: profile?.dir || task.profileDir,
    resultPath,
    capturedAt: new Date().toISOString(),
  });
  return resultPath;
}

async function closePageSafely(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (_) {
    // ignore close errors
  }
}

function printConfig(config, taskCount) {
  console.log('');
  console.log('Alice Chat Task Runner');
  console.log('======================');
  console.log(`Input JSON:      ${config.inputJsonPath}`);
  console.log(`Tasks:           ${taskCount}`);
  console.log(`Profiles:        ${config.profiles.length}`);
  console.log(`Profile dirs:    ${config.profiles.map((profile) => profile.dir).join(', ')}`);
  if (config.skippedProfiles.length > 0) {
    console.log(`Skipped missing: ${config.skippedProfiles.map((profile) => profile.id).join(', ')}`);
  }
  console.log(`Target URL:      ${config.targetUrl}`);
  console.log(`Output dir:      ${config.outputDir}`);
  console.log(`Results log:     ${config.resultsPath}`);
  console.log(`Headless:        ${config.headless}`);
  console.log(`Browser channel: ${config.browserChannel}`);
  console.log(`Page timeout:    ${config.pageTimeoutMs}ms`);
  console.log(`Task timeout:    ${config.taskTimeoutMs}ms`);
  console.log(`Proxy tasks:     ${process.env.PROXY_TASKS || '(not set)'}`);
  console.log('');
}

async function createWorker(group, workerId, config, results, profileIndex) {
  const { profile, tasks } = group;
  const workerLabel = `[alice-worker-${workerId}]`;
  const profileDir = profile.dir;
  if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
    throw new Error(`Alice profile directory disappeared before launch: ${profileDir}`);
  }

  const proxy = loadProxyConfig('alice', profileIndex);

  // Stagger browser launch to avoid simultaneous starts
  const staggerDelayMs = (profileIndex + 1) * 10000;
  console.log(`${workerLabel} stagger delay: ${staggerDelayMs / 1000}s before launching browser`);
  await new Promise((resolve) => setTimeout(resolve, staggerDelayMs));

  let context;
  try {
    const launchOptions = {
      headless: config.headless,
      channel: config.browserChannel,
    };
    if (proxy) {
      launchOptions.proxy = proxy;
      console.log(`${workerLabel} launch profile: ${profileDir} (proxy: ${proxy.server})`);
    } else {
      console.log(`${workerLabel} launch profile: ${profileDir} (no proxy)`);
    }
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(config.targetUrl).origin,
    }).catch(() => {});

    for (const task of tasks) {
      // Each task gets a fresh tab: close previous page, open a new one
      let page;
      try {
        page = await context.newPage();
        page.setDefaultTimeout(config.pageTimeoutMs);
        page.setDefaultNavigationTimeout(config.pageTimeoutMs);
      } catch (err) {
        console.error(`${workerLabel} task #${task.index} failed to open new tab: ${err.message}`);
        appendJsonl(config.resultsPath, {
          taskIndex: task.index,
          taskName: task.name,
          skillNumber: task.skillNumber,
          prompt: task.prompt,
          ok: false,
          error: `Failed to open new tab: ${err.message}`,
          profileId: profile.id,
          profileDir: profile.dir,
          capturedAt: new Date().toISOString(),
        });
        results.push({ index: task.index, ok: false, error: err.message, profileId: profile.id });
        continue;
      }

      console.log(`${workerLabel} start task #${task.index}, skill #${task.skillNumber} (new tab)`);
      try {
        const resultPath = await runTask(page, task, config, profile);
        console.log(`${workerLabel} task #${task.index} saved -> ${resultPath}`);
        results.push({ index: task.index, ok: true, profileId: profile.id });
      } catch (err) {
        console.error(`${workerLabel} task #${task.index} failed: ${err.message}`);
        appendJsonl(config.resultsPath, {
          taskIndex: task.index,
          taskName: task.name,
          skillNumber: task.skillNumber,
          prompt: task.prompt,
          ok: false,
          error: err.message,
          profileId: profile.id,
          profileDir: profile.dir,
          capturedAt: new Date().toISOString(),
        });
        results.push({ index: task.index, ok: false, error: err.message, profileId: profile.id });
      } finally {
        await closePageSafely(page);
      }
    }
  } finally {
    if (context) {
      await Promise.race([
        context.close(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]).catch(() => {});
    }
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const config = getEnvConfig();
  const taskPlan = loadTaskPlan(config.inputJsonPath, config.profiles);
  const taskCount = taskPlan.reduce((sum, group) => sum + group.tasks.length, 0);

  if (process.argv.includes('--dry-run')) {
    printConfig(config, taskCount);
    for (const group of taskPlan) {
      console.log(`Profile ${group.profile.id}: ${group.tasks.length} task(s)`);
      for (const task of group.tasks) {
        console.log(`  - #${task.index} skill #${task.skillNumber}: ${task.prompt}`);
      }
    }
    console.log('Dry run only. Browser was not launched.');
    return;
  }

  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.writeFileSync(config.resultsPath, '', 'utf8');

  printConfig(config, taskCount);

  const results = [];
  await Promise.all(taskPlan.map((group, i) => createWorker(group, i + 1, config, results, i)));

  const successCount = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok).sort((a, b) => a.index - b.index);
  console.log('');
  console.log('Run Summary');
  console.log('===========');
  console.log(`Success: ${successCount}/${taskCount}`);
  if (failed.length > 0) {
    failed.forEach((item) => console.log(`  - #${item.index}: ${item.error}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
