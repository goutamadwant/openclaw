/** Tests external plugin channel secret contract API loading. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  createPluginCache,
  getPluginCacheSource,
  resetPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const {
  loadPluginMetadataSnapshotMock,
  loadBundledPublicArtifactMock,
  shouldRejectHardlinkedPluginFilesMock,
} = vi.hoisted(() => ({
  loadPluginMetadataSnapshotMock: vi.fn(),
  loadBundledPublicArtifactMock: vi.fn(() => null),
  shouldRejectHardlinkedPluginFilesMock: vi.fn(() => true),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: (...args: unknown[]) => {
    const snapshot = loadPluginMetadataSnapshotMock(...args);
    return snapshot.manifestRegistry ?? snapshot;
  },
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadBundledPublicArtifactMock,
}));

vi.mock("../plugins/hardlink-policy.js", () => ({
  shouldRejectHardlinkedPluginFiles: shouldRejectHardlinkedPluginFilesMock,
}));

import {
  loadChannelSecretContractApi,
  loadChannelSecretContractApiForRecord,
} from "./channel-contract-api.js";

type ChannelSecretContractApi = NonNullable<ReturnType<typeof loadChannelSecretContractApi>>;

function requireChannelSecretContractApi(
  api: ReturnType<typeof loadChannelSecretContractApi>,
): ChannelSecretContractApi {
  if (!api) {
    throw new Error("expected channel secret contract API");
  }
  return api;
}

function expectDiscordTokenRegistryEntry(contractApi: ChannelSecretContractApi): void {
  const entries = contractApi.secretTargetRegistryEntries ?? [];
  const entry = entries.find((record) => record.id === "channels.discord.token");
  expect(entry?.id).toBe("channels.discord.token");
}

function channelSecretContractModuleSource(channelId: string) {
  return `
module.exports = {
  secretTargetRegistryEntries: [
    {
      id: "channels.${channelId}.token",
      targetType: "channels.${channelId}.token",
      configFile: "openclaw.json",
      pathPattern: "channels.${channelId}.token",
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true
    }
  ],
  collectRuntimeConfigAssignments(params) {
    params.context.assignments.push({
      path: "channels.${channelId}.token",
      ref: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
      expected: "string",
      apply() {}
    });
  }
};
`;
}

function writeExternalChannelPlugin(params: {
  pluginId: string;
  channelId: string;
  directory?: string;
}) {
  const rootDir = makeTrackedTempDir("openclaw-channel-secret-contract", tempDirs);
  const contractDir = path.join(rootDir, params.directory ?? "");
  fs.mkdirSync(contractDir, { recursive: true });
  fs.writeFileSync(
    path.join(contractDir, "secret-contract-api.cjs"),
    channelSecretContractModuleSource(params.channelId),
    "utf8",
  );
  return {
    id: params.pluginId,
    origin: "global",
    channels: [params.channelId],
    channelConfigs: {},
    rootDir,
  };
}

describe("external channel secret contract api", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshotMock.mockReset();
    loadBundledPublicArtifactMock.mockClear();
    shouldRejectHardlinkedPluginFilesMock.mockReset();
    shouldRejectHardlinkedPluginFilesMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetPluginCache();
    cleanupTrackedTempDirs(tempDirs);
  });

  it("keeps a healthy external contract available when another artifact fails to load", () => {
    const broken = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    const healthy = writeExternalChannelPlugin({ pluginId: "custom-alt", channelId: "custom" });
    fs.writeFileSync(
      path.join(broken.rootDir, "secret-contract-api.cjs"),
      'throw new Error("contract dependency unavailable");\n',
    );
    loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: [broken, healthy] });

    const api = loadChannelSecretContractApi({ channelId: "custom", config: {}, env: {} });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.custom.token",
    ]);
  });

  it("caches a failed external contract load for the current plugin generation", () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    const markerPath = path.join(record.rootDir, "contract-loads.txt");
    fs.writeFileSync(
      path.join(record.rootDir, "secret-contract-api.cjs"),
      `require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "x");\nthrow new Error("broken contract");\n`,
      "utf8",
    );

    let firstError: unknown;
    try {
      loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      });
    } catch (error) {
      firstError = error;
    }
    const firstExecutionMarker = fs.readFileSync(markerPath, "utf8");
    let secondError: unknown;
    try {
      loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      });
    } catch (error) {
      secondError = error;
    }

    expect(firstError).toBeInstanceOf(Error);
    expect(secondError).toBe(firstError);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(firstExecutionMarker);
  });

  it("captures computed local dependencies used by an external contract", () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    fs.writeFileSync(
      path.join(record.rootDir, "helper.cjs"),
      channelSecretContractModuleSource("computed"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(record.rootDir, "secret-contract-api.cjs"),
      `module.exports = require("./" + ["helper"].join("") + ".cjs");\n`,
      "utf8",
    );

    const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
      throwOnLoadError: true,
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.computed.token",
    ]);
  });

  it("captures extensionless computed CommonJS dependencies", () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    fs.writeFileSync(
      path.join(record.rootDir, "helper"),
      channelSecretContractModuleSource("extensionless"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(record.rootDir, "secret-contract-api.cjs"),
      `module.exports = require("./" + ["helper"].join(""));\n`,
      "utf8",
    );

    const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
      throwOnLoadError: true,
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.extensionless.token",
    ]);
  });

  it.skipIf(process.platform === "win32").each(["file", "directory"])(
    "captures computed dependencies through an in-root %s symlink",
    (shape) => {
      const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
      const realDir = path.join(record.rootDir, "real-deps");
      fs.mkdirSync(realDir);
      fs.writeFileSync(
        path.join(realDir, "helper.cjs"),
        channelSecretContractModuleSource(`symlink-${shape}`),
        "utf8",
      );
      const alias = path.join(record.rootDir, shape === "file" ? "helper-link.cjs" : "deps-link");
      fs.symlinkSync(
        shape === "file" ? path.join(realDir, "helper.cjs") : realDir,
        alias,
        shape === "file" ? "file" : "dir",
      );
      fs.writeFileSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        shape === "file"
          ? `module.exports = require("./" + "helper-link.cjs");\n`
          : `module.exports = require("./" + "deps-link/helper.cjs");\n`,
        "utf8",
      );

      const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      });

      expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
        `channels.symlink-${shape}.token`,
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a canonical computed dependency when its symlink alias is captured first",
    () => {
      const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
      const realDir = path.join(record.rootDir, "real");
      fs.mkdirSync(realDir);
      const helper = path.join(realDir, "helper.cjs");
      fs.writeFileSync(helper, channelSecretContractModuleSource("canonical-after-alias"), "utf8");
      fs.symlinkSync(helper, path.join(record.rootDir, "alias.cjs"), "file");
      fs.writeFileSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        `module.exports = require("./" + "real/helper.cjs");\n`,
        "utf8",
      );

      const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      });

      expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
        "channels.canonical-after-alias.token",
      ]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a canonical computed dependency after statically capturing its symlink alias",
    () => {
      const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
      const realDir = path.join(record.rootDir, "real");
      fs.mkdirSync(realDir);
      const helper = path.join(realDir, "helper.cjs");
      fs.writeFileSync(helper, channelSecretContractModuleSource("canonical-after-static-alias"));
      fs.symlinkSync(helper, path.join(record.rootDir, "alias.cjs"), "file");
      fs.writeFileSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        `require("./alias.cjs");\nmodule.exports = require("./" + "real/helper.cjs");\n`,
        "utf8",
      );

      const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      });

      expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
        "channels.canonical-after-static-alias.token",
      ]);
    },
  );

  it("rejects a contract module without supported exports in strict mode", () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    fs.writeFileSync(
      path.join(record.rootDir, "secret-contract-api.cjs"),
      "module.exports = {};\n",
    );

    expect(() =>
      loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      }),
    ).toThrow("Channel secret contract for custom has no supported exports");
  });

  it.runIf(process.platform !== "win32")(
    "ignores unrelated dangling symlinks while capturing computed dependencies",
    () => {
      const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
      fs.symlinkSync("missing.cjs", path.join(record.rootDir, "dangling.cjs"));

      const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      });

      expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
        "channels.custom.token",
      ]);
    },
  );

  it("captures parent-relative computed dependencies for dist contracts", () => {
    const record = writeExternalChannelPlugin({
      pluginId: "custom",
      channelId: "custom",
      directory: "dist",
    });
    fs.writeFileSync(
      path.join(record.rootDir, "helper.cjs"),
      channelSecretContractModuleSource("parent-computed"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(record.rootDir, "dist", "secret-contract-api.cjs"),
      `module.exports = require("../" + ["helper"].join("") + ".cjs");\n`,
      "utf8",
    );

    const api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
      throwOnLoadError: true,
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.parent-computed.token",
    ]);
  });

  it("does not resolve contract imports through a mutable source tsconfig", () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    const outsideDir = makeTrackedTempDir("openclaw-channel-secret-contract-tsconfig", tempDirs);
    const markerPath = path.join(outsideDir, "executed.txt");
    const outsideHelper = path.join(outsideDir, "helper.cjs");
    fs.writeFileSync(
      outsideHelper,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");\n${channelSecretContractModuleSource("escaped")}`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(record.rootDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@escaped": [outsideHelper] } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(record.rootDir, "secret-contract-api.cjs"),
      'module.exports = require("@escaped");\n',
      "utf8",
    );
    vi.stubEnv("JITI_TSCONFIG_PATHS", "true");

    expect(() =>
      loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
      }),
    ).toThrow("Cannot find module '@escaped'");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("disposes captured contracts once when an operation cache retires", async () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    const cache = createPluginCache();
    const contractPath = path.join(record.rootDir, "secret-contract-api.cjs");
    const dispose = withPluginCache(cache, () => {
      expect(
        loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
          throwOnLoadError: true,
        }),
      ).toBeDefined();
      const source = getPluginCacheSource(contractPath);
      const originalDispose = source.disposeModule;
      const trackedDispose = vi.fn(() => originalDispose?.());
      source.disposeModule = trackedDispose;
      return trackedDispose;
    });

    await retirePluginCache(cache);
    await retirePluginCache(cache);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not retain source-generation loaders or contract artifacts", () => {
    const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
    const cache = createPluginCache();

    const api = withPluginCache(cache, () =>
      loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
        throwOnLoadError: true,
        ephemeral: true,
      }),
    );

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.custom.token",
    ]);
    expect(cache.channelSecretContracts.size).toBe(0);
    expect(cache.moduleLoaders.size).toBe(0);
    expect(cache.sources.size).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a hardlinked computed dependency under strict admission",
    () => {
      const record = writeExternalChannelPlugin({ pluginId: "custom", channelId: "custom" });
      const outsideDir = makeTrackedTempDir(
        "openclaw-channel-secret-contract-helper-outside",
        tempDirs,
      );
      const outsideHelper = path.join(outsideDir, "helper.cjs");
      fs.writeFileSync(outsideHelper, channelSecretContractModuleSource("computed"), "utf8");
      fs.linkSync(outsideHelper, path.join(record.rootDir, "helper.cjs"));
      fs.writeFileSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        `module.exports = require("./" + ["helper"].join("") + ".cjs");\n`,
        "utf8",
      );

      expect(() =>
        loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
          throwOnLoadError: true,
          bindToRecord: true,
        }),
      ).toThrow("Unable to open channel secret contract for custom");
    },
  );

  it("loads dist/ secret-contract-api sidecars for compiled npm-published external channel plugins", () => {
    const record = writeExternalChannelPlugin({
      pluginId: "discord",
      channelId: "discord",
      directory: "dist",
    });
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [record],
    });

    const api = loadChannelSecretContractApi({
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["discord", "global"]]),
    });

    const contractApi = requireChannelSecretContractApi(api);
    expectDiscordTokenRegistryEntry(contractApi);
    expect(contractApi.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it.runIf(process.platform !== "win32")(
    "loads hardlinked external channel contracts when the plugin hardlink policy allows them",
    () => {
      const record = writeExternalChannelPlugin({ pluginId: "discord", channelId: "discord" });
      const outsideDir = makeTrackedTempDir(
        "openclaw-channel-secret-contract-hardlink-outside",
        tempDirs,
      );
      fs.linkSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        path.join(outsideDir, "secret-contract-api.cjs"),
      );
      shouldRejectHardlinkedPluginFilesMock.mockReturnValue(false);
      const env = { OPENCLAW_NIX_MODE: "1" };
      loadPluginMetadataSnapshotMock.mockReturnValue({
        plugins: [record],
      });

      const api = loadChannelSecretContractApi({
        channelId: "discord",
        config: { channels: { discord: {} } },
        env,
        loadablePluginOrigins: new Map([["discord", "global"]]),
      });

      expect(shouldRejectHardlinkedPluginFilesMock).toHaveBeenCalledWith({
        origin: "global",
        rootDir: record.rootDir,
        env,
      });
      const contractApi = requireChannelSecretContractApi(api);
      expectDiscordTokenRegistryEntry(contractApi);
      expect(() =>
        loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
          throwOnLoadError: true,
          bindToRecord: true,
        }),
      ).toThrow("Unable to open channel secret contract for discord");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not execute a contract replacement after source admission",
    () => {
      const record = writeExternalChannelPlugin({ pluginId: "discord", channelId: "discord" });
      const contractPath = path.join(record.rootDir, "secret-contract-api.cjs");
      const outsideDir = makeTrackedTempDir(
        "openclaw-channel-secret-contract-race-outside",
        tempDirs,
      );
      const replacementPath = path.join(outsideDir, "secret-contract-api.cjs");
      fs.writeFileSync(replacementPath, channelSecretContractModuleSource("replacement"), "utf8");
      const closeSync = fs.closeSync.bind(fs);
      let replaced = false;
      const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        closeSync(fd);
        if (!replaced) {
          replaced = true;
          fs.unlinkSync(contractPath);
          fs.linkSync(replacementPath, contractPath);
        }
      });

      let api: ReturnType<typeof loadChannelSecretContractApiForRecord>;
      let loadError: unknown;
      try {
        api = loadChannelSecretContractApiForRecord(record as PluginManifestRecord, {
          throwOnLoadError: true,
        });
      } catch (error) {
        loadError = error;
      } finally {
        closeSpy.mockRestore();
      }

      expect(replaced).toBe(true);
      expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id) ?? []).not.toContain(
        "channels.replacement.token",
      );
      if (!api) {
        expect(loadError).toBeInstanceOf(Error);
      }
    },
  );

  it("skips external channel records outside the loadable plugin origin set", () => {
    const record = writeExternalChannelPlugin({ pluginId: "discord", channelId: "discord" });
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [record],
    });

    const api = loadChannelSecretContractApi({
      channelId: "discord",
      config: { channels: { discord: {} } },
      env: {},
      loadablePluginOrigins: new Map([["other", "global"]]),
    });

    expect(api).toBeUndefined();
  });

  it("falls back to official host secret metadata when an external plugin has no artifact", () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: [] });

    const api = loadChannelSecretContractApi({
      channelId: "qqbot",
      config: { channels: { qqbot: { appId: "app" } } },
      env: {},
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.qqbot.accounts.*.clientSecret",
      "channels.qqbot.clientSecret",
    ]);
    expect(api?.collectRuntimeConfigAssignments).toBeTypeOf("function");
  });

  it("falls back to official host secret metadata when plugin metadata is unavailable", () => {
    loadPluginMetadataSnapshotMock.mockImplementation(() => {
      throw new Error("metadata unavailable");
    });

    const api = loadChannelSecretContractApi({
      channelId: "qqbot",
      config: { channels: { qqbot: { appId: "app" } } },
      env: {},
    });

    expect(api?.secretTargetRegistryEntries?.map((entry) => entry.id)).toEqual([
      "channels.qqbot.accounts.*.clientSecret",
      "channels.qqbot.clientSecret",
    ]);
  });

  it("does not hide installed plugin contract loading failures behind the official fallback", () => {
    const record = writeExternalChannelPlugin({ pluginId: "qqbot", channelId: "qqbot" });
    loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: [record] });
    shouldRejectHardlinkedPluginFilesMock.mockImplementation(() => {
      throw new Error("contract policy failed");
    });

    expect(() =>
      loadChannelSecretContractApi({
        channelId: "qqbot",
        config: { channels: { qqbot: { appId: "app" } } },
        env: {},
      }),
    ).toThrow("contract policy failed");
  });
});
