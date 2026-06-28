-- Stripe 信用卡直付迁移脚本
-- 从旧版 schema 升级到 Stripe 卡池支付所需结构
-- 执行前请确认已选择正确数据库，例如: USE gpt;

-- 1. card_assets 扩展字段：持卡人姓名、使用追踪、冷却机制
ALTER TABLE card_assets
    ADD COLUMN IF NOT EXISTS card_holder VARCHAR(128) NOT NULL DEFAULT '' COMMENT '持卡人姓名' AFTER card_cvc,
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP NULL DEFAULT NULL COMMENT '最后使用时间' AFTER locked_by,
    ADD COLUMN IF NOT EXISTS daily_usage_count INT NOT NULL DEFAULT 0 COMMENT '24h 内使用次数' AFTER last_used_at,
    ADD COLUMN IF NOT EXISTS daily_usage_reset_at TIMESTAMP NULL DEFAULT NULL COMMENT '24h 计数重置时间' AFTER daily_usage_count,
    ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP NULL DEFAULT NULL COMMENT '冷却截止时间' AFTER daily_usage_reset_at;

-- 2. cdk_codes 扩展字段：套餐类型绑定
ALTER TABLE cdk_codes
    ADD COLUMN IF NOT EXISTS plan_type VARCHAR(16) NOT NULL DEFAULT 'plus' COMMENT 'plus/pro_5x/pro_20x' AFTER type;

-- 3. 新增免税地址模板表
CREATE TABLE IF NOT EXISTS tax_free_addresses (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    region VARCHAR(4) NOT NULL COMMENT '地区代码 PH/US/SG/MY',
    line1 VARCHAR(200) NOT NULL COMMENT '街道地址',
    city VARCHAR(100) NOT NULL COMMENT '城市',
    state VARCHAR(100) NOT NULL COMMENT '州/省',
    postal_code VARCHAR(20) NOT NULL COMMENT '邮政编码',
    country VARCHAR(2) NOT NULL COMMENT 'ISO 3166-1 alpha-2',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_tax_free_region (region, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. 新增账单记录表
CREATE TABLE IF NOT EXISTS billing_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    payment_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '支付时间',
    card_last4 VARCHAR(4) NOT NULL COMMENT '卡片后四位',
    amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '支付金额',
    currency VARCHAR(8) NOT NULL DEFAULT 'USD' COMMENT '币种',
    plan_type VARCHAR(16) NOT NULL DEFAULT 'plus' COMMENT 'plus/pro_5x/pro_20x',
    stripe_session_id VARCHAR(128) NULL COMMENT 'Stripe Session ID',
    cdk_code VARCHAR(32) NULL COMMENT '关联 CDK',
    email VARCHAR(255) NULL COMMENT '关联邮箱',
    status VARCHAR(16) NOT NULL DEFAULT 'success' COMMENT 'success/failed',
    error_code VARCHAR(64) NULL COMMENT 'Stripe 错误码',
    error_message VARCHAR(512) NULL COMMENT '失败原因',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_billing_time (payment_time),
    KEY idx_billing_card (card_last4),
    KEY idx_billing_plan (plan_type),
    KEY idx_billing_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. 新增支付相关配置项
INSERT INTO app_config (config_key, config_value)
VALUES
    ('payment_region', 'PH'),
    ('external_card_api_key', UUID()),
    ('last_used_address_id', '')
ON DUPLICATE KEY UPDATE config_value = app_config.config_value;
