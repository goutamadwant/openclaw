import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
} from "./main-session-restart-recovery-fixture.test-support.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));

vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementation(
    actual.appendAssistantMessageToSessionTranscript,
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript:
      transcriptMocks.appendAssistantMessageToSessionTranscript,
  };
});

const gatewayRuntime: GatewayRecoveryRuntime = {
  prepareRestartRecovery: () => undefined,
  dispatchSessionMethod: async () => {
    throw new Error("tombstone race must not dispatch session methods");
  },
  dispatchAgent: async () => {
    throw new Error("tombstone race must not dispatch agents");
  },
  waitForAgent: async () => {
    throw new Error("tombstone race must not wait for agents");
  },
  sendRecoveryNotice: async () => {
    throw new Error("transcript tombstone must not send a provider notice");
  },
};

const sessionKey = "agent:main:main";
let stateDir: string;
const { makeSessionsDir, transcriptFixture, writeStore, writeTranscript } =
  createRestartRecoveryStoreFixture(() => stateDir);

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = transcriptFixture.prepareRoot();
});

afterEach(async () => {
  await transcriptFixture.reset(stateDir);
});

it("defers when another owner tombstones the observed recovery", async () => {
  const sessionsDir = await makeSessionsDir();
  const storePath = path.join(sessionsDir, "sessions.json");
  await writeStore(sessionsDir, {
    [sessionKey]: mainSessionEntry({
      mainRestartRecovery: {
        cycleId: "cycle-exhausted",
        revision: 1,
        chargedAttempts: 3,
      },
    }),
  });
  await writeTranscript(sessionsDir, "main-session", [
    { role: "user", content: "continue this turn" },
  ]);
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(async () => {
    const current = loadSessionEntry({ sessionKey, storePath });
    if (!current?.mainRestartRecovery) {
      throw new Error("expected active restart recovery");
    }
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...current,
        mainRestartRecovery: {
          ...current.mainRestartRecovery,
          revision: current.mainRestartRecovery.revision + 1,
          tombstone: { reason: "concurrent recovery owner" },
        },
      },
    );
    return { ok: false, code: "session-rebound", reason: "session metadata changed" };
  });
  const skipped: string[] = [];

  await expect(
    recoverStore({
      gatewayRuntime,
      handledSessionKeys: new Set(),
      onSkipped: (reason) => skipped.push(reason),
      stateDir,
      storePath,
    }),
  ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });

  expect(skipped).toEqual(["state_changed"]);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    mainRestartRecovery: { tombstone: { reason: "concurrent recovery owner" } },
  });
});
