#!/usr/bin/env node
/**
 * Twitter/X User Timeline Scraper
 *
 * Scrapes posts from a single X profile into one markdown blog per post.
 * Default target is https://x.com/aimikoda and the default cutoff is
 * 2026-02-07T00:00:00 local time, so posts on Feb 7 are included.
 *
 * Supports resume through crawl-state.json in the output directory.
 */

const { chromium } = require('patchright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { loadProxyConfig } = require('../../proxy-utils');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_PROFILE_ID = 1;
const DEFAULT_URL = 'https://x.com/aimikoda';
const DEFAULT_HANDLE = 'aimikoda';
const DEFAULT_UNTIL = `${new Date().getFullYear()}-02-07`;
const DEFAULT_SCROLL_DELAY = 2000;
const DEFAULT_MAX_POSTS = 1000;
const DEFAULT_MAX_SCROLLS = 300;

function sanitizeFilePart(input, fallback = 'post') {
  const value = String(input || '')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return value || fallback;
}

function parseLocalDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: DEFAULT_URL,
    handle: DEFAULT_HANDLE,
    profileId: DEFAULT_PROFILE_ID,
    until: DEFAULT_UNTIL,
    untilDate: parseLocalDate(DEFAULT_UNTIL),
    outputDir: null,
    headless: false,
    scrollDelay: DEFAULT_SCROLL_DELAY,
    maxPosts: DEFAULT_MAX_POSTS,
    maxScrolls: DEFAULT_MAX_SCROLLS,
    resume: true,
    includeReposts: false,
    downloadImages: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--url':
        if (!next) throw new Error('--url requires a URL');
        config.url = next;
        i += 1;
        break;
      case '--handle':
        if (!next) throw new Error('--handle requires a username');
        config.handle = next.replace(/^@/, '');
        i += 1;
        break;
      case '--profile':
        if (!next) throw new Error('--profile requires a number');
        config.profileId = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--until':
        if (!next) throw new Error('--until requires YYYY-MM-DD');
        config.until = next;
        config.untilDate = parseLocalDate(next);
        if (!config.untilDate) throw new Error(`Invalid --until value: ${next}`);
        i += 1;
        break;
      case '--output-dir':
        if (!next) throw new Error('--output-dir requires a path');
        config.outputDir = path.resolve(next);
        i += 1;
        break;
      case '--headless':
        config.headless = true;
        break;
      case '--scroll-delay':
        if (!next) throw new Error('--scroll-delay requires a number');
        config.scrollDelay = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--max-posts':
        if (!next) throw new Error('--max-posts requires a number');
        config.maxPosts = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--max-scrolls':
        if (!next) throw new Error('--max-scrolls requires a number');
        config.maxScrolls = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--fresh':
      case '--no-resume':
        config.resume = false;
        break;
      case '--include-reposts':
        config.includeReposts = true;
        break;
      case '--download-images':
        config.downloadImages = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.warn(`Unknown argument: ${arg}`);
    }
  }

  if (!config.outputDir) {
    config.outputDir = path.join(__dirname, `twitter-user-${sanitizeFilePart(config.handle)}-${config.until}`);
  }

  return config;
}

function printUsage() {
  console.log(`
Twitter/X User Timeline Scraper

Usage:
  node other-task/twitter-task/scrape-twitter-user.js [options]

Options:
  --url <url>           X profile URL (default: https://x.com/aimikoda)
  --handle <name>       Profile handle used for filtering (default: aimikoda)
  --until <YYYY-MM-DD>  Crawl down to this date, inclusive (default: ${DEFAULT_UNTIL})
  --profile <id>        Browser profile ID (default: 1)
  --output-dir <dir>    Output directory
  --headless            Run browser in headless mode
  --scroll-delay <ms>   Delay between scrolls (default: 2000)
  --max-posts <n>       Safety cap for saved posts (default: 1000)
  --max-scrolls <n>     Safety cap for scrolling (default: 300)
  --fresh               Delete output and start over
  --include-reposts     Save reposted posts too
  --download-images     Download post images and include local image links
  -h, --help            Show this help

Examples:
  npm run scrape:twitter:user
  npm run scrape:twitter:user -- --profile 2 --until 2026-02-07
  npm run scrape:twitter:user -- --fresh
`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadState(config) {
  ensureDir(config.outputDir);
  const statePath = path.join(config.outputDir, 'crawl-state.json');
  if (!config.resume) {
    if (fs.existsSync(config.outputDir)) fs.rmSync(config.outputDir, { recursive: true, force: true });
    ensureDir(config.outputDir);
    return { statePath, state: { nextIndex: 1, seenUrls: [], saved: [], reachedCutoff: false } };
  }
  if (!fs.existsSync(statePath)) {
    return { statePath, state: { nextIndex: 1, seenUrls: [], saved: [], reachedCutoff: false } };
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    statePath,
    state: {
      nextIndex: Number.isInteger(parsed.nextIndex) ? parsed.nextIndex : 1,
      seenUrls: Array.isArray(parsed.seenUrls) ? parsed.seenUrls : [],
      saved: Array.isArray(parsed.saved) ? parsed.saved : [],
      reachedCutoff: Boolean(parsed.reachedCutoff),
    },
  };
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

function downloadFile(url, filepath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { timeout: 30000 }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        return downloadFile(response.headers.location, filepath, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
      const stream = fs.createWriteStream(filepath);
      response.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve(filepath);
      });
      stream.on('error', (err) => {
        fs.unlink(filepath, () => {});
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

function bestImageUrl(imgUrl) {
  try {
    const url = new URL(imgUrl);
    if (url.hostname === 'pbs.twimg.com') url.searchParams.set('name', 'orig');
    return url.toString();
  } catch {
    return imgUrl;
  }
}

function imageExtension(imgUrl) {
  try {
    const url = new URL(imgUrl);
    const format = url.searchParams.get('format');
    if (format) return `.${format}`;
    const ext = path.extname(url.pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? ext : '.jpg';
  } catch {
    return '.jpg';
  }
}

async function waitForTimeline(page, config) {
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const selectors = ['article[data-testid="tweet"]', 'article[role="article"]', 'article'];
  for (let retry = 0; retry < 3; retry += 1) {
    const bodyText = await page.evaluate(() => document.body?.innerText || document.body?.textContent || '').catch(() => '');
    if (bodyText.includes('Something went wrong') || bodyText.includes('Retry')) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      continue;
    }
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 12000 });
        return;
      } catch {}
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  const debugScreenshot = path.join(__dirname, 'debug-twitter-user-screenshot.png');
  try {
    await page.screenshot({ path: debugScreenshot, fullPage: false });
  } catch (err) {
    console.warn(`Failed to save debug screenshot: ${err.message}`);
  }
  const bodyText = await page.evaluate(() => document.body?.innerText || document.body?.textContent || '').catch(() => '');
  const pageUrl = page.url();
  const title = await page.title().catch(() => '');
  const snippet = bodyText.substring(0, 500).replace(/\s+/g, ' ');
  throw new Error(`No posts found. Page URL: ${pageUrl}. Title: ${title}. Debug screenshot: ${debugScreenshot}. Page preview: ${snippet}`);
}

async function expandVisibleShowMore(page) {
  let totalClicked = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const clicked = await page.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < window.innerHeight
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      }

      function isShowMoreText(text) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return normalized === 'show more' || normalized === '显示更多' || normalized === '查看更多';
      }

      const clickedElements = new Set();
      const candidates = [];
      for (const article of document.querySelectorAll('article[data-testid="tweet"], article[role="article"], article')) {
        for (const el of article.querySelectorAll('button, a, [role="button"], [tabindex], span, div')) {
          if (!isVisible(el) || !isShowMoreText(el.textContent)) continue;
          const clickable = el.closest('button, a, [role="button"], [tabindex]') || el;
          if (!clickable || clickedElements.has(clickable)) continue;
          clickedElements.add(clickable);
          candidates.push(clickable);
        }
      }

      for (const el of candidates) {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.click();
      }
      return candidates.length;
    });

    if (clicked === 0) break;
    totalClicked += clicked;
    await page.waitForTimeout(1200);
  }
  return totalClicked;
}

async function extractVisiblePosts(page, handle, includeReposts) {
  return await page.evaluate(({ handle, includeReposts }) => {
    const normalizedHandle = `@${handle.toLowerCase().replace(/^@/, '')}`;
    const articles = Array.from(
      document.querySelectorAll('article[data-testid="tweet"], article[role="article"], article')
    );
    const posts = [];
    const seen = new Set();

    function authorFrom(container) {
      let name = '';
      let userHandle = '';
      if (!container) return { name, handle: userHandle };
      const spans = Array.from(container.querySelectorAll('span')).map((s) => s.textContent.trim()).filter(Boolean);
      const handleText = spans.find((text) => text.startsWith('@'));
      if (handleText) userHandle = handleText;
      const link = container.querySelector('a[href^="/"]');
      if (link) {
        name = link.textContent.trim();
        if (!userHandle) userHandle = `@${link.getAttribute('href').split('/')[1] || ''}`;
      }
      return { name, handle: userHandle };
    }

    function imageUrls(container, excludeEl) {
      const urls = [];
      for (const photo of container.querySelectorAll('[data-testid="tweetPhoto"]')) {
        if (excludeEl && excludeEl.contains(photo)) continue;
        const img = photo.querySelector('img');
        if (img?.src && !img.src.includes('emoji') && !img.src.includes('hashflag')) urls.push(img.src);
      }
      if (urls.length === 0) {
        for (const video of container.querySelectorAll('video[poster]')) {
          if (excludeEl && excludeEl.contains(video)) continue;
          if (video.poster) urls.push(video.poster);
        }
      }
      return Array.from(new Set(urls));
    }

    for (const article of articles) {
      const quote = article.querySelector('[data-testid="quoteTweet"]');
      const socialContext = article.querySelector('[data-testid="socialContext"]');
      const isRepost = Boolean(socialContext?.textContent?.match(/reposted|retweeted/i));
      if (isRepost && !includeReposts) continue;

      let tweetUrl = '';
      for (const link of article.querySelectorAll('a[href*="/status/"]')) {
        if (quote && quote.contains(link)) continue;
        const href = link.getAttribute('href') || '';
        if (/^\/[^/]+\/status\/\d+/.test(href)) {
          tweetUrl = `https://x.com${href.split('?')[0]}`;
          break;
        }
      }
      if (!tweetUrl || seen.has(tweetUrl)) continue;
      seen.add(tweetUrl);

      const author = authorFrom(article.querySelector('[data-testid="User-Name"]'));
      if (author.handle && author.handle.toLowerCase() !== normalizedHandle && !includeReposts) continue;

      let timestamp = '';
      for (const time of article.querySelectorAll('time')) {
        if (quote && quote.contains(time)) continue;
        timestamp = time.getAttribute('datetime') || '';
        break;
      }

      let text = '';
      for (const textEl of article.querySelectorAll('[data-testid="tweetText"]')) {
        if (quote && quote.contains(textEl)) continue;
        text = textEl.innerText.trim();
        break;
      }

      let quotedTweet = null;
      if (quote) {
        const quotedAuthor = authorFrom(quote.querySelector('[data-testid="User-Name"]'));
        const quotedTextEl = quote.querySelector('[data-testid="tweetText"]');
        const quotedTimeEl = quote.querySelector('time');
        let quotedUrl = '';
        const quotedLink = quote.querySelector('a[href*="/status/"]');
        if (quotedLink) quotedUrl = `https://x.com${(quotedLink.getAttribute('href') || '').split('?')[0]}`;
        quotedTweet = {
          authorName: quotedAuthor.name,
          authorHandle: quotedAuthor.handle,
          text: quotedTextEl ? quotedTextEl.innerText.trim() : '',
          timestamp: quotedTimeEl ? quotedTimeEl.getAttribute('datetime') || '' : '',
          tweetUrl: quotedUrl,
          images: imageUrls(quote, null),
        };
      }

      posts.push({
        text,
        images: imageUrls(article, quote),
        authorName: author.name,
        authorHandle: author.handle,
        timestamp,
        tweetUrl,
        isRepost,
        quotedTweet,
      });
    }
    return posts;
  }, { handle, includeReposts });
}

async function hasVisiblePostOlderThan(page, cutoffISO, handle, includeReposts) {
  return await page.evaluate(({ cutoff, handle, includeReposts }) => {
    const normalizedHandle = `@${handle.toLowerCase().replace(/^@/, '')}`;
    const times = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"], article[role="article"], article')) {
      const quote = article.querySelector('[data-testid="quoteTweet"]');
      const socialContext = article.querySelector('[data-testid="socialContext"]');
      const isRepost = Boolean(socialContext?.textContent?.match(/reposted|retweeted/i));
      if (isRepost && !includeReposts) continue;

      const userName = article.querySelector('[data-testid="User-Name"]');
      const spans = userName ? Array.from(userName.querySelectorAll('span')).map((span) => span.textContent.trim()) : [];
      const authorHandle = spans.find((text) => text.startsWith('@')) || '';
      if (authorHandle && authorHandle.toLowerCase() !== normalizedHandle && !includeReposts) continue;

      let mainTime = null;
      for (const time of article.querySelectorAll('time[datetime]')) {
        if (quote && quote.contains(time)) continue;
        mainTime = time;
        break;
      }
      if (!mainTime) continue;
      const value = new Date(mainTime.getAttribute('datetime')).getTime();
      if (Number.isFinite(value)) times.push(value);
    }
    if (times.length === 0) return false;
    return Math.min(...times) < new Date(cutoff).getTime();
  }, { cutoff: cutoffISO, handle, includeReposts });
}

async function savePost(post, index, outputDir, options = {}) {
  const id = (post.tweetUrl.match(/status\/(\d+)/) || [])[1] || String(index).padStart(4, '0');
  const blogDir = path.join(outputDir, `blog-${String(index).padStart(4, '0')}-${id}`);
  ensureDir(blogDir);

  const allImages = [...post.images, ...(post.quotedTweet?.images || [])];
  const lines = [];
  lines.push(`# ${post.authorName || post.authorHandle || `Post ${index}`}`);
  if (post.authorHandle) lines.push(`**${post.authorHandle}**`);
  lines.push('');
  if (post.timestamp) lines.push(`**Date:** ${new Date(post.timestamp).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`);
  lines.push(`**URL:** ${post.tweetUrl}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(post.text || '*(No text content)*');

  if (options.downloadImages && post.images.length > 0) {
    lines.push('', '### Images', '');
    post.images.forEach((url, i) => lines.push(`![image-${i + 1}](image-${i + 1}${imageExtension(url)})`));
  }

  if (post.quotedTweet) {
    const quote = post.quotedTweet;
    lines.push('', '---', '', '## Quoted Tweet', '');
    if (quote.authorName || quote.authorHandle) lines.push(`**${quote.authorName || ''}** ${quote.authorHandle || ''}`.trim());
    if (quote.timestamp) lines.push(`**Date:** ${new Date(quote.timestamp).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}`);
    if (quote.tweetUrl) lines.push(`**URL:** ${quote.tweetUrl}`);
    lines.push('', quote.text ? `> ${quote.text.split('\n').join('\n> ')}` : '> *(No text content)*');
    if (options.downloadImages && quote.images.length > 0) {
      const offset = post.images.length;
      lines.push('', '### Quoted Tweet Images', '');
      quote.images.forEach((url, i) => lines.push(`![image-${offset + i + 1}](image-${offset + i + 1}${imageExtension(url)})`));
    }
  }
  lines.push('');
  fs.writeFileSync(path.join(blogDir, 'content.md'), lines.join('\n'), 'utf8');

  let downloaded = 0;
  if (options.downloadImages) {
    for (let i = 0; i < allImages.length; i += 1) {
      const url = bestImageUrl(allImages[i]);
      const target = path.join(blogDir, `image-${i + 1}${imageExtension(url)}`);
      try {
        await downloadFile(url, target);
        downloaded += 1;
      } catch (err) {
        console.warn(`      Failed image ${i + 1}: ${err.message}`);
      }
    }
  }

  return { blogDir, downloaded, totalImages: allImages.length };
}

async function main() {
  const config = parseArgs();
  const cutoffISO = config.untilDate.toISOString();
  const { statePath, state } = loadState(config);
  const seenUrls = new Set(state.seenUrls);
  const userDataDir = path.join(PROJECT_ROOT, 'browser-profiles', `browser-${config.profileId}`);

  if (!fs.existsSync(userDataDir)) {
    throw new Error(`Browser profile not found: ${userDataDir}. Run: node launch-browser.js ${config.profileId}`);
  }

  console.log('');
  console.log('Twitter/X User Timeline Scraper');
  console.log(`URL:       ${config.url}`);
  console.log(`Handle:    @${config.handle}`);
  console.log(`Until:     ${config.until} inclusive (${formatDate(config.untilDate)})`);
  console.log(`Profile:   ${config.profileId}`);
  console.log(`Resume:    ${config.resume}`);
  console.log(`Images:    ${config.downloadImages ? 'download' : 'skip'}`);
  console.log(`Output:    ${config.outputDir}`);
  console.log('');

  const launchOptions = {
    channel: 'chrome',
    headless: config.headless,
    viewport: config.headless ? { width: 1280, height: 900 } : null,
  };
  const proxy = loadProxyConfig('twitter', config.profileId - 1);
  if (proxy) launchOptions.proxy = proxy;

  let context = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    const page = await context.newPage();
    await waitForTimeline(page, config);
    await page.waitForTimeout(3000);

    let stableScrolls = 0;
    let lastHeight = 0;
    let savedThisRun = 0;

    for (let scroll = 0; scroll < config.maxScrolls; scroll += 1) {
      const expandedCount = await expandVisibleShowMore(page);
      if (expandedCount > 0) {
        console.log(`Expanded ${expandedCount} Show more control(s)`);
      }
      const posts = await extractVisiblePosts(page, config.handle, config.includeReposts);
      for (const post of posts) {
        if (!post.tweetUrl || seenUrls.has(post.tweetUrl)) continue;
        if (post.timestamp && new Date(post.timestamp).getTime() < new Date(cutoffISO).getTime()) continue;

        const index = state.nextIndex;
        const result = await savePost(post, index, config.outputDir, { downloadImages: config.downloadImages });
        state.nextIndex += 1;
        state.saved.push({
          index,
          url: post.tweetUrl,
          timestamp: post.timestamp,
          dir: path.basename(result.blogDir),
        });
        seenUrls.add(post.tweetUrl);
        state.seenUrls = Array.from(seenUrls);
        saveState(statePath, state);
        savedThisRun += 1;
        const preview = (post.text || '').replace(/\s+/g, ' ').slice(0, 70) || '(no text)';
        console.log(`Saved #${index}: ${post.timestamp || 'no time'} ${preview}`);
      }

      if (state.saved.length >= config.maxPosts) {
        console.log(`Reached max posts limit: ${config.maxPosts}`);
        break;
      }

      if (await hasVisiblePostOlderThan(page, cutoffISO, config.handle, config.includeReposts)) {
        state.reachedCutoff = true;
        saveState(statePath, state);
        console.log(`Reached cutoff date ${config.until}; stopping.`);
        break;
      }

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(config.scrollDelay);
      const height = await page.evaluate(() => document.body.scrollHeight);
      if (height === lastHeight) {
        stableScrolls += 1;
        if (stableScrolls >= 5) {
          console.log('Page height stopped changing; stopping.');
          break;
        }
      } else {
        stableScrolls = 0;
      }
      lastHeight = height;
      console.log(`Scroll ${scroll + 1}: total saved ${state.saved.length}, this run ${savedThisRun}`);
    }

    console.log('');
    console.log(`Complete. Saved this run: ${savedThisRun}. Total saved: ${state.saved.length}.`);
    console.log(`State: ${statePath}`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

process.on('SIGINT', () => {
  console.log('\nInterrupted. Progress is saved in crawl-state.json.');
  process.exit(0);
});

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
