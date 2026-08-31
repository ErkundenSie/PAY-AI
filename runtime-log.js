/**
 * 进程内环形运行日志（供管理后台「运行日志」页展示）。
 * 重启后清空；与 task_logs 表独立。
 */
const { redactSensitiveText } = require("./log-redact");

const MAX_ENTRIES = 15000;
const MAX_LINE = 8192;

let seq = 1;
const buffer = [];

function push(entry) {
  const text = redactSensitiveText(String(entry.text || "").replace(/\r/g, ""), {
    maxLen: MAX_LINE,
  });
  if (!text.trim()) {
    return;
  }
  const id = seq++;
  buffer.push({
    id,
    ts: Date.now(),
    jobKey: String(entry.jobKey || "").slice(0, 80),
    level: String(entry.level || "log").slice(0, 24),
    source: String(entry.source || "").slice(0, 64),
    text,
  });
  while (buffer.length > MAX_ENTRIES) {
    buffer.shift();
  }
}

function tail(limit) {
  const n = Math.min(MAX_ENTRIES, Math.max(1, Number(limit) || 500));
  return buffer.slice(-n);
}

function after(afterId, limit) {
  const aid = Math.max(0, Number(afterId) || 0);
  const n = Math.min(2000, Math.max(1, Number(limit) || 500));
  const out = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const e = buffer[i];
    if (e.id > aid) {
      out.push(e);
      if (out.length >= n) {
        break;
      }
    }
  }
  return out;
}

function forJob(jobKey, afterId, limit) {
  const key = String(jobKey || "").trim();
  const aid = Math.max(0, Number(afterId) || 0);
  const n = Math.min(500, Math.max(1, Number(limit) || 200));
  if (!key) return [];
  const out = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const e = buffer[i];
    if (e.jobKey === key && e.id > aid) {
      out.push(e);
      if (out.length >= n) break;
    }
  }
  return out;
}

function clear() {
  buffer.length = 0;
}

function stats() {
  return { count: buffer.length, nextSeq: seq };
}

module.exports = { push, tail, after, forJob, clear, stats };
