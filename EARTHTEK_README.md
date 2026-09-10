# EarthTekniks Domain Assistant — Setup & Deployment

Built on [Better Chatbot](https://github.com/cgoinglove/better-chatbot). See
`CUSTOMIZATION.md` for the architecture audit and design decisions.

## 1. Prerequisites

- Node.js ≥ 20, `pnpm` (`corepack enable`)
- A Supabase project (Postgres + optionally its Auth later)
- The ET-MCP server running somewhere reachable (Python 3.12+; `ConTresillo/et-mcp`)
- One LLM provider API key (OpenAI / Anthropic / Google / xAI / OpenRouter / Groq)

## 2. Installation

```bash
pnpm install
cp .env.example .env      # then edit .env (section 3)
pnpm db:push              # create/sync tables in Supabase (incl. usage_daily)
pnpm dev                  # http://localhost:3000
```

## 3. Environment variables

| Var | Purpose |
|---|---|
| `POSTGRES_URL` | Supabase Postgres connection string (used by better-auth + Drizzle) |
| `BETTER_AUTH_SECRET` | `npx @better-auth/cli@latest secret` |
| `BETTER_AUTH_URL` | your app URL (e.g. `https://assistant.earthtek.com`) |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase keys (from the provided env file) |
| `MCP_SERVER_URL` | ET-MCP streamable-http endpoint, e.g. `https://et-mcp.fly.dev/mcp` |
| `MCP_AUTH_TOKEN` | optional bearer token sent to the MCP server (server-side only) |
| `AI_PROVIDER` / `AI_MODEL` / `AI_PROVIDER_API_KEY` | default model, provider-agnostic |
| `GUEST_DAILY_LIMIT` / `VERIFIED_DAILY_LIMIT` / `EMPLOYEE_DAILY_LIMIT` | daily request quotas (default 10 / 20 / 50) |
| `MAX_TOOL_STEPS` | agent step limit (default 10) |
| `MAX_RETRIES` | transient-failure retries (default 2) |
| `ENABLE_VOICE` | `true` \| `false` — voice input feature flag |
| `DEFAULT_USER_ROLE` | **set to `user`** so new signups become `verified` (not `employee`) |

MCP credentials are never bundled to the browser — the ET-MCP server is registered
in-memory server-side (`src/lib/ai/mcp/mcp-manager.ts`).

## 4. Supabase configuration

1. Create a project; copy the connection string into `POSTGRES_URL`
   (use the **pooled** `...pooler.supabase.com:6543` string on Vercel).
2. `pnpm db:push` applies the schema.
3. The `catalog` MCP tools need the **same** DB via `SUPABASE_DB_URL` on the ET-MCP host
   (read-only). That is configured on the MCP server, not here.

## 5. ET-MCP configuration

Run the provided server with HTTP transport:

```bash
# on the MCP host (Fly.io machine / small container)
python -m et_mcp.server --server all --transport streamable-http --port 8001 --host 0.0.0.0
```

Set `MCP_SERVER_URL=http://<host>:8001/mcp` here. For local dev you can also run it and
point at `http://127.0.0.1:8001/mcp`. Lightweight in BM25 mode
(`DISABLE_SITE_VECTOR=true`) — no model download, ~150 MB RAM.

## 6. Local development

```bash
pnpm dev              # app
pnpm test             # unit tests (vitest)
pnpm check-types      # tsc --noEmit
pnpm lint
```

First account created becomes `admin`. Promote/demote users from `/admin/users`.

## 7. Production deployment

- **App → Vercel.** Import the repo, set all env vars, deploy. `IS_MCP_SERVER_REMOTE_ONLY`
  is automatically true on Vercel so only the remote ET-MCP server is used.
- **ET-MCP → Fly.io / container.** `Dockerfile.mcp` in the et-mcp repo is standalone.
- **DB → Supabase.** Run `pnpm db:push` once against the prod DB.

## 8. RBAC configuration

Domain roles are derived from the better-auth DB role (`src/lib/policy/index.ts`):

| DB role | Domain role | Daily requests | Autonomous MCP tools | Step limit |
|---|---|---|---|---|
| (no session) | `guest` | `GUEST_DAILY_LIMIT` | no | 0 |
| `user` | `verified` | `VERIFIED_DAILY_LIMIT` | yes | `MAX_TOOL_STEPS` |
| `editor` / `admin` | `employee` | `EMPLOYEE_DAILY_LIMIT` | yes | `MAX_TOOL_STEPS` |

Per-tool approval / role gating lives in `TOOL_POLICY` in the same file — read-only
knowledge & product search run automatically; `calculate` and `run_select` are
approval-gated; unknown tools fail closed (approval + verified-only).

## 9. Quota configuration

Just the three `*_DAILY_LIMIT` env vars. Enforced atomically server-side in
`src/lib/policy/usage.ts` against the `usage_daily` table (one row per user per UTC
day: `request_count`, `tool_call_count`, `input_tokens`, `output_tokens`,
`estimated_cost`). Client-supplied counts are ignored.

---

## Implementation status

**Done**

- Central policy layer (`src/lib/policy/`) — roles, quotas, per-tool approval, step/retry limits, all env-driven
- Env-driven ET-MCP registration (server-side only), reusing Better Chatbot's MCP SDK client
- Server-side RBAC: role-based MCP tool filtering in the chat route; guests get no autonomous MCP tools
- Server-side daily quotas: atomic increment, friendly 429, `usage_daily` table + token/tool accounting
- HITL with **editable parameters**: approval card renders an editable form; approved args replace the model's args before the MCP call (`ManualToolConfirmTag.args` → `manualToolExecuteByLastMessage`)
- Per-tool approval gating (not all-or-nothing): gated tools have `execute` stripped and route through the existing manual-confirm mechanism
- Agent step limit + retries from env (`stepCountIs`, `maxRetries`)
- Provider-agnostic default model (`AI_PROVIDER` / `AI_MODEL` / `AI_PROVIDER_API_KEY`)
- Voice behind `ENABLE_VOICE` flag
- Unit tests for the policy layer

**Pending** (tracked, not yet built)

- Unauthenticated guest chat (Better Chatbot currently requires a session for all chat).
  Recommended: cookie-based guest id + nullable `thread.userId`, or a "sign in to continue"
  wall with a small anonymous allowance. Today: unauthenticated users are sent to sign-in.
- "Maximum tool steps reached — [Continue] [Stop]" UI affordance (server stops correctly at
  the limit; the explicit Continue/Stop control is not wired yet).
- Rich result renderers (`calculation-result`, `product-card`, `product-compare`) — results
  currently render via Better Chatbot's default tool-result view.
- Hiding unused nav (workflow builder, agent marketplace) — tools are not loaded but the nav
  entries are still visible.
- Focused e2e tests for auth/quota/HITL/MCP-failure flows.
