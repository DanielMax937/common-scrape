# Alice Chat Task

用一个或多个持久化 Chrome profile 打开 Wind Alice Chat，按页面技能列表编号选择技能，然后提交 prompt 并保存回答。浏览器数量由 env 里的 profile 数量决定。

目标 URL：`https://alice.wind.com.cn/chat`

## 输入格式

```json
[
  {
    "skillNumber": 1,
    "prompt": "请总结今天适合关注的宏观经济变量。"
  }
]
```

字段：
- `skillNumber`：页面技能列表编号，例如 `1`。脚本会优先点击文本以 `1.`、`1、`、`1)` 开头的技能项；找不到时会退回点击可见技能列表里的第 1 项。
- `prompt`：提交给 Alice 的内容。

## 环境变量

- `ALICE_INPUT_JSON`：输入 JSON 路径，默认 `./other-task/alice-task/input.json`
- `ALICE_PROFILE_IDS`：浏览器 profile id 列表，如 `1,2,3`。默认 `1`；列表长度就是启动浏览器数量。
- `ALICE_PROFILE_DIRS`：profile 目录列表，设置后优先于 `ALICE_PROFILE_IDS`
- `ALICE_OUTPUT_DIR`：输出目录，默认 `output/alice`
- `ALICE_TARGET_URL`：默认 `https://alice.wind.com.cn/chat`
- `ALICE_BROWSER_CHANNEL`：默认 `chrome`
- `ALICE_HEADLESS`：默认 `false`
- `ALICE_PAGE_TIMEOUT_MS`：页面操作超时，默认 `120000`
- `ALICE_RESPONSE_TIMEOUT_MS`：等待回答超时，默认 `600000`
- `ALICE_STABLE_MS`：回答稳定判定时间，默认 `3000`

## 使用

先登录：

```bash
npm run browser -- 1
```

打开后登录 `https://alice.wind.com.cn/chat`，关闭浏览器保存 profile。

校验输入：

```bash
ALICE_INPUT_JSON=./other-task/alice-task/input.example.json npm run alice:chat -- --dry-run
```

运行：

```bash
ALICE_INPUT_JSON=./other-task/alice-task/input.example.json \
ALICE_PROFILE_IDS=1,2 \
npm run alice:chat
```

多个浏览器会共享同一个任务队列，每个任务仍按自己的 `skillNumber` 和 `prompt` 执行。

输出：
- `output/alice/results.jsonl`
- `output/alice/task-001.md`
