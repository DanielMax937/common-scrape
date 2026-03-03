/**
 * Workflow Engine
 *
 * 轻量级工作流引擎，将数据采集和解读拆分为可追踪的流水线节点。
 *
 * 核心概念：
 *   - Workflow:  顶层编排，包含多条 Pipeline 和一个终结步骤
 *   - Pipeline:  一个数据源的处理流水线，内含多个 Step
 *   - Step:      原子操作单元 (fetch / extract / analyze 等)
 *
 * 特性：
 *   - 步骤状态跟踪 (pending → running → success / failed / skipped)
 *   - 依赖解析（步骤仅在所有前置完成后才执行）
 *   - 自动重试 (可配置次数和退避策略)
 *   - 状态持久化 (JSON，支持断点续跑)
 *   - 并发控制 (跨 Pipeline 限制同时执行的步骤数)
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// ── Step 状态常量 ─────────────────────────────────────────────
const STEP_STATUS = {
  PENDING:  'pending',
  RUNNING:  'running',
  SUCCESS:  'success',
  FAILED:   'failed',
  SKIPPED:  'skipped',
};

// ── Step 数据结构 ─────────────────────────────────────────────

/**
 * @typedef {Object} StepDef
 * @property {string}   id        - 步骤 ID（Pipeline 内唯一）
 * @property {string}   type      - 步骤类型 (fetch-page | extract-content | llm-analyze | generate-report)
 * @property {string[]} [dependsOn] - 前置步骤 ID 列表
 * @property {object}   [input]   - 步骤输入参数
 * @property {number}   [retries] - 最大重试次数 (默认 1)
 */

/**
 * @typedef {Object} StepState
 * @property {string}      status     - 当前状态
 * @property {object|null} output     - 步骤输出
 * @property {string|null} error      - 错误信息
 * @property {number}      attempts   - 已执行次数
 * @property {number|null} startedAt  - 开始时间戳
 * @property {number|null} finishedAt - 结束时间戳
 * @property {number|null} durationMs - 耗时毫秒
 */

// ── Pipeline 数据结构 ─────────────────────────────────────────

/**
 * @typedef {Object} PipelineDef
 * @property {string}    id          - Pipeline ID (= data source name)
 * @property {string}    name        - 显示名称
 * @property {string}    category    - macro | industry
 * @property {StepDef[]} steps       - 步骤定义列表
 */

// ── Workflow 数据结构 ─────────────────────────────────────────

/**
 * @typedef {Object} WorkflowDef
 * @property {string}        id         - Workflow ID
 * @property {string}        name       - 显示名称
 * @property {PipelineDef[]} pipelines  - 所有 Pipeline
 * @property {StepDef}       [finalStep]- 终结步骤 (generate-report)
 */

// ── 辅助函数 ──────────────────────────────────────────────────

function makeStepKey(pipelineId, stepId) {
  return `${pipelineId}::${stepId}`;
}

function now() {
  return Date.now();
}

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

// ── WorkflowEngine ────────────────────────────────────────────

class WorkflowEngine extends EventEmitter {
  /**
   * @param {WorkflowDef} definition
   * @param {object} opts
   * @param {object} opts.handlers     - { [stepType]: async (input, context) => output }
   * @param {number} [opts.concurrency=2]
   * @param {number} [opts.defaultRetries=1]
   * @param {string} [opts.stateFile]  - JSON 持久化路径
   * @param {object} [opts.context={}] - 共享上下文 (browser, llm 等)
   */
  /**
   * @param {WorkflowDef} definition
   * @param {object} opts
   * @param {object} opts.handlers       - { [stepType]: async (input, context) => output }
   * @param {number} [opts.concurrency=2]
   * @param {number} [opts.defaultRetries=1]
   * @param {string} [opts.stateFile]    - JSON 持久化路径
   * @param {string} [opts.stepOutputDir]- 步骤输出保存目录 (每步骤一个 .md)
   * @param {object} [opts.context={}]   - 共享上下文 (browser, llm 等)
   */
  constructor(definition, opts = {}) {
    super();
    this.definition = definition;
    this.handlers = opts.handlers || {};
    this.concurrency = opts.concurrency || 2;
    this.defaultRetries = opts.defaultRetries || 1;
    this.stateFile = opts.stateFile || null;
    this.stepOutputDir = opts.stepOutputDir || null;
    this.context = opts.context || {};

    // ── 内部状态 ──
    // stepKey → StepState
    this.state = new Map();
    // stepKey → StepDef (扁平化)
    this.stepDefs = new Map();
    // stepKey → pipelineId
    this.stepPipeline = new Map();
    // 当前运行计数
    this.running = 0;
    // 已完成 promise resolve
    this._resolveFinished = null;

    this._initState();
  }

  // ── 初始化 ──────────────────────────────────────────────────

  _initState() {
    // 将所有 pipeline 的 steps 扁平化
    for (const pipeline of this.definition.pipelines) {
      for (const step of pipeline.steps) {
        const key = makeStepKey(pipeline.id, step.id);
        this.stepDefs.set(key, step);
        this.stepPipeline.set(key, pipeline.id);
        this.state.set(key, {
          status: STEP_STATUS.PENDING,
          output: null,
          error: null,
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
        });
      }
    }

    // 终结步骤
    if (this.definition.finalStep) {
      const key = makeStepKey('__final__', this.definition.finalStep.id);
      this.stepDefs.set(key, this.definition.finalStep);
      this.stepPipeline.set(key, '__final__');
      this.state.set(key, {
        status: STEP_STATUS.PENDING,
        output: null,
        error: null,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      });
    }
  }

  // ── 状态持久化 ──────────────────────────────────────────────

  saveState() {
    if (!this.stateFile) return;
    const serializable = {};
    for (const [key, val] of this.state) {
      serializable[key] = val;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(serializable, null, 2), 'utf-8');
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      for (const [key, val] of Object.entries(data)) {
        if (this.state.has(key)) {
          // Don't resume running steps — reset them to pending
          if (val.status === STEP_STATUS.RUNNING) {
            val.status = STEP_STATUS.PENDING;
          }
          this.state.set(key, val);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── 步骤输出保存 (每步骤一个 .md) ──────────────────────────

  /**
   * 将步骤的输出保存为独立的 Markdown 文件
   * 目录结构: {stepOutputDir}/steps/{pipelineId}/{stepId}.md
   */
  _saveStepOutput(stepKey) {
    if (!this.stepOutputDir) return;

    const def = this.stepDefs.get(stepKey);
    const state = this.state.get(stepKey);
    if (!state || state.status !== STEP_STATUS.SUCCESS || !state.output) return;

    const pipelineId = this.stepPipeline.get(stepKey);
    const pipeline = this.definition.pipelines.find((p) => p.id === pipelineId);
    const pipelineName = pipeline ? pipeline.name : pipelineId;

    // 安全化目录/文件名 (替换路径不安全字符)
    const safePipelineId = pipelineId.replace(/[<>:"/\\|?*]/g, '_');
    const safeStepId = def.id.replace(/[<>:"/\\|?*]/g, '_').replace(/:/g, '-');
    const dir = path.join(this.stepOutputDir, 'steps', safePipelineId);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${safeStepId}.md`);
    const content = this._formatStepOutputMd(stepKey, def, state, pipelineId, pipelineName);
    fs.writeFileSync(filePath, content, 'utf-8');

    this.emit('step:saved', { key: stepKey, filePath });
  }

  /**
   * 根据步骤类型将 output 格式化为 Markdown
   */
  _formatStepOutputMd(stepKey, def, state, pipelineId, pipelineName) {
    const duration = formatDuration(state.durationMs);
    const ts = state.finishedAt ? new Date(state.finishedAt).toLocaleString('zh-CN') : '-';
    const output = state.output;

    let md = `# ${pipelineName} — ${def.id}\n\n`;
    md += `> 步骤类型：${def.type} | 状态：${state.status} | 耗时：${duration} | 完成时间：${ts}\n`;
    md += `> Pipeline：${pipelineId} | Key：${stepKey}\n\n`;
    md += '---\n\n';

    switch (def.type) {
      case 'fetch-page':
        md += this._formatFetchOutput(output);
        break;
      case 'extract-content':
        md += this._formatExtractOutput(output);
        break;
      case 'llm-analyze':
        md += this._formatAnalyzeOutput(output, def);
        break;
      case 'generate-report':
        md += this._formatReportOutput(output);
        break;
      default:
        md += '```json\n' + JSON.stringify(output, null, 2) + '\n```\n';
    }

    return md;
  }

  _formatFetchOutput(output) {
    let md = `## 页面信息\n\n`;
    md += `- **URL**: ${output.url || '-'}\n`;
    md += `- **标题**: ${output.title || '-'}\n\n`;

    if (output.textSnapshot) {
      md += `## 页面文本快照\n\n`;
      md += output.textSnapshot + '\n';
    }
    return md;
  }

  _formatExtractOutput(output) {
    let md = '';
    if (output.pages && output.pages.length > 0) {
      md += `## 提取统计\n\n`;
      md += `- 页面数: ${output.pages.length}\n`;
      md += `- 表格数: ${output.totalTables || 0}\n`;
      md += `- 链接数: ${output.totalLinks || 0}\n`;
      md += `- 文本长度: ${output.totalTextLength || 0}\n\n`;
    }

    if (output.combinedContent) {
      md += `## 提取内容\n\n`;
      md += output.combinedContent + '\n';
    }
    return md;
  }

  _formatAnalyzeOutput(output, def) {
    let md = '';
    if (def.input && def.input.prompt) {
      md += `## 分析指令\n\n${def.input.prompt}\n\n`;
    }

    if (output.skipped) {
      md += `## 结果\n\n${output.analysis}\n`;
    } else {
      if (output.inputLength) {
        md += `> 输入长度: ${output.inputLength} 字 | 输出长度: ${output.outputLength} 字\n\n`;
      }
      md += `## AI 解读分析\n\n`;
      md += (output.analysis || '') + '\n';
    }
    return md;
  }

  _formatReportOutput(output) {
    if (output.report) {
      return output.report;
    }
    return '```json\n' + JSON.stringify(output, null, 2) + '\n```\n';
  }

  // ── 依赖解析 ────────────────────────────────────────────────

  /**
   * 检查一个步骤的所有前置是否已完成 (success 或 skipped)
   */
  _areDependenciesMet(stepKey) {
    const def = this.stepDefs.get(stepKey);
    if (!def.dependsOn || def.dependsOn.length === 0) return true;

    const pipelineId = this.stepPipeline.get(stepKey);
    for (const depId of def.dependsOn) {
      // 依赖可以是同 pipeline 内的 stepId，也可以是完整 key
      const depKey = depId.includes('::') ? depId : makeStepKey(pipelineId, depId);
      const depState = this.state.get(depKey);
      if (!depState) return false;
      if (depState.status !== STEP_STATUS.SUCCESS && depState.status !== STEP_STATUS.SKIPPED) {
        return false;
      }
    }
    return true;
  }

  /**
   * 检查前置是否有失败的（用于决定是否 skip）
   */
  _hasFailedDependency(stepKey) {
    const def = this.stepDefs.get(stepKey);
    if (!def.dependsOn || def.dependsOn.length === 0) return false;

    const pipelineId = this.stepPipeline.get(stepKey);
    for (const depId of def.dependsOn) {
      const depKey = depId.includes('::') ? depId : makeStepKey(pipelineId, depId);
      const depState = this.state.get(depKey);
      if (depState && depState.status === STEP_STATUS.FAILED) return true;
    }
    return false;
  }

  // ── 步骤输入收集 ────────────────────────────────────────────

  /**
   * 收集步骤的输入：合并 step.input 定义和前置步骤的 output
   */
  _collectStepInput(stepKey) {
    const def = this.stepDefs.get(stepKey);
    const pipelineId = this.stepPipeline.get(stepKey);
    const input = { ...(def.input || {}) };

    // 找到对应的 pipeline 定义
    const pipeline = this.definition.pipelines.find((p) => p.id === pipelineId);
    if (pipeline) {
      input._pipeline = {
        id: pipeline.id,
        name: pipeline.name,
        category: pipeline.category,
      };
    }

    // 汇入前置步骤的 output
    if (def.dependsOn && def.dependsOn.length > 0) {
      input._deps = {};
      for (const depId of def.dependsOn) {
        const depKey = depId.includes('::') ? depId : makeStepKey(pipelineId, depId);
        const depState = this.state.get(depKey);
        if (depState && depState.output) {
          input._deps[depId] = depState.output;
        }
      }
    }

    return input;
  }

  // ── 执行循环 ────────────────────────────────────────────────

  /**
   * 运行整个工作流，返回完成后的汇总
   */
  async run() {
    this.emit('workflow:start', { id: this.definition.id, name: this.definition.name });

    return new Promise((resolve) => {
      this._resolveFinished = resolve;
      this._tick();
    });
  }

  /**
   * 调度循环：找到可运行的步骤并启动
   */
  _tick() {
    // 找到所有可运行的步骤
    const readySteps = [];
    for (const [key, state] of this.state) {
      if (state.status !== STEP_STATUS.PENDING) continue;

      // 前置依赖有失败 → skip 本步骤
      if (this._hasFailedDependency(key)) {
        state.status = STEP_STATUS.SKIPPED;
        state.error = '前置步骤失败，已跳过';
        this.emit('step:skipped', { key, reason: state.error });
        this.saveState();
        continue;
      }

      if (this._areDependenciesMet(key)) {
        readySteps.push(key);
      }
    }

    // 按并发限制启动
    for (const key of readySteps) {
      if (this.running >= this.concurrency) break;
      this._executeStep(key);
    }

    // 检查是否全部完成
    if (this.running === 0 && readySteps.length === 0) {
      this._finalize();
    }
  }

  /**
   * 执行单个步骤
   */
  async _executeStep(stepKey) {
    const def = this.stepDefs.get(stepKey);
    const state = this.state.get(stepKey);
    const maxRetries = def.retries ?? this.defaultRetries;

    state.status = STEP_STATUS.RUNNING;
    state.startedAt = now();
    state.attempts++;
    this.running++;

    this.emit('step:start', {
      key: stepKey,
      type: def.type,
      attempt: state.attempts,
      pipeline: this.stepPipeline.get(stepKey),
    });
    this.saveState();

    const handler = this.handlers[def.type];
    if (!handler) {
      state.status = STEP_STATUS.FAILED;
      state.error = `未注册步骤处理器: ${def.type}`;
      state.finishedAt = now();
      state.durationMs = state.finishedAt - state.startedAt;
      this.running--;
      this.emit('step:failed', { key: stepKey, error: state.error });
      this.saveState();
      this._tick();
      return;
    }

    try {
      const input = this._collectStepInput(stepKey);
      const output = await handler(input, this.context);

      state.status = STEP_STATUS.SUCCESS;
      state.output = output;
      state.finishedAt = now();
      state.durationMs = state.finishedAt - state.startedAt;

      // 保存步骤输出为独立 .md 文件
      this._saveStepOutput(stepKey);

      this.emit('step:success', {
        key: stepKey,
        durationMs: state.durationMs,
        outputPreview: typeof output === 'string'
          ? output.slice(0, 80)
          : JSON.stringify(output).slice(0, 80),
      });
    } catch (err) {
      // 重试逻辑
      if (state.attempts < maxRetries) {
        state.status = STEP_STATUS.PENDING;
        state.error = `第 ${state.attempts} 次失败: ${err.message}`;
        this.emit('step:retry', { key: stepKey, attempt: state.attempts, error: err.message });
      } else {
        state.status = STEP_STATUS.FAILED;
        state.error = err.message;
        state.finishedAt = now();
        state.durationMs = state.finishedAt - state.startedAt;
        this.emit('step:failed', { key: stepKey, error: err.message, attempts: state.attempts });
      }
    }

    this.running--;
    this.saveState();
    this._tick();
  }

  // ── 结束汇总 ────────────────────────────────────────────────

  _finalize() {
    const summary = this.getSummary();
    this.emit('workflow:finish', summary);
    if (this._resolveFinished) this._resolveFinished(summary);
  }

  /**
   * 获取执行汇总
   */
  getSummary() {
    let total = 0, success = 0, failed = 0, skipped = 0, pending = 0;
    let totalDurationMs = 0;
    const pipelineSummaries = {};

    for (const [key, state] of this.state) {
      total++;
      if (state.status === STEP_STATUS.SUCCESS) { success++; totalDurationMs += (state.durationMs || 0); }
      else if (state.status === STEP_STATUS.FAILED) failed++;
      else if (state.status === STEP_STATUS.SKIPPED) skipped++;
      else pending++;

      const pipelineId = this.stepPipeline.get(key);
      if (!pipelineSummaries[pipelineId]) {
        pipelineSummaries[pipelineId] = { total: 0, success: 0, failed: 0, skipped: 0 };
      }
      pipelineSummaries[pipelineId].total++;
      if (state.status === STEP_STATUS.SUCCESS) pipelineSummaries[pipelineId].success++;
      else if (state.status === STEP_STATUS.FAILED) pipelineSummaries[pipelineId].failed++;
      else if (state.status === STEP_STATUS.SKIPPED) pipelineSummaries[pipelineId].skipped++;
    }

    return {
      workflowId: this.definition.id,
      total, success, failed, skipped, pending,
      totalDurationMs,
      pipelineSummaries,
    };
  }

  /**
   * 获取完整步骤详情（给 reporter 用）
   */
  getStepDetails() {
    const details = [];
    for (const [key, state] of this.state) {
      const def = this.stepDefs.get(key);
      details.push({
        key,
        pipelineId: this.stepPipeline.get(key),
        stepId: def.id,
        type: def.type,
        status: state.status,
        attempts: state.attempts,
        durationMs: state.durationMs,
        error: state.error,
        output: state.output,
      });
    }
    return details;
  }

  /**
   * 按 pipeline 聚合步骤详情
   */
  getStepsByPipeline() {
    const byPipeline = {};
    for (const [key, state] of this.state) {
      const pipelineId = this.stepPipeline.get(key);
      if (!byPipeline[pipelineId]) byPipeline[pipelineId] = [];
      const def = this.stepDefs.get(key);
      byPipeline[pipelineId].push({
        key,
        stepId: def.id,
        type: def.type,
        ...state,
      });
    }
    return byPipeline;
  }
}

module.exports = { WorkflowEngine, STEP_STATUS, makeStepKey, formatDuration };
