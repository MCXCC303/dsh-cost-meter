# 客户端 TS 模块化迁移手册(自用分支)

> 本文件是迁移期的施工图,**迁移完成后删除**。目标是让多个执行者按同一套约定
> 并行拆分,不产生冲突。

## 背景与目标

- 原客户端是 4 个"按文件名排序拼接"的片段(`src/client/01-*.js` ~ `03-*.js`),
  因为上游 DSH STORE 对每个文件限 256 KiB 且浏览器端是单个 factory 闭包。
- 本仓库是自用分支,**不再受该限制**,改为真 ES 模块 + 按需分块。
- 迁移中已完成的基座:
  - `src/client/styles.ts` —— 原片段 01 的 CSS 数组(`export const css: string`)
  - `src/client/i18n-messages.ts` —— 双语词典(`export const MESSAGES`)
  - `src/client/t.ts` —— 语言解析(`resolveLocale` / `supportedLocale` / `detectBrowserLocale`)、
    `makeT`、`PERIOD_KEYS`、`USAGE_POSITION_SWITCHABLE`、`createStyleTag`

## 硬性约定

1. **只写 TypeScript**,`strict` 已开(`noImplicitAny` 暂关,见 tsconfig 的 TODO)。
   边界处(DSH ctx、RPC payload、第三方模块)允许 `any`,但必须紧跟
   `// TODO(types): <怎么收紧>` 注释。
2. **导入必须带 `.js` 后缀**(NodeNext 解析),例如 `import { makeT } from './t.js'`。
   类型导入用 `import type`(`verbatimModuleSyntax` 已开)。
3. **不要改动 `src/host/**`**(宿主侧由另一条线负责)。
4. **不要改 `src/client/index.ts` 的注册契约**:浏览器半必须是 classic script,
   入口固定为 `window.__ModuleLoader__.load({ id, factory })`,`factory(require)`
   里 `require('react')` / `require('@deepseek-ai/dsh-client-ui-primitives')` 是平台种子,
   其余依赖一律走本地模块。
5. React 钩子从 `React` 命名空间取(原代码即如此):`const { useState, useEffect } = React`。
6. 文本、注释一律中文(与仓库既有风格一致);导出名保持原函数名,便于对照。

## 目标模块图

```
src/client/
  index.ts            启动包入口:注册侧栏/徽标/峰谷条,按需拉起其它分块
  settings.ts         设置分节(按需分块 client.settings.js)
  statistics.ts       计费统计(按需分块 client.statistics.js)
  openrouter.ts       价格目录(按需分块 client.openrouter.js)
  peak.ts             动态峰谷样式(按需分块 client.peak.js)

  t.ts                语言/翻译/样式注入(已完成)
  styles.ts           CSS 文本(已完成)
  i18n-messages.ts    词典(已完成)

  wire.ts             服务端数据校验器 + codec + CONTRIBUTION(纯函数)
  pricing.ts          客户端计价:价格表匹配、峰谷分档、costOfBuckets、usageCost
  format.ts           金额/token/时间格式化:formatMoneyValue、formatTokens、fixedAmount…
  peak-core.ts        峰谷相位与分段计算(peakPhaseAt/peakView/phaseLabelKeys/countdownText)
  store.ts            makeStore(轻量快照 store)
  ui-badge.ts         会话徽标:TurnCost / SessionCost / DockLine / useSessionUsage…
  ui-balance.ts       余额:BalanceBar / BalanceRowContent / BalanceBox / segmentsFor*
  ui-custom-balance.ts 自定义 Provider 余额卡片
  ui-corner.ts        CornerChips(右下角角标)
  ui-peak.ts          峰谷条:PeakStrip/PeakStripClassic/PeakRail*/PeakAlert/PeakLazy
  ui-quota.ts         Go 额度 / MiniMax / CodingPlan / 网关 / Codex / QuotaStrip
  ui-sidebar.ts       SidebarFooter / BudgetBoxContent / 三个引导组件
  guides.ts           引导提示的本地存储读写(simple-guide / balance-click-hint)
```

> `ui-*.ts` 之间允许互相 import 组件;`wire/pricing/format/peak-core/store` 是纯逻辑,
> **不得** import React。

## 拆分映射(原片段 02 = `src/client/02-validators-helpers-sidebar.js`,3238 行)

| 原行号 | 归属模块 | 备注 |
|---|---|---|
| 4–605 | `wire.ts` | fail/needObject…/parseState/各 codec/CONTRIBUTION |
| 592–760 | `pricing.ts` 起步 | priceEntryFor、normalizeClientPrice、tierFor、costOfBuckets |
| 762–1000 | `pricing.ts` | matchModelIdLocal、resolveClientPrice*、usageCost |
| 1001–1200 | `pricing.ts` + `format.ts` | displayCostOf / format* / timezoneMismatchOf |
| 1197–1226 | `store.ts` | makeStore |
| 1226–1336 | `ui-credential.ts` | CredentialField / SecretMigrationNotice / WalletIcon |
| 1337–1510 | `ui-badge.ts` | useProjectionRefresh / useSessionUsage / TurnCost / SessionCost / DockLine |
| 1511–1881 | `ui-balance.ts` + `ui-custom-balance.ts` | 余额条、自定义余额 |
| 1882–1958 | `ui-corner.ts` | CornerChips |
| 1959–2270 | `peak-core.ts` + `ui-peak.ts` | 相位计算 → peak-core;组件 → ui-peak |
| 2270–2495 | `ui-quota.ts` | budgetBoxBody/goBoxBody/GoQuotaBox/MiniMax* |
| 2495–2668 | `ui-quota.ts` | Codex / CodingPlan |
| 2668–2960 | `ui-quota.ts` + `guides.ts` | 网关额度、QuotaStrip |
| 2960–3146 | `guides.ts` + `ui-sidebar.ts` | 引导组件、BudgetBoxContent |
| 3146–3238 | `ui-sidebar.ts` | SidebarFooter(注册入口在 index.ts) |

原片段 03(`03-model-sidebar.js` 56 行 + `03-settings-panels-main.js` 3027 行):
- `settings.ts` ← 后者(设置分节全部组件 + `apply` 的 settings 注册部分)
- `index.ts` ← 前者(侧栏模型花费卡片)+ `activate()` 顶层注册逻辑

## 验收

1. `npx tsc --noEmit` 中 `src/client/**` 无错误。
2. `node scripts/build.mjs --client` 产出 5 个文件:`lib/client.js`、
   `client.peak.js`、`client.settings.js`、`client.statistics.js`、`client.openrouter.js`。
3. `node test/peak-dynamic-style.mjs` 通过(峰谷动态样式的关键回归)。
4. 迁移完成的模块不得再引用 `01-*.js` / `02-*.js` / `03-*.js` 片段;确认无引用后删除这些片段。
