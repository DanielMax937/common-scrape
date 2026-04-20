# Arena Video Batch Runner

通过多个浏览器 profile 并发提交 Arena 视频任务，并抓取结果下载 URL。

## JSON 输入格式

```json
[
  {
    "prompt": "A cinematic close-up...",
    "attachments": [
      "./assets/ref-1.jpg",
      "/absolute/path/to/ref-2.png"
    ]
  },
  {
    "prompt": "Another prompt",
    "attachment": "./assets/one-file.png"
  }
]
```

支持字段：
- `prompt` (必填)
- `attachments` (可选，字符串数组；最多 1 个)
- `attachment` (可选，字符串；会转成单元素数组)
- `files` (可选，字符串数组；兼容，最多 1 个)

相对路径会基于 JSON 文件所在目录解析。

## 环境变量

- `ARENA_INPUT_JSON`：输入 JSON 路径（必填）
- `ARENA_PROFILE_IDS`：profile id 列表，如 `1,2,3`（与 `browser-profiles/browser-{id}` 组合）
- `ARENA_PROFILE_DIRS`：profile 目录列表（绝对或相对路径）。设置后优先于 `ARENA_PROFILE_IDS`
- `ARENA_TARGET_URL`：默认 `https://arena.ai/video`
- 输出目录固定为项目根目录的 `videooutput/`
- 不下载视频文件；仅抓取下载 URL
- 下载链接清单固定写入 `videooutput/download-links.jsonl`（JSONL，每行一个结果 URL 记录）
- `ARENA_BROWSER_CHANNEL`：默认 `chrome`
- `ARENA_HEADLESS`：`true/false`，默认 `false`
- `ARENA_MAX_WAIT_MS`：单任务最大等待时间，默认 `1800000`（30 分钟）
- `ARENA_POLL_INTERVAL_MS`：轮询间隔，默认 `10000`
- `ARENA_PAGE_TIMEOUT_MS`：页面操作超时（如 `page.goto`、元素等待、URL 等待），默认 `30000`
- `ARENA_EXPECTED_DOWNLOADS`：每个 prompt 期望下载文件数，默认 `2`
- `ARENA_IDLE_EXIT_MS`：worker 空闲多久后退出（毫秒），默认 `0`（永不因空闲退出）
- `ARENA_PRESERVE_PROFILES`：是否保持 profile 持久化，默认 `true`（脚本不会清理 profile 目录）

## 示例

```bash
ARENA_INPUT_JSON=./other-task/arena-task/input.json \
ARENA_PROFILE_IDS=1,2 \
npm run arena:video:batch
```
