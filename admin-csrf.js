"use strict";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerHost(value) {
  return String(value || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}

function hostFromUrl(raw) {
  const value = String(raw || "").trim();
  if (!value || value === "null") {
    return "";
  }
  try {
    return new URL(value).host.toLowerCase();
  } catch (_) {
    return "";
  }
}

function requestOriginHost(req) {
  const originHost = hostFromUrl(req?.headers?.origin);
  if (originHost) {
    return originHost;
  }
  return hostFromUrl(req?.headers?.referer);
}

function requestHost(req, trustProxy = false) {
  const raw = trustProxy
    ? req?.headers?.["x-forwarded-host"] || req?.headers?.host
    : req?.headers?.host;
  return headerHost(raw);
}

function rejectCrossOriginAdmin(req, options = {}) {
  const method = String(req?.method || "").toUpperCase();
  const path = String(req?.path || req?.url || "").split("?")[0];
  if (!MUTATING_METHODS.has(method) || !path.startsWith("/api/admin")) {
    return null;
  }

  const fetchSite = String(req?.headers?.["sec-fetch-site"] || "")
    .trim()
    .toLowerCase();
  if (fetchSite === "cross-site") {
    return { status: 403, message: "拒绝跨源请求" };
  }

  const originHost = requestOriginHost(req);
  const host = requestHost(req, Boolean(options.trustProxy));
  if (!host || !originHost || originHost !== host) {
    return { status: 403, message: "拒绝跨源请求" };
  }
  return null;
}

module.exports = {
  MUTATING_METHODS,
  requestOriginHost,
  requestHost,
  rejectCrossOriginAdmin,
};
