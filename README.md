# locale-fallback-state-web

本地化工作台：管理 5 个语言（en / fr-FR / fr-CA / pt-BR / pt-PT）的译文、三态状态、
可配置回退链、CLDR 复数规则、源文变更复核流程，以及乱序安全的自动保存。

消息解析与回退全部手写，**没有**使用 i18next / formatjs / intl-messageformat /
messageformat 等库（`Intl.PluralRules` 只在测试里作为对照，运行时的复数判定用的是
`src/shared/plural.ts` 里按 CLDR v46 手工转录的规则与谓词求值器）。

## 运行

```bash
npm install
npm test       # vitest 一次跑完：消息解析 / 回退 / 自动保存队列 / Express 接口
npm run dev    # Vite (4173) + Express (4174)，/api 代理到后端
npm run build  # tsc 类型检查 + 构建到 dist/client
npm start      # 仅生产模式 Express（同时托管 dist/client）
```

## 两个回归场景的种子数据

- `checkout.title`：fr-CA 缺译文 → 必须沿 fr-CA → fr-FR → en 拿到法语，而不是直接掉英文。
- `checkout.optionalTip`：pt-PT 显式留空、pt-BR 有译文 → pt-PT 必须渲染为空，
  不能漏出巴西葡语句子。显式空是终态，回退不会跳过它继续找。

## 模型要点

- 每个 (key, locale) 三态：`missing`（没翻过）/ `empty`（明确留空）/ `present`（有内容）。
- 回退图在工作台里逐语言可改；自环、重复、未知语言、任意长度的环都被拒绝（DFS 三色标记，
  400 响应附带成环路径）。
- 解析统一走 `src/shared/resolve.ts` 的 `resolveCell`：列表、完成度、`POST /api/resolve`
  是同一份纯函数结果，回退链一改全部立即反映。
- 完成度 = (自有文本 + 回退文本) / 总数，回退覆盖单独计数；显式空不算文本覆盖。
- 英文源文修改后，该 key 所有译文置 `needsReview`，复核前解析仍返回旧译文。

### CLDR 复数类别（v46，cardinal）

| 语言 | 必需类别 | 备注 |
| --- | --- | --- |
| en | one, other | one: `i = 1 and v = 0` |
| fr / fr-CA | one, many, other | one 覆盖 0 和 1（`i = 0,1`） |
| pt-BR | one, many, other | one 覆盖 0 和 1（`i = 0..1`） |
| pt-PT | one, many, other | one 只有整数 1；0 归 other |

保存译文时：占位符集合必须与英文源文一致；每个 plural 块必须给齐该语言需要的类别
（`many` 规则含 10⁶ 倍数与紧凑指数形式，操作数按 CLDR 精确十进制语义用 BigInt 求值）。

## 并发

- 译文保存带 `baseVersion` 乐观锁，旧版本后到返回 409 + 当前内容，前端弹冲突框，
  可选“用我的覆盖 / 用对方的”，绝不静默覆盖。
- 前端自动保存是单飞 + 合并队列（`src/shared/saveQueue.ts`）：打字停顿产生的多次保存，
  在途时新草稿只保留最新一份；迟到的旧响应按 seq 丢弃。切换语言会作废旧语言全部
  在途/排队请求，迟到响应不会出现在新语言列表里。

## 目录

```
src/shared/   locales · plural(CLDR) · message(ICU 子集解析/校验/格式化) ·
              fallback(图+环检测) · resolve(解析+完成度) · model · saveQueue
src/server/   index(Express 路由) · store(内存数据 + 乐观锁 + 种子)
src/client/   App · LocaleTabs · KeyList · Editor · PreviewPane ·
              FallbackEditor · useSaveQueue · api
test/         message · fallback · saveQueue · api（supertest）
```
