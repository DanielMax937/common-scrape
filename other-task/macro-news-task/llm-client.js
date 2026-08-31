/**
 * LLM Client - VolcEngine (豆包) API wrapper
 *
 * Requires: VOLCENGINE_API_KEY and VOLCENGINE_MODEL environment variables.
 * Configuration via environment variables or constructor options.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_CONFIG = {
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: '',
  model: '',
  maxTokens: 4096,
  temperature: 0.3,
};

/**
 * Call OpenAI-compatible chat completion API
 * @param {object} opts
 * @param {string} opts.endpoint - API base URL (e.g. https://api.openai.com/v1)
 * @param {string} opts.apiKey   - Bearer token
 * @param {string} opts.model    - Model name
 * @param {string} opts.system   - System prompt
 * @param {string} opts.user     - User prompt
 * @param {number} [opts.maxTokens=4096]
 * @param {number} [opts.temperature=0.3]
 * @returns {Promise<string>} The assistant's text reply
 */
async function chatCompletion({
  endpoint = DEFAULT_CONFIG.endpoint,
  apiKey = DEFAULT_CONFIG.apiKey,
  model = DEFAULT_CONFIG.model,
  system,
  user,
  maxTokens = DEFAULT_CONFIG.maxTokens,
  temperature = DEFAULT_CONFIG.temperature,
}) {
  const url = new URL(endpoint.replace(/\/+$/, '') + '/chat/completions');
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
  });

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 120000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            const error = new Error(`LLM API returned HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }
          try {
            const json = JSON.parse(data);
            if (json.error) {
              const error = new Error('LLM API returned an error response');
              error.statusCode = res.statusCode;
              reject(error);
              return;
            }
            const content = json.choices?.[0]?.message?.content || '';
            if (!content.trim()) {
              reject(new Error('LLM API returned an empty response'));
              return;
            }
            resolve(content.trim());
          } catch (e) {
            reject(new Error(`LLM response parse error: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LLM API request timeout (120s)'));
    });
    req.write(body);
    req.end();
  });
}

function normalizeEndpoint(raw) {
  const endpoint = String(raw || '').trim().replace(/\/+$/, '');
  if (!endpoint) return '';
  return endpoint.endsWith('/v1') || endpoint.includes('/api/v3') ? endpoint : `${endpoint}/v1`;
}

function safeError(error) {
  const status = error && error.statusCode ? ` status=${error.statusCode}` : '';
  return `${error?.name || 'Error'}${status}`;
}

function readEnvFile(filePath) {
  try {
    return dotenv.parse(fs.readFileSync(filePath));
  } catch (_) {
    return {};
  }
}

function buildAttempts(primary) {
  const attempts = [];
  const seen = new Set();
  const add = (label, endpoint, apiKey, model, maxTokens, temperature) => {
    const normalized = normalizeEndpoint(endpoint);
    const identity = `${normalized}|${model}`;
    if (!normalized || !apiKey || !model || seen.has(identity)) return;
    seen.add(identity);
    attempts.push({ label, endpoint: normalized, apiKey, model, maxTokens, temperature });
  };

  add('migrated:volcengine', primary.endpoint, primary.apiKey, primary.model, primary.maxTokens, primary.temperature);

  const migrationRoot = path.resolve(__dirname, '../../../../..');
  const configs = [
    ['migrated:blog2media', path.join(migrationRoot, 'config', 'blog2media.env')],
    ['m4:blog2media', path.join(os.homedir(), 'Desktop', 'git', 'blog2media', '.env')],
  ];
  for (const [label, filePath] of configs) {
    const values = readEnvFile(filePath);
    const defaultModel = values.FALLBACK_OPENAI_MODEL || 'codex-login/gpt-5.5';
    add(`${label}:primary`, values.OPENAI_BASE_URL, values.OPENAI_API_KEY, values.OPENAI_MODEL || defaultModel, primary.maxTokens, primary.temperature);
    add(`${label}:fallback`, values.FALLBACK_OPENAI_BASE_URL, values.FALLBACK_OPENAI_API_KEY, values.FALLBACK_OPENAI_MODEL || defaultModel, primary.maxTokens, primary.temperature);
  }
  return attempts;
}

/**
 * Create a configured LLM client from environment variables
 */
function createLLMClient() {
  const config = {
    endpoint: process.env.LLM_ENDPOINT || DEFAULT_CONFIG.endpoint,
    apiKey: process.env.VOLCENGINE_API_KEY || '',
    model: process.env.VOLCENGINE_MODEL || '',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS, 10) || DEFAULT_CONFIG.maxTokens,
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || DEFAULT_CONFIG.temperature,
  };
  const attempts = buildAttempts(config);

  if (attempts.length === 0) {
    console.warn('⚠️  没有可用的迁移 LLM 或 blog2media 降级配置，LLM 解读将跳过');
  }

  return {
    config,

    /**
     * Ask the LLM to analyze extracted web content
     * @param {string} sourceName - Data source name
     * @param {string} pageContent - Extracted page text
     * @param {string} analysisPrompt - Specific analysis instruction
     * @returns {Promise<string>}
     */
    async analyze(sourceName, pageContent, analysisPrompt) {
      if (attempts.length === 0) return '[未配置可用 LLM，跳过解读]';

      const system = `你是一位资深的宏观经济和行业分析师。请基于提供的数据，给出专业、客观、简洁的分析解读。
要求：
1. 提取关键数据点和变化趋势
2. 分析数据背后的原因
3. 对未来趋势做出判断
4. 用中文回答，使用 Markdown 格式
5. 如果提供的页面内容不包含有效数据（可能是导航页面或需要进一步操作的页面），请说明情况并给出该领域的一般性分析`;

      const user = `## 数据源：${sourceName}

## 页面提取内容：
${pageContent.slice(0, 8000)}

## 分析要求：
${analysisPrompt}`;

      const failures = [];
      for (const attempt of attempts) {
        try {
          const answer = await chatCompletion({ ...attempt, system, user });
          console.log(`    ✓ LLM provider: ${attempt.label} model=${attempt.model}`);
          return answer;
        } catch (error) {
          failures.push(`${attempt.label}:${safeError(error)}`);
          console.warn(`    ⚠ LLM provider failed: ${attempt.label} (${safeError(error)})`);
        }
      }
      throw new Error(`All configured LLM providers failed: ${failures.join(', ')}`);
    },
  };
}

module.exports = { chatCompletion, createLLMClient };
