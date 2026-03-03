#!/usr/bin/env node
/**
 * Eastmoney Futures Scraper
 *
 * Scrapes futures data from eastmoney.com for given symbols.
 * Extracts three sections per symbol:
 *   1. 资讯 (News)     → Opens each article, saves full content to news/ folder
 *   2. 库存数据 (Inventory) → Extracts date/stock/change table → stock.md
 *   3. 全部 (Forum)     → Extracts guba forum posts (reads, comments, title, author, date) → blog.md
 *
 * Usage:
 *   node scrape-eastmoney-futures.js ma                     # Single symbol
 *   node scrape-eastmoney-futures.js ma pp eg sc            # Multiple symbols
 *   node scrape-eastmoney-futures.js ma --output-dir ./out  # Custom output dir
 *   node scrape-eastmoney-futures.js --help                 # Show help
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('patchright');

// ============================================================
// Constants
// ============================================================

const BASE_URL = 'https://futures.eastmoney.com';

// ============================================================
// CLI Argument Parser
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    symbols: [],
    outputDir: null,
    headless: false,
    cache: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    switch (arg) {
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
      case '--no-cache':
        config.cache = false;
        break;
      default:
        if (!arg.startsWith('-')) {
          config.symbols.push(arg.toLowerCase());
        }
    }
  }

  if (config.symbols.length === 0) {
    console.error('❌ No symbols provided. Usage: node scrape-eastmoney-futures.js <symbol> [symbol2 ...]');
    console.error('   Example: node scrape-eastmoney-futures.js ma pp eg');
    process.exit(1);
  }

  if (!config.outputDir) {
    const dateStr = new Date().toISOString().split('T')[0];
    config.outputDir = path.join(__dirname, `${dateStr}_eastmoney_review`);
  }

  return config;
}

function printHelp() {
  console.log(`
Eastmoney Futures Scraper
=========================

Scrapes futures data from futures.eastmoney.com for given commodity symbols.

Usage:
  node scrape-eastmoney-futures.js <symbol> [symbol2 ...] [options]

Arguments:
  <symbol>             Futures symbol(s): ma, pp, eg, sc, ta, etc.

Options:
  --output-dir <dir>   Output directory (default: YYYY-MM-DD_eastmoney_review/)
  --no-headless        Show browser window (default: headless)
  --no-cache           Force regeneration even if output exists
  --help, -h           Show this help

Output structure:
  {output-dir}/
    {symbol-name}/
      news/
        1.md           # Full article content
        2.md
        ...
      stock.md         # Inventory data (date, stock, change)
      blog.md          # Forum posts (全部 tab: reads, comments, title, author, date)

Examples:
  node scrape-eastmoney-futures.js ma                  # Scrape methanol
  node scrape-eastmoney-futures.js ma pp eg            # Multiple symbols
  node scrape-eastmoney-futures.js ma --no-headless    # Show browser
`);
}

// ============================================================
// Section 1: 资讯 (News) Extraction
// ============================================================

async function extractNewsLinks(page) {
  return await page.evaluate(() => {
    const container = document.querySelector('#futureImportentNews1');
    if (!container) return [];
    const results = [];
    container.querySelectorAll('li a').forEach(a => {
      const title = a.textContent.trim();
      const href = a.href;
      if (title && href && href.includes('eastmoney.com')) {
        results.push({ title, href });
      }
    });
    return results;
  });
}

async function extractArticleContent(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    return await page.evaluate(() => {
      const titleEl = document.querySelector('h1, .newsTitle, .b-review-title, .title');
      const title = titleEl ? titleEl.textContent.trim() : '';

      const infoEl = document.querySelector('.Info, .time, .author, .info, .source');
      const info = infoEl ? infoEl.textContent.trim() : '';

      const bodyEl = document.querySelector('#ContentBody');
      if (!bodyEl) return { title, info, content: '' };

      // Extract text, preserving paragraph structure
      const paragraphs = [];
      bodyEl.querySelectorAll('p, h3, h4').forEach(el => {
        const text = el.textContent.trim();
        if (text && !el.querySelector('a[href*="ai.eastmoney"]')) {
          if (el.tagName === 'H3' || el.tagName === 'H4') {
            paragraphs.push(`## ${text}`);
          } else {
            paragraphs.push(text);
          }
        }
      });

      return { title, info, content: paragraphs.join('\n\n') };
    });
  } catch (e) {
    return { title: '', info: '', content: `Error fetching: ${e.message}` };
  }
}

// ============================================================
// Section 2: 库存数据 (Inventory) Extraction
// ============================================================

async function extractInventoryData(page) {
  return await page.evaluate(() => {
    const container = document.querySelector('#KcContent');
    if (!container) return null;

    const table = container.querySelector('#div_table table');
    if (!table) return null;

    const rows = table.querySelectorAll('tr');
    if (rows.length < 2) return null;

    // Row 0: dates (first cell is header "日期")
    // Row 1: stock values (first cell is "库存")
    // Row 2: change values (first cell is "增减")
    const dates = [];
    const stocks = [];
    const changes = [];

    rows.forEach((row, rowIdx) => {
      const cells = row.querySelectorAll('th, td');
      cells.forEach((cell, colIdx) => {
        const text = cell.textContent.trim();
        if (colIdx === 0) return; // skip label column
        if (rowIdx === 0) dates.push(text);
        else if (rowIdx === 1) stocks.push(text);
        else if (rowIdx === 2) changes.push(text);
      });
    });

    // Combine into records
    const records = [];
    for (let i = 0; i < dates.length; i++) {
      records.push({
        date: dates[i] || '',
        stock: stocks[i] || '',
        change: changes[i] || '',
      });
    }

    return records;
  });
}

// ============================================================
// Section 3: 全部 (Guba Forum) Extraction
// ============================================================

/**
 * Extract the guba code from the iframe embedded in the futures page.
 * The iframe src looks like: https://gbfek.dfcfw.com/...?code=fczcemam&...
 */
async function extractGubaCode(page) {
  return await page.evaluate(() => {
    const iframe = document.querySelector('iframe.gubamodule2017');
    if (!iframe || !iframe.src) return null;
    const match = iframe.src.match(/[?&]code=([^&]+)/);
    return match ? match[1] : null;
  });
}

/**
 * Navigate to the guba page and extract forum posts from the 全部 tab.
 */
async function extractGubaPosts(page, gubaCode) {
  const gubaUrl = `https://guba.eastmoney.com/list,${gubaCode}.html`;
  await page.goto(gubaUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('.listitem').forEach(item => {
      const readEl = item.querySelector('.read');
      const replyEl = item.querySelector('.reply');
      const titleEl = item.querySelector('.title a');
      const authorEl = item.querySelector('.author a.nametext');

      // Last td is the date
      const tds = item.querySelectorAll('td');
      const lastTd = tds.length > 0 ? tds[tds.length - 1] : null;
      const date = lastTd ? lastTd.textContent.trim() : '';

      if (titleEl) {
        results.push({
          reads: readEl ? readEl.textContent.trim() : '',
          comments: replyEl ? replyEl.textContent.trim() : '',
          title: titleEl.getAttribute('data-rawcntitle') || titleEl.textContent.trim(),
          author: authorEl ? authorEl.textContent.trim() : '',
          date,
        });
      }
    });
    return results;
  });
}

// ============================================================
// Save Functions
// ============================================================

function saveNewsArticle(article, index, newsDir) {
  const filePath = path.join(newsDir, `${index}.md`);
  const lines = [];
  if (article.title) lines.push(`# ${article.title}`);
  if (article.info) lines.push(`\n*${article.info}*`);
  if (article.href) lines.push(`\n> Source: ${article.href}`);
  lines.push('\n---\n');
  if (article.content) lines.push(article.content);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function saveInventoryData(records, goodsDir, goodsName) {
  const filePath = path.join(goodsDir, 'stock.md');
  const lines = [];
  lines.push(`# ${goodsName} 库存数据\n`);
  lines.push('| 日期 | 库存 | 增减 |');
  lines.push('|------|------|------|');
  // Show most recent first
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.date) {
      lines.push(`| ${r.date} | ${r.stock} | ${r.change} |`);
    }
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function saveGubaBlog(posts, goodsDir, goodsName) {
  const filePath = path.join(goodsDir, 'blog.md');
  const lines = [];
  lines.push(`# ${goodsName} 全部讨论\n`);
  lines.push('| 阅读 | 评论 | 标题 | 作者 | 最后更新 |');
  lines.push('|------|------|------|------|----------|');
  posts.forEach(p => {
    lines.push(`| ${p.reads} | ${p.comments} | ${p.title} | ${p.author} | ${p.date} |`);
  });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ============================================================
// Get goods name from page title
// ============================================================

async function getGoodsName(page) {
  const title = await page.title();
  // Title format: "甲醇 _ 期货频道 _ 东方财富网"
  const match = title.match(/^(.+?)\s*_/);
  return match ? match[1].trim() : 'unknown';
}

// ============================================================
// Process a single symbol
// ============================================================

async function processSymbol(page, symbol, outputDir) {
  const url = `${BASE_URL}/qihuo/${symbol}.html`;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📦 Symbol: ${symbol.toUpperCase()} → ${url}`);
  console.log('─'.repeat(60));

  // Navigate to the futures page
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Verify page loaded
  const title = await page.title();
  if (title.includes('不存在') || title.includes('404')) {
    console.log(`   ❌ Page not found for symbol: ${symbol}`);
    return false;
  }

  const goodsName = await getGoodsName(page);
  console.log(`   📋 Commodity: ${goodsName}`);

  // Use symbol for folder name to ensure consistency
  const goodsDir = path.join(outputDir, symbol);
  const newsDir = path.join(goodsDir, 'news');
  fs.mkdirSync(newsDir, { recursive: true });

  // --- Section 1: 资讯 (News) ---
  console.log(`\n   📰 Extracting news (资讯)...`);
  const newsLinks = await extractNewsLinks(page);
  console.log(`      Found ${newsLinks.length} news links`);

  for (let i = 0; i < newsLinks.length; i++) {
    const link = newsLinks[i];
    console.log(`      [${i + 1}/${newsLinks.length}] ${link.title.substring(0, 50)}...`);
    const article = await extractArticleContent(page, link.href);
    article.href = link.href;
    if (!article.title) article.title = link.title;
    saveNewsArticle(article, i + 1, newsDir);
  }
  console.log(`      ✅ Saved ${newsLinks.length} articles to news/`);

  // Navigate back to the main page for remaining sections
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  // --- Section 2: 库存数据 (Inventory) ---
  console.log(`\n   📊 Extracting inventory data (库存数据)...`);
  const inventory = await extractInventoryData(page);
  if (inventory && inventory.length > 0) {
    saveInventoryData(inventory, goodsDir, goodsName);
    console.log(`      ✅ Saved ${inventory.length} inventory records to stock.md`);
  } else {
    console.log(`      ⚠️  No inventory data found for ${goodsName}`);
    fs.writeFileSync(path.join(goodsDir, 'stock.md'), `# ${goodsName} 库存数据\n\n*No inventory data available for this symbol.*\n`, 'utf-8');
  }

  // --- Section 3: 全部 (Guba Forum) ---
  console.log(`\n   💬 Extracting forum posts (全部)...`);
  // Get the guba code from the iframe on the current page (still on main page from Section 2)
  const gubaCode = await extractGubaCode(page);

  if (gubaCode) {
    console.log(`      Guba code: ${gubaCode}`);
    const posts = await extractGubaPosts(page, gubaCode);
    if (posts.length > 0) {
      saveGubaBlog(posts, goodsDir, goodsName);
      console.log(`      ✅ Saved ${posts.length} forum posts to blog.md`);
    } else {
      console.log(`      ⚠️  No forum posts found`);
      fs.writeFileSync(path.join(goodsDir, 'blog.md'), `# ${goodsName} 全部讨论\n\n*No forum posts available.*\n`, 'utf-8');
    }
  } else {
    console.log(`      ⚠️  Could not find guba code for ${goodsName}`);
    fs.writeFileSync(path.join(goodsDir, 'blog.md'), `# ${goodsName} 全部讨论\n\n*Guba forum not available for this symbol.*\n`, 'utf-8');
  }

  console.log(`\n   ✅ Done: ${goodsName} → ${goodsDir}`);
  return true;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const config = parseArgs();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          📈 Eastmoney Futures Scraper                    ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Symbols:  ${config.symbols.map(s => s.toUpperCase()).join(', ').substring(0, 46).padEnd(46)} ║`);
  console.log(`║  Headless: ${String(config.headless).padEnd(47)} ║`);
  console.log(`║  Output:   ${config.outputDir.substring(0, 47).padEnd(47)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // Check cache for all symbols
  if (config.cache) {
    const cachedSymbols = [];
    const symbolsToProcess = [];
    
    for (const symbol of config.symbols) {
      const symbolDir = path.join(config.outputDir, symbol);
      if (fs.existsSync(symbolDir)) {
        cachedSymbols.push(symbol);
      } else {
        symbolsToProcess.push(symbol);
      }
    }
    
    if (cachedSymbols.length > 0) {
      console.log(`\n📦 Cache hit for ${cachedSymbols.length} symbol(s): ${cachedSymbols.map(s => s.toUpperCase()).join(', ')}`);
    }
    
    if (symbolsToProcess.length === 0) {
      console.log(`   All symbols already processed. Use --no-cache to regenerate.`);
      process.exit(0);
    }
    
    if (symbolsToProcess.length < config.symbols.length) {
      console.log(`   Will process ${symbolsToProcess.length} new symbol(s): ${symbolsToProcess.map(s => s.toUpperCase()).join(', ')}`);
      config.symbols = symbolsToProcess;
    }
  }

  // Create output directory (don't clear it - we're doing per-symbol caching)
  fs.mkdirSync(config.outputDir, { recursive: true });

  // Launch browser (no login needed for eastmoney)
  console.log('\n🚀 Launching browser...');
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    const results = [];

    for (const symbol of config.symbols) {
      const ok = await processSymbol(page, symbol, config.outputDir, config);
      results.push({ symbol, ok });
    }

    // Summary
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║          ✅ Scraping Complete                            ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Output: ${config.outputDir.substring(0, 49).padEnd(49)} ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    for (const r of results) {
      const icon = r.ok ? '✅' : '❌';
      console.log(`║  ${icon} ${r.symbol.toUpperCase().padEnd(55)} ║`);
    }
    console.log('╚═══════════════════════════════════════════════════════════╝');
  } finally {
    await browser.close();
    console.log('\n🔄 Browser closed');
  }
}

main().catch(e => {
  console.error(`\n❌ Fatal error: ${e.message}`);
  process.exit(1);
});
