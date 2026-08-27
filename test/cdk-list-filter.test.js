"use strict";

const { filterCdkItems } = require("../cdk-list-filter");

const pool = [
  { code: "KC-AAA", status: "unused", plan_type: "plus", card_group_id: 7, shipped: false },
  { code: "KC-BBB", status: "used", plan_type: "plus", card_group_id: 7, shipped: true },
  { code: "KC-CCC", status: "unused", plan_type: "pro_5x", card_group_id: null, shipped: false },
  "KC-DDD",
];

describe("filterCdkItems", () => {
  it("hides grouped codes when filter is ungrouped only", () => {
    const result = filterCdkItems(pool, { groupId: "none" });
    expect(result.map((item) => (typeof item === "string" ? item : item.code))).toEqual([
      "KC-CCC",
      "KC-DDD",
    ]);
  });

  it("keeps only the selected card group", () => {
    const result = filterCdkItems(pool, { groupId: 7 });
    expect(result.map((item) => item.code)).toEqual(["KC-AAA", "KC-BBB"]);
  });

  it("combines status and group filters", () => {
    const result = filterCdkItems(pool, { status: "unused", groupId: 7 });
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("KC-AAA");
  });
});
