import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockInsert = vi.fn();
const mockSelect = vi.fn();

vi.mock("lib/db/pg/db.pg", () => ({
  pgDb: {
    insert: (...args: any[]) => mockInsert(...args),
    select: (...args: any[]) => mockSelect(...args),
  },
}));

import {
  QuotaExceededError,
  claimDailyRequest,
  recordUsage,
  getUsageToday,
} from "./usage";

describe("QuotaExceededError", () => {
  it("initializes with limit and role", () => {
    const err = new QuotaExceededError(10, "guest");
    expect(err.limit).toBe(10);
    expect(err.role).toBe("guest");
    expect(err.message).toBe("Daily usage limit reached");
    expect(err.name).toBe("QuotaExceededError");
  });
});

describe("claimDailyRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockOnConflict = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ requestCount: 1 }]),
    });
    const mockValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: mockOnConflict,
    });
    mockInsert.mockReturnValue({
      values: mockValues,
    });
  });

  it("claims a daily request successfully when DB returns a row", async () => {
    await expect(
      claimDailyRequest("user-123", "verified"),
    ).resolves.not.toThrow();
    expect(mockInsert).toHaveBeenCalled();
  });

  it("throws QuotaExceededError when DB returns 0 rows (quota reached)", async () => {
    const mockOnConflict = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    });
    const mockValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: mockOnConflict,
    });
    mockInsert.mockReturnValue({
      values: mockValues,
    });

    await expect(claimDailyRequest("user-123", "verified")).rejects.toThrow(
      QuotaExceededError,
    );
  });
});

describe("recordUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records usage metrics without throwing even if DB succeeds", async () => {
    const mockOnConflict = vi.fn().mockResolvedValue(undefined);
    const mockValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: mockOnConflict,
    });
    mockInsert.mockReturnValue({
      values: mockValues,
    });

    await expect(
      recordUsage("user-123", {
        toolCalls: 2,
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: 0.002,
      }),
    ).resolves.not.toThrow();
  });

  it("swallows DB errors gracefully", async () => {
    mockInsert.mockImplementation(() => {
      throw new Error("DB Connection Error");
    });

    await expect(
      recordUsage("user-123", { toolCalls: 1 }),
    ).resolves.not.toThrow();
  });
});

describe("getUsageToday", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns row when present", async () => {
    const fakeRow = { userId: "user-1", requestCount: 5, date: "2026-09-11" };
    const mockWhere = vi.fn().mockResolvedValue([fakeRow]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });

    const res = await getUsageToday("user-1");
    expect(res).toEqual(fakeRow);
  });

  it("returns null when no row is returned", async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });

    const res = await getUsageToday("user-1");
    expect(res).toBeNull();
  });
});
