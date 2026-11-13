'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createQiniuService } = require('./qiniuService');

const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;

function createStorageService(config) {
  if (config.driver === 'qiniu') {
    const qiniuService = createQiniuService(config);
    return {
      driver: 'qiniu',
      async createUpload({ key }) {
        return {
          mode: 'form',
          key,
          uploadHost: config.uploadHost,
          uploadToken: qiniuService.uploadToken(key),
          expiresAt: Math.floor(Date.now() / 1000) + config.uploadTtlSeconds,
        };
      },
      async createDownload({ key }) {
        return {
          key,
          url: qiniuService.downloadUrl(key),
          expiresAt: Math.floor(Date.now() / 1000) + config.downloadTtlSeconds,
        };
      },
      async stat(key) {
        return qiniuService.stat(key);
      },
    };
  }

  const client = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
    // 预签名 PUT 不应带占位 checksum，否则客户端上传时容易校验失败。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  async function sign(command, ttlSeconds) {
    const expiresIn = Math.min(Math.max(ttlSeconds, 1), SEVEN_DAYS_SECONDS);
    return {
      url: await getSignedUrl(client, command, { expiresIn }),
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    };
  }

  return {
    driver: 's3',
    async createUpload({ key, size, contentType }) {
      const input = {
        Bucket: config.bucket,
        Key: key,
      };
      if (size) input.ContentLength = size;
      if (contentType) input.ContentType = contentType;

      const signed = await sign(new PutObjectCommand(input), config.uploadTtlSeconds);
      const headers = {};
      if (contentType) headers['Content-Type'] = contentType;
      // 如果客户端显式传入 size，预签名会绑定 content-length；OkHttp 会按请求体自动设置。
      if (size) headers['Content-Length'] = String(size);

      return {
        mode: 'put',
        key,
        uploadUrl: signed.url,
        method: 'PUT',
        headers,
        expiresAt: signed.expiresAt,
      };
    },
    async createDownload({ key }) {
      const signed = await sign(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        config.downloadTtlSeconds,
      );
      return {
        key,
        url: signed.url,
        expiresAt: signed.expiresAt,
      };
    },
    async stat(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return {
          size: Number(result.ContentLength) || 0,
          contentType: result.ContentType || null,
        };
      } catch (error) {
        if (error && error.$metadata && error.$metadata.httpStatusCode === 404) return null;
        throw error;
      }
    },
  };
}

module.exports = { createStorageService };