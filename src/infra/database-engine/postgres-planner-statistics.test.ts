import { expect, it, vi } from "vitest";
import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  analyzePostgresNamespace,
  analyzePostgresNamespaceSync,
} from "./postgres-planner-statistics.js";

const relations = [{ relname: "ordinary" }, { relname: 'quoted"table' }];

it("analyzes only fully qualified relations in the requested async namespace", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: relations })
    .mockResolvedValueOnce({ rows: [] });
  const assertCurrent = vi.fn();

  await analyzePostgresNamespace({ query } as never, 'tenant"one', assertCurrent);

  expect(query.mock.calls[0]?.[1]).toEqual(['tenant"one']);
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
    query.mock.invocationCallOrder[1] ?? 0,
  );
  expect(query.mock.calls[1]?.[0]).toBe(
    'ANALYZE "tenant""one"."ordinary", "tenant""one"."quoted""table"',
  );
});

it("analyzes only fully qualified relations in the requested sync namespace", () => {
  const all = vi.fn(() => relations);
  const prepare = vi.fn(() => ({ all }));
  const exec = vi.fn();
  const db = { prepare, exec } as unknown as PostgresSqlConnection;
  const assertCurrent = vi.fn();

  analyzePostgresNamespaceSync(db, 'tenant"two', assertCurrent);

  expect(all).toHaveBeenCalledWith('tenant"two');
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
    exec.mock.invocationCallOrder[0] ?? 0,
  );
  expect(exec).toHaveBeenCalledWith(
    'ANALYZE "tenant""two"."ordinary", "tenant""two"."quoted""table"',
  );
});
