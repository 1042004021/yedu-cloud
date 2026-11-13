'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.STORAGE_DRIVER = 's3';
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.R2_BUCKET = 'test-bucket';
process.env.SERVER_SECRET = 's'.repeat(64);

const { loadConfig } = require('../src/config');
const { createStorageService } = require('../src/storageService');

test('R2 预签名上传和下载 URL 可生成', async () => {
  const config = loadConfig();
  assert.equal(config.driver, 's3');
  assert.equal(config.s3Endpoint, 'https://test-account.r2.cloudflarestorage.com');

  const storage = createStorageService(config);
  const key = 'yedu/device/works/work-1/script.json';
  const upload = await storage.createUpload({
    key,
    size: 123,
    contentType: 'application/json',
  });
  assert.equal(upload.mode, 'put');
  assert.equal(upload.method, 'PUT');
  assert.match(upload.uploadUrl, /^https:\/\/test-bucket\.test-account\.r2\.cloudflarestorage\.com\//);
  assert.doesNotMatch(upload.uploadUrl, /x-amz-checksum/i);
  assert.match(upload.uploadUrl, /X-Amz-Signature=/);
  assert.equal(upload.headers['Content-Type'], 'application/json');
  assert.equal(upload.headers['Content-Length'], '123');
  assert.ok(upload.expiresAt > Math.floor(Date.now() / 1000));

  const download = await storage.createDownload({ key });
  assert.match(download.url, /^https:\/\/test-bucket\.test-account\.r2\.cloudflarestorage\.com\//);
  assert.match(download.url, /X-Amz-Signature=/);
  assert.ok(download.expiresAt > Math.floor(Date.now() / 1000));
});
