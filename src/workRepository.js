'use strict';

const crypto = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function parseTags(value) {
  try {
    const tags = JSON.parse(value || '[]');
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}

function toWork(row) {
  if (!row) return null;
  return {
    ...row,
    tags: parseTags(row.tags),
  };
}

function createWorkRepository(db) {
  const insertWork = db.prepare(`
    INSERT INTO works (
      id, device_id, title, description, author, tags,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `);
  const selectWork = db.prepare('SELECT * FROM works WHERE id = ?');
  const selectPublished = db.prepare("SELECT * FROM works WHERE id = ? AND status = 'published'");
  const updateFiles = db.prepare(`
    UPDATE works SET
      script_key = ?, script_name = ?,
      cover_key = ?, cover_name = ?,
      pack_key = ?, pack_name = ?,
      updated_at = ?
    WHERE id = ?
  `);
  const publish = db.prepare(`
    UPDATE works SET
      title = ?, description = ?, author = ?, tags = ?,
      node_count = ?, image_count = ?,
      script_size = ?, cover_size = ?, pack_size = ?, size_bytes = ?,
      status = 'published', published_at = ?, updated_at = ?
    WHERE id = ?
  `);
  const incrementDownload = db.prepare(`
    UPDATE works SET download_count = download_count + 1 WHERE id = ?
  `);

  function createWork({ deviceId, title, description, author, tags }) {
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    insertWork.run(
      id,
      deviceId,
      title,
      description || '',
      author || '',
      JSON.stringify(tags || []),
      timestamp,
      timestamp,
    );
    return getWork(id);
  }

  function getWork(id) {
    return toWork(selectWork.get(id));
  }

  function getPublished(id) {
    return toWork(selectPublished.get(id));
  }

  function updateDraftFiles(id, deviceId, files) {
    const current = getWork(id);
    if (!current) return { error: 'not_found' };
    if (current.device_id !== deviceId) return { error: 'forbidden' };
    if (current.status !== 'draft') return { error: 'not_draft' };

    const scriptKey = files.scriptKey !== undefined ? files.scriptKey : current.script_key;
    const coverKey = files.coverKey !== undefined ? files.coverKey : current.cover_key;
    const packKey = files.packKey !== undefined ? files.packKey : current.pack_key;
    const scriptName = files.scriptName !== undefined ? files.scriptName : current.script_name;
    const coverName = files.coverName !== undefined ? files.coverName : current.cover_name;
    const packName = files.packName !== undefined ? files.packName : current.pack_name;

    updateFiles.run(
      scriptKey,
      scriptName,
      coverKey,
      coverName,
      packKey,
      packName,
      nowIso(),
      id,
    );
    return { work: getWork(id) };
  }

  function finalizeWork(id, deviceId, metadata) {
    const current = getWork(id);
    if (!current) return { error: 'not_found' };
    if (current.device_id !== deviceId) return { error: 'forbidden' };
    if (current.status !== 'draft') return { error: 'not_draft' };

    const timestamp = nowIso();
    const scriptSize = metadata.scriptSize || 0;
    const coverSize = metadata.coverSize || 0;
    const packSize = metadata.packSize || 0;
    publish.run(
      metadata.title,
      metadata.description,
      metadata.author,
      JSON.stringify(metadata.tags || []),
      metadata.nodeCount,
      metadata.imageCount,
      scriptSize,
      coverSize,
      packSize,
      scriptSize + coverSize + packSize,
      timestamp,
      timestamp,
      id,
    );
    return { work: getPublished(id) };
  }

  function listPublished({ limit, offset, query }) {
    const q = String(query || '').trim();
    if (q) {
      const like = `%${q}%`;
      const where = "status = 'published' AND (title LIKE ? OR author LIKE ? OR description LIKE ? OR tags LIKE ?)";
      const total = db.prepare(`SELECT COUNT(*) AS count FROM works WHERE ${where}`)
        .get(like, like, like, like).count;
      const rows = db.prepare(`
        SELECT * FROM works WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
      `).all(like, like, like, like, limit, offset);
      return { total, rows: rows.map(toWork) };
    }
    const total = db.prepare("SELECT COUNT(*) AS count FROM works WHERE status = 'published'").get().count;
    const rows = db.prepare(`
      SELECT * FROM works WHERE status = 'published'
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
    return { total, rows: rows.map(toWork) };
  }

  function markDownloaded(id) {
    incrementDownload.run(id);
  }

  return {
    createWork,
    getWork,
    getPublished,
    updateDraftFiles,
    finalizeWork,
    listPublished,
    markDownloaded,
  };
}

module.exports = { createWorkRepository };