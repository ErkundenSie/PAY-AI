"use strict";

const crypto = require("crypto");

const CDK_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CDK_GROUP_SIZE = 4;
const CDK_GROUP_COUNT = 4;
const CDK_BODY_LENGTH = CDK_GROUP_SIZE * CDK_GROUP_COUNT;
const CDK_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;

function randomCharsetChar() {
  return CDK_CHARSET[crypto.randomInt(CDK_CHARSET.length)];
}

function randomCdkBody(length = CDK_BODY_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += randomCharsetChar();
  }
  return out;
}

function formatCdk(body) {
  const raw = String(body || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[ILO01]/g, "")
    .slice(0, CDK_BODY_LENGTH);
  if (raw.length < CDK_BODY_LENGTH) return "";
  const chunks = [];
  for (let i = 0; i < CDK_BODY_LENGTH; i += CDK_GROUP_SIZE) {
    chunks.push(raw.slice(i, i + CDK_GROUP_SIZE));
  }
  return chunks.join("-");
}

function createCdkCode() {
  let code = "";
  while (!CDK_PATTERN.test(code)) {
    code = formatCdk(randomCdkBody());
  }
  return code;
}

function createCdks(count) {
  const results = new Set();
  const target = Math.max(1, Math.min(Number(count) || 1, 100));

  while (results.size < target) {
    results.add(createCdkCode());
  }

  return [...results];
}

module.exports = {
  CDK_CHARSET,
  CDK_GROUP_SIZE,
  CDK_GROUP_COUNT,
  CDK_BODY_LENGTH,
  CDK_PATTERN,
  createCdkCode,
  createCdks,
  formatCdk,
};
