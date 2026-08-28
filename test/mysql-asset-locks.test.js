"use strict";

const mysql = require("mysql2/promise");

describe("asset lock reservation", () => {
  let store;
  let connection;
  let state;

  beforeEach(() => {
    vi.restoreAllMocks();
    state = { reserved: false, updates: [] };
    connection = {
      beginTransaction: vi.fn().mockResolvedValue(),
      commit: vi.fn().mockResolvedValue(),
      rollback: vi.fn().mockResolvedValue(),
      release: vi.fn(),
      query: vi.fn(async (sql, params) => {
        if (sql.includes("FOR UPDATE SKIP LOCKED")) {
          if (state.reserved) {
            return [[]];
          }
          state.reserved = true;
          return [[{
            id: 7,
            card_number: "4242424242424242",
            card_expiry: "12/30",
            card_cvc: "123",
            card_holder: "Jane Doe",
            usage_count: 0,
          }]];
        }
        if (sql.includes("UPDATE card_assets")) {
          state.updates.push(params);
          return [{ affectedRows: 1 }];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };
    vi.spyOn(mysql, "createPool").mockReturnValue({
      getConnection: vi.fn().mockResolvedValue(connection),
    });
    delete require.cache[require.resolve("../mysql-store")];
    store = require("../mysql-store");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assigns a contested card to only one concurrent task", async () => {
    const reservations = await Promise.all([
      store.reserveCard("job-a"),
      store.reserveCard("job-b"),
    ]);

    const reserved = reservations.filter(Boolean);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ id: 7, card_number: "4242424242424242" });
    expect(state.updates).toHaveLength(1);
    expect(connection.query).toHaveBeenCalledTimes(3);
    expect(connection.beginTransaction).toHaveBeenCalledTimes(2);
    expect(connection.commit).toHaveBeenCalledTimes(2);
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});