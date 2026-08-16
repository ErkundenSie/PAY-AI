'use strict';

// Load .env when the application is started directly with Node. Docker Compose
// injects its own values; explicit process environment values always win.
const fs = require('fs');
const path = require('path');

function stripUnquotedComment(value) {
    let quote = null;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
            if (char === quote && value[index - 1] !== '\\') quote = null;
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd();
    }
    return value;
}

function parseEnvValue(rawValue) {
    const value = stripUnquotedComment(String(rawValue || '').trim());
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        const unquoted = value.slice(1, -1);
        return value.startsWith('"')
            ? unquoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"')
            : unquoted;
    }
    return value;
}

function loadEnvFile(filePath = path.join(process.cwd(), '.env'), env = process.env) {
    if (!fs.existsSync(filePath)) return false;

    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;

        const [, key, rawValue] = match;
        if (env[key] === undefined) env[key] = parseEnvValue(rawValue);
    }
    return true;
}

loadEnvFile();

module.exports = { loadEnvFile, parseEnvValue };
