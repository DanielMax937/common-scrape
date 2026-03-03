# Other-Task Utilities

A collection of web scraping and data analysis utilities for Chinese social media platforms and macro-economic data sources.

## 📋 Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Available Tasks](#available-tasks)
  - [Twitter/X Scraper](#1-twitterx-scraper)
  - [Weibo List Scraper](#2-weibo-list-scraper)
  - [Weibo User Scraper](#3-weibo-user-scraper)
  - [Eastmoney Futures Scraper](#4-eastmoney-futures-scraper)
  - [Macro News Fetcher](#5-macro-news-fetcher)
  - [Macro Workflow Runner](#6-macro-workflow-runner)
- [Browser Profiles](#browser-profiles)
- [Cache Behavior](#cache-behavior)
- [Proxy Configuration](#proxy-configuration)
- [Troubleshooting](#troubleshooting)

---

## Overview

This repository contains standalone scraping and analysis tools for:

- **Social Media**: Twitter/X lists, Weibo groups and user profiles
- **Financial Data**: Eastmoney futures market data
- **Macro Economics**: Chinese macro-economic indicators from official sources
- **Content Analysis**: LLM-powered analysis of collected data

All scrapers use browser automation (Patchright - Playwright fork) with persistent browser profiles to maintain authentication sessions.

---

## Quick Start

### Installation

```bash
# Install dependencies
npm install

# Create browser profile for authenticated scraping
npm run browser 1

# Run your first scraper
npm run scrape:twitter
```

### Prerequisites

- Node.js >= 14.0.0
- Chrome browser installed

---

## Available Tasks

### 1. Twitter/X Scraper

Scrapes tweets (text + images) from X lists with support for retweets and quote tweets.

**Script**: `other-task/twitter-task/scrape-twitter-list.js`

#### NPM Commands

```bash
# Basic usage (default: 5 tweets, profile 1)
npm run scrape:twitter

# With custom arguments
npm run scrape:twitter -- --count 10 --since today
npm run scrape:twitter -- --profile 2 --since 24h
npm run scrape:twitter -- --no-cache  # Force regenerate
```

#### Direct Command

```bash
node other-task/twitter-task/scrape-twitter-list.js [options]
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--profile <id>` | number | `1` | Browser profile ID to use |
| `--count <n>` | number | `5` | Number of tweets to scrape |
| `--since <when>` | string | - | Time filter (see below) |
| `--url <url>` | string | Built-in | Custom X list URL |
| `--output-dir <dir>` | string | `twitter-YYYY-MM-DD/` | Output directory |
| `--headless` | flag | false | Run browser in headless mode |
| `--scroll-delay <ms>` | number | `2000` | Delay between scrolls (ms) |
| `--no-cache` | flag | - | Force regenerate (ignore cache) |
| `--help` | flag | - | Show help message |

#### Time Filters (`--since`)

- `today` - Start of today (midnight)
- `yesterday` - Start of yesterday
- `24h`, `12h`, `2h`, `1h` - Relative hours ago
- `2d`, `7d` - Relative days ago
- `30m`, `90m` - Relative minutes ago
- `YYYY-MM-DD` - Specific date (midnight)

**Note**: Using `--since` removes the default 5-tweet limit. Add `--count N` to cap results.

#### Examples

```bash
# Latest 5 tweets (default)
npm run scrape:twitter

# All tweets from today
npm run scrape:twitter -- --since today

# Last 24 hours, max 20 tweets
npm run scrape:twitter -- --since 24h --count 20

# Since specific date
npm run scrape:twitter -- --since 2026-02-09

# Custom list URL with profile 2
npm run scrape:twitter -- --url https://x.com/i/lists/YOUR_LIST_ID --profile 2

# Show browser window (non-headless)
npm run scrape:twitter -- --no-headless

# Force regenerate cached data
npm run scrape:twitter -- --no-cache
```

#### Output Structure

```
twitter-2026-03-03/
  blog-1/
    content.md        # Tweet text with metadata
    image-1.jpg       # High-res images
    image-2.jpg
  blog-2/
    content.md
  ...
```

#### Cache Behavior

✅ **Cached by date** - If `twitter-YYYY-MM-DD/` exists, scraping is skipped.  
Use `--no-cache` to force regeneration.

---

### 2. Weibo List Scraper

Scrapes posts (text + images) from Weibo group feeds with support for reposts.

**Script**: `other-task/weibo-task/scrape-weibo-list.js`

#### NPM Commands

```bash
# Basic usage (default: 5 posts, profile 1)
npm run scrape:weibo

# With custom arguments
npm run scrape:weibo -- --count 10 --since today
npm run scrape:weibo -- --profile 2 --since 2d
npm run scrape:weibo -- --no-cache
```

#### Direct Command

```bash
node other-task/weibo-task/scrape-weibo-list.js [options]
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--profile <id>` | number | `1` | Browser profile ID to use |
| `--count <n>` | number | `5` | Number of posts to scrape |
| `--since <when>` | string | - | Time filter (same as Twitter) |
| `--url <url>` | string | Built-in | Custom Weibo group URL |
| `--output-dir <dir>` | string | `weibo-YYYY-MM-DD/` | Output directory |
| `--headless` | flag | false | Run browser in headless mode |
| `--scroll-delay <ms>` | number | `2000` | Delay between scrolls (ms) |
| `--no-cache` | flag | - | Force regenerate (ignore cache) |
| `--help` | flag | - | Show help message |

#### Examples

```bash
# Latest 5 posts (default)
npm run scrape:weibo

# All posts from today
npm run scrape:weibo -- --since today

# Last 2 days, max 20 posts
npm run scrape:weibo -- --since 2d --count 20

# Custom group URL with profile 3
npm run scrape:weibo -- --url https://weibo.com/mygroups/YOUR_GROUP --profile 3

# Force regenerate
npm run scrape:weibo -- --no-cache
```

#### Output Structure

```
weibo-2026-03-03/
  blog-1/
    content.md        # Post text with metadata
    image-1.jpg       # Best quality images
    image-2.jpg
  blog-2/
    content.md
  ...
```

#### Cache Behavior

✅ **Cached by date** - If `weibo-YYYY-MM-DD/` exists, scraping is skipped.  
Use `--no-cache` to force regeneration.

---

### 3. Weibo User Scraper

Scrapes posts from a specific Weibo user's profile page.

**Script**: `other-task/weibo-task/scrape-weibo-user.js`

#### NPM Commands

```bash
# Must provide user URL
npm run scrape:weibo-user -- --url https://weibo.com/u/USER_ID
npm run scrape:weibo-user -- --url https://weibo.com/u/USER_ID --count 20
```

#### Direct Command

```bash
node other-task/weibo-task/scrape-weibo-user.js <url> [options]
# or
node other-task/weibo-task/scrape-weibo-user.js --url <url> [options]
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--url <url>` | string | **Required** | Weibo user profile URL |
| `<url>` | string | **Required** | Weibo user URL (positional) |
| `--profile <id>` | number | `1` | Browser profile ID to use |
| `--count <n>` | number | `50` | Max number of posts to scrape |
| `--start <n>` | number | `0` | Skip first N posts, start from N+1 |
| `--since <when>` | string | - | Time filter (same as Twitter) |
| `--output-dir <dir>` | string | `weibo-user-{uid}-YYYY-MM-DD/` | Output directory |
| `--headless` | flag | false | Run browser in headless mode |
| `--scroll-delay <ms>` | number | `2000` | Delay between scrolls (ms) |
| `--help` | flag | - | Show help message |

#### Examples

```bash
# Scrape user's latest 50 posts
npm run scrape:weibo-user -- https://weibo.com/u/1234567890

# Latest 20 posts
npm run scrape:weibo-user -- --url https://weibo.com/u/1234567890 --count 20

# All posts from today
npm run scrape:weibo-user -- https://weibo.com/u/1234567890 --since today

# Skip first 10 posts, scrape next 20
npm run scrape:weibo-user -- https://weibo.com/u/1234567890 --start 10 --count 20

# Use profile 2
npm run scrape:weibo-user -- https://weibo.com/u/1234567890 --profile 2
```

#### Output Structure

```
weibo-user-1234567890-2026-03-03/
  blog-1/
    content.md
    image-1.jpg
  blog-2/
    content.md
  ...
```

#### Cache Behavior

❌ **No cache** - Always fetches fresh data (user posts are frequently updated).

---

### 4. Eastmoney Futures Scraper

Scrapes futures market data (news, stock info, forum posts) from Eastmoney.

**Script**: `other-task/eastmoney-task/scrape-eastmoney-futures.js`

#### NPM Commands

```bash
# Scrape default symbols (ma, pp, eg, sc)
npm run scrape:eastmoney

# Scrape specific symbols
npm run scrape:eastmoney -- ma pp eg
npm run scrape:eastmoney -- au ag cu  # Gold, silver, copper
npm run scrape:eastmoney -- --no-cache  # Force regenerate
```

#### Direct Command

```bash
node other-task/eastmoney-task/scrape-eastmoney-futures.js <symbol>... [options]
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `<symbol>...` | string[] | `ma pp eg sc` | Futures symbols to scrape |
| `--output-dir <dir>` | string | `YYYY-MM-DD_eastmoney_review/` | Output directory |
| `--no-headless` | flag | - | Show browser window |
| `--no-cache` | flag | - | Force regenerate all symbols |
| `--help` | flag | - | Show help message |

#### Common Symbols

- `ma` - Methanol (甲醇)
- `pp` - Polypropylene (聚丙烯)
- `eg` - Ethylene Glycol (乙二醇)
- `sc` - Crude Oil (原油)
- `ta` - PTA
- `au` - Gold (黄金)
- `ag` - Silver (白银)
- `cu` - Copper (铜)

#### Examples

```bash
# Scrape default symbols
npm run scrape:eastmoney

# Scrape specific symbols
npm run scrape:eastmoney -- ma pp

# Scrape metals
npm run scrape:eastmoney -- au ag cu

# Show browser window
npm run scrape:eastmoney -- ma pp --no-headless

# Force regenerate (ignore cache)
npm run scrape:eastmoney -- ma pp eg --no-cache
```

#### Output Structure

```
2026-03-03_eastmoney_review/
  ma/
    news/
      1.md          # Full news articles
      2.md
    stock.md        # Price & market data
    blog.md         # Forum posts (title, author, date, stats)
  pp/
    news/
    stock.md
    blog.md
  ...
```

#### Cache Behavior

✅ **Cached by date + symbol** - Each symbol is cached independently.  
Running `npm run scrape:eastmoney -- ma pp eg` twice will:
1. First run: Scrape all three (MA, PP, EG)
2. Second run: Skip all (cached)
3. Add new symbol: `ma pp eg au` → Only scrape AU

Use `--no-cache` to force regenerate all symbols.

---

### 5. Macro News Fetcher

Fetches and analyzes macro-economic and industry data from official Chinese sources with optional LLM analysis.

**Script**: `other-task/macro-news-task/fetch-macro-news.js`

#### NPM Commands

```bash
# Fetch all sources with LLM analysis
npm run fetch:macro-news

# Fetch macro data only
npm run fetch:macro-news:macro

# Fetch industry data only
npm run fetch:macro-news:industry

# With custom arguments
npm run fetch:macro-news -- --no-llm --concurrency 3
npm run fetch:macro-news -- --source M2_M1_M0 --source CPI_PPI_PMI
npm run fetch:macro-news -- --no-cache  # Force regenerate
```

#### Direct Command

```bash
node other-task/macro-news-task/fetch-macro-news.js [options]
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--category <type>` | string | all | Filter: `macro` or `industry` |
| `--source <name>` | string | - | Specific data source (repeatable) |
| `--output-dir <path>` | string | `./output` | Output directory |
| `--headless` | flag | true | Run browser in headless mode |
| `--no-headless` | flag | - | Show browser window |
| `--no-llm` | flag | - | Skip LLM analysis (scrape only) |
| `--no-cache` | flag | - | Force regenerate report |
| `--concurrency <n>` | number | `2` | Concurrent browsers |
| `--timeout <ms>` | number | `30000` | Page load timeout (ms) |
| `--help` | flag | - | Show help message |

#### Data Sources

**Macro Sources**:
- `M2_M1_M0` - Money supply (PBC)
- `CPI_PPI_PMI` - Inflation & manufacturing (Stats Bureau)
- `利率_LPR` - Interest rates (PBC)
- `外汇储备` - Foreign reserves (SAFE)
- `进出口数据` - Trade data (Customs)
- `财政收支` - Fiscal data (MOF)
- `能源产量` - Energy production
- More...

**Industry Sources**:
- `中汽协销量` - Auto sales (CAAM)
- `港交所交易量` - HKEX trading volume
- `巨潮资讯网公告` - CNINFO announcements

#### Examples

```bash
# Fetch all sources with LLM
npm run fetch:macro-news

# Macro data only
npm run fetch:macro-news:macro

# Industry data only
npm run fetch:macro-news:industry

# Specific sources
npm run fetch:macro-news -- --source M2_M1_M0 --source CPI_PPI_PMI

# No LLM analysis (faster)
npm run fetch:macro-news -- --no-llm

# Higher concurrency & timeout
npm run fetch:macro-news -- --concurrency 4 --timeout 45000

# Show browser window
npm run fetch:macro-news -- --no-headless

# Force regenerate cached report
npm run fetch:macro-news -- --no-cache
```

#### Output

**File**: `output/macro-news-report-YYYY-MM-DD.md`

**Contents**:
- Table of contents by category (macro/industry)
- Data source URLs and access status
- Raw extracted content (collapsed details)
- AI analysis for each source (if LLM enabled)
- Statistics summary

#### LLM Configuration

Create `other-task/macro-news-task/.env`:

```bash
LLM_API_KEY=your-volcengine-api-key
LLM_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3
LLM_MODEL=your-model-id
LLM_MAX_TOKENS=2000
LLM_TEMPERATURE=0.7
```

Or use `VOLCENGINE_API_KEY` and `VOLCENGINE_MODEL` (auto-mapped).

#### Cache Behavior

✅ **Cached by date** - If `macro-news-report-YYYY-MM-DD.md` exists, fetching is skipped.  
Use `--no-cache` to force regeneration.

---

### 6. Macro Workflow Runner

Runs the macro news fetching as a structured workflow with step-level progress tracking and resume capability.

**Script**: `other-task/macro-news-task/run-workflow.js`

#### NPM Commands

```bash
# Run full workflow
npm run workflow:macro-news

# With custom arguments
npm run workflow:macro-news -- --concurrency 3 --no-llm
npm run workflow:macro-news -- --resume  # Resume from saved state
npm run workflow:macro-news -- --no-cache  # Clear state, fresh start
```

#### Direct Command

```bash
node other-task/macro-news-task/run-workflow.js [options]
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--category <type>` | string | all | Filter: `macro` or `industry` |
| `--source <name>` | string | - | Specific data source (repeatable) |
| `--output-dir <path>` | string | `./output` | Output directory |
| `--headless` | flag | true | Run browser in headless mode |
| `--no-headless` | flag | - | Show browser window |
| `--no-llm` | flag | - | Skip all LLM analysis steps |
| `--concurrency <n>` | number | `2` | Concurrent steps |
| `--timeout <ms>` | number | `30000` | Page load timeout (ms) |
| `--retries <n>` | number | `2` | Retry count for failed steps |
| `--resume` | flag | - | Resume from saved state |
| `--no-cache` | flag | - | Clear state file, start fresh |
| `--dry-run` | flag | - | Show workflow structure only |
| `--help` | flag | - | Show help message |

#### Examples

```bash
# Run full workflow
npm run workflow:macro-news

# Resume interrupted workflow
npm run workflow:macro-news -- --resume

# Clear state and restart
npm run workflow:macro-news -- --no-cache

# Show workflow structure without running
npm run workflow:macro-news -- --dry-run

# Custom concurrency and retries
npm run workflow:macro-news -- --concurrency 3 --retries 3

# Skip LLM analysis
npm run workflow:macro-news -- --no-llm
```

#### Workflow Steps

Each data source creates a pipeline:
1. `fetch-page` - Scrape source URL
2. `analyze` - LLM analysis of content
3. `generate-report` - Compile final report

#### State Management

**State file**: `output/workflow-state.json`

- Automatically saves progress after each step
- `--resume` continues from last completed step
- `--no-cache` clears state for fresh start
- Each step tracks: status, output, error, retry count

#### Output

- **State**: `output/workflow-state.json` (progress tracking)
- **Report**: `output/macro-news-report-YYYY-MM-DD.md` (final report)

#### Cache Behavior

🔄 **State-based resume** (not traditional cache):
- Uses `workflow-state.json` to track step completion
- Auto-resumes if state exists
- `--resume` explicitly continues from state
- `--no-cache` clears state for fresh start

---

## Browser Profiles

All scrapers (except Eastmoney) use persistent browser profiles to maintain login sessions.

### Creating a Browser Profile

```bash
# Launch browser with profile ID
npm run browser 1

# Or directly
node launch-browser.js 1
```

This opens Chrome with:
- Persistent storage at `browser-profiles/browser-1/`
- Interactive welcome page with login instructions
- No auto-close (stays open for manual login)

**Steps**:
1. Run `npm run browser 1`
2. Log in to required platforms:
   - Twitter/X: Visit x.com and log in
   - Weibo: Visit weibo.com and log in
3. Close browser when done
4. Your session is saved!

### Using Different Profiles

```bash
# Create multiple profiles
npm run browser 1  # Profile 1
npm run browser 2  # Profile 2
npm run browser 3  # Profile 3

# Use in scrapers
npm run scrape:twitter -- --profile 1
npm run scrape:twitter -- --profile 2
npm run scrape:weibo -- --profile 3
```

**Use cases**:
- Multiple accounts
- Different login sessions
- Proxy rotation
- Parallel scraping

---

## Cache Behavior

Each task has optimized cache logic:

| Task | Cache Strategy | Auto-invalidate | Override |
|------|---------------|-----------------|----------|
| **Twitter** | Date-based | Daily | `--no-cache` |
| **Weibo List** | Date-based | Daily | `--no-cache` |
| **Weibo User** | ❌ No cache | Always fresh | N/A |
| **Eastmoney** | Date + Symbol | Daily | `--no-cache` |
| **Macro News** | Date-based | Daily | `--no-cache` |
| **Macro Workflow** | State resume | Manual | `--no-cache` |

### How It Works

**Date-based cache**:
- Output directory/file includes date: `twitter-2026-03-03/`
- Scraper checks if it exists before running
- If exists: Fast exit with cache hit message
- If not exists: Run scraper normally
- Next day: New date → automatic invalidation

**Symbol-based cache** (Eastmoney):
- Each symbol cached independently
- `ma pp` cached → Add `eg` → Only scrapes `eg`
- All cached → Fast exit
- Use `--no-cache` to regenerate all

**No cache** (Weibo User):
- Always fetches fresh data
- User posts are frequently updated
- Ensures accuracy

**State resume** (Workflow):
- Not a traditional cache
- Tracks step completion in `workflow-state.json`
- `--resume` continues from last step
- `--no-cache` clears state

### Cache Examples

```bash
# First run: fresh scrape
$ npm run scrape:twitter
🚀 Launching browser...
✅ Scraped 10 tweets

# Second run: cache hit
$ npm run scrape:twitter
📦 Cache hit: twitter-2026-03-03/ already exists
   Contains 10 blog(s)
   Use --no-cache to regenerate

# Force regenerate
$ npm run scrape:twitter -- --no-cache
🗑️  Clearing existing output
🚀 Launching browser...
```

---

## Proxy Configuration

(Optional) Configure proxies for browser profiles.

### Setup

Create `proxy-config.json` in project root:

```json
[
  {
    "server": "proxy1.example.com:8080",
    "username": "user1",
    "password": "pass1"
  },
  {
    "server": "proxy2.example.com:8080",
    "username": "user2",
    "password": "pass2"
  },
  {
    "server": "proxy3.example.com:8080",
    "username": "user3",
    "password": "pass3"
  }
]
```

### Usage

Profile index maps to proxy array index:
- Profile 1 → Proxy 1 (array[0])
- Profile 2 → Proxy 2 (array[1])
- Profile 3 → Proxy 3 (array[2])

```bash
# Create profile 1 with proxy 1
npm run browser 1

# Scrape with profile 2 (uses proxy 2)
npm run scrape:twitter -- --profile 2
```

### Supported Tasks

Proxies work with:
- ✅ Twitter scraper
- ✅ Weibo scrapers (list + user)
- ✅ Browser launcher
- ❌ Eastmoney (no profile, no proxy)
- ❌ Macro news (no profile, no proxy)

---

## Troubleshooting

### Not Logged In Error

**Error**: "❌ Not logged in to X/Weibo"

**Solution**:
1. Create/refresh profile: `npm run browser <profile-id>`
2. Log in to the platform
3. Close browser
4. Run scraper again

### Browser Profile Not Found

**Error**: "❌ Browser profile not found"

**Solution**:
```bash
# Create the missing profile
npm run browser 1  # or 2, 3, etc.
```

### Page Not Loading / Timeout

**Symptoms**: Scraper hangs or times out

**Solutions**:
- Check internet connection
- Increase scroll delay: `--scroll-delay 5000`
- Increase timeout (macro only): `--timeout 60000`
- Show browser to debug: `--no-headless`
- Check if platform changed page structure

### Image Download Failures

**Symptoms**: Some images missing in output

**Causes**: Network issues, invalid URLs, rate limiting

**Solutions**:
- Scraper auto-retries with fallback URLs
- Check console output for specific errors
- Reduce concurrency if rate-limited
- Increase `--scroll-delay` to give images time to load

### LLM Analysis Failures (Macro News)

**Error**: "LLM call failed" or missing analysis

**Solutions**:
1. Verify `.env` configuration:
   ```bash
   cd other-task/macro-news-task
   cat .env  # Should show LLM_API_KEY
   ```

2. Check API quota and rate limits

3. Skip LLM to test scraping only:
   ```bash
   npm run fetch:macro-news -- --no-llm
   ```

4. Test with single source:
   ```bash
   npm run fetch:macro-news -- --source M2_M1_M0
   ```

### Cache Issues

**Problem**: Stale cached data

**Solution**:
```bash
# Force regenerate with --no-cache
npm run scrape:twitter -- --no-cache
npm run fetch:macro-news -- --no-cache
npm run scrape:eastmoney -- ma pp --no-cache
```

**Problem**: Want to skip cache permanently

**Solution**: Delete cached output:
```bash
# Twitter
rm -rf other-task/twitter-task/twitter-2026-03-03/

# Weibo
rm -rf other-task/weibo-task/weibo-2026-03-03/

# Eastmoney
rm -rf other-task/eastmoney-task/2026-03-03_eastmoney_review/

# Macro news
rm other-task/macro-news-task/output/macro-news-report-2026-03-03.md
```

### Workflow State Corruption

**Problem**: Workflow can't resume or shows errors

**Solution**: Clear state and restart
```bash
npm run workflow:macro-news -- --no-cache
```

Or manually:
```bash
rm other-task/macro-news-task/output/workflow-state.json
npm run workflow:macro-news
```

### Debugging Tips

1. **Show browser window**: Add `--no-headless` to see what's happening
2. **Check terminal logs**: All scrapers print detailed progress
3. **Test with small counts**: Use `--count 1` for quick tests
4. **Verify platform access**: Open URLs manually in browser
5. **Check rate limits**: Reduce `--concurrency` if hitting limits

---

## NPM Scripts Quick Reference

```bash
# Browser Profiles
npm run browser                      # Launch browser profile 1
npm run browser 2                    # Launch browser profile 2

# Twitter
npm run scrape:twitter               # Latest 5 tweets, cache enabled
npm run scrape:twitter -- --count 10 # Latest 10 tweets
npm run scrape:twitter -- --since today  # All tweets from today
npm run scrape:twitter -- --no-cache     # Force regenerate

# Weibo List
npm run scrape:weibo                 # Latest 5 posts, cache enabled
npm run scrape:weibo -- --count 10   # Latest 10 posts
npm run scrape:weibo -- --since today    # All posts from today
npm run scrape:weibo -- --no-cache       # Force regenerate

# Weibo User
npm run scrape:weibo-user -- <url>   # User URL required (no cache)
npm run scrape:weibo-user -- https://weibo.com/u/1234567890

# Eastmoney
npm run scrape:eastmoney             # Default symbols, per-symbol cache
npm run scrape:eastmoney -- ma pp eg # Specific symbols
npm run scrape:eastmoney -- --no-cache   # Force regenerate all

# Macro News
npm run fetch:macro-news             # All sources, cache enabled
npm run fetch:macro-news:macro       # Macro only
npm run fetch:macro-news:industry    # Industry only
npm run fetch:macro-news -- --no-llm     # Skip LLM analysis
npm run fetch:macro-news -- --no-cache   # Force regenerate

# Macro Workflow
npm run workflow:macro-news          # Full workflow with state
npm run workflow:macro-news -- --resume  # Resume from state
npm run workflow:macro-news -- --no-cache    # Clear state, restart
npm run workflow:macro-news -- --dry-run     # Show structure only
```

---

## Project Structure

```
article-generator/
├── browser-profiles/          # Persistent browser sessions
│   ├── browser-1/            # Profile 1 data
│   ├── browser-2/            # Profile 2 data
│   └── ...
├── other-task/
│   ├── twitter-task/
│   │   ├── scrape-twitter-list.js
│   │   └── twitter-YYYY-MM-DD/   # Output
│   ├── weibo-task/
│   │   ├── scrape-weibo-list.js
│   │   ├── scrape-weibo-user.js
│   │   ├── weibo-YYYY-MM-DD/     # List output
│   │   └── weibo-user-*-YYYY-MM-DD/  # User output
│   ├── eastmoney-task/
│   │   ├── scrape-eastmoney-futures.js
│   │   └── YYYY-MM-DD_eastmoney_review/  # Output
│   └── macro-news-task/
│       ├── fetch-macro-news.js
│       ├── run-workflow.js
│       ├── data-sources.js
│       ├── llm-client.js
│       ├── workflow-engine.js
│       ├── .env                  # LLM config
│       └── output/
│           ├── macro-news-report-YYYY-MM-DD.md
│           └── workflow-state.json
├── launch-browser.js          # Browser profile launcher
├── proxy-config.json          # Proxy configuration (optional)
├── package.json
└── README.md
```

---

## License

MIT

## Author

yanan.wu

---

## Contributing

Contributions welcome! Please:
1. Test changes thoroughly
2. Update documentation
3. Follow existing code style
4. Add examples for new features

---

## Support

For issues or questions:
1. Check [Troubleshooting](#troubleshooting) section
2. Review error messages carefully
3. Test with `--no-headless` to see browser behavior
4. Verify platform website hasn't changed structure
