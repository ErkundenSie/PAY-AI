"use strict";

const {
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginAttempts,
} = require("../admin-auth");

describe("admin login rate limit", () => {
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const email = `lock-${Date.now()}@example.com`;

  afterEach(() => {
    const rate = checkLoginRateLimit(ip, email);
    clearLoginAttempts(rate.keys || rate.key);
  });

  it("locks by email even when IP changes", () => {
    for (let i = 0; i < 5; i += 1) {
      const rate = checkLoginRateLimit(`198.51.100.${i + 1}`, email);
      expect(rate.allowed).toBe(true);
      recordLoginFailure(rate.keys || rate.key, rate.entries || rate.entry);
    }
    const blocked = checkLoginRateLimit("198.51.100.99", email);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("locks by IP independently of email", () => {
    for (let i = 0; i < 5; i += 1) {
      const rate = checkLoginRateLimit(ip, `other-${i}@example.com`);
      expect(rate.allowed).toBe(true);
      recordLoginFailure(rate.keys || rate.key, rate.entries || rate.entry);
    }
    const blocked = checkLoginRateLimit(ip, "fresh@example.com");
    expect(blocked.allowed).toBe(false);
  });
});
