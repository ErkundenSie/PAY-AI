'use strict';

/**
 * 支付地区配置映射
 * 每个地区包含对应的币种和中文标签
 */
const REGION_CONFIG = {
    PH: { currency: 'PHP', label: '菲律宾', locale: 'en-PH', timezone: 'Asia/Manila' },
    US: { currency: 'USD', label: '美国', locale: 'en-US', timezone: 'America/New_York' },
    SG: { currency: 'SGD', label: '新加坡', locale: 'en-SG', timezone: 'Asia/Singapore' },
    MY: { currency: 'MYR', label: '马来西亚', locale: 'en-MY', timezone: 'Asia/Kuala_Lumpur' }
};

/** 支持的地区代码列表 */
const SUPPORTED_REGIONS = Object.keys(REGION_CONFIG);

/** 默认支付地区 */
const DEFAULT_REGION = 'PH';

const PLAN_TYPE_LABELS = {
    plus: 'ChatGPT Plus',
    pro_5x: 'ChatGPT Pro 5x',
    pro_20x: 'ChatGPT Pro 20x'
};

/**
 * 检查地区代码是否在支持列表中
 * @param {string} regionCode - 地区代码
 * @returns {boolean}
 */
function isSupportedRegion(regionCode) {
    return SUPPORTED_REGIONS.includes(String(regionCode || '').toUpperCase());
}

/**
 * 获取指定地区的配置（currency, label）
 * @param {string} regionCode - 地区代码
 * @returns {{ currency: string, label: string, locale: string, timezone: string } | null}
 */
function getRegionConfig(regionCode) {
    const code = String(regionCode || '').toUpperCase();
    return REGION_CONFIG[code] || null;
}

function getRegionBilling(regionCode) {
    const cfg = getRegionConfig(regionCode);
    if (!cfg) {
        return null;
    }
    const code = String(regionCode || '').toUpperCase();
    return {
        country: code,
        currency: cfg.currency,
        label: cfg.label
    };
}

function getRegionBrowserProfile(regionCode) {
    const cfg = getRegionConfig(regionCode) || REGION_CONFIG[DEFAULT_REGION];
    return {
        locale: cfg.locale,
        timezoneId: cfg.timezone
    };
}

function getPlanTypeLabel(planType) {
    return PLAN_TYPE_LABELS[planType] || PLAN_TYPE_LABELS.plus;
}

module.exports = {
    REGION_CONFIG,
    SUPPORTED_REGIONS,
    DEFAULT_REGION,
    PLAN_TYPE_LABELS,
    isSupportedRegion,
    getRegionConfig,
    getRegionBilling,
    getRegionBrowserProfile,
    getPlanTypeLabel
};
