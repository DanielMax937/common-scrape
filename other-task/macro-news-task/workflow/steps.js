/**
 * Workflow Step Handlers
 *
 * 每个 handler 签名:  async (input, context) => output
 *
 * input 包含:
 *   - step 定义中的 input 字段
 *   - _pipeline: { id, name, category }
 *   - _deps: { [depId]: depOutput }  (前置步骤输出)
 *
 * context 包含:
 *   - browser:  Playwright Browser 实例
 *   - llm:      LLM Client 实例
 *   - config:   全局配置
 */

// ============================================================
// fetch-page: 使用 Playwright 访问 URL，获取原始 HTML
// ============================================================

async function fetchPage(input, context) {
  const { url } = input;
  const { browser, config } = context;
  const timeout = config.timeout || 30000;

  const browserContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await browserContext.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000); // JS 渲染缓冲

    const title = await page.title();
    const html = await page.content();

    // 同时在 page context 里提取纯文本快照 (给 extract 步骤备用)
    const textSnapshot = await page.evaluate(() => document.body.innerText.slice(0, 20000));

    return { url, title, html, textSnapshot };
  } finally {
    await browserContext.close();
  }
}

// ============================================================
// extract-content: 从 fetch-page 输出中提取结构化文本
// ============================================================

async function extractContent(input, context) {
  // 从依赖中获取 fetch 输出
  const deps = input._deps || {};
  const depKeys = Object.keys(deps);
  if (depKeys.length === 0) return { content: '', tables: [], links: [] };

  const { browser, config } = context;
  const allContent = [];

  for (const depKey of depKeys) {
    const fetchOutput = deps[depKey];
    if (!fetchOutput || !fetchOutput.html) continue;

    // 用 browser 做 DOM 解析更可靠 (在新 page 中加载 HTML)
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();

    try {
      await page.setContent(fetchOutput.html, { waitUntil: 'domcontentloaded' });

      const extracted = await page.evaluate(() => {
        // 移除噪音
        const removeSelectors = [
          'script', 'style', 'noscript', 'iframe',
          'nav', 'header', 'footer',
          '.nav', '.header', '.footer', '.sidebar', '.breadcrumb',
          '.advertisement', '.ad', '#cookie-banner',
        ];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        }

        // 提取表格
        const tables = [];
        document.querySelectorAll('table').forEach((table, idx) => {
          const rows = [];
          table.querySelectorAll('tr').forEach((tr) => {
            const cells = [];
            tr.querySelectorAll('th, td').forEach((cell) => {
              cells.push(cell.innerText.trim().replace(/\s+/g, ' '));
            });
            if (cells.length > 0) rows.push(cells.join(' | '));
          });
          if (rows.length > 0) tables.push({ index: idx + 1, rows });
        });

        // 提取链接
        const mainContent =
          document.body.querySelector('main, .main, .content, .article, #content, #main') ||
          document.body;
        const links = [];
        mainContent.querySelectorAll('a').forEach((a) => {
          const text = a.innerText.trim();
          if (text.length > 5 && text.length < 200) {
            links.push({ text, href: a.getAttribute('href') || '' });
          }
        });

        // 正文
        const textContent = mainContent.innerText
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 15000);

        return { tables, links: links.slice(0, 50), textContent };
      });

      // 组装成 markdown 文本
      let md = '';
      if (extracted.tables.length > 0) {
        md += '### 页面表格数据\n\n';
        for (const t of extracted.tables) {
          md += `[表格 ${t.index}]\n${t.rows.join('\n')}\n\n`;
        }
      }
      if (extracted.links.length > 0) {
        md += '### 页面链接列表\n\n';
        for (const l of extracted.links) {
          md += `- ${l.text}${l.href ? ' (' + l.href + ')' : ''}\n`;
        }
        md += '\n';
      }
      md += '### 页面正文\n\n' + extracted.textContent;

      allContent.push({
        url: fetchOutput.url,
        title: fetchOutput.title,
        content: md,
        tableCount: extracted.tables.length,
        linkCount: extracted.links.length,
        textLength: extracted.textContent.length,
      });
    } finally {
      await browserContext.close();
    }
  }

  // 合并多个 URL 的内容
  const combinedContent = allContent
    .map((c) => `[来源: ${c.url}]\n\n${c.content}`)
    .join('\n\n---\n\n');

  return {
    pages: allContent,
    combinedContent,
    totalTables: allContent.reduce((s, c) => s + c.tableCount, 0),
    totalLinks: allContent.reduce((s, c) => s + c.linkCount, 0),
    totalTextLength: allContent.reduce((s, c) => s + c.textLength, 0),
  };
}

// ============================================================
// llm-analyze: 调用 LLM 解读提取的内容
// ============================================================

async function llmAnalyze(input, context) {
  const { llm, config } = context;

  if (!config.enableLLM || !llm) {
    return { analysis: '[LLM 已禁用]', skipped: true };
  }

  // 从依赖中获取 extract 输出
  const deps = input._deps || {};
  let combinedContent = '';
  for (const dep of Object.values(deps)) {
    if (dep && dep.combinedContent) {
      combinedContent += dep.combinedContent + '\n\n';
    }
  }

  if (!combinedContent.trim()) {
    return { analysis: '[无有效内容可供解读]', skipped: true };
  }

  const prompt = input.prompt || '请对以上数据进行专业解读。';
  const pipelineName = input._pipeline?.name || input._pipeline?.id || '未知数据源';

  const analysis = await llm.analyze(pipelineName, combinedContent, prompt);

  return {
    analysis,
    skipped: false,
    inputLength: combinedContent.length,
    outputLength: analysis.length,
  };
}

// ============================================================
// generate-report: 汇总所有 pipeline 结果，生成 Markdown 报告
// ============================================================

async function generateReport(input, context) {
  const { engine } = context;
  const stepsByPipeline = engine.getStepsByPipeline();
  const definition = engine.definition;

  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  let report = `# 宏观经济与行业数据报告

> 生成时间：${dateStr} ${timeStr}
> 
> 本报告通过自动化工作流采集中国各主要政府部门和行业机构公开数据，并使用 AI 进行解读分析。

---

`;

  // ── 目录 ──
  report += '## 目录\n\n';
  const macroP = definition.pipelines.filter((p) => p.category === 'macro');
  const industryP = definition.pipelines.filter((p) => p.category === 'industry');

  if (macroP.length > 0) {
    report += '### 一、宏观数据\n\n';
    macroP.forEach((p, i) => {
      report += `${i + 1}. [${p.name}](#${p.id})\n`;
    });
    report += '\n';
  }
  if (industryP.length > 0) {
    report += '### 二、行业数据\n\n';
    industryP.forEach((p, i) => {
      report += `${i + 1}. [${p.name}](#${p.id})\n`;
    });
    report += '\n';
  }
  report += '---\n\n';

  // ── 各 Pipeline 报告 ──
  function renderPipelineSection(pipeline) {
    const steps = stepsByPipeline[pipeline.id] || [];
    let section = `## ${pipeline.name}\n\n`;
    section += `> 数据源：${pipeline.id} | 分类：${pipeline.category === 'macro' ? '宏观数据' : '行业数据'}\n\n`;

    // 流水线状态
    section += '### 流水线执行状态\n\n';
    section += '| 步骤 | 类型 | 状态 | 耗时 | 备注 |\n';
    section += '|------|------|------|------|------|\n';
    for (const step of steps) {
      const statusIcon = {
        success: '✅', failed: '❌', skipped: '⏭️', running: '🔄', pending: '⏳',
      }[step.status] || '❓';
      const duration = step.durationMs != null ? `${(step.durationMs / 1000).toFixed(1)}s` : '-';
      const note = step.error ? step.error.slice(0, 60) : '';
      section += `| ${step.stepId} | ${step.type} | ${statusIcon} ${step.status} | ${duration} | ${note} |\n`;
    }
    section += '\n';

    // 数据来源
    const fetchSteps = steps.filter((s) => s.type === 'fetch-page');
    if (fetchSteps.length > 0) {
      section += '### 数据来源\n\n';
      for (const fs of fetchSteps) {
        if (fs.output && fs.output.url) {
          const icon = fs.status === 'success' ? '✓' : '✗';
          section += `- ${icon} [${fs.output.title || fs.output.url}](${fs.output.url})\n`;
        }
      }
      section += '\n';
    }

    // 提取内容（折叠）
    const extractSteps = steps.filter((s) => s.type === 'extract-content' && s.output);
    if (extractSteps.length > 0) {
      for (const es of extractSteps) {
        if (!es.output || !es.output.combinedContent) continue;
        section += '<details>\n<summary>📄 原始提取内容（点击展开）</summary>\n\n';
        const content = es.output.combinedContent;
        section += content.length > 3000
          ? content.slice(0, 3000) + '\n\n... (内容已截断)\n'
          : content;
        section += '\n</details>\n\n';
      }
    }

    // AI 解读
    const analyzeSteps = steps.filter((s) => s.type === 'llm-analyze' && s.output);
    for (const as of analyzeSteps) {
      if (as.output && as.output.analysis && !as.output.skipped) {
        section += '### AI 解读分析\n\n';
        section += as.output.analysis + '\n\n';
      }
    }

    section += '---\n\n';
    return section;
  }

  if (macroP.length > 0) {
    report += '# 一、宏观数据\n\n';
    for (const p of macroP) report += renderPipelineSection(p);
  }
  if (industryP.length > 0) {
    report += '# 二、行业数据\n\n';
    for (const p of industryP) report += renderPipelineSection(p);
  }

  // ── 采集统计 ──
  const summary = engine.getSummary();
  report += `\n---\n\n## 工作流执行统计\n\n`;
  report += `| 指标 | 数值 |\n|------|------|\n`;
  report += `| 总步骤数 | ${summary.total} |\n`;
  report += `| 成功 | ${summary.success} |\n`;
  report += `| 失败 | ${summary.failed} |\n`;
  report += `| 跳过 | ${summary.skipped} |\n`;
  report += `| 总耗时 | ${(summary.totalDurationMs / 1000).toFixed(1)}s |\n`;

  return { report, summary };
}

// ============================================================
// 导出 step handler 注册表
// ============================================================

const STEP_HANDLERS = {
  'fetch-page':       fetchPage,
  'extract-content':  extractContent,
  'llm-analyze':      llmAnalyze,
  'generate-report':  generateReport,
};

module.exports = { STEP_HANDLERS };
