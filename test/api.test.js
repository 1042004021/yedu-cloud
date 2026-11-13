'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.STORAGE_DRIVER = 's3';
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.R2_BUCKET = 'test-bucket';
process.env.SERVER_SECRET = 's'.repeat(64);
process.env.RATE_LIMIT_PER_MINUTE = '1000';

const { loadConfig } = require('../src/config');
const { createDatabase } = require('../src/db');
const { createWorkRepository } = require('../src/workRepository');
const { createApp } = require('../src/app');

const storedSizes = new Map();
const fakeStorage = {
  driver: 's3',
  async createUpload({ key, size }) {
    storedSizes.set(key, size);
    return {
      mode: 'put',
      key,
      uploadUrl: `https://r2.example/${encodeURIComponent(key)}?sig=upload`,
      method: 'PUT',
      headers: {},
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  },
  async createDownload({ key }) {
    return {
      key,
      url: `https://r2.example/${encodeURIComponent(key)}?sig=download`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  },
  async stat(key) {
    const size = storedSizes.get(key);
    return size ? { size, contentType: null } : null;
  },
};

let server;
let base;
let db;

before(async () => {
  const config = loadConfig();
  db = createDatabase(':memory:');
  const repository = createWorkRepository(db);
  const app = createApp(config, fakeStorage, repository);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

async function register() {
  const response = await fetch(`${base}/api/v1/device/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function createWork(token, title = '雨夜来客') {
  const response = await fetch(`${base}/api/v1/works`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description: '测试作品',
      author: '蒋磊',
      tags: ['雨夜', '悬疑'],
      nodeCount: 4,
      imageCount: 5,
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

function auth(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function presign(token, workId) {
  const response = await fetch(`${base}/api/v1/works/${workId}/presign`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      files: [
        { kind: 'script', name: 'script.json', size: 100, contentType: 'application/json' },
        { kind: 'cover', name: 'cover.png', size: 200, contentType: 'image/png' },
        { kind: 'pack', name: 'pack.zip', size: 300, contentType: 'application/zip' },
      ],
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function finalize(token, workId) {
  const response = await fetch(`${base}/api/v1/works/${workId}/finalize`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      title: '雨夜来客',
      description: '测试作品',
      author: '蒋磊',
      tags: ['雨夜', '悬疑'],
      nodeCount: 4,
      imageCount: 5,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('health 返回 R2 驱动状态', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.driver, 's3');
});

test('设备注册、创建作品、预签名、发布、列表和下载完整流程', async () => {
  const device = await register();
  const work = await createWork(device.token);
  assert.equal(work.status, 'draft');
  assert.match(work.id, /^[0-9a-f-]{36}$/);

  const signed = await presign(device.token, work.id);
  assert.equal(signed.files.length, 3);
  const byKind = Object.fromEntries(signed.files.map((file) => [file.kind, file]));
  assert.match(byKind.script.key, /\/script\.json$/);
  assert.match(byKind.cover.key, /\/cover\.png$/);
  assert.match(byKind.pack.key, /\/pack\.zip$/);
  assert.equal(byKind.script.mode, 'put');
  assert.match(byKind.script.uploadUrl, /sig=upload/);

  const published = await finalize(device.token, work.id);
  assert.equal(published.title, '雨夜来客');
  assert.match(published.coverUrl, /sig=download/);
  assert.equal(published.nodeCount, 4);
  assert.equal(published.imageCount, 5);

  const listResponse = await fetch(`${base}/api/v1/works?page=1&pageSize=10`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, work.id);
  assert.match(list.items[0].coverUrl, /sig=download/);

  const searchResponse = await fetch(`${base}/api/v1/works?q=${encodeURIComponent('雨夜')}`);
  const search = await searchResponse.json();
  assert.equal(search.total, 1);

  const detailResponse = await fetch(`${base}/api/v1/works/${work.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.title, '雨夜来客');

  const downloadResponse = await fetch(`${base}/api/v1/works/${work.id}/download`);
  assert.equal(downloadResponse.status, 200);
  const download = await downloadResponse.json();
  assert.match(download.script.url, /sig=download/);
  assert.match(download.pack.url, /sig=download/);
  assert.match(download.cover.url, /sig=download/);

  const listAfterDownload = await (await fetch(`${base}/api/v1/works`)).json();
  assert.equal(listAfterDownload.items[0].downloadCount, 1);
});

test('草稿不会出现在公开列表', async () => {
  const device = await register();
  const work = await createWork(device.token, '未发布作品');
  const list = await (await fetch(`${base}/api/v1/works?q=${encodeURIComponent('未发布作品')}`)).json();
  assert.equal(list.total, 0);
  const detail = await fetch(`${base}/api/v1/works/${work.id}`);
  assert.equal(detail.status, 404);
});

test('其他设备不能给自己的作品预签名或发布', async () => {
  const owner = await register();
  const other = await register();
  const work = await createWork(owner.token, '别人的作品');
  const presignResponse = await fetch(`${base}/api/v1/works/${work.id}/presign`, {
    method: 'POST',
    headers: auth(other.token),
    body: JSON.stringify({
      files: [{ kind: 'script', name: 'script.json', size: 100, contentType: 'application/json' }],
    }),
  });
  assert.equal(presignResponse.status, 403);

  const finalizeResponse = await fetch(`${base}/api/v1/works/${work.id}/finalize`, {
    method: 'POST',
    headers: auth(other.token),
    body: '{}',
  });
  assert.equal(finalizeResponse.status, 403);
});

test('拒绝缺少脚本的预签名请求和未上传文件的发布', async () => {
  const device = await register();
  const work = await createWork(device.token, '缺文件作品');
  const response = await fetch(`${base}/api/v1/works/${work.id}/presign`, {
    method: 'POST',
    headers: auth(device.token),
    body: JSON.stringify({
      files: [{ kind: 'cover', name: 'cover.png', size: 100, contentType: 'image/png' }],
    }),
  });
  assert.equal(response.status, 400);

  const finalizeResponse = await fetch(`${base}/api/v1/works/${work.id}/finalize`, {
    method: 'POST',
    headers: auth(device.token),
    body: '{}',
  });
  assert.equal(finalizeResponse.status, 409);
});

test('拒绝未认证创建作品和非法元数据', async () => {
  const unauth = await fetch(`${base}/api/v1/works`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauth.status, 401);

  const device = await register();
  const badTitle = await fetch(`${base}/api/v1/works`, {
    method: 'POST',
    headers: auth(device.token),
    body: JSON.stringify({ title: '' }),
  });
  assert.equal(badTitle.status, 400);

  const badTags = await fetch(`${base}/api/v1/works`, {
    method: 'POST',
    headers: auth(device.token),
    body: JSON.stringify({ title: '标题', tags: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }),
  });
  assert.equal(badTags.status, 400);
});
