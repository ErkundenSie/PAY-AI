"use strict";

const crypto = require("crypto");

const VIEWPORTS = [
  { width: 1920, height: 1080, availHeight: 1032 },
  { width: 1920, height: 1080, availHeight: 1040 },
  { width: 1680, height: 1050, availHeight: 1010 },
  { width: 1600, height: 900, availHeight: 860 },
  { width: 1536, height: 864, availHeight: 824 },
  { width: 1440, height: 900, availHeight: 860 },
  { width: 2560, height: 1440, availHeight: 1392 },
];

const CORES = [4, 6, 8, 12, 16];
const MEMORY = [4, 8, 16];
const PLATFORM_VERSIONS = ["10.0.0", "13.0.0", "15.0.0"];
const WEBGL = [
  {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedToInt(seed) {
  if (seed == null || seed === "") {
    return crypto.randomBytes(4).readUInt32LE(0);
  }
  const hex = crypto.createHash("sha256").update(String(seed)).digest("hex");
  return Number.parseInt(hex.slice(0, 8), 16);
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function buildBrowserFingerprint({
  chromeMajor = 147,
  locale = "en-US",
  seed = "",
} = {}) {
  const seedInt = seedToInt(seed);
  const rng = mulberry32(seedInt);
  const screen = pick(VIEWPORTS, rng);
  const gpu = pick(WEBGL, rng);
  const language = String(locale || "en-US");
  const languages = language.startsWith("en")
    ? [language, "en"].filter((item, idx, arr) => arr.indexOf(item) === idx)
    : [language, "en-US", "en"];

  return {
    seed: seedInt,
    chromeMajor: Number(chromeMajor) || 147,
    viewport: { width: screen.width, height: screen.height },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: screen.availHeight,
      colorDepth: 24,
      pixelDepth: 24,
    },
    hardwareConcurrency: pick(CORES, rng),
    deviceMemory: pick(MEMORY, rng),
    platformVersion: pick(PLATFORM_VERSIONS, rng),
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    connection: {
      effectiveType: "4g",
      rtt: 50 + Math.floor(rng() * 80),
      downlink: 5 + Math.floor(rng() * 16),
      saveData: false,
    },
    canvasNoise: 1 + Math.floor(rng() * 3),
    language: languages[0],
    languages,
  };
}

module.exports = {
  buildBrowserFingerprint,
};
