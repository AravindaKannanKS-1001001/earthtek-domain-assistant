import { describe, it, expect } from "vitest";
import { toDomainRole, decideTool, rolePolicy } from "./index";

describe("domain role mapping", () => {
  it("maps db roles to domain roles", () => {
    expect(toDomainRole("admin")).toBe("employee");
    expect(toDomainRole("editor")).toBe("employee");
    expect(toDomainRole("user")).toBe("verified");
    expect(toDomainRole(undefined)).toBe("guest");
    expect(toDomainRole("nonsense")).toBe("guest");
  });
});

describe("decideTool", () => {
  it("denies all MCP tools to guests", () => {
    expect(decideTool("guest", "search_products").allowed).toBe(false);
    expect(decideTool("guest", "calculate").allowed).toBe(false);
  });

  it("allows read-only tools without approval for verified", () => {
    const d = decideTool("verified", "search_products");
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("gates calculation + raw SQL behind approval", () => {
    expect(decideTool("verified", "calculate").requiresApproval).toBe(true);
    expect(decideTool("employee", "run_select").requiresApproval).toBe(true);
  });

  it("fails closed for unknown tools", () => {
    const d = decideTool("verified", "some_new_tool");
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });
});

describe("rolePolicy", () => {
  it("gives guests zero tool steps and no autonomous tools", () => {
    const p = rolePolicy("guest");
    expect(p.maxToolSteps).toBe(0);
    expect(p.autonomousMcpTools).toBe(false);
  });

  it("caps verified/employee at MAX_TOOL_STEPS", () => {
    expect(rolePolicy("verified").maxToolSteps).toBe(
      rolePolicy("employee").maxToolSteps,
    );
  });
});
