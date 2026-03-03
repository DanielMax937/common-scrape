#!/usr/bin/env node
/**
 * Weibo User Profile Scraper
 *
 * Scrapes all posts (text + images + reposts) from a specific Weibo user's profile.
 * Uses existing browser profiles with patchright (Playwright fork) for authentication.
 * Scrolls incrementally to load all posts (Weibo uses virtual scroller).
 *
 * Output structure:
 *   weibo-user-{username}-YYYY-MM-DD/
 *     blog-1/
 *       content.md
 *       image-1.jpg
 *     blog-2/
 *       content.md
 *     ...
 *
 * Usage:
 *   node scrape-weibo-user.js                                 # Default user, 50 posts
 *   node scrape-weibo-user.js --url https://weibo.com/u/XXX   # Custom user URL
 *   node scrape-weibo-user.js --count 100                     # Scrape 100 posts
 *   node scrape-weibo-user.js --start 50                      # Skip first 50, scrape from #51
 *   node scrape-weibo-user.js --start 100 --count 100         # Scrape posts 101-200
 *   node scrape-weibo-user.js --since today                   # Only today's posts
 *   node scrape-weibo-user.js --since yesterday               # Since yesterday
 *   node scrape-weibo-user.js --since 24h                     # Last 24 hours
 *   node scrape-weibo-user.js --since 2d                      # Last 2 days
 *   node scrape-weibo-user.js --since 2026-02-09              # Since specific date
 *   node scrape-weibo-user.js --profile 2                     # Use browser profile 2
 *   node scrape-weibo-user.js --headless                      # Run headless
 */

const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ============================================================
// Configuration
// ============================================================

const DEFAULT_USER_URL = 'https://www.weibo.com/u/1645776681';
const DEFAULT_PROFILE_ID = 1;
const DEFAULT_COUNT = 50;
const DEFAULT_SCROLL_DELAY = 2000;
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ============================================================
// Weibo Timestamp Parser
// ============================================================

function parseWeiboTime(timeText) {
  if (!timeText) return null;
  const t = timeText.trim();
  const now = new Date();

  if (t === '刚刚') return now;

  const minsMatch = t.match(/^(\d+)分钟前$/);
  if (minsMatch) return new Date(now.getTime() - parseInt(minsMatch[1], 10) * 60 * 1000);

  const hoursMatch = t.match(/^(\d+)小时前$/);
  if (hoursMatch) return new Date(now.getTime() - parseInt(hoursMatch[1], 10) * 60 * 60 * 1000);

  const yesterdayMatch = t.match(/^昨天\s*(\d{1,2}):(\d{2})$/);
  if (yesterdayMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(parseInt(yesterdayMatch[1], 10), parseInt(yesterdayMatch[2], 10), 0, 0);
    return d;
  }

  const todayMatch = t.match(/^今天\s*(\d{1,2}):(\d{2})$/);
  if (todayMatch) {
    const d = new Date(now);
    d.setHours(parseInt(todayMatch[1], 10), parseInt(todayMatch[2], 10), 0, 0);
    return d;
  }

  const mdhmMatch = t.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (mdhmMatch) {
    return new Date(now.getFullYear(), parseInt(mdhmMatch[1], 10) - 1, parseInt(mdhmMatch[2], 10),
      parseInt(mdhmMatch[3], 10), parseInt(mdhmMatch[4], 10));
  }

  const mdMatch = t.match(/^(\d{1,2})-(\d{1,2})$/);
  if (mdMatch) {
    return new Date(now.getFullYear(), parseInt(mdMatch[1], 10) - 1, parseInt(mdMatch[2], 10));
  }

  const fullMatch = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (fullMatch) {
    return new Date(parseInt(fullMatch[1], 10), parseInt(fullMatch[2], 10) - 1, parseInt(fullMatch[3], 10),
      parseInt(fullMatch[4], 10), parseInt(fullMatch[5], 10));
  }

  const ymdMatch = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    return new Date(parseInt(ymdMatch[1], 10), parseInt(ymdMatch[2], 10) - 1, parseInt(ymdMatch[3], 10));
  }

  return null;
}

// ============================================================
// Time Filter (--since)
// ============================================================

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
    userUrl: DEFAULT_USER_URL,
    profileId: DEFAULT_PROFILE_ID,
    count: DEFAULT_COUNT,
    start: 0,
    since: null,
    sinceDate: null,
    outputDir: null,
    headless: false,
    scrollDelay: DEFAULT_SCROLL_DELAY,
  };

  let hasExplicitCount = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }

    switch (arg) {
      case '--url':
        if (!next) throw new Error('--url requires a value');
        config.userUrl = next; i++; break;
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
      case '--output-dir':
        if (!next) throw new Error('--output-dir requires a path');
        config.outputDir = path.resolve(next); i++; break;
      case '--headless':
        config.headless = true; break;
      case '--start':
        if (!next) throw new Error('--start requires a number');
        config.start = parseInt(next, 10); i++; break;
      case '--scroll-delay':
        if (!next) throw new Error('--scroll-delay requires a number');
        config.scrollDelay = parseInt(next, 10); i++; break;
      default:
        if (!arg.startsWith('-')) {
          // Treat as URL if it looks like one
          if (arg.includes('weibo.com')) config.userUrl = arg;
        }
    }
  }

  if (config.sinceDate && !hasExplicitCount) {
    config.count = MAX_SINCE_COUNT;
  }

  // Extract uid from URL for output dir naming
  const uidMatch = config.userUrl.match(/\/u\/(\d+)/);
  const uid = uidMatch ? uidMatch[1] : 'unknown';

  if (!config.outputDir) {
    const dateStr = new Date().toISOString().split('T')[0];
    config.outputDir = path.join(__dirname, `weibo-user-${uid}-${dateStr}`);
  }

  config.uid = uid;
  return config;
}

function printHelp() {
  console.log(`
Weibo User Profile Scraper
===========================

Scrapes all posts from a specific Weibo user's profile page.
Extracts text, images, and repost/retweet content.

Usage:
  node scrape-weibo-user.js [options]

Options:
  --url <user-url>     Weibo user profile URL (default: built-in user)
  --profile <n>        Browser profile ID for login (default: 1)
  --count <n>          Max number of posts to scrape (default: 50)
  --start <n>          Skip first N posts, start scraping from N+1 (default: 0)
  --since <when>       Only scrape posts since this time
  --output-dir <dir>   Output directory
  --headless           Run browser in headless mode
  --scroll-delay <ms>  Delay between scrolls in ms (default: 2000)
  --help, -h           Show this help

--since values:
  today                Start of today (midnight)
  yesterday            Start of yesterday
  24h, 12h, 2h, 1h    Relative hours ago
  2d, 7d               Relative days ago
  30m, 90m             Relative minutes ago
  YYYY-MM-DD           Specific date

Examples:
  node scrape-weibo-user.js                                    # Default user, 50 posts
  node scrape-weibo-user.js --count 100                        # 100 posts
  node scrape-weibo-user.js --since today                      # Today's posts
  node scrape-weibo-user.js --url https://weibo.com/u/12345    # Custom user
`);
}

// ============================================================
// Image Utilities
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

function getBestQualityUrl(imgUrl) {
  if (!imgUrl) return imgUrl;
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
// Post Extraction (same DOM selectors as Weibo group scraper)
// ============================================================

async function extractVisiblePosts(page) {
  return await page.evaluate(() => {
    const articles = document.querySelectorAll('article');
    const results = [];

    for (const article of articles) {
      // --- Author ---
      const nameEl = article.querySelector('[class*="_name_"] span[title]')
        || article.querySelector('header span[title]');
      const authorName = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent.trim()) : '';

      const profileLink = article.querySelector('header a[href*="/u/"]');
      const authorUid = profileLink ? profileLink.getAttribute('href').replace(/.*\/u\//, '') : '';

      // --- Timestamp ---
      const timeEl = article.querySelector('a[class*="_time_"]');
      const timeText = timeEl ? timeEl.textContent.trim() : '';

      // --- Post text (original, not repost) ---
      const textEl = article.querySelector('.wbpro-feed-ogText [class*="_wbtext_"]')
        || article.querySelector('[class*="_wbtext_"]');
      let text = textEl ? textEl.innerText.trim() : '';
      // Clean up expand/collapse UI artifacts
      text = text.replace(/\s*\.\.\.展开\s*$/, '...');
      text = text.replace(/\s*收起\s*$/, '');

      // --- Images ---
      const images = [];
      const imgEls = article.querySelectorAll('[class*="_pic_"] img[src*="sinaimg.cn"], [class*="_img_"] img[src*="sinaimg.cn"], [class*="_media_"] img[src*="sinaimg.cn"]');
      for (const img of imgEls) {
        const src = img.src;
        if (src.includes('face.t.sinajs.cn')) continue;
        if (img.classList.contains('woo-avatar-img')) continue;
        if (src.includes('/upload/108/')) continue;
        images.push(src);
      }

      // Fallback: broader image search
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
            if (src.match(/wx\d\.sinaimg\.cn/)) images.push(src);
          }
        }
      }

      // --- Repost detection ---
      const repostEl = article.querySelector('[class*="_retweet_"]');
      const isRepost = repostEl !== null;

      let repostAuthor = '';
      let repostText = '';
      const repostImages = [];
      if (isRepost && repostEl) {
        // Try multiple selectors for repost author name
        const rpNameEl = repostEl.querySelector('a[class*="_name_"]')
          || repostEl.querySelector('span[class*="_nick_"]')
          || repostEl.querySelector('a[href*="/u/"] span');
        repostAuthor = rpNameEl ? rpNameEl.textContent.trim().replace(/^@/, '') : '';
        const rpTextEl = repostEl.querySelector('[class*="_wbtext_"]');
        repostText = rpTextEl ? rpTextEl.innerText.trim() : '';
        repostText = repostText.replace(/\s*\.\.\.展开\s*$/, '...');
        repostText = repostText.replace(/\s*收起\s*$/, '');

        // Repost images
        const rpImgEls = repostEl.querySelectorAll('img[src*="sinaimg.cn"]');
        for (const img of rpImgEls) {
          const src = img.src;
          if (src.includes('face.t.sinajs.cn')) continue;
          if (img.classList.contains('woo-avatar-img')) continue;
          if (src.includes('/upload/108/')) continue;
          if (src.includes('/crop.')) continue;
          if (src.match(/wx\d\.sinaimg\.cn/)) repostImages.push(src);
        }
      }

      const dedupKey = `${authorName}::${text.substring(0, 80)}::${timeText}`;

      results.push({
        authorName,
        authorUid,
        timeText,
        text,
        images,
        isRepost,
        repostAuthor,
        repostText,
        repostImages,
        dedupKey,
      });
    }

    return results;
  });
}

// ============================================================
// Expand Truncated Posts
// ============================================================

/**
 * Click all visible "展开" (expand) buttons to reveal full text of long posts.
 * Must be called before extracting post text from the DOM.
 * Returns the number of buttons clicked.
 */
async function expandAllPosts(page) {
  // Find and click all expand buttons visible in the current viewport
  const expandCount = await page.evaluate(() => {
    // Weibo expand buttons: text content is "展开" inside an anchor or span
    const expandBtns = [];
    // Selector 1: anchor tags with text "展开" commonly used in wbtext
    document.querySelectorAll('article').forEach(article => {
      // Look for the expand action inside the text area
      const textAreas = article.querySelectorAll('[class*="_wbtext_"], .wbpro-feed-ogText');
      textAreas.forEach(area => {
        const links = area.querySelectorAll('a, span');
        links.forEach(el => {
          if (el.textContent.trim() === '展开' || el.textContent.trim() === '...展开') {
            expandBtns.push(el);
          }
        });
      });
      // Also check retweet section
      const retweetEl = article.querySelector('[class*="_retweet_"]');
      if (retweetEl) {
        const links = retweetEl.querySelectorAll('a, span');
        links.forEach(el => {
          if (el.textContent.trim() === '展开' || el.textContent.trim() === '...展开') {
            expandBtns.push(el);
          }
        });
      }
    });
    return expandBtns.length;
  });

  if (expandCount > 0) {
    // Click them via Playwright (not page.evaluate) for proper event handling
    const buttons = await page.$$('article a, article span');
    let clicked = 0;
    for (const btn of buttons) {
      try {
        const text = await btn.textContent();
        if (text && (text.trim() === '展开' || text.trim() === '...展开')) {
          await btn.click({ timeout: 2000 });
          clicked++;
        }
      } catch {
        // Button may have disappeared after a previous click triggered DOM update
      }
    }
    if (clicked > 0) {
      // Wait briefly for content to expand
      await page.waitForTimeout(500);
    }
    return clicked;
  }
  return 0;
}

// ============================================================
// Scroll and Extract
// ============================================================

async function scrollAndExtractPosts(page, targetCount, scrollDelay, sinceDate, startOffset = 0) {
  const allPosts = new Map();       // posts we want to keep (after skipping)
  const seenKeys = new Set();       // all seen dedup keys (including skipped)
  let totalSeen = 0;                // total unique posts encountered
  let previousHeight = 0;
  let stableCount = 0;
  const totalNeeded = startOffset + targetCount;
  const maxScrollAttempts = sinceDate ? 150 : Math.max(50, Math.ceil(totalNeeded / 4));
  let oldPostStreak = 0;
  const OLD_POST_STREAK_LIMIT = 3;

  if (startOffset > 0) {
    console.log(`   ⏩ Skipping first ${startOffset} posts...`);
  }

  for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
    // Expand truncated posts before extraction
    const expanded = await expandAllPosts(page);
    if (expanded > 0) {
      console.log(`   📖 Expanded ${expanded} truncated post(s)`);
    }

    const visible = await extractVisiblePosts(page);

    const sizeBefore = allPosts.size;
    let foundOldPost = false;

    for (const post of visible) {
      if (seenKeys.has(post.dedupKey)) continue;
      seenKeys.add(post.dedupKey);

      const parsedTime = parseWeiboTime(post.timeText);
      post.parsedTime = parsedTime ? parsedTime.toISOString() : null;

      // Time cutoff check
      if (sinceDate && parsedTime && parsedTime.getTime() < sinceDate.getTime()) {
        foundOldPost = true;
        continue;
      }

      totalSeen++;

      // Skip posts before start offset
      if (totalSeen <= startOffset) continue;

      allPosts.set(post.dedupKey, post);
    }

    const currentSize = allPosts.size;
    const addedNew = currentSize > sizeBefore;

    // Track consecutive scrolls with only old posts
    if (sinceDate && foundOldPost && !addedNew) {
      oldPostStreak++;
    } else if (addedNew) {
      oldPostStreak = 0;
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
      const skipInfo = startOffset > 0 ? ` (skipped ${Math.min(totalSeen, startOffset)})` : '';
      const statusMsg = sinceDate
        ? `collected ${currentSize} posts (scrolling to time cutoff)${skipInfo}`
        : `collected ${currentSize}/${targetCount} posts${skipInfo}`;
      console.log(`   📜 Scroll #${attempt}: ${statusMsg}...`);
    }

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(scrollDelay);

    // Stable height detection
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableCount++;
      if (stableCount >= 5) {
        console.log(`   ⚠️  Page height stable after ${stableCount} scrolls, stopping`);
        break;
      }
    } else {
      stableCount = 0;
    }
    previousHeight = currentHeight;
  }

  console.log(`   📊 Total unique posts collected: ${allPosts.size}`);
  const posts = Array.from(allPosts.values());

  // Trim to target count if no --since
  if (!sinceDate && posts.length > targetCount) {
    return posts.slice(0, targetCount);
  }
  return posts;
}

// ============================================================
// Save Post
// ============================================================

async function savePost(post, index, outputDir) {
  const blogDir = path.join(outputDir, `blog-${index + 1}`);
  fs.mkdirSync(blogDir, { recursive: true });

  const allImages = [...post.images];
  const repostImageOffset = allImages.length;
  if (post.repostImages) allImages.push(...post.repostImages);

  // Build content.md
  const lines = [];
  lines.push(`# ${post.authorName}`);
  if (post.authorUid) lines.push(`**weibo.com/u/${post.authorUid}**`);
  lines.push('');

  const timeStr = post.parsedTime
    ? new Date(post.parsedTime).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
    : 'Unknown';
  lines.push(`**Date:** ${timeStr}`);
  lines.push(`**Original time:** ${post.timeText}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (post.isRepost) {
    lines.push(`> 🔁 **Reposted** (original by @${post.repostAuthor || 'unknown'})`);
    lines.push('');
  }

  if (post.text) {
    lines.push(post.text);
  } else {
    lines.push('*(no text)*');
  }

  // Main images
  if (post.images.length > 0) {
    lines.push('');
    lines.push('### Images');
    lines.push('');
    post.images.forEach((_, i) => {
      const ext = getImageExtension(post.images[i]);
      lines.push(`![image-${i + 1}](image-${i + 1}${ext})`);
    });
  }

  // Repost content
  if (post.isRepost && (post.repostText || (post.repostImages && post.repostImages.length > 0))) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Original Post');
    lines.push('');
    if (post.repostText) lines.push(`> ${post.repostText}`);
    if (post.repostImages && post.repostImages.length > 0) {
      lines.push('');
      post.repostImages.forEach((_, i) => {
        const idx = repostImageOffset + i + 1;
        const ext = getImageExtension(post.repostImages[i]);
        lines.push(`![image-${idx}](image-${idx}${ext})`);
      });
    }
  }

  lines.push('');
  fs.writeFileSync(path.join(blogDir, 'content.md'), lines.join('\n'), 'utf-8');

  // Download images
  const downloaded = await downloadImages(allImages, blogDir);
  return { imageCount: allImages.length, downloaded };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const config = parseArgs();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          👤 Weibo User Scraper                           ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  User URL: ${config.userUrl.substring(0, 47).padEnd(47)} ║`);
  console.log(`║  Profile:  ${String(config.profileId).padEnd(47)} ║`);
  if (config.start > 0) {
    console.log(`║  Start:    ${String(config.start).padEnd(47)} ║`);
  }
  if (config.sinceDate) {
    console.log(`║  Since:    ${(config.since + ' → ' + formatCutoff(config.sinceDate)).substring(0, 47).padEnd(47)} ║`);
    console.log(`║  Max count:${String(config.count).padEnd(47)} ║`);
  } else {
    console.log(`║  Count:    ${String(config.count).padEnd(47)} ║`);
  }
  console.log(`║  Headless: ${String(config.headless).padEnd(47)} ║`);
  console.log(`║  Output:   ${config.outputDir.substring(0, 47).padEnd(47)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // NO CACHE for weibo user scraper - user posts are dynamic and should always be fetched fresh

  // Browser setup
  const userDataDir = path.join(PROJECT_ROOT, 'browser-profiles', `browser-${config.profileId}`);
  if (!fs.existsSync(userDataDir)) {
    console.error(`❌ Browser profile not found: ${userDataDir}`);
    console.error(`   Run 'node launch-browser.js ${config.profileId}' first.`);
    process.exit(1);
  }

  console.log(`\n🚀 Launching browser with profile #${config.profileId}...`);
  console.log(`   📂 ${userDataDir}`);

  const launchOptions = {
    channel: 'chrome',
    headless: config.headless,
    viewport: config.headless ? { width: 1280, height: 900 } : null,
  };

  // Proxy config
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
        console.log(`   🌐 Using proxy: ${proxy.server}`);
      }
    } catch {}
  }

  const browser = await chromium.launchPersistentContext(userDataDir, launchOptions);
  try { await browser.grantPermissions(['clipboard-read', 'clipboard-write']); } catch {}
  const page = await browser.newPage();

  try {
    // Navigate to user profile
    console.log(`\n🌐 Navigating to user profile...`);
    await page.goto(config.userUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check for login wall
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    if (pageText.includes('登录') && pageText.length < 200) {
      console.error('❌ Login required. Please log in first:');
      console.error(`   node launch-browser.js ${config.profileId}`);
      console.error('   Then navigate to weibo.com and log in manually.');
      process.exit(1);
    }

    // Wait for feed to load
    console.log('   ⏳ Waiting for feed to load...');
    try {
      await page.waitForSelector('article', { timeout: 15000 });
      console.log('   ✅ Feed loaded');
    } catch {
      console.error('❌ Could not find any posts on the page.');
      console.error(`   Page title: ${pageTitle}`);
      process.exit(1);
    }

    // Get username from page
    const username = await page.evaluate(() => {
      const el = document.querySelector('[class*="_name_"] span[title]');
      return el ? el.getAttribute('title') : '';
    });
    if (username) console.log(`   👤 User: ${username}`);

    // Scroll and extract
    const startInfo = config.start > 0 ? `, starting from #${config.start + 1}` : '';
    if (config.sinceDate) {
      console.log(`\n📜 Loading posts since ${formatCutoff(config.sinceDate)} (max ${config.count}${startInfo})...`);
    } else {
      console.log(`\n📜 Loading posts (target: ${config.count}${startInfo})...`);
    }

    const posts = await scrollAndExtractPosts(page, config.count, config.scrollDelay, config.sinceDate, config.start);

    if (posts.length === 0) {
      console.error('❌ No posts extracted.');
      process.exit(1);
    }

    console.log(`\n   ✅ Extracted ${posts.length} posts`);

    // Clear and create output directory
    if (fs.existsSync(config.outputDir)) {
      console.log(`\n🗑️  Clearing existing output: ${config.outputDir}/`);
      fs.rmSync(config.outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(config.outputDir, { recursive: true });

    // Save posts
    console.log(`\n💾 Saving posts to ${config.outputDir}/`);
    const summary = [];

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const rpTag = post.isRepost ? '🔁 Repost of @' + (post.repostAuthor || 'unknown') : '';
      const textPreview = (post.text || '(no text)').substring(0, 60).replace(/\n/g, ' ');

      console.log(`\n   [${i + 1}/${posts.length}] ${post.authorName}`);
      if (rpTag) console.log(`      ${rpTag}`);
      console.log(`      📝 ${textPreview}...`);
      console.log(`      🖼️  ${post.images.length + (post.repostImages?.length || 0)} image(s)`);
      console.log(`      🕐 ${post.timeText}`);

      const result = await savePost(post, i, config.outputDir);
      summary.push({
        index: i + 1,
        author: post.authorName,
        isRepost: post.isRepost,
        images: result.imageCount,
        downloaded: result.downloaded,
      });
      console.log(`      ✅ Saved to blog-${i + 1}/`);
    }

    // Summary table
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║          ✅ Scraping Complete                            ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Posts scraped: ${String(posts.length).padEnd(42)} ║`);
    console.log(`║  Output:        ${config.outputDir.substring(0, 42).padEnd(42)} ║`);
    if (username) {
      console.log(`║  User:          ${username.substring(0, 42).padEnd(42)} ║`);
    }
    console.log('╠═══════════════════════════════════════════════════════════╣');
    for (const s of summary) {
      const rp = s.isRepost ? 'RP ' : '   ';
      const name = s.author.substring(0, 20).padEnd(20);
      const imgs = `${s.downloaded}/${s.images} imgs`;
      console.log(`║  blog-${String(s.index).padEnd(4)} ${rp} ${name} ${imgs.padEnd(18)} ║`);
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
