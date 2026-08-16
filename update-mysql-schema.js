require('./load-env');

const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_NAME = process.env.DB_NAME || 'gpt';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

async function hasTable(connection, tableName) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS count
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?`,
        [DB_NAME, tableName]
    );
    return Number(rows[0]?.count || 0) > 0;
}

async function hasColumn(connection, tableName, columnName) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [DB_NAME, tableName, columnName]
    );
    return Number(rows[0]?.count || 0) > 0;
}

async function hasIndex(connection, tableName, indexName) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS count
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?`,
        [DB_NAME, tableName, indexName]
    );
    return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(connection, tableName, columnName, definition) {
    if (await hasColumn(connection, tableName, columnName)) {
        console.log(`= 列已存在 ${tableName}.${columnName}`);
        return;
    }

    await connection.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
    console.log(`+ 已添加列 ${tableName}.${columnName}`);
}

async function ensureIndex(connection, tableName, indexName, definitionSql) {
    if (await hasIndex(connection, tableName, indexName)) {
        console.log(`= 索引已存在 ${tableName}.${indexName}`);
        return;
    }

    await connection.query(`ALTER TABLE \`${tableName}\` ADD ${definitionSql}`);
    console.log(`+ 已添加索引 ${tableName}.${indexName}`);
}

async function ensureProductAssetsTable(connection) {
    if (!(await hasTable(connection, 'product_assets'))) {
        await connection.query(`
            CREATE TABLE product_assets (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                imap_key VARCHAR(64) NULL,
                claimed_cdk VARCHAR(32) NULL,
                password VARCHAR(255) NULL,
                token TEXT NULL,
                file_path VARCHAR(512) NULL,
                status VARCHAR(32) NOT NULL DEFAULT '正常',
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                shipped TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_product_assets_email (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('+ 已创建表 product_assets');
        return;
    }

    console.log('= 表已存在 product_assets');
    await ensureColumn(connection, 'product_assets', 'imap_key', 'VARCHAR(64) NULL');
    await ensureColumn(connection, 'product_assets', 'claimed_cdk', 'VARCHAR(32) NULL');
    await ensureColumn(connection, 'product_assets', 'password', 'VARCHAR(255) NULL');
    await ensureColumn(connection, 'product_assets', 'token', 'TEXT NULL');
    await ensureColumn(connection, 'product_assets', 'file_path', 'VARCHAR(512) NULL');
    await ensureColumn(connection, 'product_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn(connection, 'product_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn(connection, 'product_assets', 'shipped', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(connection, 'product_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn(connection, 'product_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await ensureIndex(connection, 'product_assets', 'uniq_product_assets_email', 'UNIQUE KEY `uniq_product_assets_email` (`email`)');
}

async function ensureActivationAttemptLimitsTable(connection) {
    if (!(await hasTable(connection, 'activation_attempt_limits'))) {
        await connection.query(`
            CREATE TABLE activation_attempt_limits (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                scope_type VARCHAR(16) NOT NULL,
                scope_key VARCHAR(128) NOT NULL,
                fail_count INT NOT NULL DEFAULT 0,
                cooldown_until TIMESTAMP NULL DEFAULT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_activation_attempt_scope (scope_type, scope_key),
                KEY idx_activation_attempt_cooldown (cooldown_until)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('+ 已创建表 activation_attempt_limits');
        return;
    }

    console.log('= 表已存在 activation_attempt_limits');
    await ensureColumn(connection, 'activation_attempt_limits', 'scope_type', 'VARCHAR(16) NOT NULL');
    await ensureColumn(connection, 'activation_attempt_limits', 'scope_key', 'VARCHAR(128) NOT NULL');
    await ensureColumn(connection, 'activation_attempt_limits', 'fail_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn(connection, 'activation_attempt_limits', 'cooldown_until', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn(connection, 'activation_attempt_limits', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn(connection, 'activation_attempt_limits', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await ensureIndex(connection, 'activation_attempt_limits', 'uniq_activation_attempt_scope', 'UNIQUE KEY `uniq_activation_attempt_scope` (`scope_type`, `scope_key`)');
    await ensureIndex(connection, 'activation_attempt_limits', 'idx_activation_attempt_cooldown', 'KEY `idx_activation_attempt_cooldown` (`cooldown_until`)');
}

async function run() {
    const connection = await mysql.createConnection({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        charset: 'utf8mb4',
        multipleStatements: true
    });

    try {
        console.log(`连接成功: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);

        await ensureColumn(connection, 'cdk_codes', 'type', "VARCHAR(16) NOT NULL DEFAULT '自助'");
        await ensureColumn(connection, 'cdk_codes', 'fail_count', 'INT NOT NULL DEFAULT 0');
        await ensureColumn(connection, 'cdk_codes', 'cooldown_until', 'TIMESTAMP NULL DEFAULT NULL');

        await ensureProductAssetsTable(connection);
        await ensureActivationAttemptLimitsTable(connection);

        console.log('数据库结构更新完成');
    } finally {
        await connection.end();
    }
}

run().catch((error) => {
    console.error('数据库结构更新失败:', error.message || error);
    process.exit(1);
});
