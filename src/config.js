'use strict';

const REQUIRED = [
  'QINIU_ACCESS_KEY',
  'QINIU_SECRET_KEY',
  'QINIU_BUCKET',
  'QINIU_DOMAIN',
  'SERVER_SECRET',
];

function readInt(value, fallback, name) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (parsed > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} 超出允许范围`);
  }
  return parsed;
}

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !String(env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }

  const domain = String(env.QINIU_DOMAIN).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(domain)) {
    throw new Error('QINIU_DOMAIN 必须以 http:// 或 https:// 开头');
  }

  const serverSecret = String(env.SERVER_SECRET).trim();
  if (serverSecret.length < 32) {
    throw new Error('SERVER_SECRET 至少需要 32 个字符');
  }

  const keyPrefix = String(env.KEY_PREFIX || 'yedu').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyPrefix)) {
    throw new Error('KEY_PREFIX 只能包含字母、数字、下划线和短横线，长度 1-32');
  }

  return {
    port: readInt(env.PORT, 8787, 'PORT'),
    accessKey: String(env.QINIU_ACCESS_KEY).trim(),
    secretKey: String(env.QINIU_SECRET_KEY).trim(),
    bucket: String(env.QINIU_BUCKET).trim(),
    domain,
    uploadHost: String(env.QINIU_UPLOAD_HOST || 'https://upload.qiniup.com').trim().replace(/\/+$/, ''),
    privateBucket: String(env.QINIU_PRIVATE ?? 'true').toLowerCase() !== 'false',
    keyPrefix,
    serverSecret,
    uploadTokenTtlSeconds: readInt(env.UPLOAD_TOKEN_TTL_SECONDS, 3600, 'UPLOAD_TOKEN_TTL_SECONDS'),
    downloadTtlSeconds: readInt(env.DOWNLOAD_TTL_SECONDS, 3600, 'DOWNLOAD_TTL_SECONDS'),
    deviceTokenTtlSeconds: readInt(env.DEVICE_TOKEN_TTL_SECONDS, 30 * 24 * 3600, 'DEVICE_TOKEN_TTL_SECONDS'),
    maxUploadBytes: readInt(env.MAX_UPLOAD_BYTES, 32 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
    rateLimitPerMinute: readInt(env.RATE_LIMIT_PER_MINUTE, 120, 'RATE_LIMIT_PER_MINUTE'),
    trustProxy: String(env.TRUST_PROXY || '1') === '1',
  };
}

module.exports = { loadConfig };
