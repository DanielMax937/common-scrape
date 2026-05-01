# Click Recorder & Replayer

Record your browser clicks and replay them as automated tasks.

## Quick Start

### Record

```bash
# Record clicks on a site (opens real Chrome with your saved profile)
npm run record -- https://example.com

# With options
npm run record -- https://example.com --profile 2 --name "login-flow"
```

The browser opens, a red **"🔴 Recording clicks"** banner appears at the bottom. Click around normally — each click is captured with its CSS selector and timing. When done, **close the browser** or press **Ctrl+C** to save.

Output: `output/recorder/<name>-<timestamp>.json`

### Replay

```bash
# Replay the recorded task
npm run replay -- output/recorder/example-2026-05-01T09-00-00.json

# Replay at 2x speed
npm run replay -- output/recorder/example.json --speed 2

# Instant replay (no delays)
npm run replay -- output/recorder/example.json --speed 0

# Headless replay
npm run replay -- output/recorder/example.json --headless
```

## Generated Task Format

```json
{
  "version": 1,
  "name": "example-com",
  "url": "https://example.com",
  "recordedAt": "2026-05-01T09:00:00.000Z",
  "totalActions": 5,
  "totalDurationMs": 12000,
  "actions": [
    {
      "type": "click",
      "selector": "#login-button",
      "delayMs": 0,
      "text": "Log In",
      "tagName": "button",
      "url": "https://example.com"
    },
    {
      "type": "click",
      "selector": "a[href=\"/dashboard\"]",
      "delayMs": 2500,
      "text": "Dashboard",
      "tagName": "a",
      "url": "https://example.com/login"
    }
  ]
}
```

Each action includes:
- **selector** — CSS selector that uniquely identifies the element
- **delayMs** — milliseconds since the previous click (preserves your interaction timing)
- **text** — visible text of the element (for reference)
- **tagName** — HTML tag name
- **url** — page URL when the click happened

## Selector Strategy

The recorder generates the most stable selector it can find, in priority order:

1. `#id` — unique element ID
2. `tag[data-testid="..."]` — test attributes
3. `tag.class1.class2` — unique class combination
4. `tag[aria-label="..."]` — accessibility label
5. `a[href="/path"]` — unique link path
6. `tag > tag:nth-child(n) > ...` — structural path (fallback)

## CLI Options

### record-clicks.js

| Option | Default | Description |
|--------|---------|-------------|
| `<url>` | *(required)* | Site URL to open |
| `--profile <id>` | `1` | Browser profile ID |
| `--output <path>` | auto | Output JSON path |
| `--name <name>` | from URL | Task name |

### replay-task.js

| Option | Default | Description |
|--------|---------|-------------|
| `<task.json>` | *(required)* | Path to recorded task |
| `--profile <id>` | `1` | Browser profile ID |
| `--speed <factor>` | `1` | Playback speed (0 = instant) |
| `--headless` | `false` | Run without UI |
| `--timeout <ms>` | `10000` | Element wait timeout |
