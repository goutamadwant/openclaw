import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryReplacements,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);

it("rejects a replacement database before projecting an admitted entry", async () => {
  const storePath = path.join(tempDirs.make("openclaw-replacement-identity-"), "sessions.json");
  const sessionKey = "agent:main:main";
  await upsertSessionEntryCore(
    { storePath, sessionKey },
    { sessionId: "original-session", updatedAt: 10 },
  );
  const entry = loadSessionEntry({ storePath, sessionKey });
  expect(entry).toBeDefined();
  const update = vi.fn(() => ({
    result: undefined,
    replacements: [{ sessionKey, entry: { ...entry!, abortedLastRun: true } }],
  }));

  await expect(
    applySessionEntryReplacements({
      expectedDatabaseIdentity: "replacement-database",
      sessionKeys: [sessionKey],
      storePath,
      update,
    }),
  ).rejects.toThrow("changed its admitted database identity");

  expect(update).not.toHaveBeenCalled();
  expect(loadSessionEntry({ storePath, sessionKey })).toEqual(entry);
});
