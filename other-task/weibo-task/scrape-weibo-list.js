#!/usr/bin/env node
/**
 * Weibo Group Scraper
 *
 * Scrapes posts (text + images) from a Weibo group timeline.
 * Uses existing browser profiles with patchright (Playwright fork) for authentication.
 *
 * Output structure:
 *   weibo-YYYY-MM-DD/
 *     blog-1/
 *       content.md
 *       image-1.jpg
 *     blog-2/
 *       content.md
 *     ...
 *
 * Usage:
 *   node scrape-weibo-list.js                            # Defaults: profile 1, 5 posts
 *   node scrape-weibo-list.js --profile 3                # Use browser profile 3
 *   node scrape-weibo-list.js --count 10                 # Scrape 10 posts
 *   node scrape-weibo-list.js --since today              # All posts from today
 *   node scrape-weibo-list.js --since yesterday          # Posts since yesterday
 *   node scrape-weibo-list.js --since 24h                # Last 24 hours
 *   node scrape-weibo-list.js --since 2d                 # Last 2 days
 *   node scrape-weibo-list.js --since 2026-02-09         # Since specific date
 *   node scrape-weibo-list.js --url <group-url>          # Custom group URL
 *   node scrape-weibo-list.js --output-dir ./my-output   # Custom output directory
 *   node scrape-weibo-list.js --headless                 # Run headless (no browser window)
 *   node scrape-weibo-list.js --scroll-delay 3000        # Custom scroll delay (ms)
 */

const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ============================================================
// Configuration
// ============================================================

const DEFAULT_GROUP_URL = 'https://weibo.com/mygroups?gid=4653960000701277';
const DEFAULT_PROFILE_ID = 1;
const DEFAULT_COUNT = 5;
const DEFAULT_SCROLL_DELAY = 2000;
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ============================================================
// Weibo Timestamp Parser
// ============================================================

/**
 * Parse Weibo relative timestamp into a Date object.
 * Formats:
 *   "刚刚"           → just now
 *   "X分钟前"         → X minutes ago
 *   "X小时前"         → X hours ago
 *   "昨天 HH:MM"     → yesterday at HH:MM
 *   "今天 HH:MM"     → today at HH:MM
 *   "MM-DD"           → this year, MM-DD
 *   "MM-DD HH:MM"    → this year, MM-DD HH:MM
 *   "YYYY-MM-DD"     → specific date
 *   "YYYY-MM-DD HH:MM" → specific datetime
 */
function parseWeiboTime(timeText) {
  if (!timeText) return null;
  const t = timeText.trim();
  const now = new Date();

  // "刚刚" = just now
  if (t === '刚刚') return now;

  // "X分钟前" = X minutes ago
  const minsMatch = t.match(/^(\d+)分钟前$/);
  if (minsMatch) return new Date(now.getTime() - parseInt(minsMatch[1], 10) * 60 * 1000);

  // "X小时前" = X hours ago
  const hoursMatch = t.match(/^(\d+)小时前$/);
  if (hoursMatch) return new Date(now.getTime() - parseInt(hoursMatch[1], 10) * 60 * 60 * 1000);

  // "昨天 HH:MM"
  const yesterdayMatch = t.match(/^昨天\s*(\d{1,2}):(\d{2})$/);
  if (yesterdayMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(parseInt(yesterdayMatch[1], 10), parseInt(yesterdayMatch[2], 10), 0, 0);
    return d;
  }

  // "今天 HH:MM"
  const todayMatch = t.match(/^今天\s*(\d{1,2}):(\d{2})$/);
  if (todayMatch) {
    const d = new Date(now);
    d.setHours(parseInt(todayMatch[1], 10), parseInt(todayMatch[2], 10), 0, 0);
    return d;
  }

  // "MM-DD HH:MM" (this year)
  const mdhmMatch = t.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (mdhmMatch) {
    const d = new Date(now.getFullYear(), parseInt(mdhmMatch[1], 10) - 1, parseInt(mdhmMatch[2], 10),
      parseInt(mdhmMatch[3], 10), parseInt(mdhmMatch[4], 10));
    return d;
  }

  // "MM-DD" (this year)
  const mdMatch = t.match(/^(\d{1,2})-(\d{1,2})$/);
  if (mdMatch) {
    return new Date(now.getFullYear(), parseInt(mdMatch[1], 10) - 1, parseInt(mdMatch[2], 10));
  }

  // "YYYY-MM-DD HH:MM"
  const fullMatch = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (fullMatch) {
    return new Date(parseInt(fullMatch[1], 10), parseInt(fullMatch[2], 10) - 1, parseInt(fullMatch[3], 10),
      parseInt(fullMatch[4], 10), parseInt(fullMatch[5], 10));
  }

  // "YYYY-MM-DD"
  const ymdMatch = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    return new Date(parseInt(ymdMatch[1], 10), parseInt(ymdMatch[2], 10) - 1, parseInt(ymdMatch[3], 10));
  }

  return null;
}

// ============================================================
// Time Filter (--since)
// ============================================================

/**
 * Parse --since value into a cutoff Date.
 * Supports: today, yesterday, 24h, 12h, 2h, 1h, 2d, 7d, 30m, 90m, YYYY-MM-DD
 */
function parseSince(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();

  if (v === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }
  if (v === 'yesterday') {
    const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d;
  }

  const hoursMatch = v.match(/^(\d+)h$/);
  if (hoursMatch) return new Date(Date.now() - parseInt(hoursMatch[1], 10) * 3600000);

  const daysMatch = v.match(/^(\d+)d$/);
  if (daysMatch) return new Date(Date.now() - parseInt(daysMatch[1], 10) * 86400000);

  const minsMatch = v.match(/^(\d+)m$/);
  if (minsMatch) return new Date(Date.now() - parseInt(minsMatch[1], 10) * 60000);

  const dateMatch = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) { const d = new Date(v + 'T00:00:00'); if (!isNaN(d.getTime())) return d; }

  return null;
}

function formatCutoff(date) {
  if (!date) return 'none';
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// ============================================================
// CLI Argument Parser
// ============================================================

const MAX_SINCE_COUNT = 500;

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    groupUrl: DEFAULT_GROUP_URL,
    profileId: DEFAULT_PROFILE_ID,
    count: DEFAULT_COUNT,
    since: null,
    sinceDate: null,
    outputDir: null,
    headless: false,
    scrollDelay: DEFAULT_SCROLL_DELAY,
    cache: true,
  };

  let hasExplicitCount = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--profile':
        if (!next) throw new Error('--profile requires a number');
        config.profileId = parseInt(next, 10); i++; break;
      case '--count':
        if (!next) throw new Error('--count requires a number');
        config.count = parseInt(next, 10); hasExplicitCount = true; i++; break;
      case '--since':
        if (!next) throw new Error('--since requires a value');
        config.since = next;
        config.sinceDate = parseSince(next);
        if (!config.sinceDate) {
          console.error(`❌ Invalid --since value: "${next}"`);
          console.error('   Supported: today, yesterday, 24h, 12h, 2d, 7d, 30m, YYYY-MM-DD');
          process.exit(1);
        }
        i++; break;
      case '--url':
        if (!next) throw new Error('--url requires a URL');
        config.groupUrl = next; i++; break;
      case '--output-dir':
        if (!next) throw new Error('--output-dir requires a path');
        config.outputDir = path.resolve(next); i++; break;
      case '--headless':
        config.headless = true; break;
      case '--scroll-delay':
        if (!next) throw new Error('--scroll-delay requires a number');
        config.scrollDelay = parseInt(next, 10); i++; break;
      case '--no-cache':
        config.cache = false; break;
      case '--help': case '-h':
        printUsage(); process.exit(0); break;
      default:
        console.warn(`⚠️  Unknown argument: ${arg}`);
    }
  }

  if (config.sinceDate && !hasExplicitCount) {
    config.count = MAX_SINCE_COUNT;
  }

  if (!config.outputDir) {
    const dateStr = new Date().toISOString().split('T')[0];
    config.outputDir = path.join(__dirname, `weibo-${dateStr}`);
  }

  return config;
}

function printUsage() {
  console.log(`
Weibo Group Scraper

Usage: node scrape-weibo-list.js [options]

Options:
  --profile <id>       Browser profile ID (default: 1)
  --count <n>          Number of posts to scrape (default: 5)
  --since <when>       Only scrape posts since this time (stops scrolling at cutoff)
  --url <group-url>    Weibo group URL (default: built-in group)
  --output-dir <dir>   Output directory (default: weibo-YYYY-MM-DD/)
  --headless           Run browser in headless mode
  --scroll-delay <ms>  Delay between scrolls in ms (default: 2000)
  --no-cache           Force regeneration even if output exists
  -h, --help           Show this help message

--since values:
  today                Start of today (midnight)
  yesterday            Start of yesterday
  24h, 12h, 2h, 1h    Relative hours ago
  2d, 7d               Relative days ago
  30m, 90m             Relative minutes ago
  YYYY-MM-DD           Specific date (midnight)

Note: --since removes the default 5-post limit. Add --count N to cap results.

Cache behavior:
  By default, if output directory exists, scraping is skipped.
  Use --no-cache to force regeneration.

Examples:
  node scrape-weibo-list.js                              # Latest 5 posts
  node scrape-weibo-list.js --since today                # All posts from today
  node scrape-weibo-list.js --since yesterday             # Since yesterday
  node scrape-weibo-list.js --since 24h                  # Last 24 hours
  node scrape-weibo-list.js --since 2d --count 20        # Last 2 days, max 20
  node scrape-weibo-list.js --profile 3 --since today    # Profile 3, today's posts
`);
}

// ============================================================
// Image Downloader
// ============================================================

function downloadImage(url, filepath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { timeout: 30000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        return downloadImage(response.headers.location, filepath, maxRedirects - 1)
          .then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));

      const fileStream = fs.createWriteStream(filepath);
      response.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(filepath); });
      fileStream.on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Upgrade Weibo image URL to best quality.
 * Replaces thumbnail size prefixes (orj360, orj480, thumb180, etc.) with 'large'.
 */
function getBestQualityUrl(imgUrl) {
  if (!imgUrl) return imgUrl;
  // Replace size prefix: /orj360/ → /large/, /orj480/ → /large/, /thumb180/ → /large/, /mw690/ → /large/
  return imgUrl.replace(/\/(orj\d+|thumb\d+|mw\d+|bmiddle|small|square)\//i, '/large/');
}

function getImageExtension(imgUrl) {
  try {
    const url = new URL(imgUrl);
    const ext = path.extname(url.pathname);
    if (ext && ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext.toLowerCase())) return ext;
    return '.jpg';
  } catch {
    return '.jpg';
  }
}

async function downloadImages(imageUrls, dir, startIndex = 0) {
  let downloadedCount = 0;
  for (let i = 0; i < imageUrls.length; i++) {
    const bestUrl = getBestQualityUrl(imageUrls[i]);
    const ext = getImageExtension(bestUrl);
    const imgPath = path.join(dir, `image-${startIndex + i + 1}${ext}`);
    try {
      await downloadImage(bestUrl, imgPath);
      downloadedCount++;
    } catch (err) {
      console.warn(`      ⚠️  Failed to download image ${startIndex + i + 1}: ${err.message}`);
      try {
        await downloadImage(imageUrls[i], imgPath);
        downloadedCount++;
      } catch (err2) {
        console.warn(`      ❌  Fallback also failed: ${err2.message}`);
      }
    }
  }
  return downloadedCount;
}

// ============================================================
// Post Extraction
// ============================================================

/**
 * Extract visible Weibo posts from the page.
 * Weibo uses a virtual scroller, so we must extract incrementally as we scroll.
 * Returns raw post objects with timeText (to be parsed in Node.js).
 */
async function extractVisiblePosts(page) {
  return await page.evaluate(() => {
    const articles = document.querySelectorAll('article');
    const results = [];

    for (const article of articles) {
      // --- Author ---
      const nameEl = article.querySelector('[class*="_name_"] span[title]');
      const authorName = nameEl ? nameEl.getAttribute('title') : '';

      const profileLink = article.querySelector('header a[href*="/u/"]');
      const authorUid = profileLink ? profileLink.getAttribute('href').replace(/.*\/u\//, '') : '';

      // --- Timestamp (relative text) ---
      const timeEl = article.querySelector('a[class*="_time_"]');
      const timeText = timeEl ? timeEl.textContent.trim() : '';

      // --- Post text ---
      // First try the original text container, then any wbtext
      const textEl = article.querySelector('.wbpro-feed-ogText [class*="_wbtext_"]')
        || article.querySelector('[class*="_wbtext_"]');
      let text = textEl ? textEl.innerText.trim() : '';
      // Clean up "展开" expand text if at end
      text = text.replace(/\s*\.\.\.展开\s*$/, '...');

      // --- Images (exclude avatars, emojis, VIP icons) ---
      const images = [];
      const imgEls = article.querySelectorAll('[class*="_pic_"] img[src*="sinaimg.cn"], [class*="_img_"] img[src*="sinaimg.cn"], [class*="_media_"] img[src*="sinaimg.cn"]');
      for (const img of imgEls) {
        const src = img.src;
        if (src.includes('face.t.sinajs.cn')) continue;
        if (img.classList.contains('woo-avatar-img')) continue;
        if (src.includes('/upload/108/')) continue;
        images.push(src);
      }

      // Fallback: if no images from container selectors, try broader search
      if (images.length === 0) {
        const feedContent = article.querySelector('.wbpro-feed-content, [class*="_body_"]');
        if (feedContent) {
          const allImgs = feedContent.querySelectorAll('img[src*="sinaimg.cn"]');
          for (const img of allImgs) {
            const src = img.src;
            if (src.includes('face.t.sinajs.cn')) continue;
            if (img.classList.contains('woo-avatar-img')) continue;
            if (src.includes('/upload/108/')) continue;
            if (src.includes('/crop.')) continue;
            // Only include actual content images (wx1-4.sinaimg.cn)
            if (src.match(/wx\d\.sinaimg\.cn/)) {
              images.push(src);
            }
          }
        }
      }

      // --- Repost detection ---
      // Reposted posts have a nested "retweet" section
      const repostEl = article.querySelector('[class*="_retweet_"]');
      const isRepost = repostEl !== null;

      // Repost original content
      let repostAuthor = '';
      let repostText = '';
      if (isRepost && repostEl) {
        const rpNameEl = repostEl.querySelector('a[class*="_name_"]');
        repostAuthor = rpNameEl ? rpNameEl.textContent.trim().replace(/^@/, '') : '';
        const rpTextEl = repostEl.querySelector('[class*="_wbtext_"]');
        repostText = rpTextEl ? rpTextEl.innerText.trim() : '';
      }

      // Build a dedup key from author + first 80 chars of text
      const dedupKey = `${authorName}::${text.substring(0, 80)}`;

      results.push({
        authorName,
        authorUid,
        timeText,
        text,
        images,
        isRepost,
        repostAuthor,
        repostText,
        dedupKey,
      });
    }

    return results;
  });
}

/**
 * Scroll and extract posts incrementally (Weibo uses virtual scroller).
 * Returns accumulated unique posts.
 */
async function scrollAndExtractPosts(page, targetCount, scrollDelay, sinceDate) {
  const allPosts = new Map(); // dedupKey → post
  let previousHeight = 0;
  let stableCount = 0;
  const maxScrollAttempts = sinceDate ? 100 : 20;
  let oldPostStreak = 0; // consecutive scrolls with no new in-range posts
  const OLD_POST_STREAK_LIMIT = 3; // stop after N consecutive scrolls finding only old posts

  for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
    // Extract currently visible posts
    const visible = await extractVisiblePosts(page);

    const sizeBefore = allPosts.size;
    let foundOldPost = false;

    for (const post of visible) {
      if (allPosts.has(post.dedupKey)) continue;

      // Parse the timestamp
      const parsedTime = parseWeiboTime(post.timeText);
      post.parsedTime = parsedTime ? parsedTime.toISOString() : null;

      // Time cutoff check
      if (sinceDate && parsedTime && parsedTime.getTime() < sinceDate.getTime()) {
        foundOldPost = true;
        continue; // skip this post but keep checking
      }

      allPosts.set(post.dedupKey, post);
    }

    const currentSize = allPosts.size;
    const addedNew = currentSize > sizeBefore;

    // Track consecutive scrolls that found old posts but no new in-range posts
    if (sinceDate && foundOldPost && !addedNew) {
      oldPostStreak++;
    } else if (addedNew) {
      oldPostStreak = 0; // reset: we found new in-range posts
    }

    // Stop conditions
    if (!sinceDate && currentSize >= targetCount) {
      console.log(`   ✅ Collected ${currentSize} posts (need ${targetCount})`);
      break;
    }
    if (sinceDate && currentSize >= targetCount) {
      console.log(`   ⚠️  Reached max count limit (${targetCount}), stopping`);
      break;
    }
    if (sinceDate && oldPostStreak >= OLD_POST_STREAK_LIMIT) {
      console.log(`   ✅ Reached time cutoff (${oldPostStreak} consecutive scrolls with only old posts), collected ${currentSize} posts in range`);
      break;
    }

    if (attempt > 0) {
      const statusMsg = sinceDate
        ? `collected ${currentSize} posts (scrolling to time cutoff)`
        : `collected ${currentSize}/${targetCount} posts`;
      console.log(`   📜 Scroll #${attempt}: ${statusMsg}...`);
    }

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(scrollDelay);

    // Stable height detection
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableCount++;
      if (stableCount >= 3) {
        console.log(`   ⚠️  Page height stable after ${stableCount} scrolls, stopping`);
        break;
      }
    } else {
      stableCount = 0;
    }
    previousHeight = currentHeight;
  }

  // Convert to array, limit to targetCount
  const posts = Array.from(allPosts.values()).slice(0, targetCount);
  console.log(`   📊 Total unique posts collected: ${posts.length}`);
  return posts;
}

// ============================================================
// Output
// ============================================================

async function savePost(post, index, outputDir) {
  const blogDir = path.join(outputDir, `blog-${index + 1}`);
  fs.mkdirSync(blogDir, { recursive: true });

  const allImages = [...post.images];
  const lines = [];

  // === Repost header ===
  if (post.isRepost && post.repostAuthor) {
    lines.push(`> 🔁 **Reposted** (original by @${post.repostAuthor})`);
    lines.push('');
  }

  // === Author ===
  lines.push(`# ${post.authorName || 'Unknown'}`);
  if (post.authorUid) {
    lines.push(`**weibo.com/u/${post.authorUid}**`);
  }
  lines.push('');

  // === Metadata ===
  if (post.parsedTime) {
    const d = new Date(post.parsedTime);
    lines.push(`**Date:** ${d.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`);
  }
  if (post.timeText) {
    lines.push(`**Original time:** ${post.timeText}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // === Post text ===
  if (post.text) {
    lines.push(post.text);
  } else {
    lines.push('*(No text content)*');
  }

  // === Post images ===
  if (post.images.length > 0) {
    lines.push('');
    lines.push('### Images');
    lines.push('');
    for (let i = 0; i < post.images.length; i++) {
      const ext = getImageExtension(post.images[i]);
      lines.push(`![image-${i + 1}](image-${i + 1}${ext})`);
    }
  }

  // === Reposted original content ===
  if (post.isRepost && post.repostText) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Original Post');
    lines.push('');
    if (post.repostAuthor) {
      lines.push(`**@${post.repostAuthor}**`);
      lines.push('');
    }
    lines.push(`> ${post.repostText.split('\n').join('\n> ')}`);
  }

  lines.push('');

  fs.writeFileSync(path.join(blogDir, 'content.md'), lines.join('\n'), 'utf-8');

  // Download images
  const downloadedCount = await downloadImages(allImages, blogDir);
  return { blogDir, downloadedCount, totalImages: allImages.length };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const config = parseArgs();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          📘 Weibo Group Scraper                           ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Group URL: ${config.groupUrl.substring(0, 46).padEnd(46)} ║`);
  console.log(`║  Profile:   ${String(config.profileId).padEnd(46)} ║`);
  if (config.sinceDate) {
    console.log(`║  Since:     ${(config.since + ' → ' + formatCutoff(config.sinceDate)).substring(0, 46).padEnd(46)} ║`);
    console.log(`║  Max count: ${String(config.count).padEnd(46)} ║`);
  } else {
    console.log(`║  Count:     ${String(config.count).padEnd(46)} ║`);
  }
  console.log(`║  Headless:  ${String(config.headless).padEnd(46)} ║`);
  console.log(`║  Output:    ${config.outputDir.substring(0, 46).padEnd(46)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // Check cache BEFORE launching browser
  if (config.cache && fs.existsSync(config.outputDir)) {
    const files = fs.readdirSync(config.outputDir);
    const blogCount = files.filter(f => f.startsWith('blog-')).length;
    
    console.log(`📦 Cache hit: ${config.outputDir}/ already exists`);
    console.log(`   Contains ${blogCount} blog(s)`);
    console.log(`   Use --no-cache to regenerate\n`);
    
    process.exit(0);
  }

  // Resolve browser profile
  const userDataDir = path.join(PROJECT_ROOT, 'browser-profiles', `browser-${config.profileId}`);
  if (!fs.existsSync(userDataDir)) {
    console.error(`❌ Browser profile not found: ${userDataDir}`);
    console.error(`   Run 'node launch-browser.js ${config.profileId}' first.`);
    process.exit(1);
  }

  console.log(`🚀 Launching browser with profile #${config.profileId}...`);
  console.log(`   📂 ${userDataDir}`);

  let context = null;
  try {
    const launchOptions = {
      channel: 'chrome',
      headless: config.headless,
      viewport: config.headless ? { width: 1280, height: 900 } : null,
    };

    // Load proxy if available
    const proxyConfigPath = path.join(PROJECT_ROOT, 'proxy-config.json');
    if (fs.existsSync(proxyConfigPath)) {
      try {
        const proxies = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf-8'));
        const proxyIndex = config.profileId - 1;
        if (Array.isArray(proxies) && proxies[proxyIndex]) {
          const proxy = proxies[proxyIndex];
          launchOptions.proxy = {
            server: `http://${proxy.server}`, username: proxy.username, password: proxy.password,
          };
          console.log(`   🔒 Proxy: ${proxy.server}`);
        }
      } catch (err) {
        console.warn(`   ⚠️  Failed to load proxy config: ${err.message}`);
      }
    }

    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch { }

    const page = await context.newPage();

    try {
      // Navigate to the group
      console.log(`\n🌐 Navigating to Weibo group...`);
      await page.goto(config.groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for feed to load
      console.log('   ⏳ Waiting for feed to load...');
      const feedSelectors = ['article', '.wbpro-feed-content', '[class*="_wrap_m3n8j"]'];
      let foundSelector = null;

      for (const sel of feedSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 15000 });
          foundSelector = sel;
          console.log(`   ✅ Feed loaded (${sel})`);
          break;
        } catch {
          console.log(`   ⚠️  Selector "${sel}" not found, trying next...`);
        }
      }

      if (!foundSelector) {
        const debugPath = path.join(__dirname, 'debug-screenshot.png');
        await page.screenshot({ path: debugPath, fullPage: false });
        console.log(`   📸 Debug screenshot: ${debugPath}`);

        const bodyText = await page.textContent('body').catch(() => '');
        if (bodyText.includes('登录') || bodyText.includes('signin')) {
          console.error('\n❌ Not logged in to Weibo. Please log in first:');
          console.error(`   1. Run: node launch-browser.js ${config.profileId}`);
          console.error('   2. Navigate to weibo.com and log in');
          console.error('   3. Close the browser and run this script again');
        } else {
          console.error('\n❌ No posts found. The page may have failed to load.');
        }
        process.exit(1);
      }

      // Extra wait for content
      await page.waitForTimeout(3000);

      // Scroll and extract
      if (config.sinceDate) {
        console.log(`\n📜 Loading posts since ${formatCutoff(config.sinceDate)} (max ${config.count})...`);
      } else {
        console.log(`\n📜 Loading posts (target: ${config.count})...`);
      }

      const posts = await scrollAndExtractPosts(page, config.count, config.scrollDelay, config.sinceDate);

      if (posts.length === 0) {
        console.error('❌ No posts extracted.');
        process.exit(1);
      }

      console.log(`\n   ✅ Extracted ${posts.length} posts`);

      // Clear existing output directory and create fresh
      if (fs.existsSync(config.outputDir)) {
        console.log(`\n🗑️  Clearing existing output: ${config.outputDir}/`);
        fs.rmSync(config.outputDir, { recursive: true, force: true });
      }
      fs.mkdirSync(config.outputDir, { recursive: true });

      // Save each post
      console.log(`\n💾 Saving posts to ${config.outputDir}/`);
      const summary = [];

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const authorDisplay = post.authorName || 'Unknown';
        const textPreview = post.text ? post.text.substring(0, 60).replace(/\n/g, ' ') + '...' : '(no text)';

        console.log(`\n   [${i + 1}/${posts.length}] ${authorDisplay}`);
        if (post.isRepost) {
          console.log(`      🔁 Repost of @${post.repostAuthor || 'unknown'}`);
        }
        console.log(`      📝 ${textPreview}`);
        console.log(`      🖼️  ${post.images.length} image(s)`);
        console.log(`      🕐 ${post.timeText}`);

        const result = await savePost(post, i, config.outputDir);
        summary.push({
          index: i + 1,
          author: authorDisplay,
          type: post.isRepost ? 'RP' : '',
          images: result.totalImages,
          downloaded: result.downloadedCount,
        });

        console.log(`      ✅ Saved to blog-${i + 1}/`);
      }

      // Summary
      console.log('\n');
      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║          ✅ Scraping Complete                             ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  Posts scraped: ${String(posts.length).padEnd(42)} ║`);
      console.log(`║  Output:        ${config.outputDir.substring(0, 42).padEnd(42)} ║`);
      console.log('╠═══════════════════════════════════════════════════════════╣');

      for (const s of summary) {
        const author = s.author.substring(0, 18).padEnd(18);
        const type = (s.type || '  ').padEnd(2);
        const imgs = `${s.downloaded}/${s.images} imgs`.padEnd(12);
        console.log(`║  blog-${String(s.index).padEnd(3)} ${type} ${author} ${imgs}        ║`);
      }

      console.log('╚═══════════════════════════════════════════════════════════╝');
      console.log('');

    } finally {
      await page.close().catch(() => {});
    }

  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (context) {
      await context.close().catch(() => {});
      console.log('🔄 Browser closed');
    }
  }
}

process.on('SIGINT', () => { console.log('\n🛑 Interrupted'); process.exit(0); });

main().catch((err) => { console.error('❌ Unhandled error:', err); process.exit(1); });
