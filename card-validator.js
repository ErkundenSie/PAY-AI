'use strict';

/**
 * 卡片格式验证模块
 * 验证信用卡号、有效期、CVC 的格式合法性
 */

/**
 * 验证卡号格式：13-19 位纯数字
 * @param {string} cardNumber
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCardNumber(cardNumber) {
    if (cardNumber == null || typeof cardNumber !== 'string') {
        return { valid: false, error: '卡号不能为空' };
    }

    const trimmed = cardNumber.trim();

    if (trimmed.length === 0) {
        return { valid: false, error: '卡号不能为空' };
    }

    if (!/^\d+$/.test(trimmed)) {
        return { valid: false, error: '卡号必须为纯数字' };
    }

    if (trimmed.length < 13 || trimmed.length > 19) {
        return { valid: false, error: '卡号长度必须为 13-19 位' };
    }

    return { valid: true };
}

/**
 * 验证有效期格式：MM/YY，MM 范围 01-12
 * @param {string} expiry
 * @returns {{ valid: boolean, error?: string }}
 */
function validateExpiry(expiry) {
    if (expiry == null || typeof expiry !== 'string') {
        return { valid: false, error: '有效期不能为空' };
    }

    const trimmed = expiry.trim();

    if (trimmed.length === 0) {
        return { valid: false, error: '有效期不能为空' };
    }

    if (!/^\d{2}\/\d{2}$/.test(trimmed)) {
        return { valid: false, error: '有效期格式必须为 MM/YY' };
    }

    const month = parseInt(trimmed.substring(0, 2), 10);

    if (month < 1 || month > 12) {
        return { valid: false, error: '有效期月份必须在 01-12 之间' };
    }

    return { valid: true };
}

/**
 * 验证 CVC 格式：3-4 位纯数字
 * @param {string} cvc
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCVC(cvc) {
    if (cvc == null || typeof cvc !== 'string') {
        return { valid: false, error: 'CVC 不能为空' };
    }

    const trimmed = cvc.trim();

    if (trimmed.length === 0) {
        return { valid: false, error: 'CVC 不能为空' };
    }

    if (!/^\d{3,4}$/.test(trimmed)) {
        return { valid: false, error: 'CVC 必须为 3-4 位数字' };
    }

    return { valid: true };
}

/**
 * 验证完整卡片对象
 * @param {{ card_number?: string, card_expiry?: string, card_cvc?: string, card_holder?: string }} cardObj
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCard(cardObj) {
    const errors = [];

    if (!cardObj || typeof cardObj !== 'object') {
        return { valid: false, errors: ['卡片数据不能为空'] };
    }

    const numberResult = validateCardNumber(cardObj.card_number);
    if (!numberResult.valid) {
        errors.push(numberResult.error);
    }

    const expiryResult = validateExpiry(cardObj.card_expiry);
    if (!expiryResult.valid) {
        errors.push(expiryResult.error);
    }

    const cvcResult = validateCVC(cardObj.card_cvc);
    if (!cvcResult.valid) {
        errors.push(cvcResult.error);
    }

    // card_holder is optional — no validation required

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    validateCardNumber,
    validateExpiry,
    validateCVC,
    validateCard
};
