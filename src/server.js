'use strict';

const { loadConfig } = require('./config');
const { createStorageService } = require('./storageService');
const { createDatabase } = require('./db');
const { createWorkRepository } = require('./workRepository');
const { createApp } = require('./app');

const config = loadConfig();
const storageService = createStorageService(config);
const db = createDatabase(config.dbPath);
const workRepository = createWorkRepository(db);
const app = createApp(config, storageService, workRepository);
const server = app.listen(config.port, () => {
  console.log(
    `[yedu-cloud] listening on :${config.port} driver=${storageService.driver} bucket=${config.bucket}`,
  );
});

function shutdown(signal) {
  console.log(`[yedu-cloud] ${signal}, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));