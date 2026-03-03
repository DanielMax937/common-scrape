#!/usr/bin/env node
/**
 * 宏观经济与行业数据 — 工作流运行器
 *
 * 将每个数据源的 "获取 → 提取 → 解读" 拆分为流水线节点，
 * 由工作流引擎统一调度，支持并发、重试、断点续跑和进度追踪。
 *
 * Usage:
 *   node run-workflow.js                             # 运行全部
 *   node run-workflow.js --category macro            # 仅宏观数据
 *   node run-workflow.js --category industry         # 仅行业数据
 *   node run-workflow.js --source M2_M1_M0           # 指定数据源
 *   node run-workflow.js --resume                    # 从上次状态续跑
 *   node run-workflow.js --no-llm                    # 跳过 LLM 解读
 *   node run-workflow.js --concurrency 3             # 并发数
 *   node run-workflow.js --dry-run                   # 仅打印工作流结构
 *   node run-workflow.js --help
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '../../src/.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('patchright');
const { ALL_SOURCES, MACRO_SOURCES, INDUSTRY_SOURCES } = require('./data-sources');
const { createLLMClient } = require('./llm-client');
const { WorkflowEngine, makeStepKey } = require('./workflow/engine');
const { STEP_HANDLERS } = require('./workflow/steps');
const { WorkflowReporter } = require('./workflow/reporter');

// ============================================================
// CLI
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    category: null,
    sourceNames: [],
    outputDir: null,
    headless: true,
    enableLLM: true,
    concurrency: 2,
    timeout: 30000,
    resume: false,
    dryRun: false,
    retries: 2,
    cache: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }

    switch (arg) {
      case '--category':
        config.category = next; i++; break;
      case '--source':
        config.sourceNames.push(next); i++; break;
      case '--output-dir':
        config.outputDir = path.resolve(next); i++; break;
      case '--headless':
        config.headless = true; break;
      case '--no-headless':
        config.headless = false; break;
      case '--no-llm':
        config.enableLLM = false; break;
      case '--concurrency':
        config.concurrency = parseInt(next, 10); i++; break;
      case '--timeout':
        config.timeout = parseInt(next, 10); i++; break;
      case '--retries':
        config.retries = parseInt(next, 10); i++; break;
      case '--resume':
        config.resume = true; break;
      case '--no-cache':
        config.cache = false; break;
      case '--dry-run':
        config.dryRun = true; break;
      default:
        if (!arg.startsWith('-')) break;
        console.warn(`未知参数: ${arg}`);
    }
  }
  return config;
}

function printHelp() {
  console.log(`
宏观经济与行业数据 — 工作流运行器

Usage:
  node run-workflow.js [options]

Options:
  --category <macro|industry>  仅运行指定类别的流水线
  --source <name>              指定数据源名称 (可多次使用)
  --output-dir <path>          输出目录 (默认: ./output)
  --headless / --no-headless   无头/有头模式 (默认: headless)
  --no-llm                     跳过所有 LLM 解读步骤
  --concurrency <n>            并发步骤数 (默认: 2)
  --timeout <ms>               页面加载超时 (默认: 30000)
  --retries <n>                失败重试次数 (默认: 2)
  --resume                     从上次保存的状态续跑
  --no-cache                   清除状态文件并重新开始
  --dry-run                    仅打印工作流结构，不执行
  --help, -h                   显示帮助

工作流结构:
  每个数据源生成一条流水线 (Pipeline)，包含以下节点：

    ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
    │ fetch-page  │────▶│extract-content│────▶│ llm-analyze  │
    │ (页面采集)   │     │ (内容提取)     │     │ (LLM 解读)   │
    └─────────────┘     └──────────────┘     └──────────────┘
         ×N URLs             合并结果              AI 分析

  所有流水线完成后执行终结步骤:
    ┌──────────────────┐
    │ generate-report  │  → macro-news-report-YYYY-MM-DD.md
    │ (报告生成)        │
    └──────────────────┘

数据源列表:`);
  for (const s of ALL_SOURCES) {
    const urlCount = s.urls.length;
    const steps = urlCount + urlCount + 1; // fetch + extract + analyze
    console.log(`  [${s.category}] ${s.name} - ${s.description} (${steps} 步骤, ${urlCount} URL)`);
  }
}

// ============================================================
// 从 data-sources 构建工作流定义
// ============================================================

function buildWorkflowDefinition(sources, config) {
  const pipelines = sources.map((source) => {
    const steps = [];

    // 为每个 URL 生成 fetch + extract 步骤对
    source.urls.forEach((url, idx) => {
      const fetchId = `fetch:${idx}`;
      const extractId = `extract:${idx}`;

      steps.push({
        id: fetchId,
        type: 'fetch-page',
        input: { url },
        retries: config.retries,
      });

      steps.push({
        id: extractId,
        type: 'extract-content',
        dependsOn: [fetchId],
        retries: 1,
      });
    });

    // analyze 步骤依赖所有 extract 步骤
    const extractIds = source.urls.map((_, idx) => `extract:${idx}`);
    steps.push({
      id: 'analyze',
      type: 'llm-analyze',
      dependsOn: extractIds,
      input: { prompt: source.prompt },
      retries: config.retries,
    });

    return {
      id: source.name,
      name: source.description,
      category: source.category,
      steps,
    };
  });

  // 终结步骤：依赖所有 pipeline 的 analyze 步骤
  const allAnalyzeKeys = pipelines.map((p) => makeStepKey(p.id, 'analyze'));
  const finalStep = {
    id: 'report',
    type: 'generate-report',
    dependsOn: allAnalyzeKeys,
  };

  return {
    id: 'macro-news-report',
    name: '宏观经济与行业数据报告',
    pipelines,
    finalStep,
  };
}

// ============================================================
// Dry-run: 打印工作流结构
// ============================================================

function printWorkflowGraph(definition) {
  console.log(`\n工作流: ${definition.name} (${definition.id})`);
  console.log(`Pipeline 数量: ${definition.pipelines.length}`);

  let totalSteps = 0;

  for (const pipeline of definition.pipelines) {
    totalSteps += pipeline.steps.length;
    console.log(`\n  ┌── Pipeline: ${pipeline.name} [${pipeline.category}]`);
    console.log(`  │   ID: ${pipeline.id}`);
    console.log(`  │   步骤数: ${pipeline.steps.length}`);
    console.log(`  │`);

    for (let i = 0; i < pipeline.steps.length; i++) {
      const step = pipeline.steps[i];
      const isLast = i === pipeline.steps.length - 1;
      const prefix = isLast ? '  └──' : '  ├──';
      const deps = step.dependsOn ? ` ← [${step.dependsOn.join(', ')}]` : '';
      const inputInfo = step.input?.url
        ? ` url=${step.input.url}`
        : step.input?.prompt
          ? ` prompt="${step.input.prompt.slice(0, 40)}..."`
          : '';
      console.log(`  │ ${prefix} ${step.id} (${step.type})${deps}${inputInfo}`);
    }
  }

  totalSteps += 1; // final step
  console.log(`\n  ★ 终结步骤: ${definition.finalStep.id} (${definition.finalStep.type})`);
  console.log(`    依赖: ${definition.finalStep.dependsOn.length} 个 analyze 步骤`);
  console.log(`\n  总步骤数: ${totalSteps}`);
}

// ============================================================
// Main
// ============================================================

(async () => {
  const config = parseArgs();

  // 筛选数据源
  let sources = ALL_SOURCES;
  if (config.category) {
    sources = config.category === 'macro' ? MACRO_SOURCES : INDUSTRY_SOURCES;
  }
  if (config.sourceNames.length > 0) {
    sources = sources.filter((s) => config.sourceNames.includes(s.name));
  }
  if (sources.length === 0) {
    console.error('没有匹配的数据源。使用 --help 查看可用列表。');
    process.exit(1);
  }

  // 构建工作流定义
  const definition = buildWorkflowDefinition(sources, config);

  // Dry-run 模式
  if (config.dryRun) {
    printWorkflowGraph(definition);
    process.exit(0);
  }

  // 输出目录 & 状态文件
  const outputDir = config.outputDir || path.resolve(__dirname, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const stateFile = path.join(outputDir, 'workflow-state.json');
  
  // 清除缓存 (如果设置了 --no-cache)
  if (!config.cache && fs.existsSync(stateFile)) {
    console.log(`🗑️  清除缓存: ${stateFile}`);
    fs.unlinkSync(stateFile);
  }

  // 初始化 LLM
  const llm = config.enableLLM ? createLLMClient() : null;

  // 启动浏览器
  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // 创建工作流引擎
  const engine = new WorkflowEngine(definition, {
    handlers: STEP_HANDLERS,
    concurrency: config.concurrency,
    defaultRetries: config.retries,
    stateFile,
    stepOutputDir: outputDir,
    context: { browser, llm, config, engine: null }, // engine 后面补上
  });

  // 补上 engine 引用（generate-report 步骤需要）
  engine.context.engine = engine;

  // 断点续跑
  if (config.resume) {
    const loaded = engine.loadState();
    if (loaded) {
      console.log(`📂 已从 ${stateFile} 恢复状态`);
    } else {
      console.log('⚠️  未找到可恢复的状态，将从头开始');
    }
  }

  // 绑定控制台 Reporter
  new WorkflowReporter(engine);

  // 运行
  const summary = await engine.run();

  // 生成报告写入文件
  const reportSteps = engine.getStepsByPipeline();
  const finalSteps = reportSteps['__final__'] || [];
  const reportStep = finalSteps.find((s) => s.type === 'generate-report' && s.output);

  if (reportStep && reportStep.output && reportStep.output.report) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const outputFile = path.join(outputDir, `macro-news-report-${dateStr}.md`);
    fs.writeFileSync(outputFile, reportStep.output.report, 'utf-8');
    console.log(`\n📄 报告已保存: ${outputFile}`);
  }

  await browser.close();

  // 退出码
  process.exit(summary.failed > 0 ? 1 : 0);
})();
