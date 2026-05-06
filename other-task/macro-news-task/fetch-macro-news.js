#!/usr/bin/env node
/**
 * 宏观经济与行业数据采集 + LLM 解读
 *
 * 功能：
 *   1. 遍历所有配置的数据源 URL（政府网站、交易所、企业披露平台等）
 *   2. 使用 Patchright (Playwright fork) 访问页面，提取页面文本内容
 *   3. 调用 LLM API 对提取内容进行专业解读
 *   4. 汇总输出一份 Markdown 报告
 *
 * Usage:
 *   node fetch-macro-news.js                          # 采集全部数据源
 *   node fetch-macro-news.js --category macro         # 仅宏观数据
 *   node fetch-macro-news.js --category industry      # 仅行业数据
 *   node fetch-macro-news.js --source M2_M1_M0        # 指定数据源
 *   node fetch-macro-news.js --source CPI_PPI_PMI --source 利率_LPR
 *   node fetch-macro-news.js --output-dir ./reports   # 指定输出目录
 *   node fetch-macro-news.js --no-llm                 # 仅采集，不调用 LLM
 *   node fetch-macro-news.js --headless               # 无头模式
 *   node fetch-macro-news.js --concurrency 3          # 并发数
 *   node fetch-macro-news.js --help
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
// Also load the main project .env as fallback for VOLCENGINE_API_KEY/VOLCENGINE_MODEL.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../src/.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('patchright');
const { ALL_SOURCES, MACRO_SOURCES, INDUSTRY_SOURCES } = require('./data-sources');
const { createLLMClient } = require('./llm-client');

// ============================================================
// CLI
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    category: null,         // 'macro' | 'industry' | null (all)
    sourceNames: [],        // filter by name
    outputDir: null,
    headless: true,
    enableLLM: true,
    concurrency: 2,
    timeout: 30000,         // page load timeout
    cache: true,            // cache enabled by default
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }

    switch (arg) {
      case '--category':
        if (!next) throw new Error('--category requires macro or industry');
        config.category = next;
        i++;
        break;
      case '--source':
        if (!next) throw new Error('--source requires a name');
        config.sourceNames.push(next);
        i++;
        break;
      case '--output-dir':
        if (!next) throw new Error('--output-dir requires a path');
        config.outputDir = path.resolve(next);
        i++;
        break;
      case '--headless':
        config.headless = true;
        break;
      case '--no-headless':
        config.headless = false;
        break;
      case '--no-llm':
        config.enableLLM = false;
        break;
      case '--no-cache':
        config.cache = false;
        break;
      case '--concurrency':
        if (!next) throw new Error('--concurrency requires a number');
        config.concurrency = parseInt(next, 10);
        i++;
        break;
      case '--timeout':
        if (!next) throw new Error('--timeout requires milliseconds');
        config.timeout = parseInt(next, 10);
        i++;
        break;
      default:
        console.warn(`Unknown arg: ${arg}`);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
宏观经济与行业数据采集 + LLM 解读

Usage:
  node fetch-macro-news.js [options]

Options:
  --category <macro|industry>  仅采集指定类别
  --source <name>              指定数据源名称 (可多次使用)
  --output-dir <path>          输出目录 (默认: ./output)
  --headless / --no-headless   无头/有头模式 (默认: headless)
  --no-llm                     跳过 LLM 解读，仅采集页面内容
  --no-cache                   强制重新生成 (即使输出已存在)
  --concurrency <n>            并发浏览器数 (默认: 2)
  --timeout <ms>               页面加载超时 (默认: 30000)
  --help, -h                   显示帮助

数据源列表:`);
  for (const s of ALL_SOURCES) {
    console.log(`  [${s.category}] ${s.name} - ${s.description}`);
  }
}

// ============================================================
// Page Content Extraction
// ============================================================

/**
 * Extract meaningful text content from a page
 * Removes scripts, styles, navigation boilerplate
 */
async function extractPageContent(page) {
  return page.evaluate(() => {
    // Remove noise elements
    const removeSelectors = [
      'script', 'style', 'noscript', 'iframe',
      'nav', 'header', 'footer',
      '.nav', '.header', '.footer', '.sidebar', '.breadcrumb',
      '.advertisement', '.ad', '#cookie-banner',
    ];
    for (const sel of removeSelectors) {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    }

    // Extract tables as structured text
    const tables = [];
    document.querySelectorAll('table').forEach((table, idx) => {
      const rows = [];
      table.querySelectorAll('tr').forEach((tr) => {
        const cells = [];
        tr.querySelectorAll('th, td').forEach((cell) => {
          cells.push(cell.innerText.trim().replace(/\s+/g, ' '));
        });
        if (cells.length > 0) rows.push(cells.join(' | '));
      });
      if (rows.length > 0) {
        tables.push(`[表格 ${idx + 1}]\n${rows.join('\n')}`);
      }
    });

    // Extract main text
    const body = document.body;
    const mainContent = body.querySelector('main, .main, .content, .article, #content, #main')
      || body;

    // Get all text links (article titles with dates are valuable)
    const links = [];
    mainContent.querySelectorAll('a').forEach((a) => {
      const text = a.innerText.trim();
      // Find links that look like data releases (contain dates or keywords)
      if (text.length > 5 && text.length < 200) {
        const href = a.getAttribute('href') || '';
        links.push(`- ${text}${href ? ' (' + href + ')' : ''}`);
      }
    });

    // Get body text
    const textContent = mainContent.innerText
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 15000);

    let result = '';
    if (tables.length > 0) {
      result += '### 页面表格数据\n\n' + tables.join('\n\n') + '\n\n';
    }
    if (links.length > 0) {
      result += '### 页面链接列表\n\n' + links.slice(0, 50).join('\n') + '\n\n';
    }
    result += '### 页面正文\n\n' + textContent;
    return result;
  });
}

/**
 * Fetch a single URL and extract content
 */
async function fetchUrl(page, url, timeout) {
  console.log(`    正在访问: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // Wait a bit for dynamic content to render
    await page.waitForTimeout(3000);
    const title = await page.title();
    const content = await extractPageContent(page);
    console.log(`    ✓ 成功 (标题: ${title})`);
    return { url, title, content, error: null };
  } catch (err) {
    console.error(`    ✗ 失败: ${err.message}`);
    return { url, title: '', content: '', error: err.message };
  }
}

// ============================================================
// Report Generation
// ============================================================

function generateReportHeader() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long',
  });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  return `# 宏观经济与行业数据报告

> 生成时间：${dateStr} ${timeStr}
> 
> 本报告自动采集中国各主要政府部门和行业机构公开数据，并使用 AI 进行解读分析。
> 数据来源包括：中国人民银行、国家统计局、海关总署、财政部、外汇管理局、国家能源局、
> 上海期货交易所、中汽协、港交所、巨潮资讯网等。

---

`;
}

function generateTOC(results) {
  let toc = '## 目录\n\n';

  const macroResults = results.filter((r) => r.source.category === 'macro');
  const industryResults = results.filter((r) => r.source.category === 'industry');

  if (macroResults.length > 0) {
    toc += '### 一、宏观数据\n\n';
    macroResults.forEach((r, i) => {
      const anchor = r.source.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-').toLowerCase();
      toc += `${i + 1}. [${r.source.description}](#${anchor})\n`;
    });
    toc += '\n';
  }

  if (industryResults.length > 0) {
    toc += '### 二、行业数据\n\n';
    industryResults.forEach((r, i) => {
      const anchor = r.source.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-').toLowerCase();
      toc += `${i + 1}. [${r.source.description}](#${anchor})\n`;
    });
    toc += '\n';
  }

  return toc + '---\n\n';
}

function generateSourceSection(result) {
  const { source, urlResults, analysis } = result;

  let section = `## ${source.description}\n\n`;
  section += `> 数据源名称：${source.name} | 分类：${source.category === 'macro' ? '宏观数据' : '行业数据'}\n\n`;

  // Data source URLs
  section += '### 数据来源\n\n';
  for (const ur of urlResults) {
    if (ur.error) {
      section += `- ✗ [${ur.url}](${ur.url}) — 访问失败: ${ur.error}\n`;
    } else {
      section += `- ✓ [${ur.title || ur.url}](${ur.url})\n`;
    }
  }
  section += '\n';

  // Extracted content summary (collapsed)
  const hasContent = urlResults.some((ur) => ur.content);
  if (hasContent) {
    section += '<details>\n<summary>📄 原始提取内容（点击展开）</summary>\n\n';
    for (const ur of urlResults) {
      if (!ur.content) continue;
      section += `#### ${ur.url}\n\n`;
      // Truncate for readability
      const truncated = ur.content.length > 3000
        ? ur.content.slice(0, 3000) + '\n\n... (内容已截断)'
        : ur.content;
      section += truncated + '\n\n';
    }
    section += '</details>\n\n';
  }

  // LLM Analysis
  if (analysis) {
    section += '### AI 解读分析\n\n';
    section += analysis + '\n\n';
  }

  section += '---\n\n';
  return section;
}

// ============================================================
// Main
// ============================================================

(async () => {
  const config = parseArgs();

  // Check cache first
  const outputDir = config.outputDir || path.resolve(__dirname, 'output');
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputFile = path.join(outputDir, `macro-news-report-${dateStr}.md`);
  
  if (config.cache && fs.existsSync(outputFile)) {
    const stats = fs.statSync(outputFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`\n📦 Cache hit: ${outputFile} already exists`);
    console.log(`   Size: ${sizeMB} MB`);
    console.log(`   Modified: ${stats.mtime.toLocaleString()}`);
    console.log(`   Use --no-cache to regenerate`);
    process.exit(0);
  }

  // Filter sources
  let sources = ALL_SOURCES;
  if (config.category) {
    sources = config.category === 'macro' ? MACRO_SOURCES : INDUSTRY_SOURCES;
  }
  if (config.sourceNames.length > 0) {
    sources = sources.filter((s) => config.sourceNames.includes(s.name));
  }

  if (sources.length === 0) {
    console.error('没有匹配的数据源。使用 --help 查看可用数据源列表。');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`宏观经济与行业数据采集`);
  console.log(`数据源: ${sources.length} 个 | 并发: ${config.concurrency} | LLM: ${config.enableLLM ? '开启' : '关闭'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Initialize LLM client
  const llm = config.enableLLM ? createLLMClient() : null;
  if (llm && !llm.config.apiKey) {
    console.warn('⚠️  LLM API Key 未配置，解读功能将跳过\n');
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const results = [];

  // Process sources with concurrency control
  const semaphore = { count: 0, max: config.concurrency };

  async function processSource(source) {
    // Wait for available slot
    while (semaphore.count >= semaphore.max) {
      await new Promise((r) => setTimeout(r, 500));
    }
    semaphore.count++;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    console.log(`\n[${source.category}] ${source.name} - ${source.description}`);
    console.log(`  URLs: ${source.urls.length}`);

    const urlResults = [];
    for (const url of source.urls) {
      const result = await fetchUrl(page, url, config.timeout);
      urlResults.push(result);
    }

    // Combine content from all URLs for this source
    const combinedContent = urlResults
      .filter((r) => r.content)
      .map((r) => `[来源: ${r.url}]\n${r.content}`)
      .join('\n\n---\n\n');

    // LLM analysis
    let analysis = null;
    if (config.enableLLM && llm && combinedContent) {
      console.log(`  🤖 正在调用 LLM 解读...`);
      try {
        analysis = await llm.analyze(source.name, combinedContent, source.prompt);
        console.log(`  ✓ LLM 解读完成 (${analysis.length} 字)`);
      } catch (err) {
        console.error(`  ✗ LLM 解读失败: ${err.message}`);
        analysis = `[LLM 解读失败: ${err.message}]`;
      }
    }

    await context.close();
    semaphore.count--;

    return { source, urlResults, analysis };
  }

  // Process all sources
  // Use sequential processing within concurrency groups to maintain order
  const batchSize = config.concurrency;
  for (let i = 0; i < sources.length; i += batchSize) {
    const batch = sources.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processSource));
    results.push(...batchResults);
  }

  await browser.close();

  // Sort results to maintain original order
  const sourceOrder = new Map(sources.map((s, idx) => [s.name, idx]));
  results.sort((a, b) => (sourceOrder.get(a.source.name) || 0) - (sourceOrder.get(b.source.name) || 0));

  // Generate report
  console.log('\n\n📝 正在生成报告...');

  let report = generateReportHeader();
  report += generateTOC(results);

  // Group by category
  const macroResults = results.filter((r) => r.source.category === 'macro');
  const industryResults = results.filter((r) => r.source.category === 'industry');

  if (macroResults.length > 0) {
    report += '# 一、宏观数据\n\n';
    for (const r of macroResults) {
      report += generateSourceSection(r);
    }
  }

  if (industryResults.length > 0) {
    report += '# 二、行业数据\n\n';
    for (const r of industryResults) {
      report += generateSourceSection(r);
    }
  }

  // Summary statistics
  const totalUrls = results.reduce((sum, r) => sum + r.urlResults.length, 0);
  const successUrls = results.reduce(
    (sum, r) => sum + r.urlResults.filter((u) => !u.error).length, 0,
  );
  const failedUrls = totalUrls - successUrls;
  const withAnalysis = results.filter((r) => r.analysis && !r.analysis.startsWith('[')).length;

  report += `\n---\n\n## 采集统计\n\n`;
  report += `| 指标 | 数值 |\n|------|------|\n`;
  report += `| 数据源总数 | ${results.length} |\n`;
  report += `| URL 总数 | ${totalUrls} |\n`;
  report += `| 成功访问 | ${successUrls} |\n`;
  report += `| 访问失败 | ${failedUrls} |\n`;
  report += `| LLM 解读完成 | ${withAnalysis} |\n`;

  // Write to file
  fs.mkdirSync(outputDir, { recursive: true });

  const outputFile2 = path.join(outputDir, `macro-news-report-${dateStr}.md`);
  fs.writeFileSync(outputFile2, report, 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ 报告已生成: ${outputFile2}`);
  console.log(`   数据源: ${results.length} | 成功: ${successUrls}/${totalUrls} | LLM解读: ${withAnalysis}`);
  console.log(`${'='.repeat(60)}\n`);
})();
