'use strict';

const DEFAULT_LOGIN_PATH = 'admin-login';
const DEFAULT_PANEL_PATH = 'admin';
const RESERVED_PATHS = new Set([
    'api',
    'public',
    'static',
    'assets',
    'favicon.svg',
    'index.html',
    'subscription.html',
    'admin-login.html',
    'admin.html'
]);

function normalizeAdminPathSegment(raw, fallback = DEFAULT_LOGIN_PATH) {
    const cleaned = String(raw || '')
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    const segment = cleaned || fallback;
    if (segment.length < 2 || segment.length > 32) {
        throw new Error('入口路径长度需在 2-32 个字符之间');
    }
    if (RESERVED_PATHS.has(segment)) {
        throw new Error(`路径 "${segment}" 为系统保留，请换一个`);
    }
    return segment;
}

function normalizeAdminPaths(input = {}) {
    const loginPath = normalizeAdminPathSegment(
        input.loginPath ?? input.admin_login_path ?? input.login_path,
        DEFAULT_LOGIN_PATH
    );
    const panelPath = normalizeAdminPathSegment(
        input.panelPath ?? input.admin_panel_path ?? input.panel_path,
        DEFAULT_PANEL_PATH
    );
    if (loginPath === panelPath) {
        throw new Error('登录入口与管理入口不能相同');
    }
    return { loginPath, panelPath };
}

function buildAdminLoginUrl(paths = {}) {
    return `/${paths.loginPath || DEFAULT_LOGIN_PATH}`;
}

function buildAdminPanelUrl(paths = {}) {
    return `/${paths.panelPath || DEFAULT_PANEL_PATH}`;
}

module.exports = {
    DEFAULT_LOGIN_PATH,
    DEFAULT_PANEL_PATH,
    normalizeAdminPathSegment,
    normalizeAdminPaths,
    buildAdminLoginUrl,
    buildAdminPanelUrl
};
