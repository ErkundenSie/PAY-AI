"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.UsTaxFreeAddress = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const US_STATE_LABELS = {
    OR: "Oregon",
    DE: "Delaware",
    MT: "Montana",
    NH: "New Hampshire",
    AK: "Alaska",
  };

  const US_TAX_FREE_STREETS = [
    {
      line1: "1050 SW 6th Ave",
      city: "Portland",
      state: "OR",
      postal_code: "97204",
    },
    {
      line1: "400 NW 23rd Ave",
      city: "Portland",
      state: "OR",
      postal_code: "97210",
    },
    {
      line1: "1200 NW Naito Pkwy",
      city: "Portland",
      state: "OR",
      postal_code: "97209",
    },
    {
      line1: "1551 SW Broadway",
      city: "Portland",
      state: "OR",
      postal_code: "97201",
    },
    {
      line1: "1000 Christiana Mall",
      city: "Newark",
      state: "DE",
      postal_code: "19702",
    },
    {
      line1: "2000 Rambleton Dr",
      city: "New Castle",
      state: "DE",
      postal_code: "19720",
    },
    {
      line1: "820 N French St",
      city: "Wilmington",
      state: "DE",
      postal_code: "19801",
    },
    {
      line1: "1100 N Market St",
      city: "Wilmington",
      state: "DE",
      postal_code: "19801",
    },
    {
      line1: "1500 S Willow St",
      city: "Manchester",
      state: "NH",
      postal_code: "03103",
    },
    {
      line1: "75 Canal St",
      city: "Manchester",
      state: "NH",
      postal_code: "03101",
    },
    {
      line1: "310 Daniel Webster Hwy",
      city: "Nashua",
      state: "NH",
      postal_code: "03060",
    },
    {
      line1: "1301 E 6th Ave",
      city: "Helena",
      state: "MT",
      postal_code: "59601",
    },
    {
      line1: "222 N 32nd St",
      city: "Billings",
      state: "MT",
      postal_code: "59101",
    },
    {
      line1: "3901 Old Seward Hwy",
      city: "Anchorage",
      state: "AK",
      postal_code: "99503",
    },
    {
      line1: "800 Glacier Ave",
      city: "Juneau",
      state: "AK",
      postal_code: "99801",
    },
  ];

  const UNIT_TYPES = ["Apt", "Unit", "Ste", "Rm"];

  function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function normalizeUsStateName(state) {
    const raw = String(state || "").trim();
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    if (US_STATE_LABELS[upper]) return US_STATE_LABELS[upper];
    const lower = raw.toLowerCase();
    const code = Object.keys(US_STATE_LABELS).find(
      (item) => US_STATE_LABELS[item].toLowerCase() === lower,
    );
    return code ? US_STATE_LABELS[code] : raw;
  }

  function varyStreetNumber(line1) {
    const match = String(line1 || "").match(/^(\d+)\s+(.*)$/);
    if (!match) return String(line1 || "").trim();
    const next = Math.max(
      10,
      Number(match[1]) + Math.floor(Math.random() * 40),
    );
    return `${next} ${match[2]}`;
  }

  function maybeAppendUnit(line1) {
    if (Math.random() >= 0.5) return line1;
    return `${line1}, ${pickRandom(UNIT_TYPES)} ${Math.floor(Math.random() * 900) + 10}`;
  }

  function generateRandomUsTaxFreeAddress() {
    const base = pickRandom(US_TAX_FREE_STREETS);
    return {
      line1: maybeAppendUnit(varyStreetNumber(base.line1)),
      city: base.city,
      state: normalizeUsStateName(base.state),
      postal_code: base.postal_code,
      country: "US",
      generated: true,
    };
  }

  return {
    US_STATE_LABELS,
    US_TAX_FREE_STREETS,
    normalizeUsStateName,
    generateRandomUsTaxFreeAddress,
  };
});
