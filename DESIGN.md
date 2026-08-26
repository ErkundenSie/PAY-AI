---
version: "alpha"
name: OAI 充值系统
description: 简约、可信、以任务效率为中心的中文 SaaS 管理后台。
colors:
  primary: "#2563EB"
  primary-hover: "#1D4ED8"
  primary-soft: "#EFF6FF"
  accent: "#0EA5E9"
  page: "#F4F7FB"
  surface: "#FFFFFF"
  surface-soft: "#F8FAFC"
  surface-hover: "#F1F5F9"
  border: "#E5E7EB"
  border-strong: "#CBD5E1"
  text: "#0F172A"
  text-secondary: "#334155"
  text-muted: "#64748B"
  text-disabled: "#94A3B8"
  success: "#10B981"
  success-soft: "#ECFDF5"
  warning: "#F59E0B"
  warning-soft: "#FFFBEB"
  error: "#EF4444"
  error-soft: "#FEF2F2"
  on-primary: "#FFFFFF"
typography:
  body:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.3px
  section-title:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.35
  label:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.35
  numeric:
    fontFamily: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    fontVariantNumeric: tabular-nums
  code:
    fontFamily: "SFMono-Regular", "Cascadia Code", Consolas, monospace
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 38px
    padding: 0 16px
    iconSize: 14px
    iconGap: 6px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 38px
    padding: 0 16px
    iconSize: 14px
    iconGap: 6px
  button-danger:
    backgroundColor: "{colors.error-soft}"
    textColor: "{colors.error}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: 38px
    padding: 0 16px
    iconSize: 14px
    iconGap: 6px
  button-icon:
    backgroundColor: "{colors.error-soft}"
    textColor: "{colors.error}"
    rounded: "{rounded.sm}"
    size: 32px
    iconSize: 14px
  action-group:
    display: flex
    gap: "{spacing.sm}"
    wrap: true
  action-group-compact:
    display: inline-flex
    gap: 6px
    wrap: true
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 10px
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: 24px
---

## Overview

这是一个中文任务管理型 SaaS 后台。界面应安静、清晰、可信，以快速读取状态和完成操作为优先；蓝色只用于主要操作、当前导航和可交互焦点。

## Colors

- 页面底色使用 `page`，卡片与表单保持纯白 `surface`。
- 每个区域只使用一个主要强调色；禁止同时堆叠多种高饱和色。
- 成功、警告、失败仅表达运行状态，不替代主要操作色。
- 文字使用 `text`、`text-secondary` 和 `text-muted` 三层层级；避免低对比度灰字。

## Typography

- 默认正文为 14px；辅助说明为 12–13px；仅页面标题使用 24px。
- 页面标题短而直接，面板标题使用名词短语。
- 按钮文案优先 2–4 个汉字；图标已表达动作时不重复冗长说明。
- 表格内代理、ID、URL 和日志使用等宽 `code` 样式，并允许长内容换行。

## Layout

- 左侧固定导航宽度为 260px；主内容区最大宽度为 1280px。
- 页面内容外边距为 36px × 48px，面板之间间距为 24px。
- 桌面端的同类统计卡优先单行排列；空间不足时再按 3 列、1 列降级。
- 表格操作按编辑、检测、删除等独立列或独立按钮分组，危险操作不得与主要操作挤在一起。
- 表单标签在上，输入框在下；配置说明紧邻对应字段，并在桌面端保持简短单行。

## Elevation & Depth

- 面板使用轻边框和低对比度阴影，不使用玻璃拟态或重阴影。
- 悬停仅提升边框或投影，不做明显位移或缩放动画。
- 弹窗遮罩使用深色半透明背景，内容面板保持白底和清晰边界。

## Shapes

- 输入框、按钮、导航项使用 8px 圆角；面板和统计卡使用 10px 圆角。
- 状态标签使用胶囊圆角；删除等图标按钮保持方形触控区域。
- 保持一致的 4px、8px、12px、16px、24px 间距节奏。

## Components

- **导航：** 当前项使用 `primary` 实底白字；普通项只在悬停时使用浅蓝背景。
- **主按钮：** 只用于当前区域的唯一关键提交动作；带操作图标时使用 2–4 字短标签。
- **次按钮：** 白底灰边，用于刷新、取消、筛选与辅助操作。
- **危险按钮：** 浅红底红字，删除使用独立图标按钮并提供 `title`。
- **状态标签：** 使用成功绿、警告黄、错误红、信息蓝的浅色背景；文案保持“活跃”“不可用”“运行中”等短状态。
- **统计卡：** 标签在上、数值在下；不在单张卡片内堆叠多余说明。
- **表格：** 表头使用浅色底；数值列适当居中；长字符串优先换行而非截断。

## Do's and Don'ts

- **Do：** 保持单页一个主任务；将复杂说明放在字段或标题下方；优先使用现有颜色与间距令牌。
- **Do：** 在移动端允许卡片和配置说明自然换行，保证触控区域至少 32px。
- **Don't：** 添加新的渐变、大面积深色背景、霓虹发光或装饰性图案。
- **Don't：** 创建超过 4 个汉字的常规按钮文案，除非文本本身是不可缩写的业务名称。
- **Don't：** 将编辑、检测、删除等不同风险级别的操作塞进同一个紧凑按钮组。
