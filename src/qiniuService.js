'use strict';

const qiniu = require('qiniu');

function createQiniuService(config) {
  const mac = new qiniu.auth.digest.Mac(config.accessKey, config.secretKey);
  const qiniuConfig = new qiniu.conf.Config();
  const bucketManager = new qiniu.rs.BucketManager(mac, qiniuConfig);

  function uploadToken(key) {
    const putPolicy = new qiniu.rs.PutPolicy({
      scope: `${config.bucket}:${key}`,
      expires: config.uploadTokenTtlSeconds,
      insertOnly: 0,
      fsizeLimit: config.maxUploadBytes,
      mimeLimit: 'image/*;application/json',
      returnBody: '{"key":"$(key)","hash":"$(etag)","fsize":$(fsize),"mimeType":"$(mimeType)"}',
    });
    return putPolicy.uploadToken(mac);
  }

  function publicDownloadUrl(key) {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${config.domain}/${encodedKey}`;
  }

  function downloadUrl(key) {
    if (!config.privateBucket) return publicDownloadUrl(key);
    const expiresAt = Math.floor(Date.now() / 1000) + config.downloadTtlSeconds;
    return bucketManager.privateDownloadUrl(config.domain, key, expiresAt);
  }

  return { uploadToken, downloadUrl };
}

module.exports = { createQiniuService };
