"use strict";

const {
  validateExpiry,
  parseCardImportLine,
  parseCardBundle,
} = require("../card-validator");

describe("card import formats", () => {
  it("accepts MMYY expiry", () => {
    expect(validateExpiry("0431")).toMatchObject({
      valid: true,
      normalized: "04/31",
    });
  });

  it("parses pipe MMYY, comma MM/YY, and comma MMYY", () => {
    expect(parseCardImportLine("5349336383247282|0431|937")).toMatchObject({
      card_number: "5349336383247282",
      card_expiry: "04/31",
      card_cvc: "937",
    });
    expect(parseCardImportLine("5349336383247282,04/31,937")).toMatchObject({
      card_number: "5349336383247282",
      card_expiry: "04/31",
      card_cvc: "937",
    });
    expect(parseCardImportLine("5349336383247282,0431,937")).toMatchObject({
      card_number: "5349336383247282",
      card_expiry: "04/31",
      card_cvc: "937",
    });
  });

  it("parses comma gift-card paste bundles", () => {
    expect(parseCardBundle("5378727122975684,09/28,748")).toMatchObject({
      number: "5378727122975684",
      expiry: "09/28",
      cvc: "748",
    });
  });
});
