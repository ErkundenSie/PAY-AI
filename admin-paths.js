"use strict";

const DEFAULT_LOGIN_PATH = "admin-login";
const DEFAULT_PANEL_PATH = "admin";
const DEFAULT_CHECKOUT_PATH = "checkout";
const RESERVED_PATHS = new Set([
  "api",
  "public",
  "static",
  "assets",
  "checkout",
  "subscription",
  "favicon.svg",
  "index.html",
  "subscription.html",
  "checkout.html",
  "admin-login.html",
  "admin.html",
]);

function slugifyPathSegment(raw) {
  return String(raw || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const RESERVED_PATH_SLUGS = new Set(
  [...RESERVED_PATHS].map((item) => slugifyPathSegment(item)).filter(Boolean),
);

function normalizeAdminPathSegment(raw, fallback = DEFAULT_LOGIN_PATH) {
  const segment = slugifyPathSegment(raw) || fallback;
  if (segment.length < 2 || segment.length > 32) {
    throw new Error("入口路径长度需在 2-32 个字符之间");
  }
  if (RESERVED_PATHS.has(segment) || RESERVED_PATH_SLUGS.has(segment)) {
    throw new Error(`路径 "${segment}" 为系统保留，请换一个`);
  }
  return segment;
}

function normalizeCheckoutPathSegment(raw, fallback = DEFAULT_CHECKOUT_PATH) {
  const segment = slugifyPathSegment(raw) || fallback;
  if (segment.length < 2 || segment.length > 32) {
    throw new Error("入口路径长度需在 2-32 个字符之间");
  }
  if (
    segment !== DEFAULT_CHECKOUT_PATH &&
    (RESERVED_PATHS.has(segment) || RESERVED_PATH_SLUGS.has(segment))
  ) {
    throw new Error(`路径 "${segment}" 为系统保留，请换一个`);
  }
  return segment;
}

function normalizeAdminPaths(input = {}) {
  const loginPath = normalizeAdminPathSegment(
    input.loginPath ?? input.admin_login_path ?? input.login_path,
    DEFAULT_LOGIN_PATH,
  );
  const panelPath = normalizeAdminPathSegment(
    input.panelPath ?? input.admin_panel_path ?? input.panel_path,
    DEFAULT_PANEL_PATH,
  );
  const checkoutPath = normalizeCheckoutPathSegment(
    input.checkoutPath ?? input.checkout_path,
    DEFAULT_CHECKOUT_PATH,
  );
  if (new Set([loginPath, panelPath, checkoutPath]).size !== 3) {
    throw new Error("登录入口、管理入口与自助开通入口不能相同");
  }
  return { loginPath, panelPath, checkoutPath };
}

function buildAdminLoginUrl(paths = {}) {
  return `/${paths.loginPath || DEFAULT_LOGIN_PATH}`;
}

function buildAdminPanelUrl(paths = {}) {
  return `/${paths.panelPath || DEFAULT_PANEL_PATH}`;
}

function buildCheckoutUrl(paths = {}) {
  return `/${paths.checkoutPath || DEFAULT_CHECKOUT_PATH}`;
}

module.exports = {
  DEFAULT_LOGIN_PATH,
  DEFAULT_PANEL_PATH,
  DEFAULT_CHECKOUT_PATH,
  normalizeAdminPathSegment,
  normalizeCheckoutPathSegment,
  normalizeAdminPaths,
  buildAdminLoginUrl,
  buildAdminPanelUrl,
  buildCheckoutUrl,
};
