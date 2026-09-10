import "server-only";

import { pgDb as db } from "lib/db/pg/db.pg";
import { UsageDailyTable } from "lib/db/pg/schema.pg";
import { and, eq, sql } from "drizzle-orm";
import { DomainRole, rolePolicy } from "./index";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly role: DomainRole,
  ) {
    super("Daily usage limit reached");
    this.name = "QuotaExceededError";
  }
}

/**
 * Atomically claim one request against the user's daily quota.
 * Throws {@link QuotaExceededError} when the limit would be exceeded.
 * Single round-trip INSERT ... ON CONFLICT with a WHERE guard — no read-modify-write race.
 */
export async function claimDailyRequest(
  userId: string,
  role: DomainRole,
): Promise<void> {
  const limit = rolePolicy(role).dailyRequests;
  if (limit <= 0) throw new QuotaExceededError(limit, role);

  const date = today();
  const rows = await db
    .insert(UsageDailyTable)
    .values({ userId, date, requestCount: 1 })
    .onConflictDoUpdate({
      target: [UsageDailyTable.userId, UsageDailyTable.date],
      set: {
        requestCount: sql`${UsageDailyTable.requestCount} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
      setWhere: sql`${UsageDailyTable.requestCount} < ${limit}`,
    })
    .returning({ requestCount: UsageDailyTable.requestCount });

  if (rows.length === 0) throw new QuotaExceededError(limit, role);
}

/** Fold token/cost/tool usage into today's row. Best-effort, never throws. */
export async function recordUsage(
  userId: string,
  usage: {
    toolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number;
  },
): Promise<void> {
  try {
    const date = today();
    await db
      .insert(UsageDailyTable)
      .values({
        userId,
        date,
        toolCallCount: usage.toolCalls ?? 0,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        estimatedCost: usage.estimatedCost ?? 0,
      })
      .onConflictDoUpdate({
        target: [UsageDailyTable.userId, UsageDailyTable.date],
        set: {
          toolCallCount: sql`${UsageDailyTable.toolCallCount} + ${usage.toolCalls ?? 0}`,
          inputTokens: sql`${UsageDailyTable.inputTokens} + ${usage.inputTokens ?? 0}`,
          outputTokens: sql`${UsageDailyTable.outputTokens} + ${usage.outputTokens ?? 0}`,
          estimatedCost: sql`${UsageDailyTable.estimatedCost} + ${usage.estimatedCost ?? 0}`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  } catch {
    // usage accounting must never break a chat response
  }
}

export async function getUsageToday(userId: string) {
  const [row] = await db
    .select()
    .from(UsageDailyTable)
    .where(
      and(
        eq(UsageDailyTable.userId, userId),
        eq(UsageDailyTable.date, today()),
      ),
    );
  return row ?? null;
}
