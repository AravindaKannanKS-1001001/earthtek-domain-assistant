import "server-only";

/**
 * Central policy layer for the EarthTekniks domain assistant.
 *
 * One place for: domain roles, daily request quotas, agent step limit, retry
 * limit, and per-MCP-tool approval / role gating. Nothing here is duplicated
 * elsewhere — the chat route and quota code import from this module only.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Domain roles
//
// Better Chatbot's DB roles (better-auth: admin | editor | user) are left
// untouched. We map them onto the three domain roles the assistant cares about,
// plus `guest` for unauthenticated visitors.
// ─────────────────────────────────────────────────────────────────────────────

export type DomainRole = "guest" | "verified" | "employee";

export function toDomainRole(dbRole?: string | null): DomainRole {
  switch (dbRole) {
    case "admin":
    case "editor":
      return "employee";
    case "user":
      return "verified";
    default:
      return "guest";
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const MAX_TOOL_STEPS = intEnv("MAX_TOOL_STEPS", 10);
export const MAX_RETRIES = intEnv("MAX_RETRIES", 2);

export interface RolePolicy {
  /** Daily chat-request cap. */
  dailyRequests: number;
  /** Max agent/tool steps per interaction. */
  maxToolSteps: number;
  /** Whether the agent may call MCP tools autonomously for this role. */
  autonomousMcpTools: boolean;
}

export const ROLE_POLICY: Record<DomainRole, RolePolicy> = {
  guest: {
    dailyRequests: intEnv("GUEST_DAILY_LIMIT", 10),
    maxToolSteps: 0,
    autonomousMcpTools: false,
  },
  verified: {
    dailyRequests: intEnv("VERIFIED_DAILY_LIMIT", 20),
    maxToolSteps: MAX_TOOL_STEPS,
    autonomousMcpTools: true,
  },
  employee: {
    dailyRequests: intEnv("EMPLOYEE_DAILY_LIMIT", 50),
    maxToolSteps: MAX_TOOL_STEPS,
    autonomousMcpTools: true,
  },
};

export function rolePolicy(role: DomainRole): RolePolicy {
  return ROLE_POLICY[role];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tool policy
//
// Tool names are discovered from the MCP server at runtime — we do not assume
// they exist. This map only overrides the category default. Anything not listed
// falls through to `defaultToolPolicy()`.
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolPolicy {
  requiresApproval: boolean;
  allowedRoles: DomainRole[];
}

const READ_ONLY: ToolPolicy = {
  requiresApproval: false,
  allowedRoles: ["verified", "employee"],
};

const GATED: ToolPolicy = {
  requiresApproval: true,
  allowedRoles: ["verified", "employee"],
};

/** Explicit overrides keyed by the MCP tool's origin name. */
export const TOOL_POLICY: Record<string, ToolPolicy> = {
  // calc — discovery is read-only, execution is gated
  search_calculator: READ_ONLY,
  get_calculator: READ_ONLY,
  search_lookups: READ_ONLY,
  get_reference: READ_ONLY,
  lookup: READ_ONLY,
  calculate: GATED,

  // site — all read-only knowledge
  search_knowledge_base: READ_ONLY,
  get_document: READ_ONLY,

  // catalog — schema/search read-only, raw SQL escape hatch is gated
  list_families: READ_ONLY,
  list_tables: READ_ONLY,
  describe_table: READ_ONLY,
  search_knowledge: READ_ONLY,
  get_table_knowledge: READ_ONLY,
  lookup_model: READ_ONLY,
  get_product: READ_ONLY,
  search_products: READ_ONLY,
  run_select: GATED,
};

/** Unknown tools: require approval, verified+ only. Fail closed. */
export function defaultToolPolicy(): ToolPolicy {
  return GATED;
}

export function toolPolicy(toolName: string): ToolPolicy {
  return TOOL_POLICY[toolName] ?? defaultToolPolicy();
}

export interface ToolDecision {
  /** Tool is visible to the agent at all. */
  allowed: boolean;
  /** Tool must be executed behind a human approval gate. */
  requiresApproval: boolean;
}

/**
 * Effective decision for (role, tool). Guests never get autonomous MCP tools.
 */
export function decideTool(role: DomainRole, toolName: string): ToolDecision {
  const rp = rolePolicy(role);
  if (!rp.autonomousMcpTools) {
    return { allowed: false, requiresApproval: true };
  }
  const tp = toolPolicy(toolName);
  return {
    allowed: tp.allowedRoles.includes(role),
    requiresApproval: tp.requiresApproval,
  };
}
