"use strict";

function getCdkCode(item) {
  return typeof item === "string" ? item : item.code || "";
}

function getCdkStatus(item) {
  return typeof item === "string" ? "unused" : item.status || "unused";
}

function getCdkGroupId(item) {
  return typeof item === "string" ? null : item.card_group_id || null;
}

function filterCdkItems(source, options = {}) {
  const {
    status = "all",
    planType = "all",
    groupId = "all",
    keyword = "",
  } = options;
  let result = Array.isArray(source) ? source : [];

  if (status === "used") {
    result = result.filter((item) => getCdkStatus(item) === "used");
  } else if (status === "unused") {
    result = result.filter((item) => getCdkStatus(item) === "unused");
  } else if (status === "shipped") {
    result = result.filter(
      (item) => typeof item !== "string" && Boolean(item.shipped),
    );
  } else if (status === "unshipped") {
    result = result.filter((item) => typeof item === "string" || !item.shipped);
  }

  if (planType && planType !== "all") {
    result = result.filter((item) => {
      const value =
        typeof item === "string" ? "plus" : item.plan_type || "plus";
      return value === planType;
    });
  }

  if (groupId && groupId !== "all") {
    result = result.filter((item) => {
      const id = getCdkGroupId(item);
      return groupId === "none" ? !id : String(id || "") === String(groupId);
    });
  }

  const key = String(keyword || "")
    .trim()
    .toUpperCase();
  if (key) {
    result = result.filter((item) =>
      String(getCdkCode(item)).toUpperCase().includes(key),
    );
  }

  return result;
}

if (typeof globalThis !== "undefined") {
  globalThis.filterCdkItems = filterCdkItems;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { filterCdkItems };
}
