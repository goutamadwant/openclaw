import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { getScopedDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { analyzePostgresNamespaceSync } from "../infra/database-engine/postgres-planner-statistics.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { openAgentEngineStore } from "../state/openclaw-agent-db-engine.js";

/** Refresh planner statistics after a memory rebuild changes a ported PostgreSQL store. */
export function refreshPortedAgentPlannerStatistics(target: {
  agentId: string;
  path: string;
  assertCurrent: () => void;
}): void {
  if (getScopedDatabaseEngineSelection()?.effectiveEngines.agent !== "postgres") {
    return;
  }
  withEngineStoreAdmission(() => {
    using anchor = openNodeSqliteDatabase(resolveExistingSqliteFileUri(target.path));
    const db = openAgentEngineStore(anchor, target.agentId, target.path, true);
    try {
      if (!isPostgresSqlConnection(db)) {
        throw new Error("Expected the ported agent store to use PostgreSQL");
      }
      const facts = getPostgresPhysicalFacts(db);
      if (!facts) {
        throw new Error("Expected admitted PostgreSQL facts for the ported agent store");
      }
      analyzePostgresNamespaceSync(db, facts.namespace, target.assertCurrent);
    } finally {
      db.close();
    }
  });
}
