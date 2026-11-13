'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.QINIU_ACCESS_KEY = 'test-access-key';
process.env.QINIU_SECRET_KEY = 'test-secret-key';
process.env.QINIU_BUCKET = 'test-bucket';
process.env.QINIU_DOMAIN = 'https://cdn.example.com';
process.env.QINIU_PRIVATE = 'true';
process.env.SERVER_SECRET = 's'.repeat(64);
process.env.RATE_LIMIT_PER_MINUTE = '1000';

const { loadConfig } = require('../src/config');
const { createQiniuService } = require('../src/qiniuService');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  const config = loadConfig();
  const app = createApp(config, createQiniuService(config));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

async function register() {
  const response = await fetch(`${base}/api/v1/device/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('health 返回服务状态', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.privateBucket, true);
});

test('注册设备后可以签发上传 Token 和私有下载 URL', async () => {
  const device = await register();
  assert.match(device.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(device.token, /^[^.]+\.[^.]+$/);
  assert.equal(device.keyPrefix, `yedu/${device.deviceId}/`);

  const key = `yedu/${device.deviceId}/scripts/demo/images/scene_01.png`;
  const uploadResponse = await fetch(`${base}/api/v1/qiniu/upload-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${device.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key }),
  });
  assert.equal(uploadResponse.status, 200);
  const upload = await uploadResponse.json();
  assert.equal(upload.key, key);
  assert.equal(upload.uploadHost, 'https://upload.qiniup.com');
  assert.ok(upload.uploadToken.split(':').length >= 3);

  const downloadResponse = await fetch(
    `${base}/api/v1/qiniu/download-url?key=${encodeURIComponent(key)}`,
    { headers: { authorization: `Bearer ${device.token}` } },
  );
  assert.equal(downloadResponse.status, 200);
  const download = await downloadResponse.json();
  assert.equal(download.key, key);
  assert.match(download.url, /^https:\/\/cdn\.example\.com\//);
  assert.match(download.url, /[?&]e=\d{10,}/);
  const expiresInUrl = Number(new URL(download.url).searchParams.get('e'));
  assert.ok(expiresInUrl > Math.floor(Date.now() / 1000));
  assert.ok(download.expiresAt);
});

test('可以用当前 Token 刷新设备 Token', async () => {
  const device = await register();
  const response = await fetch(`${base}/api/v1/device/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${device.token}` },
  });
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.equal(refreshed.deviceId, device.deviceId);
  assert.match(refreshed.token, /^[^.]+\.[^.]+$/);
});

test('拒绝其他设备目录的 key', async () => {
  const device = await register();
  const response = await fetch(`${base}/api/v1/qiniu/upload-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${device.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key: 'yedu/other-device/scripts/demo/images/scene_01.png' }),
  });
  assert.equal(response.status, 400);
});

test('拒绝未认证请求', async () => {
  const response = await fetch(`${base}/api/v1/qiniu/download-url?key=yedu/x/a.png`);
  assert.equal(response.status, 401);
});

test('拒绝不支持的文件类型', async () => {
  const device = await register();
  const response = await fetch(`${base}/api/v1/qiniu/upload-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${device.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key: `yedu/${device.deviceId}/scripts/demo/evil.sh` }),
  });
  assert.equal(response.status, 400);
});
