/**
 * LLM Client - OpenAI-compatible API wrapper
 *
 * Supports: VolcEngine (豆包), OpenAI, DeepSeek, or any OpenAI-compatible endpoint.
 * Configuration via environment variables or constructor options.
 */

const https = require('https');
const http = require('http');

const DEFAULT_CONFIG = {
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: '',
  model: 'doubao-pro-32k',
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
  const url = new URL(endpoint + '/chat/completions');
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
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(`LLM API error: ${json.error.message || JSON.stringify(json.error)}`));
              return;
            }
            const content = json.choices?.[0]?.message?.content || '';
            resolve(content.trim());
          } catch (e) {
            reject(new Error(`LLM response parse error: ${e.message}\nRaw: ${data.slice(0, 500)}`));
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

/**
 * Create a configured LLM client from environment variables
 */
function createLLMClient() {
  const config = {
    endpoint: process.env.LLM_ENDPOINT || DEFAULT_CONFIG.endpoint,
    apiKey: process.env.LLM_API_KEY || process.env.VOLCENGINE_API_KEY || '',
    model: process.env.LLM_MODEL || process.env.VOLCENGINE_MODEL || DEFAULT_CONFIG.model,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS, 10) || DEFAULT_CONFIG.maxTokens,
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || DEFAULT_CONFIG.temperature,
  };

  if (!config.apiKey) {
    console.warn('⚠️  未配置 LLM_API_KEY 或 VOLCENGINE_API_KEY，LLM 解读将跳过');
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
      if (!config.apiKey) return '[未配置 LLM API Key，跳过解读]';

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

      return chatCompletion({
        ...config,
        system,
        user,
      });
    },
  };
}

module.exports = { chatCompletion, createLLMClient };
