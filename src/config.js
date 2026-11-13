'use strict';

const DRIVERS = new Set(['s3', 'qiniu']);

function readInt(value, fallback, name) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (parsed > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} 超出允许范围`);
  }
  return parsed;
}

function requireEnv(env, names) {
  const missing = names.filter((name) => !String(env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

function normalizeUrl(value, name) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`${name} 必须以 http:// 或 https:// 开头`);
  }
  return url;
}

function loadConfig(env = process.env) {
  const driver = String(env.STORAGE_DRIVER || 's3').trim().toLowerCase();
  if (!DRIVERS.has(driver)) {
    throw new Error('STORAGE_DRIVER 只能是 s3 或 qiniu');
  }

  const serverSecret = String(env.SERVER_SECRET || '').trim();
  if (serverSecret.length < 32) {
    throw new Error('SERVER_SECRET 至少需要 32 个字符');
  }

  const keyPrefix = String(env.KEY_PREFIX || 'yedu').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyPrefix)) {
    throw new Error('KEY_PREFIX 只能包含字母、数字、下划线和短横线，长度 1-32');
  }

  const common = {
    driver,
    port: readInt(env.PORT, 8787, 'PORT'),
    dbPath: String(env.DB_PATH || './data/yedu.db').trim(),
    keyPrefix,
    serverSecret,
    uploadTtlSeconds: readInt(
      env.UPLOAD_TOKEN_TTL_SECONDS || env.UPLOAD_TTL_SECONDS,
      3600,
      'UPLOAD_TOKEN_TTL_SECONDS',
    ),
    downloadTtlSeconds: readInt(env.DOWNLOAD_TTL_SECONDS, 3600, 'DOWNLOAD_TTL_SECONDS'),
    deviceTokenTtlSeconds: readInt(env.DEVICE_TOKEN_TTL_SECONDS, 30 * 24 * 3600, 'DEVICE_TOKEN_TTL_SECONDS'),
    maxUploadBytes: readInt(env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
    rateLimitPerMinute: readInt(env.RATE_LIMIT_PER_MINUTE, 120, 'RATE_LIMIT_PER_MINUTE'),
    trustProxy: String(env.TRUST_PROXY || '1') === '1',
  };

  if (driver === 's3') {
    requireEnv(env, ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
    if (!String(env.R2_ACCOUNT_ID || '').trim() && !String(env.R2_ENDPOINT || '').trim()) {
      throw new Error('缺少环境变量: R2_ACCOUNT_ID 或 R2_ENDPOINT');
    }

    const accountId = String(env.R2_ACCOUNT_ID || '').trim();
    const endpoint = normalizeUrl(
      env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
      'R2_ENDPOINT',
    );
    const region = String(env.R2_REGION || 'auto').trim();

    return {
      ...common,
      driver: 's3',
      bucket: String(env.R2_BUCKET).trim(),
      s3AccessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
      s3SecretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
      s3Endpoint: endpoint,
      s3Region: region || 'auto',
      s3ForcePathStyle: String(env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
    };
  }

  requireEnv(env, ['QINIU_ACCESS_KEY', 'QINIU_SECRET_KEY', 'QINIU_BUCKET', 'QINIU_DOMAIN']);
  return {
    ...common,
    driver: 'qiniu',
    accessKey: String(env.QINIU_ACCESS_KEY).trim(),
    secretKey: String(env.QINIU_SECRET_KEY).trim(),
    bucket: String(env.QINIU_BUCKET).trim(),
    domain: normalizeUrl(env.QINIU_DOMAIN, 'QINIU_DOMAIN'),
    uploadHost: normalizeUrl(env.QINIU_UPLOAD_HOST || 'https://upload.qiniup.com', 'QINIU_UPLOAD_HOST'),
    privateBucket: String(env.QINIU_PRIVATE ?? 'true').toLowerCase() !== 'false',
  };
}

module.exports = { loadConfig };