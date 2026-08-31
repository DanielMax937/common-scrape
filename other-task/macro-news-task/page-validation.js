'use strict';

const ERROR_PATTERNS = [
  /^\s*(403|404|429)\s*(forbidden|not found|too many requests)?/i,
  /\baccess denied\b/i,
  /\brequest blocked\b/i,
  /\btoo many requests\b/i,
  /您访问的页面不存在/,
  /页面不存在/,
  /请求被拒绝/,
  /访问过于频繁/,
  /安全验证/,
  /请输入验证码/,
];

function validatePageResult({ status, title, text, url, finalUrl }) {
  const effectiveUrl = finalUrl || url || '(unknown URL)';
  if (Number.isFinite(status) && status >= 400) {
    throw new Error(`Source returned HTTP ${status}: ${effectiveUrl}`);
  }

  const cleanTitle = String(title || '').trim();
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  const sample = `${cleanTitle}\n${cleanText.slice(0, 1600)}`;

  if (cleanText.length < 80) {
    throw new Error(`Source returned too little meaningful text (${cleanText.length} chars): ${effectiveUrl}`);
  }
  const matched = ERROR_PATTERNS.find((pattern) => pattern.test(sample));
  if (matched) {
    throw new Error(`Source returned an error/challenge page: ${effectiveUrl}`);
  }
}

module.exports = { validatePageResult };
