import fs from "node:fs";
import { isPathInside } from "../infra/path-guards.js";
import {
  createPluginNativeAdmission,
  type PluginNativeRecovery,
} from "./plugin-native-admission.js";

export type PluginGenerationCaptureBudget = {
  maxEntries: number;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export function createPluginGenerationCaptureBudget(
  rootDir: string,
  budget?: PluginGenerationCaptureBudget,
) {
  const canonicalRootDir = fs.realpathSync(rootDir);
  let fileCount = 0;
  let byteCount = 0;
  let totalByteCount = 0;
  let entryCount = 0;
  const reserveEntry = () => {
    entryCount += 1;
    if (budget && entryCount > budget.maxEntries) {
      throw new Error("Plugin source capture exceeds its entry budget");
    }
  };
  const reserveFile = (source: string, sizeBytes: number) => {
    totalByteCount += sizeBytes;
    if (budget && (sizeBytes > budget.maxFileBytes || totalByteCount > budget.maxTotalBytes)) {
      throw new Error("Plugin source capture exceeds its total byte budget");
    }
    if (!isPathInside(canonicalRootDir, source)) {
      return;
    }
    fileCount += 1;
    byteCount += sizeBytes;
    if (budget && (fileCount > budget.maxFiles || byteCount > budget.maxBytes)) {
      throw new Error("Plugin source capture exceeds its file budget");
    }
  };
  return {
    directoryEntryLimit: budget?.maxEntries,
    reserveEntry,
    reserveFile,
    readDirectoryNames(directory: string): string[] {
      const names: string[] = [];
      const handle = fs.opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          reserveEntry();
          names.push(entry.name);
        }
      } finally {
        handle.closeSync();
      }
      return names.toSorted();
    },
  };
}

export function createBudgetedPluginNativeAdmission(params: {
  rootDir: string;
  directory: string;
  entryFile?: string;
  recovery?: PluginNativeRecovery;
  outputRoot?: string;
  captureBudget?: PluginGenerationCaptureBudget;
  hardlinkedSources: Set<string>;
}) {
  const budget = createPluginGenerationCaptureBudget(params.rootDir, params.captureBudget);
  const nativeAdmission = createPluginNativeAdmission(
    params.rootDir,
    params.directory,
    params.entryFile,
    params.recovery,
    params.outputRoot,
    params.captureBudget
      ? {
          onDirectoryEntry: budget.reserveEntry,
          onSourceDescriptor(source, stat, admittedHardlink) {
            budget.reserveFile(source, Number(stat.size));
            if (stat.nlink > 1n && !admittedHardlink) {
              params.hardlinkedSources.add(source);
            }
          },
        }
      : undefined,
  );
  return { budget, nativeAdmission };
}
