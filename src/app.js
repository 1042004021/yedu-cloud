'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createDeviceToken, decodeDeviceToken, verifyDeviceToken, validateObjectKey } = require('./security');
const { createRateLimiter } = require('./rateLimit');

function createApp(config, qiniuService) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const registerLimiter = createRateLimiter({ max: Math.min(config.rateLimitPerMinute, 30) });
  const signedLimiter = createRateLimiter({ max: config.rateLimitPerMinute });

  function authDevice(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const payload = verifyDeviceToken(token, config.serverSecret);
    if (!payload) {
      return res.status(401).json({ error: '设备令牌无效或已过期' });
    }
    req.deviceId = payload.sub;
    next();
  }

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'yedu-qiniu-signer',
      privateBucket: config.privateBucket,
      time: new Date().toISOString(),
    });
  });

  app.post('/api/v1/device/register', registerLimiter, (req, res) => {
    // 设备 ID 由服务端生成，避免客户端随意领取其他设备目录。
    const deviceId = crypto.randomUUID();
    const token = createDeviceToken(deviceId, config.serverSecret, config.deviceTokenTtlSeconds);
    res.json({
      deviceId,
      token,
      expiresAt: Math.floor(Date.now() / 1000) + config.deviceTokenTtlSeconds,
      keyPrefix: `${config.keyPrefix}/${deviceId}/`,
    });
  });

  app.post('/api/v1/device/refresh', registerLimiter, (req, res) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // 刷新允许过期 Token，但必须是本服务签发的有效签名。
    const payload = decodeDeviceToken(token, config.serverSecret, { allowExpired: true });
    if (!payload) {
      return res.status(401).json({ error: '设备令牌无效' });
    }
    const refreshed = createDeviceToken(payload.sub, config.serverSecret, config.deviceTokenTtlSeconds);
    res.json({
      deviceId: payload.sub,
      token: refreshed,
      expiresAt: Math.floor(Date.now() / 1000) + config.deviceTokenTtlSeconds,
      keyPrefix: `${config.keyPrefix}/${payload.sub}/`,
    });
  });

  app.get('/api/v1/me', signedLimiter, authDevice, (req, res) => {
    res.json({
      deviceId: req.deviceId,
      keyPrefix: `${config.keyPrefix}/${req.deviceId}/`,
    });
  });

  app.post('/api/v1/qiniu/upload-token', signedLimiter, authDevice, (req, res) => {
    const key = req.body && req.body.key;
    if (!validateObjectKey(key, req.deviceId, config.keyPrefix)) {
      return res.status(400).json({
        error: 'key 必须位于当前设备目录下，且只能上传 png/jpg/jpeg/webp/json',
      });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + config.uploadTokenTtlSeconds;
    res.json({
      key,
      uploadHost: config.uploadHost,
      uploadToken: qiniuService.uploadToken(key),
      expiresAt,
    });
  });

  app.get('/api/v1/qiniu/download-url', signedLimiter, authDevice, (req, res) => {
    const key = req.query.key;
    if (!validateObjectKey(key, req.deviceId, config.keyPrefix)) {
      return res.status(400).json({
        error: 'key 必须位于当前设备目录下，且只能下载 png/jpg/jpeg/webp/json',
      });
    }
    const expiresAt = config.privateBucket
      ? Math.floor(Date.now() / 1000) + config.downloadTtlSeconds
      : null;
    res.json({
      key,
      url: qiniuService.downloadUrl(key),
      expiresAt,
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: '请求体过大' });
    }
    console.error('[yedu-signer]', err);
    res.status(500).json({ error: '服务内部错误' });
  });

  return app;
}

module.exports = { createApp };
