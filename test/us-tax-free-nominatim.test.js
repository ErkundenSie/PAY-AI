"use strict";

const {
  isZipInState,
  normalizeNominatimAddress,
  resolveValidatedPoint,
  generateNominatimUsTaxFreeAddress,
} = require("../us-tax-free-nominatim");

describe("us-tax-free-nominatim", () => {
  it("accepts ZIP prefixes that belong to tax-free states", () => {
    expect(isZipInState("97204", "OR")).toBe(true);
    expect(isZipInState("19702", "DE")).toBe(true);
    expect(isZipInState("03101", "NH")).toBe(true);
    expect(isZipInState("90012", "OR")).toBe(false);
  });

  it("rejects water and coarse nominatim results", () => {
    const point = { lat: 45.5152, lng: -122.6784, zip: "97204", cityHint: "Portland" };
    expect(
      resolveValidatedPoint(point, {
        lat: 45.5152,
        lon: -122.6784,
        place_rank: 28,
        category: "natural",
        type: "water",
        address: { road: "SW 6th Ave", city: "Portland", country_code: "us" },
      }),
    ).toBeNull();
    expect(
      resolveValidatedPoint(point, {
        lat: 45.5152,
        lon: -122.6784,
        place_rank: 16,
        type: "city",
        address: { city: "Portland", country_code: "us" },
      }),
    ).toBeNull();
  });

  it("normalizes a street-level reverse result", () => {
    const addr = normalizeNominatimAddress(
      {
        lat: 45.5152,
        lon: -122.6784,
        address: {
          house_number: "1050",
          road: "SW 6th Ave",
          city: "Portland",
          state: "Oregon",
          postcode: "97204",
          country_code: "us",
        },
      },
      "OR",
      { zip: "97204", cityHint: "Portland" },
    );
    expect(addr).toMatchObject({
      line1: "1050 SW 6th Ave",
      city: "Portland",
      state: "Oregon",
      postal_code: "97204",
      country: "US",
      source: "nominatim",
    });
  });

  it("retries until nominatim returns a usable street address", async () => {
    const payloads = [
      {
        place_rank: 16,
        type: "city",
        lat: 45.51,
        lon: -122.67,
        address: { city: "Portland", country_code: "us" },
      },
      {
        place_rank: 28,
        lat: 45.5152,
        lon: -122.6784,
        address: {
          house_number: "400",
          road: "NW 23rd Ave",
          city: "Portland",
          state: "Oregon",
          postcode: "97210",
          country_code: "us",
        },
      },
    ];
    const addr = await generateNominatimUsTaxFreeAddress({
      stateCode: "OR",
      skipDelay: true,
      fetchJson: async () => payloads.shift(),
      pickPoint: () => ({
        state: "OR",
        cityHint: "Portland",
        zip: "97204",
        lat: 45.5152,
        lng: -122.6784,
      }),
    });
    expect(addr.line1).toBe("400 NW 23rd Ave");
    expect(addr.postal_code).toBe("97210");
  });
});
