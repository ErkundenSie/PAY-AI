'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const PASSPHRASE_SALT = 'kc-gpt-pay-data-encryption-v1';
const KEY_FILE = path.join(__dirname, 'data', '.data-encryption-key');

let cachedKey = null;
let cachedDecryptKeys = null;

function decodeKey(value) {
    try {
        const key = Buffer.from(String(value || '').trim(), 'base64url');
        return key.length === KEY_BYTES ? key : null;
    } catch (_) {
        return null;
    }
}

function deriveKeyFromPassphrase(passphrase) {
    return crypto.scryptSync(String(passphrase), PASSPHRASE_SALT, KEY_BYTES, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
    });
}

function keyEquals(left, right) {
    return Boolean(
        left &&
            right &&
            left.length === right.length &&
            crypto.timingSafeEqual(left, right),
    );
}

function parseConfiguredKey(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    return decodeKey(value) || deriveKeyFromPassphrase(value);
}

function loadFileKey() {
    try {
        return decodeKey(fs.readFileSync(KEY_FILE, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function resolveDataEncryptionKey() {
    if (cachedKey) return cachedKey;
    const configured = parseConfiguredKey(process.env.DATA_ENCRYPTION_KEY);
    if (configured) {
        cachedKey = configured;
        return cachedKey;
    }

    const existing = loadFileKey();
    if (existing) {
        cachedKey = existing;
        return cachedKey;
    }

    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    const generated = crypto.randomBytes(KEY_BYTES);
    try {
        fs.writeFileSync(KEY_FILE, `${generated.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        console.warn('[安全] 未设置 DATA_ENCRYPTION_KEY，已在 data 卷生成随机数据加密密钥；请妥善备份该文件或在 .env 设置密钥。');
        cachedKey = generated;
        return cachedKey;
    } catch (error) {
        if (error.code === 'EEXIST') {
            const raced = loadFileKey();
            if (raced) {
                cachedKey = raced;
                return cachedKey;
            }
        }
        throw error;
    }
}

function listDecryptionKeys() {
    if (cachedDecryptKeys) return cachedDecryptKeys;
    const keys = [];
    const push = (key) => {
        if (!key || keys.some((item) => keyEquals(item, key))) return;
        keys.push(key);
    };
    push(resolveDataEncryptionKey());
    push(loadFileKey());
    for (const part of String(process.env.DATA_ENCRYPTION_KEY_PREVIOUS || '').split(',')) {
        push(parseConfiguredKey(part));
    }
    cachedDecryptKeys = keys;
    return keys;
}

function decryptWithKey(stored, key) {
    const parts = stored.slice(PREFIX.length).split('.');
    if (parts.length !== 3) throw new Error('加密数据格式无效');
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function isEncryptedSecret(value) {
    return String(value || '').startsWith(PREFIX);
}

function encryptSecret(value) {
    if (value == null || value === '') return value == null ? null : '';
    const plainText = String(value);
    if (isEncryptedSecret(plainText)) return plainText;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', resolveDataEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value) {
    if (value == null || value === '') return value == null ? null : '';
    const stored = String(value);
    if (!isEncryptedSecret(stored)) return stored;
    const keys = listDecryptionKeys();
    let lastError = null;
    for (const key of keys) {
        try {
            return decryptWithKey(stored, key);
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(
        lastError
            ? '无法解密敏感数据：请确认 DATA_ENCRYPTION_KEY 或 data/.data-encryption-key 未丢失'
            : '加密数据格式无效',
    );
}

function reencryptSecret(value) {
    if (value == null || value === '') return value == null ? null : '';
    const stored = String(value);
    if (!isEncryptedSecret(stored)) return stored;
    const primary = resolveDataEncryptionKey();
    try {
        decryptWithKey(stored, primary);
        return stored;
    } catch (_) {
        /* try legacy keys below */
    }
    const plain = decryptSecret(stored);
    return encryptSecret(plain);
}

module.exports = { encryptSecret, decryptSecret, reencryptSecret, isEncryptedSecret };
