"use strict";

const {
  US_STATE_LABELS,
  US_TAX_FREE_STREETS,
  generateRandomUsTaxFreeAddress,
  normalizeUsStateName,
} = require("../us-tax-free-address");

describe("us-tax-free-address", () => {
  it("keeps generated addresses inside tax-free states with matching zip", () => {
    const zipsByCity = new Map();
    for (const row of US_TAX_FREE_STREETS) {
      const key = `${row.city}|${normalizeUsStateName(row.state)}`;
      const zips = zipsByCity.get(key) || new Set();
      zips.add(row.postal_code);
      zipsByCity.set(key, zips);
    }

    for (let i = 0; i < 40; i += 1) {
      const addr = generateRandomUsTaxFreeAddress();
      const stateName = normalizeUsStateName(addr.state);
      expect(Object.values(US_STATE_LABELS)).toContain(stateName);
      expect(addr.country).toBe("US");
      expect(addr.line1).toMatch(/^\d+\s+.+/);
      const zips = zipsByCity.get(`${addr.city}|${stateName}`);
      expect(zips).toBeTruthy();
      expect(zips.has(addr.postal_code)).toBe(true);
    }
  });

  it("normalizes state codes to checkout labels", () => {
    expect(normalizeUsStateName("OR")).toBe("Oregon");
    expect(normalizeUsStateName("new hampshire")).toBe("New Hampshire");
  });
});
