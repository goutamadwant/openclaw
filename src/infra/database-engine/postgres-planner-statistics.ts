import type { Client } from "pg";
import type { PostgresSqlConnection } from "../sql-connection.js";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function analyzeSql(namespace: string, tables: readonly { relname: string }[]): string | undefined {
  if (tables.length === 0) {
    return undefined;
  }
  return `ANALYZE ${tables
    .map(({ relname }) => `${quoteIdentifier(namespace)}.${quoteIdentifier(relname)}`)
    .join(", ")}`;
}

const relationsSql = `SELECT c.relname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm')
  ORDER BY c.relname`;

export async function analyzePostgresNamespace(
  db: Pick<Client, "query">,
  namespace: string,
  assertCurrent: () => void,
): Promise<void> {
  const relations = await db.query<{ relname: string }>(relationsSql, [namespace]);
  const sql = analyzeSql(namespace, relations.rows);
  if (sql) {
    assertCurrent();
    await db.query(sql);
  }
}

export function analyzePostgresNamespaceSync(
  db: PostgresSqlConnection,
  namespace: string,
  assertCurrent: () => void,
): void {
  // SAFETY: The fixed catalog projection above returns relname as PostgreSQL text.
  const tables = db.prepare(relationsSql.replace("$1", "?")).all(namespace) as Array<{
    relname: string;
  }>;
  const sql = analyzeSql(namespace, tables);
  if (sql) {
    assertCurrent();
    db.exec(sql);
  }
}
