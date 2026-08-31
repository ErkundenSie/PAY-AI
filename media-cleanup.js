"use strict";

const fs = require("fs");
const path = require("path");

const MEDIA_EXT = /\.(png|webm)$/i;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_KEEP_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function isInsideRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function collectMediaFiles(root, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (!isInsideRoot(root, full)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      collectMediaFiles(full, acc);
      continue;
    }
    if (!entry.isFile() || !MEDIA_EXT.test(entry.name)) {
      continue;
    }
    try {
      const stat = fs.statSync(full);
      acc.push({
        path: full,
        mtimeMs: Number(stat.mtimeMs) || 0,
        size: Number(stat.size) || 0,
      });
    } catch (_) {
      /* ignore */
    }
  }
  return acc;
}

function removeEmptyDirs(dir, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name), root);
    }
  }
  if (path.resolve(dir) === path.resolve(root)) {
    return;
  }
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch (_) {
    /* ignore */
  }
}

function unlinkMedia(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function purgeOldMedia(root, options = {}) {
  const now = Number(options.now) || Date.now();
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const minKeepMs = Math.max(0, Number(options.minKeepMs ?? DEFAULT_MIN_KEEP_MS));
  const maxTotalBytes = Number(options.maxTotalBytes);
  const quotaEnabled = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0;
  const result = {
    scanned: 0,
    deleted: 0,
    bytesFreed: 0,
    remainingBytes: 0,
    freedText: "0 B",
  };

  if (!root || !fs.existsSync(root)) {
    return result;
  }

  const files = collectMediaFiles(root);
  result.scanned = files.length;

  const kept = [];
  for (const file of files) {
    const age = now - file.mtimeMs;
    if (age >= maxAgeMs && age >= minKeepMs && unlinkMedia(file.path)) {
      result.deleted += 1;
      result.bytesFreed += file.size;
      continue;
    }
    kept.push(file);
  }

  if (quotaEnabled) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    for (const file of kept) {
      if (total <= maxTotalBytes) {
        break;
      }
      const age = now - file.mtimeMs;
      if (age < minKeepMs) {
        continue;
      }
      if (!unlinkMedia(file.path)) {
        continue;
      }
      result.deleted += 1;
      result.bytesFreed += file.size;
      total -= file.size;
      file.deleted = true;
    }
    result.remainingBytes = kept.reduce(
      (sum, file) => sum + (file.deleted ? 0 : file.size),
      0,
    );
  } else {
    result.remainingBytes = kept.reduce((sum, file) => sum + file.size, 0);
  }

  removeEmptyDirs(root, root);
  result.freedText = formatBytes(result.bytesFreed);
  return result;
}

module.exports = {
  collectMediaFiles,
  purgeOldMedia,
  formatBytes,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MIN_KEEP_MS,
  DEFAULT_MAX_TOTAL_BYTES,
};
