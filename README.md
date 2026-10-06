# locale-fallback-state-web

本地化工作台：管理翻译的三种状态、可配置回退链、CLDR 复数校验、源改动复核流，以及自动保存的并发安全。

- TypeScript + React + Vite + Express + vitest
- **不依赖** i18next / formatjs / intl-messageformat / messageformat —— 消息解析、复数选择、回退全部自写（`src/shared/`）

## 运行

```bash
npm install
npm dev      # Vite(4173) + API(4174)，Vite 已配 /api 代理
npm test     # 一次跑完：消息解析 / CLDR 复数 / 回退 / HTTP 接口 / 自动保存协调
npm run build
```

## 语言与回退

语言：`en`（源）、`fr-FR`、`fr-CA`、`pt-BR`、`pt-PT`。默认链：

```
fr-CA → fr-FR → en      pt-PT → pt-BR → en      fr-FR / pt-BR → en
```

链在工作台里可改，**成环 / 自引用 / 未知语言一律拒绝**（422 并返回环上语言）；
保存成功后返回整份新状态，列表、完成度、解析接口立刻使用新链。

### 关键语义

- 每个条目三态：**没翻**（缺失，继续回退）/ **明确留空**（`""`，**终止回退**）/ **有内容**。
  这正是 pt-PT 的修复：可选提示留空后解析停在 pt-PT，不会冒出 pt-BR 的句子。
- 解析结果带 `source`（实际来自哪个语言）和 `via`（own / fallback / missing）。
- 完成度把回退算进去，并**单独数出靠回退才有文本的条数**（`fallbackCount`）。

## CLDR 复数（cardinal，手写）

`src/shared/plural.ts`，规则依据 CLDR 46（`supplemental/plurals.xml`），并用 Node 自带 ICU（`Intl.PluralRules`，ICU 78）逐个取值核对：

| 语言 | 必需类别 | 0 | 1 | 2+ | 整百万 |
|---|---|---|---|---|---|
| en | one, other | other | one | other | other |
| fr-FR / fr-CA | one, **many**, other | one | one | other | many（1 million / 2 millions） |
| pt-BR | one, **many**, other | one | one | other | many |
| pt-PT | one, **many**, other | **other** | one | other | many |

保存译文时：占位符集合必须与英文一致；plural 变量必须一致；该语言需要的类别必须给齐，否则 400 返回诊断。
消息格式是 ICU 子集：`{name}`、`{count, plural, one {...} =0 {...} other {...}}`、`offset:N`、`#`、`''` 转义。

## 源改动与复核

英文原文保存后 `sourceVersion` 前进，其他语言该条全部标记 **待复核**；
复核前解析照旧给出旧译文（仍带 `stale: true`）。保存新译文或点「标记复核通过」清除待复核。

## 自动保存的并发处理（`src/client/saveCoordinator.ts`）

- 停顿后连发保存、慢网乱序回来：每个编辑会话带单调 `seq`，迟到的旧 `seq` 服务端判 `superseded` 不入库，
  客户端也忽略过期响应 —— 服务端与编辑框留下的都是最后一次输入。
- 两人改同一条：保存带 `expectedVersion`，版本不符返回 **409 冲突**（不覆盖），UI 弹窗让译者选择覆盖（`force`）或采用服务端版本。
- 切换语言/消息：`bumpGeneration()` 作废旧流，在路上的保存结果不会出现在新语言的列表里。

## 主要接口

| 方法 & 路径 | 作用 |
|---|---|
| `GET /api/state` | 全部语言：链、统计、列表行 |
| `GET /api/resolve/:key?locale=` | 最终文本 + 实际来源语言 + 链 + 待复核 |
| `PUT /api/fallbacks/:locale` | 改回退链（成环 422） |
| `PUT /api/messages/:key/translations/:locale` | 保存译文（`value`/`expectedVersion`/`editor`/`seq`/`force`） |
| `PUT /api/messages/:key/source` | 改英文原文（其余语言转待复核） |
| `POST /api/messages/:key/review/:locale` | 标记复核通过 |
| `POST /api/preview` | 用同一解析器渲染，不落库 |

## 代码布局

```
src/shared/   message.ts（解析/校验/渲染） plural.ts（CLDR） fallback.ts（链/解析/统计） types.ts
src/server/   store.ts（内存数据+原子写） index.ts（Express 路由）
src/client/   saveCoordinator.ts（并发纯逻辑） api.ts components/* App.tsx
test/         message / fallback / api(supertest) / saveCoordinator
```
