/**
 * Workflow Console Reporter
 *
 * 实时将工作流事件输出到控制台，包含：
 *   - 工作流启动/结束
 *   - 步骤启动/成功/失败/跳过/重试
 *   - 进度条 & 汇总表
 */

const { STEP_STATUS, formatDuration } = require('./engine');

// ── 颜色辅助（ANSI） ─────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
};

const STATUS_STYLES = {
  [STEP_STATUS.PENDING]:  { icon: '⏳', color: c.gray },
  [STEP_STATUS.RUNNING]:  { icon: '🔄', color: c.blue },
  [STEP_STATUS.SUCCESS]:  { icon: '✅', color: c.green },
  [STEP_STATUS.FAILED]:   { icon: '❌', color: c.red },
  [STEP_STATUS.SKIPPED]:  { icon: '⏭️ ', color: c.yellow },
};

const STEP_TYPE_LABELS = {
  'fetch-page':       '📥 页面采集',
  'extract-content':  '📋 内容提取',
  'llm-analyze':      '🤖 LLM 解读',
  'generate-report':  '📝 报告生成',
};

// ── Reporter ──────────────────────────────────────────────────

class WorkflowReporter {
  constructor(engine) {
    this.engine = engine;
    this.startTime = null;
    this._bind();
  }

  _bind() {
    const e = this.engine;
    e.on('workflow:start',  (d) => this._onWorkflowStart(d));
    e.on('workflow:finish', (d) => this._onWorkflowFinish(d));
    e.on('step:start',     (d) => this._onStepStart(d));
    e.on('step:success',   (d) => this._onStepSuccess(d));
    e.on('step:failed',    (d) => this._onStepFailed(d));
    e.on('step:skipped',   (d) => this._onStepSkipped(d));
    e.on('step:retry',     (d) => this._onStepRetry(d));
    e.on('step:saved',     (d) => this._onStepSaved(d));
  }

  // ── 事件处理 ────────────────────────────────────────────────

  _onWorkflowStart({ id, name }) {
    this.startTime = Date.now();
    const def = this.engine.definition;
    const totalSteps = Array.from(this.engine.state.keys()).length;
    const totalPipelines = def.pipelines.length;

    console.log('');
    console.log(`${c.bold}${'═'.repeat(70)}${c.reset}`);
    console.log(`${c.bold}  📊 工作流启动: ${name}${c.reset}`);
    console.log(`${c.dim}  ID: ${id}${c.reset}`);
    console.log(`${c.dim}  Pipeline 数量: ${totalPipelines} | 总步骤数: ${totalSteps} | 并发: ${this.engine.concurrency}${c.reset}`);
    console.log(`${c.bold}${'═'.repeat(70)}${c.reset}`);
    console.log('');

    // 打印工作流结构
    this._printWorkflowStructure();
  }

  _onWorkflowFinish(summary) {
    const elapsed = Date.now() - this.startTime;
    console.log('');
    console.log(`${c.bold}${'═'.repeat(70)}${c.reset}`);
    console.log(`${c.bold}  📊 工作流完成${c.reset}`);
    console.log(`${c.bold}${'─'.repeat(70)}${c.reset}`);
    console.log(`  总步骤: ${summary.total}`);
    console.log(`  ${c.green}✅ 成功: ${summary.success}${c.reset}`);
    if (summary.failed > 0) console.log(`  ${c.red}❌ 失败: ${summary.failed}${c.reset}`);
    if (summary.skipped > 0) console.log(`  ${c.yellow}⏭️  跳过: ${summary.skipped}${c.reset}`);
    console.log(`  ⏱️  总耗时: ${formatDuration(elapsed)}`);
    console.log(`${c.bold}${'═'.repeat(70)}${c.reset}`);
    console.log('');
  }

  _onStepStart({ key, type, attempt, pipeline }) {
    const label = STEP_TYPE_LABELS[type] || type;
    const attemptStr = attempt > 1 ? ` ${c.yellow}(第${attempt}次尝试)${c.reset}` : '';
    const pipelineLabel = pipeline !== '__final__' ? `${c.dim}[${pipeline}]${c.reset} ` : '';
    console.log(`  ${c.blue}▶${c.reset} ${pipelineLabel}${label}${attemptStr}  ${c.dim}${key}${c.reset}`);
  }

  _onStepSuccess({ key, durationMs, outputPreview }) {
    const duration = formatDuration(durationMs);
    const preview = outputPreview ? `  ${c.dim}${outputPreview}${c.reset}` : '';
    console.log(`  ${c.green}✓${c.reset} ${key}  ${c.green}${duration}${c.reset}${preview}`);
    this._printProgress();
  }

  _onStepFailed({ key, error, attempts }) {
    console.log(`  ${c.red}✗${c.reset} ${key}  ${c.red}${error}${c.reset}  ${c.dim}(${attempts}次尝试)${c.reset}`);
    this._printProgress();
  }

  _onStepSkipped({ key, reason }) {
    console.log(`  ${c.yellow}⏭${c.reset}  ${key}  ${c.dim}${reason}${c.reset}`);
  }

  _onStepRetry({ key, attempt, error }) {
    console.log(`  ${c.yellow}↻${c.reset} ${key}  ${c.yellow}重试 ${attempt}${c.reset}  ${c.dim}${error}${c.reset}`);
  }

  _onStepSaved({ key, filePath }) {
    const relPath = filePath.replace(process.cwd() + '/', '');
    console.log(`  ${c.dim}💾 ${relPath}${c.reset}`);
  }

  // ── 进度条 ──────────────────────────────────────────────────

  _printProgress() {
    const total = this.engine.state.size;
    let done = 0;
    for (const state of this.engine.state.values()) {
      if (state.status === STEP_STATUS.SUCCESS ||
          state.status === STEP_STATUS.FAILED ||
          state.status === STEP_STATUS.SKIPPED) {
        done++;
      }
    }
    const pct = Math.round((done / total) * 100);
    const barLen = 30;
    const filled = Math.round((done / total) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const elapsed = formatDuration(Date.now() - this.startTime);

    process.stdout.write(
      `\r  ${c.cyan}[${bar}] ${pct}% (${done}/${total})${c.reset}  ⏱️ ${elapsed}     `,
    );
    if (done === total) console.log(''); // 完成后换行
  }

  // ── 工作流结构打印 ──────────────────────────────────────────

  _printWorkflowStructure() {
    const def = this.engine.definition;
    const macroP = def.pipelines.filter((p) => p.category === 'macro');
    const industryP = def.pipelines.filter((p) => p.category === 'industry');

    if (macroP.length > 0) {
      console.log(`  ${c.bold}── 宏观数据 (${macroP.length} 条流水线) ──${c.reset}`);
      for (const p of macroP) {
        const stepTypes = p.steps.map((s) => STEP_TYPE_LABELS[s.type] || s.type).join(' → ');
        console.log(`    ${c.cyan}▸${c.reset} ${p.name}  ${c.dim}[${stepTypes}]${c.reset}`);
      }
      console.log('');
    }
    if (industryP.length > 0) {
      console.log(`  ${c.bold}── 行业数据 (${industryP.length} 条流水线) ──${c.reset}`);
      for (const p of industryP) {
        const stepTypes = p.steps.map((s) => STEP_TYPE_LABELS[s.type] || s.type).join(' → ');
        console.log(`    ${c.cyan}▸${c.reset} ${p.name}  ${c.dim}[${stepTypes}]${c.reset}`);
      }
      console.log('');
    }

    if (def.finalStep) {
      const label = STEP_TYPE_LABELS[def.finalStep.type] || def.finalStep.type;
      console.log(`  ${c.bold}── 终结步骤 ──${c.reset}`);
      console.log(`    ${c.magenta}★${c.reset} ${label}`);
      console.log('');
    }
  }
}

module.exports = { WorkflowReporter };
