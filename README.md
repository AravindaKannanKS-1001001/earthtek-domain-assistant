# EarthTekniks Domain Assistant

**Repo:** https://github.com/AravindaKannanKS-1001001/earthtek-domain-assistant

An AI chat assistant for **EarthTekniks** — a machine-vision optics company. You ask
questions in plain language (or by voice) and it answers using three real tool
domains served over [MCP](https://modelcontextprotocol.io):

- **Calculations** — optical/engineering calculators (field of view, working distance,
  depth of field, exposure, line-scan, etc.) with warnings and structured results
- **Site knowledge** — company / product / project information
- **Product catalog** — lens catalog backed by a SQL database ("find lenses under
  ₹10,000", "compare these", "which fits this requirement")

The assistant decides on its own which tools to use, can chain several steps
(search → filter → compare → calculate), asks for your approval before running
sensitive tools, and lets you **edit the numbers before it runs them**.

### What this repo actually is

It is the [**Better Chatbot**](https://github.com/cgoinglove/better-chatbot) open-source
project (Next.js + Vercel AI SDK + MCP), customized into a focused, secured domain
assistant. Almost all infrastructure — streaming, MCP client, auth, voice, tool UI — is
reused as-is. The customization adds: role-based access, daily usage quotas, a per-tool
approval policy, editable tool parameters, and env-driven configuration.

- **`CUSTOMIZATION.md`** — the full audit of what was reused vs. added, and why
- **`EARTHTEK_README.md`** — the detailed operator guide (every env var, Supabase,
  ET-MCP hosting, RBAC/quota tables, implementation status)
- **`UPSTREAM_README.md`** — the original Better Chatbot readme

---

## Architecture (one agent, no orchestration frameworks)

```
Browser ─► Chat UI ─► Vercel AI SDK ─► single agent ─► MCP client ─► ET-MCP server
                          ▲                                              ├─ Calculations
              Supabase Auth + RBAC + daily quota                         ├─ Site knowledge
              (all enforced server-side)                                 └─ Product catalog (SQL)
```

- **App**: Next.js 16 / React 19 / TypeScript / Tailwind → deploy to **Vercel**
- **Auth + database**: `better-auth` + Drizzle on **Supabase Postgres** (Supabase is
  just Postgres here — no second auth system introduced)
- **MCP server**: the provided Python [`ConTresillo/et-mcp`](https://github.com/ConTresillo/et-mcp),
  run separately (17 tools). Lightweight in BM25 mode (~150 MB RAM, no model download).

---

## Prerequisites

- Node.js **≥ 20** and `pnpm` (`corepack enable`)
- A [Supabase](https://supabase.com) project (free tier is fine)
- One LLM provider API key — OpenAI / Anthropic / Google / xAI / OpenRouter / Groq
- The ET-MCP server running and reachable (see step 5)

---

## Setup

```bash
git clone https://github.com/AravindaKannanKS-1001001/earthtek-domain-assistant.git
cd earthtek-domain-assistant

pnpm install
cp .env.example .env          # then fill it in — see the table below
pnpm db:push                  # creates all tables in your Supabase DB
pnpm dev                      # open http://localhost:3000
```

The **first account you create becomes the admin.**

### 1. Database (Supabase)

1. Create a Supabase project.
2. Copy its connection string into `POSTGRES_URL` in `.env`
   (use the **pooled** `...pooler.supabase.com:6543` string when deploying to Vercel).
3. `pnpm db:push` applies the schema (chat tables + `usage_daily`).

### 2. Auth secret

```bash
npx @better-auth/cli@latest secret     # paste into BETTER_AUTH_SECRET
```

### 3. LLM provider

Set `AI_PROVIDER`, `AI_MODEL`, `AI_PROVIDER_API_KEY` (provider-agnostic — no model is
hard-coded).

### 4. Environment variables

| Variable | Required | Purpose |
|---|:---:|---|
| `POSTGRES_URL` | ✅ | Supabase Postgres connection string |
| `BETTER_AUTH_SECRET` | ✅ | session signing secret |
| `BETTER_AUTH_URL` | ✅ | the URL you open the app from (`http://localhost:3000` in dev) |
| `AI_PROVIDER` / `AI_MODEL` / `AI_PROVIDER_API_KEY` | ✅ | default model |
| `MCP_SERVER_URL` | ✅ | ET-MCP HTTP endpoint, e.g. `http://127.0.0.1:8001/mcp` |
| `MCP_AUTH_TOKEN` | — | optional bearer token for the MCP server (server-side only) |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase keys (kept for future use) |
| `GUEST_DAILY_LIMIT` / `VERIFIED_DAILY_LIMIT` / `EMPLOYEE_DAILY_LIMIT` | — | daily request caps (default **10 / 20 / 50**) |
| `MAX_TOOL_STEPS` | — | agent step limit per request (default **10**) |
| `MAX_RETRIES` | — | retries on transient failures (default **2**) |
| `ENABLE_VOICE` | — | `true` \| `false` — voice input |
| `DEFAULT_USER_ROLE` | — | set to `user` so new signups become **verified** (not employee) |

> MCP credentials are **never** sent to the browser — the ET-MCP server is registered
> server-side only.

### 5. Run the ET-MCP server

Clone [`ConTresillo/et-mcp`](https://github.com/ConTresillo/et-mcp) and run:

```bash
pip install -e .
cp .env.example .env          # set SUPABASE_DB_URL (same DB, read-only) for catalog tools
python -m et_mcp.server --server all --transport streamable-http --port 8001 --host 0.0.0.0
```

Then set `MCP_SERVER_URL=http://127.0.0.1:8001/mcp` in this app's `.env`.

---

## How access control works

Roles are derived from the login account (`src/lib/policy/index.ts`):

| Account | Assistant role | Daily requests | Can the agent call MCP tools on its own? | Step limit |
|---|---|:---:|:---:|:---:|
| not signed in | `guest` | `GUEST_DAILY_LIMIT` | no — asked to sign in | 0 |
| normal user (`user`) | `verified` | `VERIFIED_DAILY_LIMIT` | yes | `MAX_TOOL_STEPS` |
| `editor` / `admin` | `employee` | `EMPLOYEE_DAILY_LIMIT` | yes | `MAX_TOOL_STEPS` |

Per-tool rules live in `TOOL_POLICY` in the same file:

- read-only knowledge & product search → run **automatically**
- `calculate` and raw SQL (`run_select`) → **require your approval** (you can edit the
  parameters first)
- any unknown tool → fails closed (approval + verified-only)

Everything above is enforced **server-side**. The browser cannot bypass it.

---

## Deployment

| Piece | Where |
|---|---|
| This app | **Vercel** — import the repo, set the env vars, deploy |
| Database | **Supabase** — run `pnpm db:push` once against the prod DB |
| ET-MCP server | small always-on host (Fly.io machine / container); `Dockerfile.mcp` in the et-mcp repo is standalone |

---

## Development commands

```bash
pnpm dev            # run the app
pnpm check-types    # TypeScript
pnpm lint           # Biome
pnpm test           # unit tests (vitest)
pnpm build          # production build
```

> Note: `pnpm test` needs the repo to live on a path **without a `#` character** —
> vite-node fails to resolve modules otherwise.

---

## Status

Implemented: policy layer, server-side RBAC + daily quotas, env-driven MCP, HITL with
editable parameters, per-tool approval gating, provider-agnostic model, voice flag,
policy unit tests. TypeScript passes clean.

Still open (see `EARTHTEK_README.md`): unauthenticated guest chat, the explicit
"[Continue] / [Stop]" control at the step limit, rich product/calculation result cards,
hiding unused nav, and e2e tests.

---

## License

MIT — inherited from [Better Chatbot](https://github.com/cgoinglove/better-chatbot).
See `LICENSE`.
