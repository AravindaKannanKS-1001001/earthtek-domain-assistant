# EarthTekniks Domain Assistant — Customization of Better Chatbot

This app is Better Chatbot, adapted into a focused MCP-powered domain assistant for
EarthTekniks (optics calculations, site knowledge, lens catalog). We reuse Better
Chatbot's infrastructure and add only what the domain needs.

---

## 1. Repository audit (what already exists, reused as-is)

| Concern | Better Chatbot implementation | Decision |
|---|---|---|
| Framework | Next.js 16, React 19, TS, Tailwid v4 | keep |
| Auth / session / RBAC | `better-auth` + Drizzle on Postgres, admin plugin, access-control roles (`src/lib/auth/*`) | **keep** — point Postgres at Supabase DB. No second auth system. |
| DB | Postgres + Drizzle, migrations in `src/lib/db/migrations/pg` | keep; add one `usage_daily` table |
| Chat / agent | `src/app/api/chat/route.ts` — `streamText` + `convertToModelMessages`, single model, `stopWhen: stepCountIs(10)`, `maxRetries: 2` | **this is the single agent.** Parameterize the two constants. |
| AI SDK | Vercel AI SDK v5 (`ai`, `@ai-sdk/*`), multi-provider in `src/lib/ai/models.ts` | keep; select provider/model via env |
| MCP client | `@modelcontextprotocol/sdk`, `src/lib/ai/mcp/*` — StreamableHTTP + SSE fallback, remote config with `headers`, OAuth, per-tool loading, auto-disconnect | **keep.** Add env-driven auto-registration of the ET-MCP server. |
| Tool calling | `loadMcpTools` → Vercel AI tools; manual/auto tool modes | keep |
| HITL | "manual" tool mode: `excludeToolExecution` → Approve/Reject UI in `src/components/message-parts.tsx` → `manualToolExecuteByLastMessage` in `shared.chat.ts` | **keep + extend**: per-tool policy decides gating; add editable params before approval. |
| Streaming | `createUIMessageStream` + `smoothStream`, progressive tool parts | keep |
| Tool rendering | `src/components/tool-invocation/*` (charts, tables, code, web-search) + `message-parts.tsx` | keep; add calculation-result + product-card renderers |
| Voice | OpenAI Realtime (`src/app/api/chat/openai-realtime`, `src/lib/ai/speech/*`, `chat-bot-voice.tsx`) | keep behind `ENABLE_VOICE` flag |
| Retry / errors | `maxRetries` in `streamText`, `handleError`, `ts-safe` | keep |
| Deploy | Vercel + Docker compose (Postgres) | Vercel + Supabase; ET-MCP hosted separately |
| Tests | Vitest (unit) + Playwright (e2e) | keep; add focused security/agent tests |

### Features we do NOT need (disabled, not deleted)

- Workflow builder (`src/app/(chat)/workflow`, `src/lib/ai/workflow`) — hidden from nav, tools not loaded
- Multi-agent / agent marketplace (`src/app/(chat)/agents`) — single implicit agent only
- Image generation (`src/lib/ai/tools/image`, nano-banana / openai image) — `imageTool` path left dead
- Code runner / JS sandbox (`src/lib/code-runner`, `js-run-tool`) — not in default toolkit
- Web search / Exa (`src/lib/ai/tools` web-search) — not loaded
- Chat export / comments, archives, bookmarks — routes stay, not surfaced

Removal strategy: stop loading the tools + hide the nav entries. No mass rewrite.

---

## 2. ET-MCP server (provided, not recreated)

Python, 3 domain servers, 17 tools. Runs `stdio` (dev) or `streamable-http` (prod).
With `DISABLE_SITE_VECTOR=true` + reranking off it is BM25-only (light). `catalog`
needs `SUPABASE_DB_URL` (read-only Postgres).

Discovered tool names (from `et-mcp/README.md`), used to seed the tool policy:

- **calc**: `search_calculator`, `get_calculator`, `calculate`, `search_lookups`, `get_reference`, `lookup`
- **site**: `search_knowledge_base`, `get_document`
- **catalog**: `list_families`, `list_tables`, `describe_table`, `search_knowledge`, `get_table_knowledge`, `lookup_model`, `get_product`, `search_products`, `run_select`

The app connects as a **remote MCP server** via `MCP_SERVER_URL` (+ optional
`MCP_AUTH_TOKEN` → `Authorization: Bearer` header, server-side only).

---

## 3. Central policy layer — `src/lib/policy/`

One place for every configurable rule. No scattering.

- `roles.ts` — app roles `guest | verified | employee` (+ existing `admin`), each with
  `dailyRequests`, `maxToolSteps`, `autonomousMcpTools: boolean`. Values from env.
- `tool-policy.ts` — per-MCP-tool: `{ requiresApproval, allowedRoles }`. Default rule by
  category: read-only knowledge/search → auto; `calculate` / `run_select` → approval.
  Tool names matched against what the MCP server actually exposes at runtime; unknown
  tools default to "approval + verified+".
- `index.ts` — resolves effective policy for `(role, toolName)` and reads env limits.

Env: `GUEST_DAILY_LIMIT`, `VERIFIED_DAILY_LIMIT`, `EMPLOYEE_DAILY_LIMIT`,
`MAX_TOOL_STEPS`, `MAX_RETRIES`.

---

## 4. RBAC & quota enforcement (server-side only)

`src/app/api/chat/route.ts` gains, before `streamText`:

1. `getSession()` → role (guest if no session).
2. `assertWithinDailyQuota(userId, role)` — atomic increment on `usage_daily`
   (`INSERT ... ON CONFLICT ... DO UPDATE SET request_count = request_count + 1`),
   reject with 429 + friendly message when over.
3. Filter MCP tools by `tool-policy` for the role. Guests get **no** autonomous MCP
   tools — the model still answers, and is told to ask the user to sign in for gated
   capability.
4. Tools whose policy says `requiresApproval` are wrapped with `excludeToolExecution`
   (existing mechanism) regardless of the client's tool-mode → approval happens in the
   follow-up request, executed server-side in `manualToolExecuteByLastMessage`.
5. `stopWhen: stepCountIs(policy.maxToolSteps)`; `maxRetries` from env.

Client-sent `allowedMcpServers` / role / quota are **ignored** for authorization —
only used as a display hint. The server recomputes everything from the session.

`usage_daily`: `user_id, date, request_count, tool_call_count, input_tokens,
output_tokens, estimated_cost` — updated in the `onFinish` callback from
`part.totalUsage` (already captured in `metadata.usage`).

---

## 5. HITL with editable parameters

Extend the existing manual-confirm flow:

- Approval card (message-parts.tsx) renders the tool input as a **form** (fields from
  the tool's JSON schema) instead of read-only JSON. Calculation tools also show
  `warnings` / `assumptions` if the model included them.
- Approve sends `ManualToolConfirmTag.create({ confirm: true, args: <editedArgs> })`.
- `manualToolExecuteByLastMessage` uses `output.args ?? part.input` when calling MCP.
  → the MCP server always receives the **user-approved** arguments.
- Reject → `{ confirm: false }` → `MANUAL_REJECT_RESPONSE_PROMPT` (already exists).

---

## 6. Tool-step limit & Continue/Stop

`stepCountIs(maxToolSteps)` already stops the loop. When the last streamed step is a
tool step and the finish reason is the step limit, the route appends a UI message part
`{ type: "data-step-limit" }`. The client renders **[Continue] [Stop]**. Continue
re-submits the thread (history + completed tool results preserved by existing
persistence) starting a fresh N-step window. Stop just ends; the model's final text
already summarizes. No unlimited auto-continue.

---

## 7. Result rendering

- `calculation-result.tsx` — result value(s), warnings block, assumptions block, from
  `{ result, warnings, assumptions }` MCP output.
- `product-card.tsx` / `product-compare.tsx` — cards + comparison table from
  `search_products` / `get_product` rows. Never shows SQL.
- Registered in `message-parts.tsx` tool-part switch, keyed by origin tool name.

---

## 8. Config / env

See `.env.example`. Provider-agnostic: `AI_PROVIDER`, `AI_MODEL`, `AI_PROVIDER_API_KEY`
map onto the existing `customModelProvider`. Supabase: standard `NEXT_PUBLIC_SUPABASE_*`
+ `SUPABASE_SERVICE_ROLE_KEY` kept for future use; `POSTGRES_URL` points at the Supabase
DB (that is what better-auth + Drizzle use).

---

## 9. Deployment

- **App** → Vercel. `POSTGRES_URL` = Supabase pooled connection. `IS_MCP_SERVER_REMOTE_ONLY`
  is already true on Vercel, so only remote MCP is used — matches our setup.
- **ET-MCP** → separate small host (Fly.io machine / container) running
  `--transport streamable-http`. Set `MCP_SERVER_URL` to its `/mcp` URL.
- **DB** → Supabase (migrations via `pnpm db:migrate`).

---

## 10. Build order (implementation)

1. Central policy layer + env wiring + `.env.example` + README.
2. Env-driven ET-MCP auto-registration in the MCP manager.
3. Verify agent → MCP round trip (single agent = existing chat route).
4. RBAC roles `guest/verified/employee` + server-side tool filtering.
5. `usage_daily` migration + atomic quota enforcement + friendly 429s.
6. Per-tool approval policy → force `excludeToolExecution` for gated tools.
7. Editable-parameter approval card; edited args reach MCP.
8. Step-limit Continue/Stop UI + data part.
9. Result renderers (calculation, products, comparison).
10. Disable unused nav/tools (workflow, agents, image, code-runner, web-search).
11. Voice behind `ENABLE_VOICE`.
12. Focused tests (auth, RBAC, quota, HITL, step limit, MCP failure) + `lint`/`typecheck`/`build`.
