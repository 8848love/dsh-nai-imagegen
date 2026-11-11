# NovelAI 会员、Anlas 与 V5 免费额度查询复刻指南

核对日期：2026-10-07。本文独立说明两个查询功能，不依赖本项目的画师串、封面、个人资料或私有仓库。所有账号数据均为合成示例，凭据仅使用占位符。

## 1. 两个功能，共用一次官方请求

| 功能 | 读取内容 | 不可混淆的内容 |
| --- | --- | --- |
| 会员与 Anlas 余额 | 订阅状态、档位、到期时间、固定与购买的 Anlas | Anlas 不是 V5 免费图片张数 |
| V5 免费生成额度 | `usage` 的百分比、是否负额、恢复速度 | `priority`、`taskPriority`、`maxPriorityActions` 不是剩余额度 |

浏览器调用自己的受保护后端，后端携带调用者自己的 NovelAI Key 向官方查询，返回白名单字段。一次成功响应同时更新两个功能；无需为余额和额度分别请求官方接口。

```http
GET https://image.novelai.net/user/subscription
Authorization: Bearer pst-<YOUR_KEY>
Accept: application/json
```

- 这是官方图片服务的订阅 GET，不是生图接口。不需要 Cookie、聊天 API 配置、请求正文或模型参数。
- 不要把 `Bearer` 重复加到 Key 内；不要将 Key 放进 URL、查询参数、控制台输出或错误消息。
- 查询本身不提交生图任务。本次文档验证只读取了公开规范和公开官网脚本，没有查询任何真实账号。
- 不在前端写死共享 Key。独立服务至少绑定 loopback，并检查 Host/Origin；远程部署必须增加自己的认证、访问控制与 HTTPS，不能做公开的任意 URL 代理。

本项目的两个入口是**本地业务路由，不是 NovelAI 官方接口**：

| 本地请求 | 行为 |
| --- | --- |
| `POST /api/session/keys/:id/verify` | 后端按本地 ID 找到 Key，查订阅，同时刷新余额/额度并执行验证状态更新 |
| `GET /api/session/v5-quota` | 仅对启用且未隔离的 Key 查订阅，汇总额度；只读失败不改变生图资格 |

它们不要求浏览器再次提交明文 Key。不要把这两个路径拼到官方域名，也不要把会员验证的停用规则套用到普通额度刷新。

## 2. 合成响应与会员解析

以下 JSON 仅展示需要的字段，不代表官方响应只包含这些字段：

```json
{
  "active": true,
  "tier": 3,
  "expiresAt": 1800000000,
  "trainingStepsLeft": {
    "fixedTrainingStepsLeft": 1200,
    "purchasedTrainingSteps": 75
  },
  "usage": {
    "percent": 32.5,
    "isNegative": false,
    "timeUntilNextPercent": 3600
  }
}
```

| 字段 | 解析规则 |
| --- | --- |
| `active` | `false` 表示未生效；本项目保留 `data.active !== false` 的兼容规则，缺失不等于显式未生效 |
| `tier` | 0 无订阅，1 Tablet，2 Scroll，3 Opus；未知档位显示原数值或“未知”，不猜测 |
| `expiresAt` | 到期时间；本项目兼容数值 Unix 秒/毫秒，显示前小于 `1e12` 乘 1000 |
| `trainingStepsLeft.fixedTrainingStepsLeft` | 固定 Anlas 余额，有效数值钳制为非负 |
| `trainingStepsLeft.purchasedTrainingSteps` | 购买 Anlas 余额，有效数值钳制为非负 |
| `remainingAnlas` | 两项均已知才相加；任何一项缺失或异常则为 `null`，显示“未知” |

示例余额：`1200 + 75 = 1275 Anlas`。不能写成 `Number(value) || 0`：缺失、空字符串、布尔值和异常值不应冒充已知的零余额。

下面的独立示例仅兼容数值及非空数字字符串，拒绝布尔、数组和对象；当前官方规范使用整数。`subscriptionTier`、`expires_at` 是本项目兼容别名，不是当前官方规范保证的主字段。

V5 判定跟随 `active` 和数值 `tier >= 3`。不能仅凭到期时间重新猜测宽限期或账户权限；显示会员状态也不等于保证某次生图必然免费或有权限。

## 3. V5 额度与官网展示公式

免费额度来自同一订阅响应的 `usage`。规范中 `percent` 允许 `0-100+`，`isNegative` 是布尔值，`timeUntilNextPercent` 的单位是**秒**：表示从当前额度再恢复 1 个百分点所需的时间，不是时间戳，也不是恢复到下一个整数百分比的倒计时。

规范化必须先检查：

1. `active === false`：`unavailable / inactive`。
2. `tier` 不是有限数值或小于 3：`unavailable / non-opus`。
3. 没有 `usage` 对象：`unavailable / missing-usage`。
4. `percent` 不是有限数值，或 `isNegative` 不是布尔值：`unavailable / invalid-usage`。

上述状态都表示“不可用或未知”，不能伪造剩余 0 张。只有有效额度实际为零时才显示 0。

2026-10-07 官网公开前端模块 `86321` 的展示规则：

```text
剩余百分比 = isNegative ? 0 : max(0, percent)
约剩余图片 = round(17.3 × 剩余百分比)

若恢复秒数有效且 > 0：
每日恢复百分比 = round((86400 / 恢复秒数) × 10) / 10
每日约恢复图片 = round(17.3 × 每日恢复百分比)
```

恢复秒数有效且 `<= 0` 时每日恢复为 0；字段缺失或异常则为 `null`，显示“官方未返回恢复速度”。剩余百分比小于 100 且恢复速度大于 0 时显示每日恢复量，否则按本项目展示规则显示“额度恢复暂停”。

示例：`32.5% -> 约 562 张`；`3600 秒/1% -> 每日 24% -> 约 415 张`。负额时剩余为 0，不能通过绝对值显示正额度。

**17.3 是核对日官网的展示估算系数，不是每种参数下保证能生成的张数。** 始终标注“约”或 `estimated: true`；尺寸、Steps、参考功能和未来官方计费规则可能影响实际消耗。不把估算用作生图前精确扣费或自动停止的依据。

百分比正文允许超过 100；进度条只能显示 `min(100, max(0, percent))`，不要反向覆盖原始额度。图片估算必须是安全整数，异常过大数值按未知处理。

## 4. 可独立复用的 Node 查询模块

适用 PC 后端：Node.js `>=18.17`，CommonJS。生产部署使用仍受安全维护且兼容的 Node 版本；这里的最低版本只是本项目兼容下限。示例依赖固定为 `undici@6.21.3`，官方该版本要求 Node `>=18.17`。

在自己的独立目录安装：

```sh
npm init -y
npm install --save-exact undici@6.21.3
```

模块名为 `subscription-query.cjs`。加载模块不会联网、读取环境凭据、访问浏览器或写入磁盘；只有显式调用 `querySubscription` 才查询。调用方通过安全凭据入口提供 Key，不能把真实 Key 写进源码。

```js
// subscription-query.cjs
'use strict';

const { fetch } = require('undici');
const ENDPOINT = 'https://image.novelai.net/user/subscription';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

class QueryError extends Error {
  constructor(code, statusCode) {
    super(`NovelAI status query failed (${code}).`);
    this.name = 'QueryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function numeric(value) {
  if (finite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeQuota(subscription, now = Date.now()) {
  const base = {
    modelVersion: '5.0', model: 'nai-diffusion-5-full',
    source: 'subscription-usage', refreshedAt: now
  };
  const unavailable = reason => ({ ...base, status: 'unavailable', reason });
  if (subscription?.active === false) return unavailable('inactive');
  if (!finite(subscription?.tier) || subscription.tier < 3) return unavailable('non-opus');
  const usage = subscription.usage;
  if (!usage || typeof usage !== 'object') return unavailable('missing-usage');
  if (!finite(usage.percent) || typeof usage.isNegative !== 'boolean') {
    return unavailable('invalid-usage');
  }
  const remainingPercent = usage.isNegative ? 0 : Math.max(0, usage.percent);
  const seconds = usage.timeUntilNextPercent;
  const dailyRefillPercent = finite(seconds)
    ? seconds <= 0 ? 0 : Math.round(86400 / seconds * 10) / 10 : null;
  const remainingImages = Math.round(17.3 * remainingPercent);
  const dailyRefillImages = dailyRefillPercent === null
    ? null : Math.round(17.3 * dailyRefillPercent);
  if (!Number.isSafeInteger(remainingImages)
    || (dailyRefillImages !== null && !Number.isSafeInteger(dailyRefillImages))) {
    return unavailable('invalid-usage');
  }
  return {
    ...base, status: 'ok', remainingPercent, remainingImages, estimated: true,
    isNegative: usage.isNegative,
    timeUntilNextPercent: finite(seconds) ? seconds : null,
    dailyRefillPercent, dailyRefillImages
  };
}

function normalizeSubscription(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new QueryError('INVALID_RESPONSE', 502);
  }
  const training = data.trainingStepsLeft || {};
  const fixed = numeric(training.fixedTrainingStepsLeft);
  const purchased = numeric(training.purchasedTrainingSteps);
  const fixedAnlas = fixed === null ? null : Math.max(0, fixed);
  const purchasedAnlas = purchased === null ? null : Math.max(0, purchased);
  const sum = fixedAnlas === null || purchasedAnlas === null
    ? null : fixedAnlas + purchasedAnlas;
  const tier = data.tier ?? data.subscriptionTier;
  return {
    active: data.active !== false,
    tier: finite(tier) ? tier : null,
    expiresAt: numeric(data.expiresAt ?? data.expires_at),
    fixedAnlas, purchasedAnlas,
    remainingAnlas: sum !== null && Number.isFinite(sum) ? sum : null,
    v5Quota: normalizeQuota(data, now)
  };
}

function safeFailure(error) {
  if (error instanceof QueryError) return error;
  if (error?.name === 'AbortError') return new QueryError('CANCELLED', 499);
  const rawCode = error?.code || error?.cause?.code;
  const code = NETWORK_CODES.has(rawCode) ? rawCode : 'NETWORK_ERROR';
  const timeout = error?.name === 'TimeoutError' || /TIMEOUT|TIMEDOUT/.test(code);
  return new QueryError(timeout ? 'TIMEOUT' : code, timeout ? 504 : 502);
}

function withinBudget(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

async function querySubscription(token, { getDispatcher = async () => undefined } = {}) {
  if (typeof token !== 'string' || token.length > 500
    || !/^pst-[^\s\x00-\x1f\x7f]+$/.test(token)) {
    throw new QueryError('INVALID_KEY_INPUT', 400);
  }
  const deadline = Date.now() + 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new QueryError('TIMEOUT', 504)), 30000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dispatcher = await withinBudget(
          () => getDispatcher(controller.signal), controller.signal
        );
        const response = await withinBudget(() => fetch(ENDPOINT, {
          method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          dispatcher, signal: controller.signal
        }), controller.signal);
        if (!response.ok) {
          if (response.body) {
            await withinBudget(() => response.body.cancel(), controller.signal);
          }
          throw new QueryError(`HTTP_${response.status}`, response.status);
        }
        let data;
        try {
          data = await withinBudget(() => response.json(), controller.signal);
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new QueryError('INVALID_RESPONSE', 502);
        }
        return normalizeSubscription(data);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const safe = safeFailure(error);
        const retryable = safe.statusCode >= 500 && safe.code !== 'INVALID_RESPONSE';
        if (attempt || !retryable || deadline - Date.now() < 500) throw safe;
        await withinBudget(
          () => new Promise(resolve => setTimeout(resolve, 250)), controller.signal
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { normalizeQuota, normalizeSubscription, querySubscription };
```

该独立示例对解析、代理发现和读取正文也限制在总 30 秒内；最多两次 GET 尝试，重试间隔 250ms。不返回原始响应，不将原始错误消息或 `cause` 带到 UI，拒绝重定向。真实应用还应限制响应体大小、刷新频率、并发量，并关闭包含认证头的网络日志。

调用示例使用**不能认证的占位 Key**，默认不会成功查询；由自己的安全入口传入真实凭据，不放进命令行参数或提交文件：

```js
const { querySubscription } = require('./subscription-query.cjs');
const { ProxyAgent } = require('undici');

async function refreshForCaller(tokenFromSecureInput, proxyUrlFromSafeSettings) {
  const dispatcher = proxyUrlFromSafeSettings
    ? new ProxyAgent(proxyUrlFromSafeSettings) : undefined;
  try {
    return await querySubscription(tokenFromSecureInput, {
      getDispatcher: async () => dispatcher
    });
  } finally {
    await dispatcher?.close();
  }
}

// Not a real credential; do not use historical chat credentials.
// await refreshForCaller('pst-<YOUR_KEY>', undefined);
```

上例显式创建的代理归调用方关闭；项目中缓存共享的代理只能在切换或退出时优雅关闭，不能每个 Key 查完就关闭公共连接池。

## 5. 本地响应、UI 与多账号汇总

会员验证成功的响应结构：

```json
{
  "ok": true,
  "key": {
    "id": "demo-key-a",
    "label": "示例账号 A",
    "enabled": true,
    "status": "healthy",
    "subscription": {
      "active": true,
      "tier": 3,
      "expiresAt": 1800000000,
      "fixedAnlas": 1200,
      "purchasedAnlas": 75,
      "remainingAnlas": 1275,
      "v5Quota": {
        "status": "ok",
        "modelVersion": "5.0",
        "model": "nai-diffusion-5-full",
        "source": "subscription-usage",
        "refreshedAt": 1800000000000,
        "remainingPercent": 32.5,
        "remainingImages": 562,
        "estimated": true,
        "isNegative": false,
        "timeUntilNextPercent": 3600,
        "dailyRefillPercent": 24,
        "dailyRefillImages": 415
      }
    },
    "v5Quota": {
      "status": "ok",
      "source": "subscription-usage",
      "remainingPercent": 32.5,
      "remainingImages": 562,
      "estimated": true
    }
  }
}
```

这是最小展示示例；实际 `key.v5Quota` 与 `subscription.v5Quota` 使用同一个完整规范化对象。本项目还返回本地 fingerprint、任务状态等白名单字段，但绝不返回 `token`、认证头或上游支付信息。新实现建议使用本地随机 ID/中性标签，不用 Key 片段命名。

`GET /api/session/v5-quota` 返回 `{ ok: true, ...summary, keys: [...] }`，`keys` 必须同时保留安全的 `subscription`，否则刷新额度后会丢失 Anlas 显示。汇总规则：

- `keyCount`：全部本地 Key 数；`queriedKeyCount`：有查询结果且不是 `unqueried` 的数量。
- `successfulKeyCount`：`ok` 或 `unavailable`；成功拿到订阅但无 Opus 额度也算查询成功。
- `failedKeyCount`：`error`；没有查询过的 Key 不算失败。
- `knownRemainingKeyCount`：`status === 'ok'`、`source === 'subscription-usage'` 且图片数为有限值的数量。
- `remainingImages`：只加上述已知图片数；没有任何已知值为 `null`。已知零仍是 0，不是未知。
- `refreshedAt`：已有结果中最新时间；展示更新时间，不能把缓存当实时状态。
- 不加总不同账号的百分比。多 Key 不一定是多账户；同一账户的凭据须归为一组后再汇总，否则可能重复计数。本项目按 Key 汇总不能证明账户独立。

UI 使用 `textContent` 或正确转义，不把 Key 名、状态错误或接口字段插入未经转义的 `innerHTML`。使用原生进度条避免动态 HTML 内联样式触发 CSP：

```js
const progress = document.createElement('progress');
progress.max = 100;
progress.value = Math.min(100, Math.max(0, quota.remainingPercent));
progress.setAttribute('aria-label', 'V5 免费额度');
```

颜色样式写外部 CSS，不放宽 CSP。读取失败时可以保留上次余额，但要显示本次失败/旧数据标记；别悄悄把“上次成功”说成“刚查询成功”。

## 6. 验证与只读查询的不同错误处理

| 结果 | 验证 Key | 普通额度查询 |
| --- | --- | --- |
| 成功 | 更新两个功能；启用并标 healthy，清空错误、失败计数和冷却 | 更新两个功能，不改 enabled/status |
| HTTP 401 | 标 invalid 并停用，等待重新验证 | 标额度查询失败；不删除、不停用、不改变生图资格 |
| HTTP 403 | 标 forbidden 并停用；拒绝访问不代表只有一种原因 | 同上，不能据一次只读失败隔离 Key |
| HTTP 429 | 不自动重试，显示限流，保留 Key | 不自动重试，保留资格和上次会员余额 |
| 网络/超时/HTTP 5xx | 总预算内最多重试一次；失败保留 Key 并记录安全错误 | 同样重试；最终仅将额度标 error |
| 缺 usage/非 Opus | 订阅查询成功，额度 unavailable | 查询成功，解释原因，不伪造 0 |
| 非 JSON/异常响应 | 安全解析失败；独立示例不自动重试 | 不暴露响应正文、不误报已知额度 |

上述 GET 重试策略**不能直接复用于生图 POST**：重放可能多消耗额度或重复生成。资格更新与任务重试属于调度器，不是订阅查询模块的职责。

成功停用、启用、验证或删除后，同步浏览器中该 Key 的 enabled/删除状态，避免刷新复活已删除或停用的 Key。失败不能先删除本地记录；invalid/forbidden 不能直接启用，须重新验证。每行操作过程中禁用三个按钮，完成后更新列表和统计。

项目状态操作路由：`PATCH /api/session/keys/:id` 的 `{ "enabled": false }`、`POST /api/session/keys/:id/verify`、`DELETE /api/session/keys/:id`。路径中的本地 ID 要 `encodeURIComponent`；服务端需验证 ID 存在。

## 7. VPN、代理与 Android 边界

- 浏览器能通过 VPN 访问官网，不等于 Node 请求也走代理。代理未覆盖后端时，正确接口仍可能出现 DNS、建连或 TLS 超时；HTTP 401/403 则是已经收到上游响应，不能混称线路未连接。
- 保持官方 HTTPS 地址，不改成未经核实的第三方转发地址。不要关闭证书校验来“修复”TLS。
- 独立示例通过 `getDispatcher` 显式接入 Undici `ProxyAgent`，不自动读取环境变量或系统代理。代理由调用者安全配置，不在文档硬编码私人端口。
- 本项目的 `nai-proxy.js` 则优先用已配置的 `HTTPS_PROXY/HTTP_PROXY` dispatcher；否则 Windows 读取启用的系统 `ProxyEnable/ProxyServer`，只支持可识别的 HTTP/HTTPS 代理，缓存 5 秒、并发共用发现。不执行 PAC，不把 SOCKS-only 当 HTTP 代理。已选择的代理失败不静默绕过直连。
- Android 不读取 Windows 注册表，也不注入 PC 的 `127.0.0.1` 代理地址；Android 的 localhost 是手机自己。VPN 必须覆盖 APK 的应用网络，连接性与实体手机环境需单独验证。
- 当前 Android 内置 Node 12 使用 `mobile-undici.js` 与构建兼容层，不能直接替换成本文 Node 18 模块；复用请求/解析逻辑时通过既有构建层处理。不要手改生成的移动后端，也不要新建第二套业务源码。

## 8. 最小验收清单

| 场景 | 应得到的结果 |
| --- | --- |
| 合成 Opus：32.5%，3600 秒/1% | 约 562 张，每日 24%/约 415 张；示例余额 1275 Anlas |
| 有效额度 0 | 已知零，非“未知” |
| `isNegative: true` | 剩余零，不将负额取绝对值 |
| `percent: 125` | 正文 125%，约 2163 张，progress 不超过 100 |
| 恢复秒数缺失/异常 | 恢复未知，不伪造暂停 |
| 恢复秒数为 0 | 每日恢复 0，显示暂停 |
| 非 Opus、inactive、无 usage、异常字段 | unavailable + reason，没有假剩余张数 |
| 余额一项缺失/空/异常 | 总余额未知；已知零余额不丢失 |
| HTTP 401/403/429 | 不重试；验证与额度刷新采用各自状态规则 |
| 临时网络/5xx | 最多两次 GET、250ms 间隔、30 秒总预算 |
| 错误正文/错误消息含合成敏感值 | 返回与日志白名单中没有该值 |
| 多账号中有失败、未知和未查询 | 分别统计，只合计已知约图片数 |
| 刷新额度 | Anlas 仍保留，不改变生图 Key 资格 |

本项目的 `tests/subscription-replication-doc.test.js` 直接提取本文件的查询模块，在 VM 中注入模拟 fetch/时钟执行；与 `public/v5-quota.js` 对照，禁止任何真实联网与凭据读取。它验证示例代码而不是只检查文字包含关键词；账号操作的既有回归见 `tests/v5-quota.test.js`。

## 9. 来源与项目定位

官方公开来源，核对日期均为 2026-10-07：

- Swagger 入口：`https://image.novelai.net/docs/index.html`。
- Swagger JSON：`https://image.novelai.net/docs/doc.json`，`GET /user/subscription`；`definitions/user.SubscriptionResponse`、`user.TrainingStepsLeft`、`usagelimit.Status`。该规范目前是 Swagger 2 的 `definitions`，不是 OpenAPI 3 的 `components.schemas`。
- 官网图片页：`https://novelai.net/image`。核对时额度公式位于 `/_next/static/chunks/1950-c8d9471bcdeab8b6.js` 的模块 `86321`，会员余额求和位于 `/_next/static/chunks/pages/_app-a70b21aef518ab63.js`。静态文件 hash/模块号会变化，应从当时官网页面重新定位；不要将该脚本作为可执行依赖。
- Undici 固定版本要求：`https://raw.githubusercontent.com/nodejs/undici/v6.21.3/package.json`；代理 API：`https://github.com/nodejs/undici/blob/v6.21.3/docs/docs/api/ProxyAgent.md`。

官网展示规则和响应结构不是本项目可以保证不变的 API 契约；升级时重新核对规范和显示规则，优先标未知，不能靠猜测字段维持假余额。

项目定位：`server.js` 的 `novelAiJsonGet`、`validateNovelAiToken`、`KeyPool.refreshV5Quota`；`public/v5-quota.js` 的 `normalize/summarize/render`；`public/key-pool-actions.js`；`nai-proxy.js`。主页、提示词助手、实验室复用同一套查询与展示逻辑。
