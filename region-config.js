"use strict";

/**
 * 支付地区配置映射
 * 每个地区包含对应的币种和中文标签
 */
const REGION_CONFIG = {
  PH: {
    currency: "PHP",
    label: "菲律宾",
    locale: "en-PH",
    timezone: "Asia/Manila",
  },
  US: {
    currency: "USD",
    label: "美国",
    locale: "en-US",
    timezone: "America/New_York",
  },
  SG: {
    currency: "SGD",
    label: "新加坡",
    locale: "en-SG",
    timezone: "Asia/Singapore",
  },
  MY: {
    currency: "MYR",
    label: "马来西亚",
    locale: "en-MY",
    timezone: "Asia/Kuala_Lumpur",
  },
  AU: {
    currency: "AUD",
    label: "澳大利亚",
    locale: "en-AU",
    timezone: "Australia/Sydney",
  },
  CA: {
    currency: "CAD",
    label: "加拿大",
    locale: "en-CA",
    timezone: "America/Toronto",
  },
  GB: {
    currency: "GBP",
    label: "英国",
    locale: "en-GB",
    timezone: "Europe/London",
  },
  AE: {
    currency: "AED",
    label: "阿联酋",
    locale: "en-AE",
    timezone: "Asia/Dubai",
  },
  JP: {
    currency: "JPY",
    label: "日本",
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
  },
  KR: {
    currency: "KRW",
    label: "韩国",
    locale: "ko-KR",
    timezone: "Asia/Seoul",
  },
  HK: {
    currency: "HKD",
    label: "中国香港",
    locale: "zh-HK",
    timezone: "Asia/Hong_Kong",
  },
  TW: {
    currency: "TWD",
    label: "中国台湾",
    locale: "zh-TW",
    timezone: "Asia/Taipei",
  },
  TH: {
    currency: "THB",
    label: "泰国",
    locale: "th-TH",
    timezone: "Asia/Bangkok",
  },
  ID: {
    currency: "IDR",
    label: "印度尼西亚",
    locale: "id-ID",
    timezone: "Asia/Jakarta",
  },
  VN: {
    currency: "VND",
    label: "越南",
    locale: "vi-VN",
    timezone: "Asia/Ho_Chi_Minh",
  },
  IN: {
    currency: "INR",
    label: "印度",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
  },
  BR: {
    currency: "BRL",
    label: "巴西",
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
  },
  MX: {
    currency: "MXN",
    label: "墨西哥",
    locale: "es-MX",
    timezone: "America/Mexico_City",
  },
  DE: {
    currency: "EUR",
    label: "德国",
    locale: "de-DE",
    timezone: "Europe/Berlin",
  },
  FR: {
    currency: "EUR",
    label: "法国",
    locale: "fr-FR",
    timezone: "Europe/Paris",
  },
  NL: {
    currency: "EUR",
    label: "荷兰",
    locale: "nl-NL",
    timezone: "Europe/Amsterdam",
  },
  IT: {
    currency: "EUR",
    label: "意大利",
    locale: "it-IT",
    timezone: "Europe/Rome",
  },
  ES: {
    currency: "EUR",
    label: "西班牙",
    locale: "es-ES",
    timezone: "Europe/Madrid",
  },
};

/** 支持的地区代码列表 */
const SUPPORTED_REGIONS = Object.keys(REGION_CONFIG);

/** 默认支付地区 */
const DEFAULT_REGION = "PH";

function isSupportedRegion(regionCode) {
  return SUPPORTED_REGIONS.includes(String(regionCode || "").toUpperCase());
}

/**
 * 获取指定地区的配置（currency, label）
 * @param {string} regionCode - 地区代码
 * @returns {{ currency: string, label: string, locale: string, timezone: string } | null}
 */
function getRegionConfig(regionCode) {
  const code = String(regionCode || "").toUpperCase();
  return REGION_CONFIG[code] || null;
}

function getRegionBilling(regionCode) {
  const cfg = getRegionConfig(regionCode);
  if (!cfg) {
    return null;
  }
  const code = String(regionCode || "").toUpperCase();
  return {
    country: code,
    currency: cfg.currency,
    label: cfg.label,
  };
}

function getRegionBrowserProfile(regionCode) {
  const cfg = getRegionConfig(regionCode) || REGION_CONFIG[DEFAULT_REGION];
  return {
    locale: cfg.locale,
    timezoneId: cfg.timezone,
  };
}

module.exports = {
  REGION_CONFIG,
  SUPPORTED_REGIONS,
  DEFAULT_REGION,
  isSupportedRegion,
  getRegionConfig,
  getRegionBilling,
  getRegionBrowserProfile,
};
