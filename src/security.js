'use strict';

const crypto = require('node:crypto');

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const ALLOWED_SUFFIX_RE = /\.(png|jpe?g|webp|json)$/i;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createDeviceToken(deviceId, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    sub: deviceId,
    iat: now,
    exp: now + ttlSeconds,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function decodeDeviceToken(token, secret, { allowExpired = false } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!timingSafeEqualText(signature, sign(payload, secret))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.sub !== 'string' || !DEVICE_ID_RE.test(data.sub)) return null;
  if (!Number.isFinite(data.exp)) return null;
  if (!allowExpired && data.exp <= Math.floor(Date.now() / 1000)) return null;
  return data;
}

function verifyDeviceToken(token, secret) {
  return decodeDeviceToken(token, secret);
}

function validateDeviceId(deviceId) {
  return typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId);
}

function validateObjectKey(key, deviceId, prefix) {
  if (typeof key !== 'string') return false;
  if (key.length < 1 || key.length > 512) return false;
  if (key.startsWith('/') || key.endsWith('/') || key.includes('//')) return false;
  if (key.includes('..') || key.includes('\\') || key.includes('\0')) return false;

  const expectedPrefix = `${prefix}/${deviceId}/`;
  if (!key.startsWith(expectedPrefix)) return false;
  if (!ALLOWED_SUFFIX_RE.test(key)) return false;

  const segments = key.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }
  return segments.every((segment) => KEY_SEGMENT_RE.test(segment));
}

module.exports = {
  createDeviceToken,
  decodeDeviceToken,
  verifyDeviceToken,
  validateDeviceId,
  validateObjectKey,
};
