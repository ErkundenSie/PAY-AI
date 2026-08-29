"use strict";

const fs = require("fs");
const path = require("path");

function choiceDir() {
  const dir = path.join(__dirname, "data", "checkout-choices");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeJobKey(jobKey) {
  return String(jobKey || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function choicePath(jobKey) {
  return path.join(choiceDir(), `${safeJobKey(jobKey)}.json`);
}

function writeCheckoutChoiceWait(jobKey) {
  if (!jobKey) return;
  fs.writeFileSync(
    choicePath(jobKey),
    JSON.stringify({ status: "waiting", at: Date.now() }),
  );
}

function setCheckoutChoice(jobKey, variant) {
  const value = String(variant || "").trim();
  if (!jobKey || !value) {
    throw new Error("缺少任务或套餐档位");
  }
  if (!["continue", "pro_5x", "pro_20x"].includes(value)) {
    throw new Error("选择无效");
  }
  fs.writeFileSync(
    choicePath(jobKey),
    JSON.stringify({ status: "chosen", variant: value, at: Date.now() }),
  );
}

function readCheckoutChoice(jobKey) {
  if (!jobKey) return null;
  try {
    return JSON.parse(fs.readFileSync(choicePath(jobKey), "utf8"));
  } catch (_) {
    return null;
  }
}

function isWaitingCheckoutChoice(jobKey) {
  return readCheckoutChoice(jobKey)?.status === "waiting";
}

function clearCheckoutChoice(jobKey) {
  if (!jobKey) return;
  try {
    fs.unlinkSync(choicePath(jobKey));
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  writeCheckoutChoiceWait,
  setCheckoutChoice,
  readCheckoutChoice,
  isWaitingCheckoutChoice,
  clearCheckoutChoice,
};
