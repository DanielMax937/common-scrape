# 宏观经济与行业数据采集 + LLM 解读

自动采集中国各主要政府部门和行业机构公开数据，使用 LLM 进行专业解读，输出 Markdown 报告。

## 数据源覆盖

### 宏观数据（9 项）
| 数据 | 来源 |
|------|------|
| M2、M1、M0 货币供应量 | 中国人民银行-调查统计司 |
| LPR 利率 | 中国人民银行-政策货币司 |
| 进出口、FDI、外汇储备 | 海关总署 + 外汇管理局 |
| 中央财政债务 | 财政部 |
| 人口结构 (出生率/死亡率) | 国家统计局-年度数据 |
| 失业金发放 | 人社部 |
| 居民可支配收入 | 国家统计局-季度数据 |
| CPI、PPI、PMI | 国家统计局-最新发布 |
| 税收、财政收支 | 财政部 |

### 行业数据（13 项）
| 数据 | 来源 |
|------|------|
| 发电量/用电量 | 国家能源局 |
| 煤炭/原油/天然气供需 | 国家统计局 + 海关总署 |
| 有色/黑色金属库存 | 上海期货交易所 |
| 橡胶/轮胎/汽车产销 | 中汽协 + 上期所 |
| 公路物流指数 | 中国物流与采购联合会 |
| 芯片进出口 | 海关总署 |
| 互联网巨头财报 | 港交所 + SEC |
| 银行财报 | 巨潮资讯网 |
| 消费品公司财报 | 巨潮资讯网 |
| 茅台财报 | 巨潮资讯网 |
| 家电龙头财报 (美的/格力) | 巨潮资讯网 |
| 中国移动财报 | 港交所 |
| 航空公司财报 | 巨潮资讯网 |

## 安装与配置

```bash
# 1. 安装依赖（项目根目录）
npm install

# 2. 配置 LLM API
cp other-task/macro-news-task/.env.example other-task/macro-news-task/.env
# 编辑 .env 填入 VOLCENGINE_API_KEY 和 VOLCENGINE_MODEL
```

必须配置的环境变量：
- **`VOLCENGINE_API_KEY`** — 火山引擎 API Key
- **`VOLCENGINE_MODEL`** — 火山引擎模型名称（如 `doubao-pro-32k`）

> 如果已在 `src/.env` 中配置了 `VOLCENGINE_API_KEY` 和 `VOLCENGINE_MODEL`，将自动复用，无需重复配置。

## 使用方法

```bash
# 采集全部数据源 + LLM 解读
npm run fetch:macro-news

# 仅宏观数据
node other-task/macro-news-task/fetch-macro-news.js --category macro

# 仅行业数据
node other-task/macro-news-task/fetch-macro-news.js --category industry

# 指定数据源
node other-task/macro-news-task/fetch-macro-news.js --source M2_M1_M0
node other-task/macro-news-task/fetch-macro-news.js --source CPI_PPI_PMI --source 利率_LPR

# 仅采集页面，不调用 LLM
node other-task/macro-news-task/fetch-macro-news.js --no-llm

# 自定义输出目录
node other-task/macro-news-task/fetch-macro-news.js --output-dir ./reports

# 调整并发数（默认 2）
node other-task/macro-news-task/fetch-macro-news.js --concurrency 3

# 有头模式（调试用）
node other-task/macro-news-task/fetch-macro-news.js --no-headless

# 查看帮助和所有数据源列表
node other-task/macro-news-task/fetch-macro-news.js --help
```

## 输出

报告输出到 `other-task/macro-news-task/output/` 目录，文件名格式：

```
macro-news-report-YYYY-MM-DD.md
```

报告结构：
```
# 宏观经济与行业数据报告
  ├── 目录
  ├── 一、宏观数据
  │   ├── M2 M1 M0 (数据来源 + 原始内容 + AI 解读)
  │   ├── LPR 利率
  │   ├── ...
  │   └── 税收/财政收支
  ├── 二、行业数据
  │   ├── 发电量/用电量
  │   ├── ...
  │   └── 航空公司财报
  └── 采集统计
```

## 工作原理

1. **页面采集**：使用 Playwright 无头浏览器访问各数据源 URL
   - 自动处理 JS 渲染和反爬机制
   - 提取页面表格、链接列表和正文内容

2. **LLM 解读**：将提取的页面内容发送给 LLM 进行分析
   - 系统提示词引导专业经济分析
   - 提取关键数据点和趋势变化
   - 分析原因并判断未来走势

3. **报告生成**：汇总所有数据源的采集结果和解读，输出结构化 Markdown

## 添加新数据源

编辑 `data-sources.js`，在对应数组中添加：

```javascript
{
  name: '数据源名称',          // 唯一标识
  category: 'macro',           // 'macro' 或 'industry'
  description: '数据描述',
  urls: ['https://...'],       // 要采集的 URL
  prompt: '给 LLM 的解读指令',
}
```

## 已知问题与 TODO

> 基于 2026-02-14 全量运行结果，22 个数据源中仅少数能直接采集到有效数据，大部分需要调整。

### 问题总览

| 状态 | 数量 | 说明 |
|------|------|------|
| ✅ 正常 | 3 | 能采集到有效数据并完成 LLM 解读 |
| ⚠️ 需调整 | 15 | 页面为索引/导航页，未采到目标数据 |
| ❌ 不可用 | 4 | 404 / 超时 / 反爬拦截，完全无法采集 |

### ❌ 完全不可用（需更换 URL 或方案）

| # | 数据源 | 问题 | 建议修复方案 |
|---|--------|------|-------------|
| 1 | **M2_M1_M0** | `pbc.gov.cn` 超时（30s），人行网站疑似屏蔽自动化访问 | 换用国家统计局月度数据页 `data.stats.gov.cn` 或中国货币网 `chinamoney.com.cn` |
| 2 | **利率_LPR** | 同上，`pbc.gov.cn` 超时 | 换用中国货币网 LPR 专页 `https://www.chinamoney.com.cn/chinese/bklpr/` |
| 3 | **发电量_用电量** | `nea.gov.cn/sj/index.htm` 返回 404 | 国家能源局数据页 URL 已变更，需找到新地址；或改用国家统计局月度工业数据 |
| 4 | **公路物流指数** | `chinawuliu.com.cn/lwsj/` 返回 404 | 中国物流与采购联合会网站重构，需找到新的数据页地址 |

### ⚠️ 页面可访问但未采到目标数据

#### A. 页面内容不匹配（数据需交互操作才能显示）

| # | 数据源 | 问题 | 建议修复方案 |
|---|--------|------|-------------|
| 5 | **人口结构** | `data.stats.gov.cn?cn=C01` 默认展示"行政区划数"，不是人口数据 | 需模拟页面操作：点击左侧"人口"分类，或构造带指标参数的 URL |
| 6 | **可支配收入** | `data.stats.gov.cn?cn=B01` 默认展示"GDP"季度数据，不是收入数据 | 需模拟页面操作：点击左侧"人民生活"分类 |
| 7 | **煤炭_原油_天然气** | `data.stats.gov.cn?cn=A01` 默认展示"CPI"月度数据，不是能源数据 | 需模拟页面操作：点击左侧"工业"或"能源"分类 |

#### B. 仅采到索引/列表页（需深入子页面）

| # | 数据源 | 问题 | 建议修复方案 |
|---|--------|------|-------------|
| 8 | **债务** | `gks.mof.gov.cn/tongjishuju/` 仅显示文章标题列表 | 需自动点击最新文章链接（如"2025年财政收支情况"）进入详情页采集 |
| 9 | **税收_财政收支** | 同上，与"债务"使用相同 URL | 同上 |
| 10 | **失业金发放** | `mohrss.gov.cn` 仅显示年度统计公报链接列表 | 需自动点击最新年度公报链接进入详情页 |
| 11 | **芯片进出口** | `customs.gov.cn` 海关统计页仅显示统计月报标题列表 | 需点击进入"重点商品量值表"子页面查找"集成电路"数据 |
| 12 | **进出口_外汇储备** | 海关页仅标题列表；`safe.gov.cn` 页面已不存在（URL 变更） | 海关页需点入子页面；外汇管理局需找到新的统计数据 URL |

#### C. 巨潮资讯网通用首页问题

| # | 数据源 | 问题 | 建议修复方案 |
|---|--------|------|-------------|
| 13 | **银行财报** | `cninfo.com.cn/new/index` 是首页，显示市场公告，非指定公司财报 | 需使用个股披露页 URL（如 `disclosure/stock?stockCode=601398`），或调用巨潮 API 搜索 |
| 14 | **消费品公司财报** | 同上 | 改用个股披露页 `disclosure/stock?stockCode=603288` |
| 15 | **航空公司财报** | 同上 | 改用个股披露页 `disclosure/stock?stockCode=601111` |

#### D. 港交所/SEC 反爬问题

| # | 数据源 | 问题 | 建议修复方案 |
|---|--------|------|-------------|
| 16 | **互联网巨头财报** | HKEX 披露易页面 JS 过重导致提取超时挂起；SEC Edgar 识别为自动化工具拒绝访问 | HKEX: 增加提取超时上限 + 特殊处理；SEC: 需设置合规 User-Agent 或改用 SEC EDGAR Full-Text Search API |
| 17 | **中国移动财报** | HKEX 披露易同上问题 | 改用巨潮资讯网 A 股页面 (`stockCode=600941`)，或对 HKEX 增加超时和重试机制 |
| 18 | **家电龙头财报** | 美的(000333)巨潮个股页返回"页面不存在"（orgId 参数可能有误） | 验证并修正 orgId 参数，或改用搜索 API |

### ✅ 数据采集基本正常

| # | 数据源 | 说明 |
|---|--------|------|
| 1 | **CPI_PPI_PMI** | 国家统计局"最新发布"页，采到 2026-01 CPI/PPI 数据标题和摘要 |
| 2 | **茅台财报** | 巨潮个股披露页正常，采到公告列表和基本面数据 |
| 3 | **格力电器** (家电龙头第二个 URL) | 巨潮个股披露页正常 |
| 4 | **橡胶_轮胎_汽车** (中汽协 URL) | 采到中汽协行业动态内容 |

### TODO：优先修复建议

按投入产出比排序：

1. **【高优先级】修正 URL 参数**
   - [ ] 银行/消费品/航空公司财报：从 `cninfo.com.cn/new/index` 改为各公司个股披露页
   - [ ] 家电龙头：修复美的(000333) orgId 参数
   - [ ] 中国移动：增加 A 股巨潮 URL 作为备选
   - [ ] 外汇管理局：查找 `safe.gov.cn` 新的统计数据 URL

2. **【高优先级】替换失效 URL**
   - [ ] M2_M1_M0/LPR：换用 `chinamoney.com.cn` 或国家统计局
   - [ ] 发电量_用电量：查找国家能源局新数据页
   - [ ] 公路物流指数：查找物流联合会新数据页

3. **【中优先级】增加页面交互能力**
   - [ ] `data.stats.gov.cn` 三个数据源（人口/收入/能源）：需在 fetch 步骤中添加页面操作逻辑（点击分类树节点）
   - [ ] 财政部/人社部/海关总署等索引页：需自动点击最新文章链接进入详情页

4. **【低优先级】处理反爬和超时**
   - [ ] HKEX 披露易：增加提取超时保护 + 重试；或考虑使用 HKEX API
   - [ ] SEC EDGAR：设置合规 User-Agent header

## 注意事项

- 部分政府网站可能需要等待 JS Challenge（类似大商所的瑞数防护）
- 某些页面可能仅显示导航/索引，实际数据需要点击进入子页面
- LLM 解读质量取决于页面内容的丰富度
- 建议定期运行，建立数据趋势追踪
- 国家统计局 `data.stats.gov.cn` 的数据表需要通过页面交互选择指标分类才能展示目标数据
