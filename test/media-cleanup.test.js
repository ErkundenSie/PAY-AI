"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { purgeOldMedia } = require("../media-cleanup");

const temporaryDirs = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kc-media-"));
  temporaryDirs.push(root);
  return root;
}

function writeFile(root, rel, content, mtimeMs) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mtimeMs) {
    const at = new Date(mtimeMs);
    fs.utimesSync(full, at, at);
  }
  return full;
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("purgeOldMedia", () => {
  it("deletes expired screenshots and videos but keeps recent files", () => {
    const root = makeRoot();
    const now = Date.UTC(2026, 7, 31, 12, 0, 0);
    writeFile(root, path.join("activation", "old.png"), "old", now - 8 * 86400000);
    writeFile(root, path.join("videos", "old.webm"), "vid", now - 10 * 86400000);
    writeFile(root, path.join("activation", "fresh.png"), "new", now - 60 * 1000);
    writeFile(root, path.join("activation", "notes.txt"), "keep", now - 10 * 86400000);

    const result = purgeOldMedia(root, {
      now,
      maxAgeMs: 7 * 86400000,
      minKeepMs: 30 * 60 * 1000,
      maxTotalBytes: 0,
    });

    expect(result.deleted).toBe(2);
    expect(fs.existsSync(path.join(root, "activation", "fresh.png"))).toBe(true);
    expect(fs.existsSync(path.join(root, "activation", "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "activation", "old.png"))).toBe(false);
    expect(fs.existsSync(path.join(root, "videos"))).toBe(false);
  });

  it("trims oldest files when over quota without touching very new ones", () => {
    const root = makeRoot();
    const now = Date.UTC(2026, 7, 31, 12, 0, 0);
    writeFile(root, "mid.png", "1234567890", now - 2 * 3600000);
    writeFile(root, "older.png", "1234567890", now - 3 * 3600000);
    writeFile(root, "live.png", "1234567890", now - 60 * 1000);

    const result = purgeOldMedia(root, {
      now,
      maxAgeMs: 30 * 86400000,
      minKeepMs: 30 * 60 * 1000,
      maxTotalBytes: 15,
    });

    expect(result.deleted).toBe(2);
    expect(fs.existsSync(path.join(root, "live.png"))).toBe(true);
    expect(fs.existsSync(path.join(root, "older.png"))).toBe(false);
    expect(fs.existsSync(path.join(root, "mid.png"))).toBe(false);
  });
});
