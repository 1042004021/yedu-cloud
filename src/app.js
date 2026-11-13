'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createDeviceToken, decodeDeviceToken, verifyDeviceToken, validateObjectKey } = require('./security');
const { createRateLimiter } = require('./rateLimit');

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const SCRIPT_CONTENT_TYPES = new Set(['application/json', 'application/octet-stream']);
const PACK_CONTENT_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function text(value, max, name) {
  if (typeof value !== 'string') return { error: `${name} 必须是字符串` };
  const clean = value.trim();
  if (clean.length > max) return { error: `${name} 不能超过 ${max} 个字符` };
  return { value: clean };
}

function tagList(value) {
  if (!Array.isArray(value)) return { error: 'tags 必须是数组' };
  if (value.length > 10) return { error: 'tags 最多 10 个' };
  const tags = [];
  for (const item of value) {
    if (typeof item !== 'string') return { error: 'tags 只能包含字符串' };
    const clean = item.trim();
    if (!clean || clean.length > 24) return { error: '每个 tag 长度需要在 1-24 个字符之间' };
    if (!tags.includes(clean)) tags.push(clean);
  }
  return { value: tags };
}

function count(value, fallback, name) {
  if (value === undefined) return { value: fallback };
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    return { error: `${name} 必须是 0-1000000 之间的整数` };
  }
  return { value };
}

function safeName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const base = value.split(/[\\/]/).pop().trim().replace(/[\u0000-\u001f]/g, '');
  return base.slice(0, 120) || fallback;
}

function coverExtension(contentType) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

function fileSpec(config, work, file) {
  if (!file || typeof file !== 'object') return { error: '文件描述无效' };
  const kind = file.kind;
  if (!['script', 'cover', 'pack'].includes(kind)) return { error: 'kind 只能是 script/cover/pack' };
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > config.maxUploadBytes) {
    return { error: `文件大小必须是 1-${config.maxUploadBytes} 字节` };
  }
  const contentType = file.contentType || 'application/octet-stream';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return { error: 'contentType 不支持' };

  const prefix = `${config.keyPrefix}/${work.device_id}/works/${work.id}/`;
  if (kind === 'script') {
    if (!SCRIPT_CONTENT_TYPES.has(contentType)) return { error: '剧本必须是 application/json' };
    return {
      kind,
      key: `${prefix}script.json`,
      name: safeName(file.name, 'script.json'),
      size: file.size,
      contentType,
    };
  }
  if (kind === 'cover') {
    if (!IMAGE_CONTENT_TYPES.has(contentType)) return { error: '封面必须是 png/jpeg/webp' };
    return {
      kind,
      key: `${prefix}cover.${coverExtension(contentType)}`,
      name: safeName(file.name, `cover.${coverExtension(contentType)}`),
      size: file.size,
      contentType,
    };
  }
  if (!PACK_CONTENT_TYPES.has(contentType)) return { error: '图包必须是 zip' };
  return {
    kind,
    key: `${prefix}pack.zip`,
    name: safeName(file.name, 'pack.zip'),
    size: file.size,
    contentType,
  };
}

function createApp(config, storageService, workRepository) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const registerLimiter = createRateLimiter({ max: Math.min(config.rateLimitPerMinute, 30) });
  const signedLimiter = createRateLimiter({ max: config.rateLimitPerMinute });
  const publicLimiter = createRateLimiter({ max: Math.min(config.rateLimitPerMinute, 90) });

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

  async function publicWork(work) {
    let coverUrl = null;
    let coverExpiresAt = null;
    if (work.cover_key) {
      try {
        const signed = await storageService.createDownload({ key: work.cover_key });
        coverUrl = signed.url;
        coverExpiresAt = signed.expiresAt;
      } catch {
        coverUrl = null;
      }
    }
    return {
      id: work.id,
      title: work.title,
      description: work.description,
      author: work.author,
      tags: work.tags,
      coverUrl,
      coverExpiresAt,
      nodeCount: work.node_count,
      imageCount: work.image_count,
      sizeBytes: work.size_bytes,
      downloadCount: work.download_count,
      createdAt: work.created_at,
      updatedAt: work.updated_at,
      publishedAt: work.published_at,
    };
  }

  function metadataFromBody(body, fallback) {
    const titleValue = body.title !== undefined ? body.title : fallback && fallback.title;
    const titleResult = text(titleValue, 120, 'title');
    if (titleResult.error) return { error: titleResult.error };
    if (!titleResult.value) return { error: 'title 不能为空' };

    const descriptionResult = text(
      body.description !== undefined ? body.description : (fallback && fallback.description) || '',
      2000,
      'description',
    );
    if (descriptionResult.error) return { error: descriptionResult.error };

    const authorResult = text(
      body.author !== undefined ? body.author : (fallback && fallback.author) || '',
      80,
      'author',
    );
    if (authorResult.error) return { error: authorResult.error };

    const tagsResult = tagList(
      body.tags !== undefined ? body.tags : (fallback && fallback.tags) || [],
    );
    if (tagsResult.error) return { error: tagsResult.error };

    const nodeResult = count(
      body.nodeCount,
      fallback ? fallback.node_count : 0,
      'nodeCount',
    );
    if (nodeResult.error) return { error: nodeResult.error };
    const imageResult = count(
      body.imageCount,
      fallback ? fallback.image_count : 0,
      'imageCount',
    );
    if (imageResult.error) return { error: imageResult.error };

    return {
      value: {
        title: titleResult.value,
        description: descriptionResult.value,
        author: authorResult.value,
        tags: tagsResult.value,
        nodeCount: nodeResult.value,
        imageCount: imageResult.value,
      },
    };
  }

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'yedu-cloud',
      driver: storageService.driver,
      privateBucket: config.driver === 'qiniu' ? config.privateBucket : true,
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
      driver: storageService.driver,
    });
  });

  app.post('/api/v1/works', signedLimiter, authDevice, asyncHandler(async (req, res) => {
    const metadata = metadataFromBody(req.body || {}, null);
    if (metadata.error) return res.status(400).json({ error: metadata.error });
    const work = workRepository.createWork({
      deviceId: req.deviceId,
      ...metadata.value,
    });
    res.status(201).json({
      id: work.id,
      title: work.title,
      status: work.status,
      keyPrefix: `${config.keyPrefix}/${req.deviceId}/works/${work.id}/`,
      createdAt: work.created_at,
    });
  }));

  app.post('/api/v1/works/:id/presign', signedLimiter, authDevice, asyncHandler(async (req, res) => {
    const work = workRepository.getWork(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在' });
    if (work.device_id !== req.deviceId) return res.status(403).json({ error: '只能上传自己的作品' });
    if (work.status !== 'draft') return res.status(409).json({ error: '作品已发布，不能重新上传文件' });

    const files = req.body && req.body.files;
    if (!Array.isArray(files) || files.length === 0 || files.length > 3) {
      return res.status(400).json({ error: 'files 必须是 1-3 个文件的数组' });
    }

    const specs = [];
    const kinds = new Set();
    for (const file of files) {
      const spec = fileSpec(config, work, file);
      if (spec.error) return res.status(400).json({ error: spec.error });
      if (kinds.has(spec.kind)) return res.status(400).json({ error: `重复的 kind: ${spec.kind}` });
      kinds.add(spec.kind);
      specs.push(spec);
    }
    if (!kinds.has('script')) {
      return res.status(400).json({ error: '本次上传必须包含 script' });
    }

    const signedFiles = await Promise.all(specs.map(async (spec) => {
      const signed = await storageService.createUpload(spec);
      return {
        kind: spec.kind,
        key: spec.key,
        name: spec.name,
        size: spec.size,
        contentType: spec.contentType,
        ...signed,
      };
    }));

    const byKind = Object.fromEntries(signedFiles.map((file) => [file.kind, file]));
    const updated = workRepository.updateDraftFiles(work.id, req.deviceId, {
      scriptKey: byKind.script.key,
      scriptName: byKind.script.name,
      coverKey: byKind.cover ? byKind.cover.key : undefined,
      coverName: byKind.cover ? byKind.cover.name : undefined,
      packKey: byKind.pack ? byKind.pack.key : undefined,
      packName: byKind.pack ? byKind.pack.name : undefined,
    });
    if (updated.error) {
      return res.status(updated.error === 'forbidden' ? 403 : 409).json({ error: '作品状态已变化' });
    }

    res.json({
      workId: work.id,
      files: signedFiles.map((file) => ({
        kind: file.kind,
        key: file.key,
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        mode: file.mode,
        uploadUrl: file.uploadUrl,
        uploadHost: file.uploadHost,
        uploadToken: file.uploadToken,
        method: file.method,
        headers: file.headers,
        expiresAt: file.expiresAt,
      })),
    });
  }));

  app.post('/api/v1/works/:id/finalize', signedLimiter, authDevice, asyncHandler(async (req, res) => {
    const work = workRepository.getWork(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在' });
    if (work.device_id !== req.deviceId) return res.status(403).json({ error: '只能发布自己的作品' });
    if (work.status !== 'draft') return res.status(409).json({ error: '作品已经发布' });
    if (!work.script_key) return res.status(409).json({ error: '请先上传并签名脚本文件' });

    const metadata = metadataFromBody(req.body || {}, work);
    if (metadata.error) return res.status(400).json({ error: metadata.error });

    const scriptStat = await storageService.stat(work.script_key);
    if (!scriptStat) return res.status(409).json({ error: '脚本文件尚未上传到存储' });
    const coverStat = work.cover_key ? await storageService.stat(work.cover_key) : null;
    if (work.cover_key && !coverStat) return res.status(409).json({ error: '封面文件尚未上传到存储' });
    const packStat = work.pack_key ? await storageService.stat(work.pack_key) : null;
    if (work.pack_key && !packStat) return res.status(409).json({ error: '图包文件尚未上传到存储' });

    const result = workRepository.finalizeWork(work.id, req.deviceId, {
      ...metadata.value,
      scriptSize: scriptStat.size,
      coverSize: coverStat ? coverStat.size : 0,
      packSize: packStat ? packStat.size : 0,
    });
    if (result.error) {
      return res.status(409).json({ error: '作品状态已变化，请刷新后重试' });
    }
    res.json(await publicWork(result.work));
  }));

  app.get('/api/v1/works', publicLimiter, asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const result = workRepository.listPublished({
      limit: pageSize,
      offset: (page - 1) * pageSize,
      query,
    });
    const items = await Promise.all(result.rows.map(publicWork));
    res.json({
      items,
      page,
      pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / pageSize),
    });
  }));

  app.get('/api/v1/works/:id/download', publicLimiter, asyncHandler(async (req, res) => {
    const work = workRepository.getPublished(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在或尚未发布' });

    const script = await storageService.createDownload({ key: work.script_key });
    const pack = work.pack_key ? await storageService.createDownload({ key: work.pack_key }) : null;
    const cover = work.cover_key ? await storageService.createDownload({ key: work.cover_key }) : null;
    workRepository.markDownloaded(work.id);
    res.json({
      id: work.id,
      title: work.title,
      script: {
        key: work.script_key,
        name: work.script_name || 'script.json',
        url: script.url,
        expiresAt: script.expiresAt,
      },
      pack: pack ? {
        key: work.pack_key,
        name: work.pack_name || 'pack.zip',
        url: pack.url,
        expiresAt: pack.expiresAt,
      } : null,
      cover: cover ? {
        key: work.cover_key,
        name: work.cover_name || 'cover',
        url: cover.url,
        expiresAt: cover.expiresAt,
      } : null,
    });
  }));

  app.get('/api/v1/works/:id', publicLimiter, asyncHandler(async (req, res) => {
    const work = workRepository.getPublished(req.params.id);
    if (!work) return res.status(404).json({ error: '作品不存在或尚未发布' });
    res.json(await publicWork(work));
  }));

  // 兼容旧版七牛专用路径；当前默认使用 R2，旧路径只在 STORAGE_DRIVER=qiniu 时可用。
  app.post('/api/v1/qiniu/upload-token', signedLimiter, authDevice, asyncHandler(async (req, res) => {
    if (storageService.driver !== 'qiniu') {
      return res.status(404).json({ error: '当前存储驱动不是七牛' });
    }
    const key = req.body && req.body.key;
    if (!validateObjectKey(key, req.deviceId, config.keyPrefix)) {
      return res.status(400).json({ error: 'key 不合法' });
    }
    res.json(await storageService.createUpload({ key }));
  }));

  app.get('/api/v1/qiniu/download-url', signedLimiter, authDevice, asyncHandler(async (req, res) => {
    if (storageService.driver !== 'qiniu') {
      return res.status(404).json({ error: '当前存储驱动不是七牛' });
    }
    const key = req.query.key;
    if (!validateObjectKey(key, req.deviceId, config.keyPrefix)) {
      return res.status(400).json({ error: 'key 不合法' });
    }
    res.json(await storageService.createDownload({ key }));
  }));

  app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: '请求体过大' });
    }
    console.error('[yedu-cloud]', err);
    res.status(500).json({ error: '服务内部错误' });
  });

  return app;
}

module.exports = { createApp };