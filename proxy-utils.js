const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;

/**
 * Check if a task should use proxy based on PROXY_TASKS env var.
 * PROXY_TASKS is a comma-separated list of task names, e.g. "alice,doubao,weibo-list".
 * Only tasks in the list will use proxy. All others connect directly.
 *
 * Special task names used across the project:
 *   alice, doubao, browser, twitter, weibo-list, weibo-user
 */
function shouldUseProxy(taskName) {
  const raw = process.env.PROXY_TASKS;
  if (!raw) return false;
  const allowed = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(taskName.toLowerCase());
}

/**
 * Load proxy config for a given task and profile index.
 * Returns { server, username, password } or null.
 */
function loadProxyConfig(taskName, profileIndex) {
  if (!shouldUseProxy(taskName)) return null;

  const proxyConfigPath = path.join(PROJECT_ROOT, 'proxy-config.json');
  if (!fs.existsSync(proxyConfigPath)) return null;

  try {
    const proxies = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf-8'));
    if (!Array.isArray(proxies) || !proxies[profileIndex]) return null;
    const proxy = proxies[profileIndex];
    return {
      server: `http://${proxy.server}`,
      username: proxy.username,
      password: proxy.password,
    };
  } catch (err) {
    console.warn(`⚠️  Failed to load proxy config: ${err.message}`);
    return null;
  }
}

module.exports = { shouldUseProxy, loadProxyConfig };
