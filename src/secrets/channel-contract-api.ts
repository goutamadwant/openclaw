/** Loads channel secret contract APIs from bundled and external plugin artifacts. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldRejectHardlinkedPluginFiles } from "../plugins/hardlink-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { pluginCacheExistsSync } from "../plugins/plugin-cache-files.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginCacheRoot,
  getPluginCacheSource,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { capturePluginGenerationArtifact } from "../plugins/plugin-generation-artifact.js";
import {
  createUncachedPluginModuleLoader,
  getCachedPluginModuleLoader,
} from "../plugins/plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../plugins/public-surface-loader.js";
import { preparePluginLoaderAliases } from "../plugins/sdk-alias.js";
import { loadOfficialExternalChannelSecretContractApi } from "./official-external-channel-secret-contract.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type BundledChannelSecretContractApi = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
};

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

function loadBundledChannelSecretContractApi(
  channelId: string,
): BundledChannelSecretContractApi | undefined {
  return (
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<BundledChannelSecretContractApi>({
      dirName: channelId,
      artifactCandidates: ["secret-contract-api.js"],
    }) ?? undefined
  );
}

function orderedContractApiExtensions(): readonly string[] {
  return RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
}

function resolvePluginContractApiPath(rootDir: string): string | null {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = "channel-secret-contract";
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached?.modulePath ?? null;
  }
  // Compiled npm-published plugins place their public artifacts under <rootDir>/dist/
  // (per package.json `openclaw.runtimeExtensions`), while flat-layout plugins keep
  // them at <rootDir>/. Search both, preferring dist/ when running from built openclaw
  // artifacts and rootDir/ when running from source.
  const searchDirs = RUNNING_FROM_BUILT_ARTIFACT
    ? [path.join(rootDir, "dist"), rootDir]
    : [rootDir, path.join(rootDir, "dist")];
  for (const basename of ["secret-contract-api", "contract-api"]) {
    for (const dir of searchDirs) {
      for (const extension of orderedContractApiExtensions()) {
        const candidate = path.join(dir, `${basename}${extension}`);
        if (pluginCacheExistsSync(candidate)) {
          artifacts.set(key, { modulePath: candidate, boundaryRoot: rootDir });
          return candidate;
        }
      }
    }
  }
  artifacts.set(key, null);
  return null;
}

const CONTRACT_CAPTURE_MAX_ENTRIES = 4_096;
const CONTRACT_CAPTURE_MAX_TOTAL_ENTRIES = 65_536;
const CONTRACT_CAPTURE_MAX_FILES = 1_024;
const CONTRACT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const CONTRACT_CAPTURE_EXTENSIONS = new Set([...CONTRACT_API_EXTENSIONS, ".json", ".node"]);

function captureComputedContractDependencies(
  artifact: ReturnType<typeof capturePluginGenerationArtifact>,
  rootDir: string,
): void {
  const rootRealPath = fs.realpathSync(rootDir);
  const directories: Array<{ path: string; ancestors: ReadonlySet<string> }> = [
    { path: rootRealPath, ancestors: new Set() },
  ];
  const sourceFiles: string[] = [];
  let entryCount = 0;
  while (directories.length > 0) {
    const pending = directories.pop();
    if (!pending) {
      continue;
    }
    const directory = pending.path;
    const directoryRealPath = fs.realpathSync(directory);
    const relativeDirectory = path.relative(rootRealPath, directoryRealPath);
    if (relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
      throw new Error("Channel secret contract dependency is outside the plugin root");
    }
    if (pending.ancestors.has(directoryRealPath)) {
      throw new Error("Channel secret contract source tree contains a directory cycle");
    }
    const ancestors = new Set(pending.ancestors).add(directoryRealPath);
    const handle = fs.opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        entryCount += 1;
        if (entryCount > CONTRACT_CAPTURE_MAX_ENTRIES) {
          throw new Error("Channel secret contract source tree exceeds the capture entry limit");
        }
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        const source = path.join(directory, entry.name);
        const stat = entry.isSymbolicLink()
          ? fs.statSync(source, { throwIfNoEntry: false })
          : undefined;
        if (entry.isSymbolicLink() && !stat) {
          continue;
        }
        if (entry.isDirectory() || stat?.isDirectory()) {
          directories.push({ path: source, ancestors });
          continue;
        }
        if (
          !(entry.isFile() || stat?.isFile()) ||
          (entry.name !== "package.json" &&
            path.extname(entry.name) !== "" &&
            !CONTRACT_CAPTURE_EXTENSIONS.has(path.extname(entry.name)))
        ) {
          continue;
        }
        const sourceRealPath = fs.realpathSync(source);
        const relativeSource = path.relative(rootRealPath, sourceRealPath);
        if (relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
          throw new Error("Channel secret contract dependency is outside the plugin root");
        }
        sourceFiles.push(source);
      }
    } finally {
      handle.closeSync();
    }
  }
  artifact.captureResolvedModules(sourceFiles, rootRealPath);
}

function loadExternalChannelSecretContractFromRecord(
  record: PluginManifestRecord,
  env: NodeJS.ProcessEnv = process.env,
  throwOnLoadError = false,
  forceRejectHardlinks = false,
  ephemeral = false,
): BundledChannelSecretContractApi | undefined {
  const contractPath = resolvePluginContractApiPath(record.rootDir);
  if (!contractPath) {
    return undefined;
  }
  const rejectHardlinks =
    forceRejectHardlinks ||
    shouldRejectHardlinkedPluginFiles({
      origin: record.origin,
      rootDir: record.rootDir,
      env,
    });
  const cache = getPluginCache();
  const source = ephemeral ? undefined : getPluginCacheSource(contractPath);
  const cacheKey = `${path.resolve(record.rootDir)}\0${path.resolve(contractPath)}\0${rejectHardlinks}`;
  const cached = ephemeral ? undefined : cache.channelSecretContracts.get(cacheKey);
  if (cached) {
    if (cached.status === "loaded") {
      return cached.exports as BundledChannelSecretContractApi;
    }
    if (cached.error && throwOnLoadError) {
      throw cached.error;
    }
    return undefined;
  }
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  let admitted = false;
  let retainArtifact = false;
  let ephemeralContract: BundledChannelSecretContractApi | undefined;
  let loadError: unknown;
  let cleanupError: unknown;
  try {
    artifact = capturePluginGenerationArtifact(
      record.rootDir,
      contractPath,
      (run) => run(),
      undefined,
      undefined,
      undefined,
      {
        maxEntries: CONTRACT_CAPTURE_MAX_TOTAL_ENTRIES,
        maxFiles: CONTRACT_CAPTURE_MAX_FILES,
        maxBytes: CONTRACT_CAPTURE_MAX_BYTES,
        maxFileBytes: CONTRACT_CAPTURE_MAX_BYTES,
        maxTotalBytes: 512 * 1024 * 1024,
      },
    );
    const capturedPath = artifact.resolve(contractPath, rejectHardlinks);
    captureComputedContractDependencies(artifact, record.rootDir);
    artifact.prepareModule(capturedPath);
    if (rejectHardlinks) {
      artifact.assertNoHardlinks();
    }
    const aliases = preparePluginLoaderAliases({
      modulePath: contractPath,
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
    });
    if (aliases.packageRoot) {
      artifact.linkHost(aliases.packageRoot);
    }
    admitted = true;
    const aliasMap = {
      ...aliases.getAliasMap(),
      ...artifact.sourceAliases,
    };
    const loadModule = () =>
      (ephemeral ? createUncachedPluginModuleLoader : getCachedPluginModuleLoader)({
        modulePath: contractPath,
        loaderFilename: capturedPath,
        disableAutomaticTsconfig: true,
        importerUrl: import.meta.url,
        tryNative: false,
        aliasMap,
      })(capturedPath) as BundledChannelSecretContractApi;
    const mod = ephemeral ? withPluginCache(createPluginCache(), loadModule) : loadModule();
    const hasSupportedExports = Boolean(
      mod.collectRuntimeConfigAssignments || mod.secretTargetRegistryEntries,
    );
    if (path.basename(contractPath).startsWith("secret-contract-api.") && !hasSupportedExports) {
      throw new Error(`Channel secret contract for ${record.id} has no supported exports`);
    }
    if (hasSupportedExports && ephemeral) {
      ephemeralContract = mod;
    } else if (hasSupportedExports) {
      const previousDispose = source!.disposeModule;
      source!.disposeModule = () => {
        const failures: unknown[] = [];
        try {
          previousDispose?.();
        } catch (error) {
          failures.push(error);
        }
        try {
          artifact?.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Channel secret contract cleanup failed");
        }
      };
      cache.channelSecretContracts.set(cacheKey, {
        status: "loaded",
        exports: mod,
      });
      retainArtifact = true;
      return mod;
    }
  } catch (error) {
    loadError = admitted
      ? error
      : new Error(`Unable to open channel secret contract for ${record.id}`, { cause: error });
  } finally {
    if (!retainArtifact) {
      try {
        artifact?.dispose();
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  const error =
    loadError && cleanupError
      ? new AggregateError(
          [loadError, cleanupError],
          "Channel secret contract loading and cleanup failed",
          { cause: loadError },
        )
      : (loadError ?? cleanupError);
  if (!ephemeral) {
    cache.channelSecretContracts.set(cacheKey, {
      status: "unavailable",
      ...(error ? { error } : {}),
    });
  }
  if (error) {
    if (throwOnLoadError) {
      throw error;
    }
    return undefined;
  }
  return ephemeralContract;
}

function recordOwnsChannel(record: PluginManifestRecord, channelId: string): boolean {
  return (
    record.channels.includes(channelId) ||
    Object.hasOwn(record.channelConfigs ?? {}, channelId) ||
    record.channelCatalogMeta?.id === channelId ||
    record.packageChannel?.id === channelId
  );
}

function listChannelSecretContractRecords(params: {
  channelId: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): PluginManifestRecord[] {
  const manifestRegistry = resolveConfigWidePluginManifestRegistry({
    config: params.config,
    env: params.env,
  });
  return manifestRegistry.plugins
    .filter((record) => record.origin !== "bundled")
    .filter((record) => recordOwnsChannel(record, params.channelId))
    .filter(
      (record) => !params.loadablePluginOrigins || params.loadablePluginOrigins.has(record.id),
    )
    .toSorted((left, right) => {
      if (left.id === params.channelId && right.id !== params.channelId) {
        return -1;
      }
      if (right.id === params.channelId && left.id !== params.channelId) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    });
}

export function loadChannelSecretContractApi(params: {
  channelId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  bundledOnly?: boolean;
}): BundledChannelSecretContractApi | undefined {
  const bundled = loadBundledChannelSecretContractApi(params.channelId);
  if (bundled || params.bundledOnly) {
    return bundled;
  }
  // External contracts are considered only after bundled artifacts so core channels keep their
  // shipped metadata stable even when similarly named plugins are installed.
  const env = params.env ?? process.env;
  const officialFallback = loadOfficialExternalChannelSecretContractApi(params.channelId);
  let records: PluginManifestRecord[];
  try {
    records = listChannelSecretContractRecords({
      channelId: params.channelId,
      config: params.config,
      env,
      loadablePluginOrigins: params.loadablePluginOrigins,
    });
  } catch (error) {
    // Catalog contracts are process-stable fallbacks when plugin metadata is unavailable.
    if (officialFallback) {
      return officialFallback;
    }
    throw error;
  }
  for (const record of records) {
    const contract = loadExternalChannelSecretContractFromRecord(record, env);
    if (contract) {
      return contract;
    }
  }
  return officialFallback;
}

export function loadChannelSecretContractApiForRecord(
  record: PluginManifestRecord,
  options?: { throwOnLoadError?: boolean; bindToRecord?: boolean; ephemeral?: boolean },
): BundledChannelSecretContractApi | undefined {
  if (record.origin === "bundled" && !options?.bindToRecord) {
    return loadBundledChannelSecretContractApi(record.id);
  }
  return loadExternalChannelSecretContractFromRecord(
    record,
    process.env,
    options?.throwOnLoadError,
    options?.bindToRecord === true,
    options?.ephemeral === true,
  );
}
