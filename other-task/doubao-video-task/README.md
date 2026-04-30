# Doubao Video Batch Runner

用持久化 Chrome profile 批量提交豆包视频生成任务，等待生成完成后下载视频文件，并写入结果记录。

## 输入格式

```json
[
  {
    "prompt": "请生成一个 15 秒短视频...",
    "imagePaths": ["./assets/ref-1.jpg"],
    "ratio": "16:9"
  }
]
```

字段：
- `prompt`：必填，提交给豆包的视频 prompt。
- `imagePaths`：可选，参考图路径数组。相对路径基于输入 JSON 文件所在目录解析。
- `ratio`：可选，默认 `16:9`。

也兼容纯字符串数组：

```json
[
  "请生成一个产品介绍短视频..."
]
```

## 环境变量

- `DOUBAO_VIDEO_INPUT_JSON`：输入 JSON 路径，默认 `./other-task/doubao-video-task/input.json`
- `DOUBAO_VIDEO_PROFILE_IDS`：profile id 列表，如 `1,2,3`，默认 `1`
- `DOUBAO_VIDEO_PROFILE_DIRS`：profile 目录列表，设置后优先于 `DOUBAO_VIDEO_PROFILE_IDS`
- `DOUBAO_VIDEO_OUTPUT_DIR`：输出目录，默认 `videooutput/doubao`
- `DOUBAO_VIDEO_TARGET_URL`：默认 `https://www.doubao.com/chat/`
- `DOUBAO_VIDEO_BROWSER_CHANNEL`：默认 `chrome`
- `DOUBAO_VIDEO_HEADLESS`：默认 `false`
- `DOUBAO_VIDEO_MAX_WAIT_MS`：单任务等待视频生成超时，默认 `1800000`
- `DOUBAO_VIDEO_POLL_INTERVAL_MS`：轮询间隔，默认 `10000`
- `DOUBAO_VIDEO_PAGE_TIMEOUT_MS`：页面操作超时，默认 `120000`
- `DOUBAO_VIDEO_MAX_RETRIES`：单任务失败重试次数，默认 `3`

## 使用

先用持久 profile 登录豆包：

```bash
npm run browser -- 1
```

运行：

```bash
DOUBAO_VIDEO_INPUT_JSON=./other-task/doubao-video-task/input.example.json \
DOUBAO_VIDEO_PROFILE_IDS=1 \
npm run doubao:video
```

输出：
- 视频文件：`videooutput/doubao/*.mp4`
- 每个视频对应的记录：同名 `.md`
- 汇总记录：`videooutput/doubao/results.jsonl`
- 提交时的 profile/url 记录：`videooutput/doubao/profile-urls.jsonl`
