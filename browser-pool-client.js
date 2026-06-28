'use strict';

/**
 * 浏览器池客户端：子进程通过 CDP 接入 server 预热的 Chromium 槽位
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { probeUserAgent, DEFAULT_UA } = require('./browser-standalone');

chromium.use(StealthPlugin());

/**
 * @param {object} options
 * @param {string} options.poolCdpUrl
 * @param {string|number} [options.poolSlotId]
 */
async function connectPoolBrowser(options = {}) {
    const poolCdpUrl = String(options.poolCdpUrl || '').trim();
    if (!poolCdpUrl) {
        throw new Error('浏览器池模式缺少 BROWSER_POOL_CDP_URL');
    }

    const slotLabel = options.poolSlotId != null ? String(options.poolSlotId) : '?';
    console.log(`♻️ [Browser/pool] 接入 slot=${slotLabel} (${poolCdpUrl})`);

    const browser = await chromium.connectOverCDP(poolCdpUrl);

    return {
        mode: 'pool',
        browser,
        ownsBrowser: false,
        cdpUrl: poolCdpUrl,
        poolSlotId: slotLabel,
        realUserAgent: await probeUserAgent(browser, DEFAULT_UA)
    };
}

module.exports = {
    connectPoolBrowser
};
