#!/usr/bin/env node
/**
 * Twitter/X List Scraper
 * 
 * Scrapes tweets (text + images) from an X list timeline.
 * Uses existing browser profiles with patchright (Playwright fork) for authentication.
 * 
 * Output structure:
 *   twitter-YYYY-MM-DD/
 *     blog-1/
 *       content.md
 *       image-1.jpg
 *       image-2.jpg
 *     blog-2/
 *       content.md
 *     ...
 * 
 * Usage:
 *   node scrape-twitter-list.js                          # Defaults: profile 1, 5 tweets
 *   node scrape-twitter-list.js --profile 3              # Use browser profile 3
 *   node scrape-twitter-list.js --count 10               # Scrape 10 tweets
 *   node scrape-twitter-list.js --since today            # Scrape all tweets from today
 *   node scrape-twitter-list.js --since yesterday        # Scrape tweets since yesterday
 *   node scrape-twitter-list.js --since 24h              # Scrape last 24 hours
 *   node scrape-twitter-list.js --since 2d               # Scrape last 2 days
 *   node scrape-twitter-list.js --since 2026-02-09       # Scrape since specific date
 *   node scrape-twitter-list.js --url <list-url>         # Custom list URL
 *   node scrape-twitter-list.js --output-dir ./my-output # Custom output directory
 *   node scrape-twitter-list.js --headless               # Run headless (no browser window)
 *   node scrape-twitter-list.js --scroll-delay 3000      # Custom scroll delay (ms)
 */

const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');
const { loadProxyConfig } = require('../../proxy-utils');
const https = require('https');
const http = require('http');

// ============================================================
// Configuration
// ============================================================

const DEFAULT_LIST_URL = 'https://x.com/i/lists/1319301370084610048';
const DEFAULT_PROFILE_ID = 1;
const DEFAULT_COUNT = 5;
const DEFAULT_SCROLL_DELAY = 2000;
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ============================================================
// Time Filter
// ============================================================

/**
 * Parse a --since value into a cutoff Date.
 * Supports:
 *   "today"          → start of today (00:00 local time)
 *   "yesterday"      → start of yesterday (00:00 local time)
 *   "24h", "12h"     → N hours ago
 *   "2d", "7d"       → N days ago
 *   "30m", "90m"     → N minutes ago
 *   "YYYY-MM-DD"     → start of that date (local time)
 * Returns a Date object or null if parsing fails.
 */
function parseSince(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();

  // Named shortcuts
  if (v === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (v === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Relative: Nh (hours)
  const hoursMatch = v.match(/^(\d+)h$/);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1], 10);
    return new Date(Date.now() - hours * 60 * 60 * 1000);
  }

  // Relative: Nd (days)
  const daysMatch = v.match(/^(\d+)d$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  // Relative: Nm (minutes)
  const minsMatch = v.match(/^(\d+)m$/);
  if (minsMatch) {
    const mins = parseInt(minsMatch[1], 10);
    return new Date(Date.now() - mins * 60 * 1000);
  }

  // Absolute date: YYYY-MM-DD
  const dateMatch = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    const d = new Date(v + 'T00:00:00');
    if (!isNaN(d.getTime())) return d;
  }

  // Absolute datetime: YYYY-MM-DDTHH:MM
  const dtMatch = v.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (dtMatch) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Format a cutoff date for display.
 */
function formatCutoff(date) {
  if (!date) return 'none';
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// ============================================================
// CLI Argument Parser
// ============================================================

const MAX_SINCE_COUNT = 500; // safety limit when using --since

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    listUrl: DEFAULT_LIST_URL,
    profileId: DEFAULT_PROFILE_ID,
    count: DEFAULT_COUNT,
    since: null,        // --since raw value
    sinceDate: null,    // parsed Date cutoff
    outputDir: null,    // will be set after parsing
    headless: false,
    scrollDelay: DEFAULT_SCROLL_DELAY,
    cache: true,        // cache enabled by default
  };

  let hasExplicitCount = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--profile':
        if (!next) throw new Error('--profile requires a number');
        config.profileId = parseInt(next, 10);
        i++;
        break;
      case '--count':
        if (!next) throw new Error('--count requires a number');
        config.count = parseInt(next, 10);
        hasExplicitCount = true;
        i++;
        break;
      case '--since':
        if (!next) throw new Error('--since requires a value (e.g. today, yesterday, 24h, 2d, 2026-02-09)');
        config.since = next;
        config.sinceDate = parseSince(next);
        if (!config.sinceDate) {
          console.error(`❌ Invalid --since value: "${next}"`);
          console.error('   Supported: today, yesterday, 24h, 12h, 2d, 7d, 30m, YYYY-MM-DD');
          process.exit(1);
        }
        i++;
        break;
      case '--url':
        if (!next) throw new Error('--url requires a URL');
        config.listUrl = next;
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
      case '--scroll-delay':
        if (!next) throw new Error('--scroll-delay requires a number');
        config.scrollDelay = parseInt(next, 10);
        i++;
        break;
      case '--no-cache':
        config.cache = false;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.warn(`⚠️  Unknown argument: ${arg}`);
    }
  }

  // When --since is used without explicit --count, raise the limit
  if (config.sinceDate && !hasExplicitCount) {
    config.count = MAX_SINCE_COUNT;
  }

  // Default output directory: twitter-YYYY-MM-DD under twitter-task/
  if (!config.outputDir) {
    const dateStr = new Date().toISOString().split('T')[0];
    config.outputDir = path.join(__dirname, `twitter-${dateStr}`);
  }

  return config;
}

function printUsage() {
  console.log(`
Twitter/X List Scraper

Usage: node scrape-twitter-list.js [options]

Options:
  --profile <id>       Browser profile ID (default: 1)
  --count <n>          Number of tweets to scrape (default: 5)
  --since <when>       Only scrape tweets since this time (stops scrolling at cutoff)
  --url <list-url>     X list URL (default: built-in list)
  --output-dir <dir>   Output directory (default: twitter-YYYY-MM-DD/)
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

Note: --since removes the default 5-tweet limit. Add --count N to cap results.

Cache behavior:
  By default, if output directory exists, scraping is skipped.
  Use --no-cache to force regeneration.

Examples:
  node scrape-twitter-list.js                              # Latest 5 tweets
  node scrape-twitter-list.js --since today                # All tweets from today
  node scrape-twitter-list.js --since yesterday             # Since yesterday
  node scrape-twitter-list.js --since 24h                  # Last 24 hours
  node scrape-twitter-list.js --since 2d --count 20        # Last 2 days, max 20
  node scrape-twitter-list.js --since 2026-02-09           # Since Feb 9, 2026
  node scrape-twitter-list.js --profile 3 --since today    # Profile 3, today's tweets
  node scrape-twitter-list.js --no-cache                   # Force regeneration
`);
}

// ============================================================
// Image Downloader
// ============================================================

/**
 * Download an image from a URL to a local file path.
 * Follows redirects and handles both http/https.
 */
function downloadImage(url, filepath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { timeout: 30000 }, (response) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        return downloadImage(response.headers.location, filepath, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }

      const fileStream = fs.createWriteStream(filepath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(filepath);
      });

      fileStream.on('error', (err) => {
        fs.unlink(filepath, () => { }); // cleanup partial file
        reject(err);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}

/**
 * Get the best quality image URL from an X/Twitter image URL.
 * Replaces size parameter with 'orig' for maximum resolution.
 */
function getBestQualityUrl(imgUrl) {
  if (!imgUrl) return imgUrl;
  try {
    const url = new URL(imgUrl);
    if (url.hostname === 'pbs.twimg.com') {
      url.searchParams.set('name', 'orig');
      return url.toString();
    }
    return imgUrl;
  } catch {
    return imgUrl;
  }
}

/**
 * Determine image file extension from URL.
 */
function getImageExtension(imgUrl) {
  try {
    const url = new URL(imgUrl);
    const format = url.searchParams.get('format');
    if (format) return `.${format}`;

    const pathname = url.pathname;
    const ext = path.extname(pathname);
    if (ext && ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext.toLowerCase())) {
      return ext;
    }
    return '.jpg'; // default
  } catch {
    return '.jpg';
  }
}

// ============================================================
// Tweet Extraction
// ============================================================

/**
 * Extract tweets from the page using page.evaluate.
 * Returns an array of tweet objects with text, images, author, timestamp, URL.
 */
async function extractTweetsFromPage(page, count, cutoffISO = null) {
  return await page.evaluate(({ targetCount, cutoffISO }) => {
    // Try specific selector first, fall back to generic article
    let articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length === 0) {
      articles = document.querySelectorAll('article[role="article"]');
    }
    if (articles.length === 0) {
      articles = document.querySelectorAll('article');
    }
    const results = [];
    const seenUrls = new Set();

    /**
     * Helper: extract author info from a User-Name container element.
     */
    function extractAuthor(container) {
      let name = '';
      let handle = '';
      if (!container) return { name, handle };

      const nameLinks = container.querySelectorAll('a');
      if (nameLinks.length > 0) {
        name = nameLinks[0].textContent.trim();
        const handleHref = nameLinks[0].getAttribute('href');
        if (handleHref) {
          handle = handleHref.replace('/', '@');
        }
      }
      // Look for explicit @handle span
      const spans = container.querySelectorAll('span');
      for (const span of spans) {
        if (span.textContent.trim().startsWith('@')) {
          handle = span.textContent.trim();
          break;
        }
      }
      return { name, handle };
    }

    /**
     * Helper: extract images from a container, excluding quote tweet zone.
     * If excludeEl is provided, skip images that are descendants of it.
     */
    function extractImages(container, excludeEl) {
      const images = [];
      const photoContainers = container.querySelectorAll('[data-testid="tweetPhoto"]');
      for (const photo of photoContainers) {
        // Skip images inside the quoted tweet
        if (excludeEl && excludeEl.contains(photo)) continue;
        const img = photo.querySelector('img');
        if (img && img.src && !img.src.includes('emoji') && !img.src.includes('hashflag')) {
          images.push(img.src);
        }
      }
      // Video thumbnail fallback
      if (images.length === 0) {
        const videos = container.querySelectorAll('video[poster]');
        for (const video of videos) {
          if (excludeEl && excludeEl.contains(video)) continue;
          if (video.poster) images.push(video.poster);
        }
      }
      return images;
    }

    for (const article of articles) {
      if (results.length >= targetCount) break;

      // --- Retweet / Repost detection ---
      const socialContext = article.querySelector('[data-testid="socialContext"]');
      const isRetweet = socialContext
        ? (socialContext.textContent.includes('reposted') || socialContext.textContent.includes('retweeted'))
        : false;

      // Extract retweeter name (the person who reposted)
      let retweeterName = '';
      let retweeterHandle = '';
      if (isRetweet && socialContext) {
        // socialContext contains "[Name] reposted" with a link to the retweeter
        const retweeterLink = socialContext.querySelector('a[href]');
        if (retweeterLink) {
          retweeterName = retweeterLink.textContent.trim().replace(/\s*reposted.*$/i, '').replace(/\s*retweeted.*$/i, '');
          const href = retweeterLink.getAttribute('href');
          if (href) retweeterHandle = href.replace('/', '@');
        }
        if (!retweeterName) {
          // Fallback: parse the full text
          retweeterName = socialContext.textContent.replace(/reposted/i, '').replace(/retweeted/i, '').trim();
        }
      }

      // --- Quote tweet element (we need to isolate it from the main tweet) ---
      const quoteTweetEl = article.querySelector('[data-testid="quoteTweet"]');
      const hasQuote = quoteTweetEl !== null;

      // --- Tweet URL (from the main tweet, not the quote) ---
      let tweetUrl = '';
      const tweetLinks = article.querySelectorAll('a[href*="/status/"]');
      for (const link of tweetLinks) {
        // Skip links inside quote tweet
        if (quoteTweetEl && quoteTweetEl.contains(link)) continue;
        const href = link.getAttribute('href');
        if (href && href.match(/^\/[^/]+\/status\/\d+$/) && !seenUrls.has(href)) {
          tweetUrl = `https://x.com${href}`;
          break;
        }
      }

      // Skip duplicates
      if (tweetUrl && seenUrls.has(tweetUrl)) continue;
      if (tweetUrl) seenUrls.add(tweetUrl);

      // --- Original tweet author (the actual content author) ---
      const userNameContainer = article.querySelector('[data-testid="User-Name"]');
      const author = extractAuthor(userNameContainer);

      // --- Timestamp ---
      const timeEls = article.querySelectorAll('time');
      let timestamp = '';
      let timeDisplay = '';
      for (const t of timeEls) {
        if (quoteTweetEl && quoteTweetEl.contains(t)) continue;
        timestamp = t.getAttribute('datetime') || '';
        timeDisplay = t.textContent.trim();
        break;
      }

      // --- Time cutoff check: skip tweets older than cutoff ---
      if (cutoffISO && timestamp) {
        const tweetTime = new Date(timestamp).getTime();
        const cutoffTime = new Date(cutoffISO).getTime();
        if (tweetTime < cutoffTime) {
          continue; // skip old tweet, don't break — list order may not be strict
        }
      }

      // --- Main tweet text (excluding quote tweet text) ---
      let text = '';
      const tweetTextEls = article.querySelectorAll('[data-testid="tweetText"]');
      for (const textEl of tweetTextEls) {
        if (quoteTweetEl && quoteTweetEl.contains(textEl)) continue;
        text = textEl.innerText.trim();
        break;
      }

      // --- Main tweet images (excluding quote tweet images) ---
      const images = extractImages(article, quoteTweetEl);

      // --- Quote tweet content (original tweet being quoted) ---
      let quotedTweet = null;
      if (hasQuote && quoteTweetEl) {
        // Quoted author
        const quotedUserName = quoteTweetEl.querySelector('[data-testid="User-Name"]');
        const quotedAuthor = extractAuthor(quotedUserName);

        // Quoted text
        const quotedTextEl = quoteTweetEl.querySelector('[data-testid="tweetText"]');
        const quotedText = quotedTextEl ? quotedTextEl.innerText.trim() : '';

        // Quoted images
        const quotedImages = extractImages(quoteTweetEl, null);

        // Quoted timestamp
        const quotedTimeEl = quoteTweetEl.querySelector('time');
        const quotedTimestamp = quotedTimeEl ? quotedTimeEl.getAttribute('datetime') : '';

        // Quoted URL
        let quotedUrl = '';
        const quotedLinks = quoteTweetEl.querySelectorAll('a[href*="/status/"]');
        for (const link of quotedLinks) {
          const href = link.getAttribute('href');
          if (href && href.match(/^\/[^/]+\/status\/\d+$/)) {
            quotedUrl = `https://x.com${href}`;
            break;
          }
        }

        quotedTweet = {
          authorName: quotedAuthor.name,
          authorHandle: quotedAuthor.handle,
          text: quotedText,
          images: quotedImages,
          timestamp: quotedTimestamp,
          tweetUrl: quotedUrl,
        };
      }

      results.push({
        text,
        images,
        authorName: author.name,
        authorHandle: author.handle,
        timestamp,
        timeDisplay,
        tweetUrl,
        hasQuote,
        isRetweet,
        retweeterName,
        retweeterHandle,
        quotedTweet,
      });
    }

    return results;
  }, { targetCount: count, cutoffISO });
}

/**
 * Check if the oldest visible tweet on the page is older than the cutoff.
 * Returns true if we've scrolled past the cutoff boundary.
 */
async function hasScrolledPastCutoff(page, cutoffISO) {
  if (!cutoffISO) return false;
  return await page.evaluate((cutoff) => {
    const articles = document.querySelectorAll('article[data-testid="tweet"], article[role="article"], article');
    if (articles.length === 0) return false;
    // Check the last (oldest) article's timestamp
    const lastArticle = articles[articles.length - 1];
    const timeEl = lastArticle.querySelector('time');
    if (!timeEl) return false;
    const ts = timeEl.getAttribute('datetime');
    if (!ts) return false;
    return new Date(ts).getTime() < new Date(cutoff).getTime();
  }, cutoffISO);
}

/**
 * Scroll the page to load more tweets until we have enough or pass the time cutoff.
 */
async function scrollToLoadTweets(page, targetCount, scrollDelay, cutoffISO = null) {
  let previousHeight = 0;
  let stableCount = 0;
  // Allow more scrolls when using time-based cutoff
  const maxScrollAttempts = cutoffISO ? 100 : 20;

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // Check how many tweets we have
    const currentCount = await page.evaluate(() => {
      let count = document.querySelectorAll('article[data-testid="tweet"]').length;
      if (count === 0) count = document.querySelectorAll('article[role="article"]').length;
      if (count === 0) count = document.querySelectorAll('article').length;
      return count;
    });

    // Count-based stop (no --since)
    if (!cutoffISO && currentCount >= targetCount) {
      console.log(`   ✅ Found ${currentCount} tweets (need ${targetCount})`);
      return currentCount;
    }

    // Safety max count with --since
    if (cutoffISO && currentCount >= targetCount) {
      console.log(`   ⚠️  Reached max count limit (${targetCount}), stopping scroll`);
      return currentCount;
    }

    // Time-based stop: check if the oldest visible tweet is past the cutoff
    if (cutoffISO && await hasScrolledPastCutoff(page, cutoffISO)) {
      console.log(`   ✅ Reached time cutoff, found ${currentCount} tweets in range`);
      return currentCount;
    }

    const statusMsg = cutoffISO
      ? `found ${currentCount} tweets (scrolling to time cutoff)`
      : `found ${currentCount}/${targetCount} tweets`;
    console.log(`   📜 Scroll #${attempt + 1}: ${statusMsg}...`);

    // Scroll down
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 2);
    });

    await page.waitForTimeout(scrollDelay);

    // Check if page height changed (new content loaded)
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

  const finalCount = await page.evaluate(() => {
    let count = document.querySelectorAll('article[data-testid="tweet"]').length;
    if (count === 0) count = document.querySelectorAll('article[role="article"]').length;
    if (count === 0) count = document.querySelectorAll('article').length;
    return count;
  });
  console.log(`   📊 Total tweets found after scrolling: ${finalCount}`);
  return finalCount;
}

// ============================================================
// Output
// ============================================================

/**
 * Download a list of images with best-quality URLs, returning count of successes.
 * Images are named image-{startIndex+1}, image-{startIndex+2}, etc.
 */
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
      // Fallback to original URL
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

/**
 * Save a tweet to a blog subfolder with content.md and images.
 * Handles retweets (shows retweeter + original) and quote tweets (shows both).
 */
async function saveTweet(tweet, index, outputDir) {
  const blogDir = path.join(outputDir, `blog-${index + 1}`);
  fs.mkdirSync(blogDir, { recursive: true });

  // Collect all images to download (main tweet + quoted tweet)
  const allImages = [...tweet.images];
  if (tweet.quotedTweet && tweet.quotedTweet.images) {
    allImages.push(...tweet.quotedTweet.images);
  }

  // --- Build content.md ---
  const lines = [];

  // === Retweet header ===
  if (tweet.isRetweet && tweet.retweeterName) {
    lines.push(`> 🔁 **Reposted by ${tweet.retweeterName}** ${tweet.retweeterHandle ? `(${tweet.retweeterHandle})` : ''}`);
    lines.push('');
  }

  // === Main tweet author ===
  if (tweet.authorName) {
    lines.push(`# ${tweet.authorName}`);
    if (tweet.authorHandle) {
      lines.push(`**${tweet.authorHandle}**`);
    }
  } else {
    lines.push(`# Tweet ${index + 1}`);
  }

  lines.push('');

  // Metadata
  if (tweet.timestamp) {
    const date = new Date(tweet.timestamp);
    lines.push(`**Date:** ${date.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`);
  }
  if (tweet.tweetUrl) {
    lines.push(`**URL:** ${tweet.tweetUrl}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Main tweet text
  if (tweet.text) {
    lines.push(tweet.text);
  } else {
    lines.push('*(No text content)*');
  }

  // Main tweet images
  if (tweet.images.length > 0) {
    lines.push('');
    lines.push('### Images');
    lines.push('');
    for (let i = 0; i < tweet.images.length; i++) {
      const ext = getImageExtension(tweet.images[i]);
      lines.push(`![image-${i + 1}](image-${i + 1}${ext})`);
    }
  }

  // === Quoted / Original tweet ===
  if (tweet.quotedTweet) {
    const qt = tweet.quotedTweet;
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Quoted Tweet (Original)');
    lines.push('');

    if (qt.authorName) {
      lines.push(`**${qt.authorName}** ${qt.authorHandle ? `(${qt.authorHandle})` : ''}`);
    }
    if (qt.timestamp) {
      const qDate = new Date(qt.timestamp);
      lines.push(`**Date:** ${qDate.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`);
    }
    if (qt.tweetUrl) {
      lines.push(`**URL:** ${qt.tweetUrl}`);
    }

    lines.push('');

    if (qt.text) {
      lines.push(`> ${qt.text.split('\n').join('\n> ')}`);
    } else {
      lines.push('> *(No text content)*');
    }

    // Quoted tweet images (numbered continuing from main images)
    if (qt.images && qt.images.length > 0) {
      const offset = tweet.images.length;
      lines.push('');
      lines.push('### Quoted Tweet Images');
      lines.push('');
      for (let i = 0; i < qt.images.length; i++) {
        const ext = getImageExtension(qt.images[i]);
        lines.push(`![image-${offset + i + 1}](image-${offset + i + 1}${ext})`);
      }
    }
  }

  lines.push('');

  const contentPath = path.join(blogDir, 'content.md');
  fs.writeFileSync(contentPath, lines.join('\n'), 'utf-8');

  // --- Download all images (main + quoted) ---
  const downloadedCount = await downloadImages(allImages, blogDir);

  return { blogDir, downloadedCount, totalImages: allImages.length };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const config = parseArgs();

  const cutoffISO = config.sinceDate ? config.sinceDate.toISOString() : null;

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          🐦 Twitter/X List Scraper                       ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  List URL:  ${config.listUrl.substring(0, 46).padEnd(46)} ║`);
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

  // Resolve browser profile path
  const userDataDir = path.join(PROJECT_ROOT, 'browser-profiles', `browser-${config.profileId}`);

  if (!fs.existsSync(userDataDir)) {
    console.error(`❌ Browser profile not found: ${userDataDir}`);
    console.error(`   Run 'node launch-browser.js ${config.profileId}' first to create the profile and log in to X.`);
    process.exit(1);
  }

  console.log(`🚀 Launching browser with profile #${config.profileId}...`);
  console.log(`   📂 ${userDataDir}`);

  let context = null;

  try {
    // Launch browser with persistent context (reuses cookies/login state)
    const launchOptions = {
      channel: 'chrome',
      headless: config.headless,
      viewport: config.headless ? { width: 1280, height: 900 } : null,
    };

    // Load proxy config if PROXY_TASKS includes "twitter"
    const proxy = loadProxyConfig('twitter', config.profileId - 1);
    if (proxy) {
      launchOptions.proxy = proxy;
      console.log(`   🔒 Proxy: ${proxy.server}`);
    }

    context = await chromium.launchPersistentContext(userDataDir, launchOptions);

    // Grant clipboard permissions
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    } catch { /* not critical */ }

    const page = await context.newPage();

    try {
      // Navigate to the list
      console.log(`\n🌐 Navigating to X list...`);
      await page.goto(config.listUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Wait for tweets to appear — try multiple selectors
      console.log('   ⏳ Waiting for tweets to load...');
      const tweetSelectors = [
        'article[data-testid="tweet"]',
        'article[role="article"]',
        'article',
      ];

      let foundSelector = null;
      let retryCount = 0;
      const MAX_PAGE_RETRIES = 3;

      while (retryCount < MAX_PAGE_RETRIES) {
        // Check for "Something went wrong"
        const errorText = await page.evaluate(() => {
          const body = document.body.innerText;
          if (body.includes('Something went wrong. Try reloading.')) return 'error';
          if (body.includes('Retry')) return 'retry_button';
          return null;
        });

        if (errorText) {
          console.log(`   ⚠️  Detected X error: "${errorText}". Retrying reload (${retryCount + 1}/${MAX_PAGE_RETRIES})...`);
          // Try clicking Retry button first if it exists
          try {
            const retryButton = await page.getByRole('button', { name: 'Retry', exact: true }).first();
            if (await retryButton.isVisible()) {
              await retryButton.click();
            } else {
              await page.reload({ waitUntil: 'domcontentloaded' });
            }
          } catch {
            await page.reload({ waitUntil: 'domcontentloaded' });
          }
          await page.waitForTimeout(5000);
          retryCount++;
          continue;
        }

        for (const selector of tweetSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 10000 });
            foundSelector = selector;
            console.log(`   ✅ Found tweets with selector: ${selector}`);
            break;
          } catch {
            console.log(`   ⚠️  Selector "${selector}" not found, trying next...`);
          }
        }

        if (foundSelector) break;

        console.log(`   ⚠️  No tweets found, but no explicit error detected. Reloading...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        retryCount++;
      }

      if (!foundSelector) {
        // Take a debug screenshot
        const debugScreenshot = path.join(__dirname, 'debug-screenshot.png');
        await page.screenshot({ path: debugScreenshot, fullPage: false });
        console.log(`   📸 Debug screenshot saved: ${debugScreenshot}`);

        // Check page content for clues
        const pageUrl = page.url();
        const pageTitle = await page.title().catch(() => 'unknown');
        const bodyText = await page.textContent('body').catch(() => '');
        const snippet = bodyText.substring(0, 500).replace(/\s+/g, ' ');

        console.log(`   🔍 Page URL: ${pageUrl}`);
        console.log(`   🔍 Page title: ${pageTitle}`);
        console.log(`   🔍 Page content preview: ${snippet}`);

        if (bodyText.includes('Log in') || bodyText.includes('Sign in') || bodyText.includes('Sign up')) {
          console.error('\n❌ Not logged in to X. Please log in first:');
          console.error(`   1. Run: node launch-browser.js ${config.profileId}`);
          console.error('   2. Log in to X/Twitter in the browser');
          console.error('   3. Close the browser and run this script again');
        } else {
          console.error('\n❌ No tweets found on page. The page may have failed to load.');
          console.error('   Check the debug screenshot for details.');
          console.error('   Try running again, or check the URL.');
        }
        process.exit(1);
      }

      // Extra wait for images and dynamic content
      await page.waitForTimeout(3000);

      // Scroll to load enough tweets
      if (cutoffISO) {
        console.log(`\n📜 Loading tweets since ${formatCutoff(config.sinceDate)} (max ${config.count})...`);
      } else {
        console.log(`\n📜 Loading tweets (target: ${config.count})...`);
      }
      await scrollToLoadTweets(page, config.count, config.scrollDelay, cutoffISO);

      // Extract tweets
      console.log(`\n🔍 Extracting tweet data...`);
      const tweets = await extractTweetsFromPage(page, config.count, cutoffISO);

      if (tweets.length === 0) {
        console.error('❌ No tweets extracted. The page structure may have changed.');
        process.exit(1);
      }

      console.log(`   ✅ Extracted ${tweets.length} tweets`);

      // Clear existing output directory and create fresh
      if (fs.existsSync(config.outputDir)) {
        console.log(`\n🗑️  Clearing existing output: ${config.outputDir}/`);
        fs.rmSync(config.outputDir, { recursive: true, force: true });
      }
      fs.mkdirSync(config.outputDir, { recursive: true });

      // Save each tweet
      console.log(`\n💾 Saving tweets to ${config.outputDir}/`);
      const summary = [];

      for (let i = 0; i < tweets.length; i++) {
        const tweet = tweets[i];
        const authorDisplay = tweet.authorHandle || tweet.authorName || `Tweet ${i + 1}`;
        const textPreview = tweet.text ? tweet.text.substring(0, 60).replace(/\n/g, ' ') + '...' : '(no text)';
        const totalImages = tweet.images.length + (tweet.quotedTweet?.images?.length || 0);

        console.log(`\n   [${i + 1}/${tweets.length}] ${authorDisplay}`);
        if (tweet.isRetweet) {
          console.log(`      🔁 Reposted by: ${tweet.retweeterName || 'unknown'} ${tweet.retweeterHandle || ''}`);
        }
        console.log(`      📝 ${textPreview}`);
        console.log(`      🖼️  ${totalImages} image(s)${tweet.hasQuote ? ' (incl. quoted tweet)' : ''}`);
        if (tweet.hasQuote && tweet.quotedTweet) {
          const qt = tweet.quotedTweet;
          const qtAuthor = qt.authorHandle || qt.authorName || 'unknown';
          const qtPreview = qt.text ? qt.text.substring(0, 50).replace(/\n/g, ' ') + '...' : '(no text)';
          console.log(`      💬 Quotes ${qtAuthor}: ${qtPreview}`);
        }

        const result = await saveTweet(tweet, i, config.outputDir);
        summary.push({
          index: i + 1,
          author: authorDisplay,
          type: tweet.isRetweet ? 'RT' : tweet.hasQuote ? 'QT' : '',
          text: tweet.text.substring(0, 100),
          images: result.totalImages,
          downloaded: result.downloadedCount,
          dir: result.blogDir,
        });

        console.log(`      ✅ Saved to blog-${i + 1}/`);
      }

      // Print summary
      console.log('\n');
      console.log('╔═══════════════════════════════════════════════════════════╗');
      console.log('║          ✅ Scraping Complete                             ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║  Tweets scraped: ${String(tweets.length).padEnd(41)} ║`);
      console.log(`║  Output:         ${config.outputDir.substring(0, 41).padEnd(41)} ║`);
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
      await page.close().catch(() => { });
    }

  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (context) {
      await context.close().catch(() => { });
      console.log('🔄 Browser closed');
    }
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Interrupted by user');
  process.exit(0);
});

// Run
main().catch((err) => {
  console.error('❌ Unhandled error:', err);
  process.exit(1);
});
