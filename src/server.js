'use strict';

const { loadConfig } = require('./config');
const { createQiniuService } = require('./qiniuService');
const { createApp } = require('./app');

const config = loadConfig();
const qiniuService = createQiniuService(config);
const app = createApp(config, qiniuService);
const server = app.listen(config.port, () => {
  console.log(`[yedu-signer] listening on :${config.port} bucket=${config.bucket} private=${config.privateBucket}`);
});

function shutdown(signal) {
  console.log(`[yedu-signer] ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
