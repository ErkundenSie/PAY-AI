"use strict";

const express = require("express");
const { registerAdminAssetRoutes } = require("../routes/admin-assets");

function passthrough(_req, _res, next) {
  next();
}

function createApp(store, createCdks) {
  const app = express();
  app.use(express.json());
  registerAdminAssetRoutes(app, {
    store,
    ensureStoreReady: async () => {},
    requireSecondaryAuth: passthrough,
    createCdks,
  });
  return app;
}

async function request(app, method, url, body) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = text;
    }
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("admin asset routes", () => {
  it("generates CDKs with the selected card group", async () => {
    const inserted = [];
    const store = {
      insertCdks: async (cdks, options) => {
        inserted.push({ cdks, options });
        return { insertedCount: cdks.length };
      },
    };
    const app = createApp(store, () => ["KC-TESTCODE12345"]);
    const res = await request(app, "POST", "/api/admin/cdks/generate", {
      count: 1,
      plan_type: "plus",
      card_group_id: 7,
    });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.insertedCount).toBe(1);
    expect(res.json.card_group_id).toBe(7);
    expect(inserted[0].options).toMatchObject({
      type: "自助",
      plan_type: "plus",
      card_group_id: 7,
    });
  });

  it("creates a card group and lists groups", async () => {
    const store = {
      createCardGroup: async ({ name, cardIds }) => ({
        id: 3,
        name,
        card_count: cardIds.length,
      }),
      listCardGroups: async () => [{ id: 3, name: "fz1", card_count: 1 }],
    };
    const app = createApp(store, () => []);
    const created = await request(app, "POST", "/api/admin/card-groups", {
      name: "fz1",
      cardIds: [11],
    });
    expect(created.status).toBe(200);
    expect(created.json.group).toMatchObject({ id: 3, name: "fz1" });
    const listed = await request(app, "GET", "/api/admin/card-groups");
    expect(listed.json.groups).toEqual([{ id: 3, name: "fz1", card_count: 1 }]);
  });

  it("passes CDK list pagination and filters to the store", async () => {
    const received = [];
    const store = {
      listCdks: async (options) => {
        received.push(options);
        return {
          cdks: [{ code: "KC-AAA", status: "unused" }],
          total: 13,
          page: 2,
          pageSize: 12,
        };
      },
    };
    const app = createApp(store, () => []);
    const res = await request(
      app,
      "GET",
      "/api/admin/cdks?page=2&pageSize=12&status=unused&plan_type=plus&group_id=7&q=KC-A",
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      success: true,
      total: 13,
      page: 2,
      pageSize: 12,
    });
    expect(res.json.cdks).toHaveLength(1);
    expect(received[0]).toMatchObject({
      page: "2",
      pageSize: "12",
      status: "unused",
      planType: "plus",
      groupId: "7",
      keyword: "KC-A",
    });
  });

  it("lists cards with pagination", async () => {
    const received = [];
    const store = {
      listAdminCards: async (options) => {
        received.push(options);
        return {
          cards: [
            {
              id: 9,
              last4: "4242",
              card_number: "4242424242424242",
              card_cvc: "123",
              card_expiry: "04/31",
              card_holder: "A",
            },
          ],
          total: 21,
          page: 2,
          pageSize: 20,
          stats: { total: 21, active: 18, cooldown: 2, exhausted: 1 },
        };
      },
    };
    const app = createApp(store, () => []);
    const res = await request(
      app,
      "GET",
      "/api/admin/cards?page=2&pageSize=20&group_id=none&q=4242",
    );
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.cards[0].card_number).toBe("4242424242424242");
    expect(res.json.cards[0].card_cvc).toBe("123");
    expect(res.json.cards[0].last4).toBe("4242");
    expect(res.json.total).toBe(21);
    expect(received[0]).toMatchObject({
      page: "2",
      pageSize: "20",
      groupId: "none",
      keyword: "4242",
    });
  });

  it("batch deletes, pauses, and sets card usage limits", async () => {
    const calls = [];
    const store = {
      deleteCardsByIds: async (cardIds, options = {}) => {
        calls.push(["delete", cardIds, options]);
        return {
          deleted: cardIds.length,
          emptied_groups: [],
          deleted_groups: 0,
          deleted_cdks: 0,
        };
      },
      setCardsPaused: async (options) => {
        calls.push(["pause", options]);
        return { updated: options.cardIds.length, paused: options.paused };
      },
      setCardsMaxUsageCount: async (options) => {
        calls.push(["limit", options]);
        return {
          updated: options.cardIds.length,
          max_usage_count: options.maxUsageCount,
          paused: 0,
        };
      },
    };
    const app = createApp(store, () => []);
    const deleted = await request(app, "POST", "/api/admin/cards/batch-delete", {
      cardIds: [1, 2],
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json.deleted).toBe(2);
    const paused = await request(app, "POST", "/api/admin/cards/pause", {
      cardIds: [3],
      paused: true,
    });
    expect(paused.json.paused).toBe(true);
    const limited = await request(app, "POST", "/api/admin/cards/max-usage", {
      cardIds: [4],
      maxUsageCount: 5,
    });
    expect(limited.json.max_usage_count).toBe(5);
    expect(calls).toEqual([
      ["delete", [1, 2], { deleteEmptyGroups: false }],
      ["pause", { cardIds: [3], paused: true }],
      ["limit", { cardIds: [4], maxUsageCount: 5 }],
    ]);
  });

  it("lists card options for checkout debug", async () => {
    const store = {
      listAdminCardOptions: async () => [
        {
          id: 3,
          last4: "1111",
          card_number: "4111111111111111",
          payment_holder_name: "B",
          is_active: 1,
        },
      ],
    };
    const app = createApp(store, () => []);
    const res = await request(app, "GET", "/api/admin/cards/options");
    expect(res.status).toBe(200);
    expect(res.json.cards).toEqual([
      {
        id: 3,
        last4: "1111",
        card_number: "4111111111111111",
        payment_holder_name: "B",
        is_active: 1,
      },
    ]);
  });
});
