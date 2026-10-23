import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloads } from "./deliver.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  RECOVERY_SUMMARY,
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

const { a2aChannelPlugin } = await loadBundledPluginFacade<{ a2aChannelPlugin: ChannelPlugin }>({
  pluginId: "a2a",
  artifactBasename: "channel-plugin-api.ts",
});

describe("A2A delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const cfg = {
    channels: {
      a2a: {
        enabled: true,
        peers: { hermes: { token: "inbound-token" } },
      },
    },
  } satisfies OpenClawConfig;

  beforeEach(() => {
    process.env.OPENCLAW_STATE_DIR = tmpDir();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "a2a", plugin: a2aChannelPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("terminalizes a peer without an outbound URL and never replays it", async () => {
    await enqueueDelivery(
      { channel: "a2a", to: "hermes", payloads: [{ text: "late task result" }] },
      tmpDir(),
    );
    const deliver = vi.fn<DeliverFn>((params) => deliverOutboundPayloads(params));
    const recover = (send: DeliverFn) =>
      recoverPendingDeliveries({
        deliver: asDeliverFn(send),
        log: createRecoveryLog(),
        cfg,
        stateDir: tmpDir(),
      });

    expect(await recover(deliver)).toEqual(RECOVERY_SUMMARY.failed);
    expect(deliver).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir())).toEqual([]);

    const replay = vi.fn<DeliverFn>();
    expect(await recover(replay)).toEqual(RECOVERY_SUMMARY.empty);
    expect(replay).not.toHaveBeenCalled();
  });
});
