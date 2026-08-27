"use strict";

function registerAdminAssetRoutes(app, deps) {
  const {
    store,
    ensureStoreReady,
    requireSecondaryAuth,
    createCdks,
    logAdminSecurityEvent,
    getClientMeta,
  } = deps;

  function auditAdminAction(req, event, detail) {
    if (typeof logAdminSecurityEvent !== "function") return;
    const meta =
      typeof getClientMeta === "function" ? getClientMeta(req) : {};
    Promise.resolve(
      logAdminSecurityEvent(event, {
        ...meta,
        email: req.admin?.email || "",
        detail,
      }),
    ).catch(() => {});
  }

  app.get("/api/admin/cards", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const result = await store.listAdminCards({
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.page_size,
        groupId: req.query.group_id ?? req.query.groupId,
      });
      res.json({
        success: true,
        cards: result.cards || [],
        total: Number(result.total || 0),
        page: Number(result.page || 1),
        pageSize: Number(result.pageSize || 20),
        stats: result.stats || {
          total: 0,
          active: 0,
          cooldown: 0,
          exhausted: 0,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/admin/cards/options", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const cards = await store.listAdminCardOptions();
      res.json({ success: true, cards });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/cards/import", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
      if (cards.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: "缺少 cards 数组或为空" });
      }
      if (cards.length > 500) {
        return res
          .status(400)
          .json({ success: false, error: "单次导入上限 500 条" });
      }

      const result = await store.importCards(cards);
      auditAdminAction(req, "cards_imported", `导入 ${result.imported || cards.length} 张卡`);
      res.json({ success: true, ...result });
    } catch (error) {
      if (error.message === "单次导入上限 500 条") {
        return res.status(400).json({ success: false, error: error.message });
      }
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/admin/card-groups", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const groups = await store.listCardGroups();
      res.json({ success: true, groups });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/card-groups", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const group = await store.createCardGroup({
        name: req.body?.name,
        cardIds: req.body?.cardIds || req.body?.card_ids || [],
      });
      res.json({ success: true, group, message: "分组已创建" });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.post(
    "/api/admin/card-groups/assign",
    requireSecondaryAuth,
    async (req, res) => {
      try {
        await ensureStoreReady();
        const result = await store.assignCardsToGroup({
          groupId: req.body?.groupId ?? req.body?.group_id ?? null,
          cardIds: req.body?.cardIds || req.body?.card_ids || [],
        });
        res.json({
          success: true,
          ...result,
          message: result.group_id ? "已加入分组" : "已移出分组",
        });
      } catch (error) {
        res.status(400).json({ success: false, message: error.message });
      }
    },
  );

  app.delete(
    "/api/admin/card-groups/:id",
    requireSecondaryAuth,
    async (req, res) => {
      try {
        await ensureStoreReady();
        await store.deleteCardGroup(req.params.id);
        res.json({ success: true, message: "分组已删除" });
      } catch (error) {
        res.status(400).json({ success: false, message: error.message });
      }
    },
  );

  app.delete("/api/admin/cards/:id", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const cardId = Number(req.params.id);
      if (!cardId || !Number.isFinite(cardId)) {
        return res.status(400).json({ success: false, error: "无效的卡片 ID" });
      }
      const result = await store.runExecute(
        `DELETE FROM card_assets WHERE id = ?`,
        [cardId],
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: "卡片不存在" });
      }
      auditAdminAction(req, "card_deleted", `删除卡片 #${cardId}`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.get("/api/admin/cdks", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const result = await store.listCdks({
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.page_size,
        status: req.query.status,
        planType: req.query.plan_type || req.query.planType,
        groupId: req.query.group_id ?? req.query.groupId,
        keyword: req.query.q || req.query.keyword,
      });
      if (Array.isArray(result)) {
        return res.json(result);
      }
      res.json({
        success: true,
        cdks: result.cdks || [],
        total: Number(result.total || 0),
        page: Number(result.page || 1),
        pageSize: Number(result.pageSize || 12),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/cdks/generate", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      const count = req.body?.count;
      const planType = req.body?.plan_type || "plus";
      const cardGroupId =
        req.body?.card_group_id ?? req.body?.cardGroupId ?? null;
      const newCdks = createCdks(count);
      const result = await store.insertCdks(newCdks, {
        type: "自助",
        plan_type: planType,
        card_group_id: cardGroupId,
      });
      auditAdminAction(
        req,
        "cdk_generated",
        `生成 ${result.insertedCount} 个 ${planType} CDK`,
      );
      res.json({
        success: true,
        message: `成功生成 ${result.insertedCount} 个自助 CDK`,
        cdks: newCdks,
        insertedCount: result.insertedCount,
        plan_type: planType,
        card_group_id: cardGroupId || null,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/admin/cdks/import", requireSecondaryAuth, async (req, res) => {
    const cdks = Array.isArray(req.body?.cdks) ? req.body.cdks : [];
    if (cdks.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "请提供要导入的卡密" });
    }

    try {
      await ensureStoreReady();
      const planType = req.body?.plan_type || "plus";
      const cardGroupId =
        req.body?.card_group_id ?? req.body?.cardGroupId ?? null;
      const summary = await store.insertCdks(cdks, {
        plan_type: planType,
        card_group_id: cardGroupId,
      });
      auditAdminAction(
        req,
        "cdk_imported",
        `导入 CDK 新增 ${summary.insertedCount} 个，重复 ${summary.duplicateCount} 个`,
      );
      res.json({
        success: true,
        message: `导入完成，新增 ${summary.insertedCount} 个，重复 ${summary.duplicateCount} 个`,
        ...summary,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post(
    "/api/admin/cdks/:cdk/ship",
    requireSecondaryAuth,
    async (req, res) => {
      try {
        await ensureStoreReady();
        const updated = await store.markCdkShipped(req.params.cdk);
        if (!updated) {
          return res.status(404).json({ success: false, message: "CDK 不存在" });
        }
        res.json({ success: true, message: "CDK 已标记出库" });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    },
  );

  app.delete("/api/admin/cdks/:cdk", requireSecondaryAuth, async (req, res) => {
    try {
      await ensureStoreReady();
      await store.deleteCdk(req.params.cdk);
      auditAdminAction(req, "cdk_deleted", `删除 CDK ${req.params.cdk}`);
      res.json({ success: true, message: "CDK 已删除" });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

module.exports = { registerAdminAssetRoutes };
