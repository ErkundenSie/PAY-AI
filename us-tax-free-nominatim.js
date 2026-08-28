"use strict";

const https = require("node:https");
const { URL } = require("node:url");

const NOMINATIM_REVERSE_API_URL =
  "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "kc-pay-gpt-tax-free-address/1.0";
const TAX_FREE_STATES = ["OR", "DE", "NH", "MT", "AK"];
const MIN_STREET_LEVEL_PLACE_RANK = 26;
const MAX_REVERSE_MATCH_DISTANCE_METERS = 350;
const MAX_COORD_SNAP_DISTANCE_METERS = 1800;
const MAX_ATTEMPTS_PER_ADDRESS = 6;

const WATER_CATEGORIES = new Set(["waterway", "natural"]);
const WATER_TYPES = new Set([
  "bay",
  "coastline",
  "harbour",
  "lake",
  "ocean",
  "river",
  "sea",
  "strait",
  "water",
  "wetland",
]);
const COARSE_TYPES = new Set([
  "administrative",
  "city",
  "continent",
  "country",
  "county",
  "district",
  "hamlet",
  "island",
  "locality",
  "municipality",
  "neighbourhood",
  "postcode",
  "province",
  "quarter",
  "region",
  "state",
  "suburb",
  "town",
  "village",
]);
const LOCALITY_FIELDS = [
  "borough",
  "city",
  "city_district",
  "county",
  "hamlet",
  "municipality",
  "neighbourhood",
  "quarter",
  "suburb",
  "town",
  "village",
];

const STATE_NAMES = {
  OR: "Oregon",
  DE: "Delaware",
  NH: "New Hampshire",
  MT: "Montana",
  AK: "Alaska",
};
const STATE_MAP = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);
const USPS_ZIP_PREFIX_RANGES = {
  OR: [[970, 979]],
  DE: [[197, 199]],
  NH: [[30, 38]],
  MT: [[590, 599]],
  AK: [[995, 999]],
};
const STATE_BOUNDS = {
  OR: [
    {
      name: "Portland",
      lat: [45.45, 45.58],
      lng: [-122.75, -122.55],
      zip: "97204",
    },
    {
      name: "Salem",
      lat: [44.88, 45.02],
      lng: [-123.1, -122.93],
      zip: "97301",
    },
    {
      name: "Bend",
      lat: [44.0, 44.12],
      lng: [-121.38, -121.23],
      zip: "97701",
    },
    {
      name: "Eugene",
      lat: [44.02, 44.1],
      lng: [-123.16, -123.02],
      zip: "97401",
    },
    {
      name: "Medford",
      lat: [42.29, 42.36],
      lng: [-122.92, -122.82],
      zip: "97501",
    },
  ],
  DE: [
    {
      name: "Wilmington",
      lat: [39.7, 39.78],
      lng: [-75.6, -75.48],
      zip: "19801",
    },
    {
      name: "Newark",
      lat: [39.63, 39.72],
      lng: [-75.82, -75.68],
      zip: "19702",
    },
    {
      name: "Dover",
      lat: [39.1, 39.2],
      lng: [-75.6, -75.45],
      zip: "19901",
    },
    {
      name: "Middletown",
      lat: [39.42, 39.48],
      lng: [-75.75, -75.66],
      zip: "19709",
    },
    {
      name: "Rehoboth Beach",
      lat: [38.69, 38.74],
      lng: [-75.12, -75.06],
      zip: "19971",
    },
  ],
  NH: [
    {
      name: "Manchester",
      lat: [42.94, 43.04],
      lng: [-71.51, -71.39],
      zip: "03101",
    },
    {
      name: "Nashua",
      lat: [42.71, 42.8],
      lng: [-71.55, -71.4],
      zip: "03060",
    },
    {
      name: "Concord",
      lat: [43.18, 43.25],
      lng: [-71.6, -71.48],
      zip: "03301",
    },
    {
      name: "Portsmouth",
      lat: [43.04, 43.1],
      lng: [-70.82, -70.72],
      zip: "03801",
    },
    {
      name: "Keene",
      lat: [42.91, 42.96],
      lng: [-72.34, -72.25],
      zip: "03431",
    },
  ],
  MT: [
    {
      name: "Billings",
      lat: [45.73, 45.84],
      lng: [-108.65, -108.42],
      zip: "59101",
    },
    {
      name: "Missoula",
      lat: [46.82, 46.92],
      lng: [-114.1, -113.92],
      zip: "59801",
    },
    {
      name: "Helena",
      lat: [46.55, 46.63],
      lng: [-112.08, -111.96],
      zip: "59601",
    },
    {
      name: "Bozeman",
      lat: [45.65, 45.72],
      lng: [-111.12, -111.0],
      zip: "59715",
    },
    {
      name: "Great Falls",
      lat: [47.47, 47.54],
      lng: [-111.38, -111.24],
      zip: "59401",
    },
  ],
  AK: [
    {
      name: "Anchorage",
      lat: [61.12, 61.23],
      lng: [-150.05, -149.75],
      zip: "99501",
    },
    {
      name: "Juneau",
      lat: [58.28, 58.36],
      lng: [-134.5, -134.35],
      zip: "99801",
    },
    {
      name: "Fairbanks",
      lat: [64.8, 64.88],
      lng: [-147.85, -147.6],
      zip: "99701",
    },
    {
      name: "Wasilla",
      lat: [61.55, 61.61],
      lng: [-149.55, -149.35],
      zip: "99654",
    },
    {
      name: "Ketchikan",
      lat: [55.32, 55.37],
      lng: [-131.7, -131.62],
      zip: "99901",
    },
  ],
};

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function getDistanceMeters(start, end) {
  const earthRadiusMeters = 6371000;
  const deltaLat = toRadians(end.lat - start.lat);
  const deltaLng = toRadians(end.lng - start.lng);
  const startLat = toRadians(start.lat);
  const endLat = toRadians(end.lat);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toTitleCaseWord(word) {
  const raw = String(word || "").trim();
  if (!raw) return "";
  if (/^[NSEW]{1,2}$/i.test(raw)) return raw.toUpperCase();
  if (/^\d+[A-Z]?$/i.test(raw)) return raw.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function toTitleCaseText(value) {
  return String(value || "")
    .trim()
    .split(/(\s+|-)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part) || part === "-") return part;
      if (part.includes("'")) {
        return part
          .split("'")
          .map((segment) => toTitleCaseWord(segment))
          .join("'");
      }
      return toTitleCaseWord(part);
    })
    .join("");
}

function normalizeZip5(zip, fallback = "") {
  const match = String(zip || "").match(/\d{5}/);
  return match ? match[0] : fallback;
}

function isZipInState(zip, stateCode) {
  const match = String(zip || "").match(/\d{5}/);
  if (!match) return false;
  const ranges = USPS_ZIP_PREFIX_RANGES[String(stateCode || "").toUpperCase()];
  if (!ranges) return false;
  const prefix = Number(match[0].slice(0, 3));
  return ranges.some(([min, max]) => prefix >= min && prefix <= max);
}

function getNominatimAddressPart(address, keys) {
  for (const key of keys) {
    const value = address?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function normalizeNominatimStateCode(address) {
  const rawState = getNominatimAddressPart(address, [
    "state",
    "region",
    "province",
  ]);
  const rawCode = getNominatimAddressPart(address, [
    "state_code",
    "ISO3166-2-lvl4",
  ]);
  if (rawCode) {
    const match = rawCode.toUpperCase().match(/(?:US-)?([A-Z]{2})$/);
    if (match) return match[1];
  }
  return STATE_MAP[rawState.toLowerCase()] || "";
}

function isWaterLike(result) {
  const category = String(result?.category || "").toLowerCase();
  const type = String(result?.type || result?.addresstype || "").toLowerCase();
  return WATER_CATEGORIES.has(category) && WATER_TYPES.has(type);
}

function isCoarseAreaResult(result) {
  const type = String(result?.type || "").toLowerCase();
  const addressType = String(result?.addresstype || "").toLowerCase();
  return COARSE_TYPES.has(type) || COARSE_TYPES.has(addressType);
}

function hasLocalityContext(address) {
  return (
    LOCALITY_FIELDS.some((field) => String(address?.[field] || "").trim()) ||
    String(address?.postcode || "").trim()
  );
}

function hasStreetLevelAddress(address) {
  return (
    Boolean(getNominatimAddressPart(address, ["road"])) &&
    hasLocalityContext(address)
  );
}

function pickNominatimPoint(stateCode) {
  const boxes = STATE_BOUNDS[stateCode] || STATE_BOUNDS.OR;
  const box = pickRandom(boxes);
  return {
    state: stateCode,
    cityHint: box.name,
    zip: box.zip,
    lat: Number(randomBetween(box.lat[0], box.lat[1]).toFixed(7)),
    lng: Number(randomBetween(box.lng[0], box.lng[1]).toFixed(7)),
  };
}

function resolveValidatedPoint(requestedPoint, raw) {
  const address = raw?.address || {};
  const countryCode = String(address.country_code || "")
    .trim()
    .toUpperCase();
  if (countryCode && countryCode !== "US") return null;
  if (isWaterLike(raw) || isCoarseAreaResult(raw)) return null;
  if (Number(raw.place_rank || 0) < MIN_STREET_LEVEL_PLACE_RANK) return null;
  if (!hasStreetLevelAddress(address)) return null;

  const reversePoint = { lat: Number(raw.lat), lng: Number(raw.lon) };
  if (
    !Number.isFinite(reversePoint.lat) ||
    !Number.isFinite(reversePoint.lng)
  ) {
    return null;
  }

  const distanceMeters = getDistanceMeters(requestedPoint, reversePoint);
  if (distanceMeters <= MAX_REVERSE_MATCH_DISTANCE_METERS) {
    return { ...requestedPoint, snapped: false };
  }
  if (distanceMeters <= MAX_COORD_SNAP_DISTANCE_METERS) {
    return {
      ...requestedPoint,
      lat: reversePoint.lat,
      lng: reversePoint.lng,
      snapped: true,
    };
  }
  return null;
}

function normalizeNominatimAddress(raw, expectedStateCode, point) {
  if (!raw || typeof raw !== "object") throw new Error("Nominatim 返回为空");
  if (raw.error) throw new Error(raw.error);

  const address = raw.address || {};
  const countryCode = String(address.country_code || "")
    .trim()
    .toUpperCase();
  if (countryCode && countryCode !== "US") {
    throw new Error(`Nominatim 返回非美国地址: ${countryCode}`);
  }

  const resultState = normalizeNominatimStateCode(address);
  const expectedState = String(expectedStateCode || "")
    .trim()
    .toUpperCase();
  if (expectedState && resultState && resultState !== expectedState) {
    throw new Error(
      `Nominatim 返回州不匹配: expected ${expectedState}, got ${resultState}`,
    );
  }

  const finalState = resultState || expectedState || "OR";
  const road = getNominatimAddressPart(address, [
    "road",
    "pedestrian",
    "residential",
    "footway",
    "cycleway",
    "path",
  ]);
  const houseNumber = getNominatimAddressPart(address, ["house_number"]);
  const city = toTitleCaseText(
    getNominatimAddressPart(address, [
      "city",
      "town",
      "village",
      "municipality",
      "hamlet",
      "suburb",
      "county",
    ]) || point?.cityHint,
  );
  const rawZip = normalizeZip5(address.postcode, "");
  if (rawZip && !isZipInState(rawZip, finalState)) {
    throw new Error(`Nominatim 返回 ZIP 与州不匹配: ${rawZip} / ${finalState}`);
  }
  const zip = rawZip || point?.zip || "";
  if (!road || !houseNumber || !city) {
    throw new Error("Nominatim 缺少详细地址字段");
  }
  if (!isZipInState(zip, finalState)) {
    throw new Error(`Nominatim ZIP 无法通过州一致性校验: ${zip} / ${finalState}`);
  }

  return {
    line1: `${houseNumber} ${toTitleCaseText(road)}`,
    city,
    state: STATE_NAMES[finalState] || finalState,
    postal_code: zip,
    country: "US",
    generated: true,
    source: "nominatim",
  };
}

function buildNominatimReverseUrl(point) {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(point.lat),
    lon: String(point.lng),
    zoom: "18",
    addressdetails: "1",
    "accept-language": "en",
  });
  return `${NOMINATIM_REVERSE_API_URL}?${params.toString()}`;
}

function fetchNominatimJson(url, timeoutMs = 7500) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const request = https.request(
      targetUrl,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-language": "en",
          "user-agent": USER_AGENT,
          referer: "https://nominatim.openstreetmap.org/ui/reverse.html",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {
            reject(new Error("Nominatim 返回不是 JSON"));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Nominatim HTTP ${response.statusCode || 500}`));
            return;
          }
          resolve(data);
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Nominatim 请求超时"));
    });
    request.on("error", reject);
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateNominatimUsTaxFreeAddress(options = {}) {
  const fetchJson = options.fetchJson || fetchNominatimJson;
  const pickState = options.pickState || (() => pickRandom(TAX_FREE_STATES));
  const stateCode = String(options.stateCode || pickState()).toUpperCase();
  const attempts = Math.max(
    1,
    Number(options.attempts || MAX_ATTEMPTS_PER_ADDRESS),
  );
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const point = options.pickPoint
      ? options.pickPoint(stateCode)
      : pickNominatimPoint(stateCode);
    try {
      const raw = await fetchJson(buildNominatimReverseUrl(point));
      const resolved = resolveValidatedPoint(point, raw);
      if (!resolved) {
        lastError = new Error("Nominatim 未通过街道级校验");
        continue;
      }
      return normalizeNominatimAddress(raw, stateCode, resolved);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts && !options.skipDelay) {
      await sleep(1100);
    }
  }

  throw lastError || new Error("Nominatim 未返回可用地址");
}

module.exports = {
  TAX_FREE_STATES,
  STATE_NAMES,
  STATE_BOUNDS,
  pickNominatimPoint,
  resolveValidatedPoint,
  normalizeNominatimAddress,
  generateNominatimUsTaxFreeAddress,
  isZipInState,
};
