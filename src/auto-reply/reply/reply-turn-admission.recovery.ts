import { isDeepStrictEqual } from "node:util";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import {
  isRecoverableTerminalSessionStatus,
  recoverTerminalSessionEntryForVisibleTurn,
} from "../../config/sessions/terminal-status.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getSessionWorkAdmissionOwnerRelease } from "../../sessions/session-lifecycle-admission.js";
import { replyRunRegistry, type ReplyTurnKind } from "./reply-run-registry.js";

/** Prepare the original recovery owner before a later input can take foreground ownership. */
export function prepareReplyRecoveryAdmission(params: {
  agentId?: string;
  allowRestartTombstoneParentFork?: boolean;
  assertCommitAllowed: () => void;
  entry: InternalSessionEntry | undefined;
  expectedDatabaseIdentity?: string | symbol;
  kind: ReplyTurnKind;
  resetTriggered: boolean;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
}):
  | { commit: () => Promise<void>; rearmed: true }
  | { rearmed: false; recoveryOwnerRelease?: Promise<void>; shouldClaimRecoveryOwner: boolean } {
  const { entry, storePath } = params;
  if (!storePath || params.resetTriggered || params.allowRestartTombstoneParentFork === true) {
    return { rearmed: false, shouldClaimRecoveryOwner: false };
  }
  if (
    params.kind !== "heartbeat" &&
    entry?.restartRecoveryHarnessCompletion &&
    isRecoverableTerminalSessionStatus(entry.status) &&
    isMainRestartRecoveryCandidate(entry, params.sessionKey)
  ) {
    return {
      rearmed: true,
      commit: () =>
        applySessionEntryReplacements({
          agentId: params.agentId,
          storePath,
          sessionKeys: [params.sessionKey],
          skipMaintenance: true,
          requireWriteSuccess: true,
          expectedDatabaseIdentity: params.expectedDatabaseIdentity,
          assertCommitAllowed: params.assertCommitAllowed,
          update: (entries) => {
            const current = entries.find(({ sessionKey }) => sessionKey === params.sessionKey);
            return {
              result: undefined,
              replacements:
                current && isDeepStrictEqual(current.entry, entry)
                  ? [
                      {
                        sessionKey: current.sessionKey,
                        entry: recoverTerminalSessionEntryForVisibleTurn(current.entry),
                      },
                    ]
                  : [],
            };
          },
        }),
    };
  }
  // A named admission remains authoritative after recovery clears its durable aborted marker.
  return {
    rearmed: false,
    recoveryOwnerRelease: getSessionWorkAdmissionOwnerRelease({
      scope: storePath,
      identities: [params.sessionKey, params.sessionId],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
    }),
    shouldClaimRecoveryOwner: Boolean(
      entry &&
      ((hasMainSessionRecoveryClaim(entry) && entry.abortedLastRun === true) ||
        (params.kind !== "heartbeat" &&
          entry.restartRecoveryRuns !== undefined &&
          (entry.mainRestartRecovery !== undefined || !replyRunRegistry.get(params.sessionKey))) ||
        entry.mainRestartRecovery?.tombstone !== undefined) &&
      isMainRestartRecoveryCandidate(entry, params.sessionKey),
    ),
  };
}
