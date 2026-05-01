# Alice Chat Task

用一个或多个持久化 Chrome profile 打开 Wind Alice Chat，按页面技能列表编号选择技能，然后提交 prompt，等待回答完成后点击复制按钮，并把复制出来的内容保存为 Markdown。浏览器数量由 env 里的 profile 数量决定。

目标 URL：`https://alice.wind.com.cn/chat`

## 输入格式

```json
{
  "version": 1,
  "assignment": {
    "profileSource": "env",
    "strategy": "perBrowserSequential",
    "tasksPerBrowser": 2
  },
  "variables": {
    "aShareStockName": {
      "type": "randomChoice",
      "source": "builtin:a_share_stock_names",
      "uniquePerRun": true
    },
    "futuresProductName": {
      "type": "randomChoice",
      "source": "builtin:futures_product_names",
      "uniquePerRun": true
    }
  },
  "taskTemplates": [
    {
      "name": "stock-analysis",
      "skillNumber": 2,
      "prompt": "请分析A股股票：{{aShareStockName}}。请给出基本面、近期市场关注点、主要风险和后续观察指标。"
    },
    {
      "name": "futures-analysis",
      "skillNumber": 1,
      "prompt": "请分析期货品种：{{futuresProductName}}。请给出产业链逻辑、供需变量、价格驱动和风险提示。"
    }
  ]
}
```

字段：
- `skillNumber`：聊天页点击“使用技能”后，弹层中“社区技能”板块里的技能顺序编号，例如 `1` 表示社区技能第 1 个。脚本不会选择“我创建的”或“官方技能”板块。
- `prompt`：提交给 Alice 的内容，支持 `{{变量名}}` 模板。
- `assignment.profileSource`：目前固定使用 `env`，即从 `ALICE_PROFILE_IDS` 或 `ALICE_PROFILE_DIRS` 读取浏览器。
- `assignment.strategy`：目前支持 `perBrowserSequential`，每个浏览器拿到自己的任务列表并顺序执行。
- `assignment.tasksPerBrowser`：每个浏览器要执行的任务数。
- `variables`：支持 `randomChoice`，内置来源有 `builtin:a_share_stock_names` 和 `builtin:futures_product_names`。
- `taskTemplates`：每个浏览器按这里的顺序执行技能和 prompt。

旧格式仍兼容：

```json
[
  {
    "skillNumber": 1,
    "prompt": "请总结今天适合关注的宏观经济变量。"
  }
]
```

## 环境变量

- `ALICE_INPUT_JSON`：输入 JSON 路径，默认 `./other-task/alice-task/input.json`
- `ALICE_PROFILE_IDS`：浏览器 profile id 列表，如 `1,2,3`。默认 `1`；列表长度就是启动浏览器数量。
- `ALICE_PROFILE_DIRS`：profile 目录列表，设置后优先于 `ALICE_PROFILE_IDS`
- `ALICE_OUTPUT_DIR`：输出目录，默认 `output/alice`
- `ALICE_TARGET_URL`：默认 `https://alice.wind.com.cn/chat`
- `ALICE_BROWSER_CHANNEL`：默认 `chrome`
- `ALICE_HEADLESS`：默认 `false`
- `ALICE_PAGE_TIMEOUT_MS`：页面操作超时，默认 `120000`
- `ALICE_TASK_TIMEOUT_MS`：单个任务最大执行时间，默认 `600000`
- `ALICE_RESPONSE_TIMEOUT_MS`：兼容旧配置；未设置 `ALICE_TASK_TIMEOUT_MS` 时作为单任务超时使用
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

多个浏览器各自执行分配到的任务列表。每个任务最多执行 10 分钟；超时、社区技能编号不存在或其他失败会写入 `results.jsonl`，然后继续下一个任务。任务只有在回答稳定、页面出现复制按钮、并且复制内容可读取后才算成功。

输出：
- `output/alice/results.jsonl`
- `output/alice/task-001.md`
