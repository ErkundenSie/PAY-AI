'use strict';

const store = require('./mysql-store');

// ─── Validation ────────────────────────────────────────────────────────────────

/**
 * 校验地址字段
 * @param {object} data - { line1, city, state, postal_code, country }
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAddressFields(data) {
    const errors = [];

    // line1: 非空, ≤ 200 字符
    if (!data.line1 || typeof data.line1 !== 'string' || data.line1.trim().length === 0) {
        errors.push('line1 不能为空');
    } else if (data.line1.length > 200) {
        errors.push('line1 长度不能超过 200 字符');
    }

    // city: 非空, ≤ 100 字符
    if (!data.city || typeof data.city !== 'string' || data.city.trim().length === 0) {
        errors.push('city 不能为空');
    } else if (data.city.length > 100) {
        errors.push('city 长度不能超过 100 字符');
    }

    // state: 非空, ≤ 100 字符
    if (!data.state || typeof data.state !== 'string' || data.state.trim().length === 0) {
        errors.push('state 不能为空');
    } else if (data.state.length > 100) {
        errors.push('state 长度不能超过 100 字符');
    }

    // postal_code: 非空, ≤ 20 字符
    if (!data.postal_code || typeof data.postal_code !== 'string' || data.postal_code.trim().length === 0) {
        errors.push('postal_code 不能为空');
    } else if (data.postal_code.length > 20) {
        errors.push('postal_code 长度不能超过 20 字符');
    }

    // country: 恰好 2 位大写字母
    if (!data.country || typeof data.country !== 'string') {
        errors.push('country 不能为空');
    } else if (!/^[A-Z]{2}$/.test(data.country)) {
        errors.push('country 必须是恰好 2 位大写字母 (ISO 3166-1 alpha-2)');
    }

    return { valid: errors.length === 0, errors };
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * 获取指定地区的所有活跃地址模板
 * @param {string} region - 地区代码 (PH/US/SG/MY)
 * @returns {Promise<Array>}
 */
async function listAddresses(region) {
    const rows = await store.runQuery(
        `SELECT id, region, line1, city, state, postal_code, country, is_active,
                is_bound, bound_card_id, bound_at, created_at, updated_at
         FROM tax_free_addresses
         WHERE region = ? AND is_active = 1
         ORDER BY is_bound ASC, id DESC`,
        [String(region)]
    );
    return rows;
}

/**
 * 新增地址模板
 * @param {object} data - { region, line1, city, state, postal_code, country }
 * @returns {Promise<{ success: boolean, id?: number, error?: string, details?: string[] }>}
 */
async function createAddress(data) {
    const validation = validateAddressFields(data);
    if (!validation.valid) {
        return { success: false, error: '字段校验失败', details: validation.errors };
    }

    if (!data.region || typeof data.region !== 'string' || data.region.trim().length === 0) {
        return { success: false, error: '字段校验失败', details: ['region 不能为空'] };
    }

    const result = await store.runExecute(
        `INSERT INTO tax_free_addresses (region, line1, city, state, postal_code, country, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
            String(data.region).toUpperCase(),
            String(data.line1),
            String(data.city),
            String(data.state),
            String(data.postal_code),
            String(data.country)
        ]
    );

    return { success: true, id: Number(result.insertId) };
}

/**
 * 更新地址模板
 * @param {number|string} id - 模板 ID
 * @param {object} data - { line1?, city?, state?, postal_code?, country? }
 * @returns {Promise<{ success: boolean, error?: string, details?: string[] }>}
 */
async function updateAddress(id, data) {
    // 先查出现有数据，用于合并验证
    const rows = await store.runQuery(
        `SELECT * FROM tax_free_addresses WHERE id = ? AND is_active = 1 LIMIT 1`,
        [Number(id)]
    );

    if (rows.length === 0) {
        return { success: false, error: '地址模板不存在' };
    }

    const existing = rows[0];
    const merged = {
        line1: data.line1 !== undefined ? data.line1 : existing.line1,
        city: data.city !== undefined ? data.city : existing.city,
        state: data.state !== undefined ? data.state : existing.state,
        postal_code: data.postal_code !== undefined ? data.postal_code : existing.postal_code,
        country: data.country !== undefined ? data.country : existing.country
    };

    const validation = validateAddressFields(merged);
    if (!validation.valid) {
        return { success: false, error: '字段校验失败', details: validation.errors };
    }

    await store.runExecute(
        `UPDATE tax_free_addresses
         SET line1 = ?, city = ?, state = ?, postal_code = ?, country = ?
         WHERE id = ?`,
        [
            String(merged.line1),
            String(merged.city),
            String(merged.state),
            String(merged.postal_code),
            String(merged.country),
            Number(id)
        ]
    );

    return { success: true };
}

/**
 * 删除地址模板（软删除）
 * @param {number|string} id - 模板 ID
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function deleteAddress(id) {
    const result = await store.runExecute(
        `UPDATE tax_free_addresses SET is_active = 0 WHERE id = ? AND is_active = 1`,
        [Number(id)]
    );

    if (result.affectedRows === 0) {
        return { success: false, error: '地址模板不存在' };
    }

    return { success: true };
}

// ─── US Tax-Free Address Generator ───────────────────────────────────────────

const US_STATE_LABELS = {
    OR: 'Oregon',
    DE: 'Delaware',
    MT: 'Montana',
    NH: 'New Hampshire',
    AK: 'Alaska'
};

const US_STATE_CODES = Object.fromEntries(
    Object.entries(US_STATE_LABELS).map(([code, name]) => [name.toLowerCase(), code])
);

/**
 * 将州字段规范为结账下拉可用的完整州名（Oregon，而非 OR）
 */
function normalizeUsStateName(state) {
    const raw = String(state || '').trim();
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    if (US_STATE_LABELS[upper]) return US_STATE_LABELS[upper];
    const lower = raw.toLowerCase();
    if (US_STATE_CODES[lower]) return US_STATE_LABELS[US_STATE_CODES[lower]];
    return raw;
}

/** 美国无销售税州：Oregon, Delaware, Montana, New Hampshire, Alaska */
const US_TAX_FREE_LOCATIONS = [
    { city: 'Portland', state: 'Oregon', postalCodes: ['97201', '97205', '97209', '97214'] },
    { city: 'Salem', state: 'Oregon', postalCodes: ['97301', '97302', '97306'] },
    { city: 'Eugene', state: 'Oregon', postalCodes: ['97401', '97402', '97404'] },
    { city: 'Wilmington', state: 'Delaware', postalCodes: ['19801', '19802', '19805'] },
    { city: 'Dover', state: 'Delaware', postalCodes: ['19901', '19904'] },
    { city: 'Billings', state: 'Montana', postalCodes: ['59101', '59102', '59105'] },
    { city: 'Missoula', state: 'Montana', postalCodes: ['59801', '59802'] },
    { city: 'Manchester', state: 'New Hampshire', postalCodes: ['03101', '03102', '03104'] },
    { city: 'Nashua', state: 'New Hampshire', postalCodes: ['03060', '03062'] },
    { city: 'Anchorage', state: 'Alaska', postalCodes: ['99501', '99503', '99508'] },
    { city: 'Fairbanks', state: 'Alaska', postalCodes: ['99701', '99709'] }
];

const US_STREET_NAMES = [
    'Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Park Blvd',
    'Washington St', 'Lake View Rd', 'Highland Ave', 'Pine St', 'Elm St'
];

/**
 * 随机生成一条美国免税州地址（不落库）
 * @returns {{ line1: string, city: string, state: string, postal_code: string, country: string, generated: true }}
 */
function generateRandomUsTaxFreeAddress() {
    const loc = US_TAX_FREE_LOCATIONS[Math.floor(Math.random() * US_TAX_FREE_LOCATIONS.length)];
    const streetNum = Math.floor(Math.random() * 8900) + 100;
    const street = US_STREET_NAMES[Math.floor(Math.random() * US_STREET_NAMES.length)];
    const postalCodes = loc.postalCodes;
    const postal_code = postalCodes[Math.floor(Math.random() * postalCodes.length)];
    return {
        line1: `${streetNum} ${street}`,
        city: loc.city,
        state: loc.state,
        postal_code,
        country: 'US',
        generated: true
    };
}

/**
 * 批量生成美国免税地址并写入地址池
 * @param {number} count - 生成数量 (1-100)
 * @returns {Promise<{ success: boolean, count: number, ids: number[], error?: string }>}
 */
async function batchGenerateUsAddresses(count = 10) {
    const n = Math.min(Math.max(Number(count) || 10, 1), 100);
    const ids = [];
    for (let i = 0; i < n; i += 1) {
        const addr = generateRandomUsTaxFreeAddress();
        const result = await createAddress({
            region: 'US',
            line1: addr.line1,
            city: addr.city,
            state: addr.state,
            postal_code: addr.postal_code,
            country: addr.country
        });
        if (result.success && result.id) {
            ids.push(result.id);
        }
    }
    return { success: true, count: ids.length, ids };
}

/**
 * 支付结账时选取账单地址：优先 US 地址池，池空则即时随机生成
 * @param {number|null} lastUsedId
 * @returns {Promise<{ id: number, line1: string, city: string, state: string, postal_code: string, country: string, generated?: boolean }>}
 */
async function pickBillingAddressForCheckout(lastUsedId = null) {
    let picked;
    try {
        picked = await pickTaxFreeAddress('US', lastUsedId);
    } catch (_) {
        picked = { id: 0, ...generateRandomUsTaxFreeAddress() };
    }
    return {
        ...picked,
        state: normalizeUsStateName(picked.state)
    };
}

/**
 * 支付成功后标记地址已绑定到卡片
 */
async function markAddressBound(addressId, cardId) {
    const id = Number(addressId);
    const cid = Number(cardId);
    if (!id || !cid) return { success: false };
    const result = await store.runExecute(
        `UPDATE tax_free_addresses
         SET is_bound = 1, bound_card_id = ?, bound_at = CURRENT_TIMESTAMP
         WHERE id = ? AND is_active = 1`,
        [cid, id]
    );
    return { success: result.affectedRows > 0 };
}

/**
 * 软删除所有未绑定（从未支付成功使用过）的地址
 */
async function clearUnboundAddresses(region = 'US') {
    const result = await store.runExecute(
        `UPDATE tax_free_addresses
         SET is_active = 0
         WHERE region = ? AND is_active = 1 AND (is_bound = 0 OR is_bound IS NULL)`,
        [String(region).toUpperCase()]
    );
    return { success: true, count: Number(result.affectedRows || 0) };
}

// ─── Pick Address ──────────────────────────────────────────────────────────────

/**
 * 从当前地区的模板池中随机选取一个免税地址（不连续重复）
 * @param {string} region - 地区代码 (PH/US/SG/MY)
 * @param {number|null} lastUsedId - 上次使用的地址模板 ID（避免连续重复）
 * @returns {Promise<{ id: number, line1: string, city: string, state: string, postal_code: string, country: string }>}
 * @throws {Error} 当该地区无可用免税地址模板时抛出错误
 */
async function pickTaxFreeAddress(region, lastUsedId = null) {
    const addresses = await store.runQuery(
        `SELECT id, line1, city, state, postal_code, country
         FROM tax_free_addresses
         WHERE region = ? AND is_active = 1 AND COALESCE(is_bound, 0) = 0
         ORDER BY id ASC`,
        [String(region)]
    );

    if (addresses.length === 0) {
        throw new Error('该地区无可用免税地址模板');
    }

    // 如果只有 1 个地址，直接返回
    if (addresses.length === 1) {
        const picked = addresses[0];
        await store.setAppConfigValue('last_used_address_id', String(picked.id));
        return picked;
    }

    // 排除 lastUsedId，从剩余中随机选取
    const candidates = lastUsedId != null
        ? addresses.filter((a) => a.id !== Number(lastUsedId))
        : addresses;

    // 理论上 candidates 不应为空（pool > 1 且只排除了 1 个），但做安全兜底
    const pool = candidates.length > 0 ? candidates : addresses;

    const randomIndex = Math.floor(Math.random() * pool.length);
    const picked = pool[randomIndex];

    // 持久化 last_used_address_id
    await store.setAppConfigValue('last_used_address_id', String(picked.id));

    return picked;
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    validateAddressFields,
    listAddresses,
    createAddress,
    updateAddress,
    deleteAddress,
    pickTaxFreeAddress,
    generateRandomUsTaxFreeAddress,
    batchGenerateUsAddresses,
    pickBillingAddressForCheckout,
    normalizeUsStateName,
    markAddressBound,
    clearUnboundAddresses,
    US_STATE_LABELS
};
