# Cloudflare Workers AI + Supabase 上线步骤

这版不需要 OpenAI API Key，也不需要一台持续开机的电脑。已知问题（空房、
租金、车位、费用、宠物政策）先读取 Supabase；只有安全且数据库规则没有直接
答案的问题才调用 Cloudflare Workers AI。无法确认或敏感问题会进入员工的
**Confirmations**。

## 1. Supabase：执行一次 migration

打开 Supabase 项目 → **SQL Editor** → **New query**，复制并执行：

`worker/schema/019_workers_ai_cloud.sql`

成功后应出现两张表：

- `ai_chat_runs`：每次数据库直答、Workers AI 回答、失败和转人工结果。
- `ai_usage_daily`：每天各来源的请求数、错误数和字符量。

这是增量 migration，不会删除或覆盖租客、单位、价格或租约。

## 2. Cloudflare：确认 Workers AI binding

代码里的 `worker/wrangler.jsonc` 已包含：

```jsonc
"ai": { "binding": "AI" }
```

正常从 GitHub 重新部署 Worker 后会建立 binding。如果 Cloudflare Dashboard
仍未显示，请打开：

**Workers & Pages → pointe-backend → Settings → Bindings → Add binding →
Workers AI**

变量名称必须填：`AI`。

## 3. Cloudflare：确认模型变量

同一项目的 **Settings → Variables and Secrets** 应有：

| Name | Type | Value |
|---|---|---|
| `WORKERS_AI_MODEL` | Text | `@cf/zai-org/glm-4.7-flash` |

这个值已经写在 `wrangler.jsonc`；GitHub 部署通常会自动带入。旧的
`OPENAI_API_KEY` 和 `OPENAI_MODEL` 已不再使用，确认新版聊天正常后可以删除。

## 4. 重新部署 Worker

Cloudflare Git integration 会在 `main` 更新后自动部署。若要手动部署，Worker
目录使用：

```bash
npm clean-install
npm run deploy
```

不要把 Supabase 密码、Resend Key 或任何 secret 写进 GitHub。

## 5. 验证

1. 员工登录后台 → **Admin → System**。
2. **AI automation** 应显示模型名称，且不再显示 binding missing。
3. 在租客聊天问「现在 3A 还有几套？」；回答来源应是最新 Supabase 数据，
   不调用模型。
4. 问一个普通但数据库没有固定模板的问题；Workers AI 可回答时，
   `ai_chat_runs.provider` 会是 `workers_ai`。
5. 问申请资格、无障碍安排、法律或私人账户问题；系统应新增 Confirmations，
   `ai_chat_runs.provider` 会是 `human`。

可在 Supabase SQL Editor 查看最近结果：

```sql
SELECT created_at, provider, model, needs_human, error_code,
       question, answer
FROM ai_chat_runs
ORDER BY created_at DESC
LIMIT 50;
```

查看今天用量：

```sql
SELECT *
FROM ai_usage_daily
WHERE usage_date = CURRENT_DATE
ORDER BY provider, model;
```
