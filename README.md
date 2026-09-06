# OpenAI Codex API Status Worker

一个运行在 Cloudflare Workers 上的 OpenAI `Codex API` 状态监控器。Cron 先读取组件状态，仅在异常或恢复时查询事件详情，使用 Workers KV 保存组件基线和当前事件的更新时间，通过 Telegram 和/或企业微信群机器人通知变化。Cron 周期由 Cloudflare 面板配置。

## 功能

- 精确匹配 `Codex API` 组件，不合并 Responses、Codex Web、Desktop、CLI 等状态。
- 通知组件恶化、恢复，以及当前关联事件更新时间变化后的最新进展。
- 正常时只查询组件；不保存历史事件或正文指纹，事件关闭或消失后移除记录，组件恢复后清空事件记录。
- 首次运行只建立基线，正常无变化时不写 KV。
- OpenAI incidents feed 失败时，仍可处理组件状态变化。
- 支持 Telegram Bot `/check` 只读实时查询，仅回复查询聊天，不广播通知、不推进 KV。
- 提供带 Bearer Token 的只读实时查询和状态诊断接口。
- 使用单一 `STATUS_KV` binding 和 `CHECK_TOKEN` 管理 Token。
- 可选调用第三方 OpenAI-compatible API，将 incident 标题和正文翻译为简体中文，同时保留官方英文原文。

## 环境变量

以下普通变量可在 Cloudflare Dashboard 中配置；未配置时使用代码默认值：

| 变量                    | 默认值          | 用途                            |
| ----------------------- | --------------- | ------------------------------- |
| `TARGET_COMPONENT_NAME` | `Codex API`     | 精确监控的组件名                |
| `INCIDENT_MATCH_MODE`   | `balanced`      | `strict`、`balanced` 或 `broad` |
| `DISPLAY_TIME_ZONE`     | `Asia/Shanghai` | 通知显示时区                    |
| `NOTIFY_ON_BOOTSTRAP`   | `false`         | 首次运行是否通知                |

Secrets：

| 变量                      | 必需性       | 用途                                    |
| ------------------------- | ------------ | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | 可选         | 与 Chat ID 同时配置才启用 Telegram 通知 |
| `TELEGRAM_CHAT_ID`        | 可选         | 接收通知和执行 `/check` 的 chat ID      |
| `TELEGRAM_WEBHOOK_SECRET` | 可选         | 额外配置后才启用 `/check`               |
| `WECOM_WEBHOOK_URL`       | 企业微信可选 | 企业微信群机器人 webhook                |
| `CHECK_TOKEN`             | 管理接口必需 | `/admin/*` Bearer Token                 |
| `TRANSLATION_API_KEY`     | 翻译可选     | 第三方翻译 API key                      |

翻译配置项（API key 和模型必填，Base URL 与协议可用默认值）：

| 变量                       | 示例                        | 用途                                         |
| -------------------------- | --------------------------- | -------------------------------------------- |
| `TRANSLATION_API_BASE_URL` | `https://api.deepseek.com`  | 第三方 API base URL                          |
| `TRANSLATION_MODEL`        | 由第三方提供商给出的模型 ID | 翻译模型                                     |
| `TRANSLATION_API_STYLE`    | `chat-completions`          | 自动拼接 `/chat/completions` 或 `/responses` |

API base URL 默认使用 `https://api.deepseek.com`，协议默认使用 `chat-completions`，客户端会自动拼接接口路径；两者均可覆盖。只有 API key 和模型 ID 同时存在时才启用翻译。接口必须使用 HTTPS，并使用 Bearer Token 鉴权。翻译失败会记录 warning，并使用官方英文原文继续通知。

Telegram Token 和 Chat ID 不完整时跳过 Telegram 通知，不影响企业微信。所有渠道均未配置时，Cron 仍更新基线，但不通知、不调用翻译；以后启用通知时不会补发禁用期间的历史变化。不要提交真实 Secret。

## 本地开发

```bash
npm ci
npm run cf-typegen
npm run check
npm run dev
```

本地变量参考 `.dev.vars.example`。Wrangler 默认使用 `.wrangler/state` 中的本地 KV。

```bash
curl http://localhost:8787/healthz
curl http://localhost:8787/__scheduled
curl -X POST -H "Authorization: Bearer $CHECK_TOKEN" \
  "http://localhost:8787/admin/check"
```

## Telegram `/check`

需要使用 `/check` 时，配置完整的 Token、Chat ID 和 webhook secret，再将 Telegram webhook 指向 Worker。缺少任一项时，webhook 直接返回 HTTP 200，不处理命令、不回复聊天、不调用状态源或翻译 API；配置完整后仍严格校验 secret。

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<worker-name>.<subdomain>.workers.dev/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message"]
  }'
```

在 `TELEGRAM_CHAT_ID` 对应的私聊或群中发送 `/check`。Worker 查询当前组件和活动事件的最新进展，配置完整时翻译内容，并仅回复该聊天。无论是否发现变化，都不写 KV、不广播状态通知；事件仍由下一次 Cron 正常通知。单次查询内容和翻译共享 20 秒预算，回复最多 5 秒；仅发送一条有长度上限的查询回复，更多事件通过官方状态页查看。

若 Bot 位于群组中且启用了 privacy mode，可使用 `/check@你的Bot用户名`。

## Cloudflare 首次部署

1. 在 Dashboard 创建 Worker（已有 Worker 无需重建），创建或选择 KV namespace。

2. 在 Worker 的 Bindings 中添加 KV 绑定，变量名为 `STATUS_KV`。Namespace ID 不写入代码。在面板设置兼容日期、域名和日志，并在 Cron Triggers 中添加 `*/5 * * * *`。这些配置不会由部署脚本创建或修改。

3. 在 Cloudflare Dashboard 的 Worker `Settings > Variables and Secrets` 中配置：

```dotenv
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_CHAT_ID=...
# TELEGRAM_WEBHOOK_SECRET=...
CHECK_TOKEN=...
TRANSLATION_API_KEY=...
TRANSLATION_MODEL=...
# WECOM_WEBHOOK_URL=...
```

普通配置项 `TARGET_COMPONENT_NAME`、`INCIDENT_MATCH_MODE`、`DISPLAY_TIME_ZONE`、`NOTIFY_ON_BOOTSTRAP`、`TRANSLATION_API_BASE_URL`、`TRANSLATION_API_STYLE` 也在 Dashboard 中按需覆盖。

4. 配置下面的构建环境变量，然后检查并仅部署代码：

```bash
npm run check
npm run deploy
```

仓库没有生产 Wrangler 配置。部署脚本使用 Cloudflare 官方 `PUT /accounts/{account_id}/workers/scripts/{script_name}/content` 接口，只更新代码，不提交任何 KV、变量、Cron、域名、兼容日期或日志配置。不要再使用 `npx wrangler deploy`，也不要用本地测试配置进行部署。`npm run deploy:dry-run` 只离线打包，不调用 Cloudflare API。

本地开发和测试单独使用 `wrangler.local.jsonc`；其中没有远程 Namespace ID，部署脚本也不读取它。

首次 Cron 只建立基线，不发送历史事件。状态统一存储在 KV key `monitor:v1:openai:codex-api`。

`activeIncidents` 仅保存当前事件的 `事件 ID -> updated_at`；上游未提供事件级时间时使用最新更新的时间。正常时为空对象。不再读取历史 revision 指纹；部署后下一次成功检查会用精简状态覆盖原基线，无需手动清空 KV。`INCIDENT_LOOKBACK_DAYS` 已移除，面板中原有同名变量可删除。

只追踪组件异常期间的事件。组件恢复时额外查询一次已跟踪事件的官方说明；查询失败仍发送组件恢复通知，不事后补发说明。组件一直正常时不追踪独立事件更新，两次轮询之间发生又恢复的短暂故障可能漏掉。正文修改但更新时间不变不会重复通知。

## 通知内容

组件状态变化通知包含旧状态、新状态、当前状态和检测时间。Incident 通知包含：

- 事件中文标题；
- investigating、identified、monitoring、resolved 等阶段的中文映射；
- 官方更新时间；
- AI 生成的中文正文翻译；
- 官方英文标题与正文；
- OpenAI Status 事件链接。

示例：

```text
OpenAI Codex API 状态通知
当前状态：性能下降
检测时间：2026-09-06 11:30:00 Asia/Shanghai

关联事件更新
Codex API 身份验证错误率升高
阶段：调查中
官方时间：2026-09-06 11:28:00 Asia/Shanghai
中文翻译：
我们正在调查 Codex API 身份验证错误率升高的问题。

官方原文：
We are investigating elevated authentication errors for the Codex API.
https://status.openai.com/
```

Cron 仅对新增当前事件、事件更新时间变化或恢复详情调用翻译；HTTP 和 Telegram 只读查询也会在配置完整、组件异常且有活动事件内容时调用翻译 API。没有待翻译正文时不调用。查询翻译可能产生第三方 API 费用。

## HTTP 接口

| 方法与路径               | 鉴权                   | 行为                          |
| ------------------------ | ---------------------- | ----------------------------- |
| `GET /healthz`           | 无                     | 健康检查，不读取 KV 或 OpenAI |
| `POST /admin/check`      | Bearer                 | 查询并翻译，不通知、不写 KV   |
| `GET /admin/state`       | Bearer                 | 返回清理后的当前状态          |
| `POST /telegram/webhook` | Telegram secret header | 响应 `/check`                 |

## Cloudflare Workers Builds

在 Cloudflare Dashboard 的 `Settings > Builds` 连接 GitHub 仓库，并配置：

| 设置                         | 值               |
| ---------------------------- | ---------------- |
| Root directory               | `/`              |
| Production branch            | `main`           |
| Build command                | `npm run check`  |
| Deploy command               | `npm run deploy` |
| Non-production branch builds | Disabled         |

在 **Builds 的变量/Secrets** 中设置部署凭据（不是 Worker 运行时变量）：

- `CLOUDFLARE_ACCOUNT_ID`：目标账户 ID。
- `CLOUDFLARE_API_TOKEN`：具有目标账户 Workers Scripts Edit 权限的 API Token，设为 Secret。若构建环境已提供则无需重复设置。
- `CLOUDFLARE_WORKER_NAME`：已有 Worker 名称。Workers Builds 提供 `WRANGLER_CI_OVERRIDE_NAME` 时优先使用其值。

这些信息只用于选择部署目标和认证，不属于 Worker 业务配置。生产 KV 绑定、环境变量、Secret、Cron、域名和日志全部在面板管理。需要 HTTP 查询或 Telegram `/check` 时，在面板启用 workers.dev 或绑定可访问的自定义域名。

接口语义参考 [Cloudflare 官方 SDK：仅更新代码](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/content.ts)。脚本要求目标 Worker 和 `STATUS_KV` 绑定已存在，不会自动创建或覆盖它们。

## 投递语义

从配置中移除或禁用通知渠道时，该渠道尚未完成的投递也会跳过，不会阻塞其他渠道和后续 Cron。仍然配置完整、但请求失败的渠道会继续重试。

只有 Cron 可以写 KV 和发送状态通知；所有 HTTP/Telegram 查询均只读，避免与 Cron 并发改写基线。保持每 5 分钟一次 Cron，外部请求共享 60 秒预算，不另建 Durable Object、Queue 或重试定时器。

Cron 在发送前持久化待投递内容，并为每个渠道/分片写入独立回执 key。一个渠道失败不妨碍另一个渠道发送该批次的剩余分片。下一次 Cron 先恢复未完成投递，跳过已有成功回执的分片，复用已保存的译文；恢复完成后，本次不再重复抓取，下一次 Cron 才检查新的状态。全部投递成功后推进基线。未完成期间的新状态检查会延后，持续失败的渠道需要修复配置。

回执使用独立 key，避免同一 KV key 每秒多次写入。完成标记保留至下一批通知替换，旧回执随之清理；日常无变化时不写 KV。异常期间 incident feed 失败时保留已知事件时间，恢复访问后只通知当前事件的新进展，不补发历史事件。首次检查默认静默建立基线；若首次事件查询失败，后续获得当前异常详情时正常通知。

投递仍为 at-least-once：若外部平台已收消息但响应丢失，或回执保存失败，下次可能重复；Telegram/企业微信没有可用于该流程的幂等键，不能保证严格 exactly-once。

## 免费套餐用量

按面板设置每 5 分钟运行，每天 288 次 Cron；持续正常时约 288 次状态源 HTTP 请求，每分钟运行则约 1440 次。异常期间和恢复当次会额外查询事件，失败重试另计。无变化时通常每次读取 KV 2 次（已有完成投递记录时为 3 次），不调用翻译、不通知、不写 KV。KV 写入和回执仅随真实变化增加，失败投递仅在后续 Cron 重试。人工查询另有一次 KV 读取、状态源请求，以及配置完整且有异常详情时的翻译调用。生产配置全部在 Cloudflare Dashboard 维护，部署只更新代码。
