'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;

function decodeKey(value) {
    try {
        const key = Buffer.from(String(value || '').trim(), 'base64url');
        return key.length === KEY_BYTES ? key : null;
    } catch (_) {
        return null;
    }
}

function resolveDataEncryptionKey() {
    const configured = decodeKey(process.env.DATA_ENCRYPTION_KEY);
    if (configured) return configured;
    if (String(process.env.DATA_ENCRYPTION_KEY || '').trim()) {
        throw new Error('DATA_ENCRYPTION_KEY 必须是 32 字节的 base64url 密钥');
    }

    const keyFile = path.join(__dirname, 'data', '.data-encryption-key');
    try {
        const existing = decodeKey(fs.readFileSync(keyFile, 'utf8'));
        if (existing) return existing;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const generated = crypto.randomBytes(KEY_BYTES);
    try {
        fs.writeFileSync(keyFile, `${generated.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        console.warn('[安全] 未设置 DATA_ENCRYPTION_KEY，已在 data 卷生成随机数据加密密钥；请妥善备份该文件或在 .env 设置密钥。');
        return generated;
    } catch (error) {
        if (error.code === 'EEXIST') {
            const existing = decodeKey(fs.readFileSync(keyFile, 'utf8'));
            if (existing) return existing;
        }
        throw error;
    }
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
    const parts = stored.slice(PREFIX.length).split('.');
    if (parts.length !== 3) throw new Error('加密数据格式无效');
    try {
        const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', resolveDataEncryptionKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch (_) {
        throw new Error('无法解密敏感数据：请确认 DATA_ENCRYPTION_KEY 或 data/.data-encryption-key 未丢失');
    }
}

module.exports = { encryptSecret, decryptSecret, isEncryptedSecret };
