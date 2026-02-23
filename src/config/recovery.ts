import fs from "node:fs";
import JSON5 from "json5";
import { CONFIG_BACKUP_COUNT } from "./backup-rotation.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectRaw } from "./validation.js";

export type RecoveryCandidate = {
  path: string;
  label: string;
  config: OpenClawConfig;
};

export type RecoveryResult =
  | { recovered: true; candidate: RecoveryCandidate; backupsChecked: number }
  | { recovered: false; backupsChecked: number; reason: string };

/**
 * Scans backup files (.bak, .bak.1, .bak.2, ...) and returns the first
 * backup that parses and validates successfully.
 */
export function findValidBackup(
  configPath: string,
  ioFs: { existsSync: typeof fs.existsSync; readFileSync: typeof fs.readFileSync } = fs,
  json5: { parse: (raw: string) => unknown } = JSON5,
): RecoveryCandidate | null {
  const candidates = buildBackupCandidates(configPath);
  for (const candidate of candidates) {
    if (!ioFs.existsSync(candidate.path)) {
      continue;
    }
    try {
      const raw = ioFs.readFileSync(candidate.path, "utf-8");
      const parsed = json5.parse(raw);
      const validated = validateConfigObjectRaw(parsed);
      if (validated.ok) {
        return { ...candidate, config: validated.config };
      }
    } catch {
      // backup is corrupt or unreadable; try next
    }
  }
  return null;
}

/**
 * Attempts to recover config from the most recent valid backup.
 * Writes the recovered config back to the primary config path.
 */
export async function tryRecoverConfigFromBackup(
  configPath: string,
  ioFs: {
    existsSync: typeof fs.existsSync;
    readFileSync: typeof fs.readFileSync;
    promises: {
      copyFile: typeof fs.promises.copyFile;
      rename: typeof fs.promises.rename;
    };
  } = fs,
  json5: { parse: (raw: string) => unknown } = JSON5,
): Promise<RecoveryResult> {
  const candidates = buildBackupCandidates(configPath);
  let backupsChecked = 0;

  for (const candidate of candidates) {
    if (!ioFs.existsSync(candidate.path)) {
      continue;
    }
    backupsChecked += 1;
    try {
      const raw = ioFs.readFileSync(candidate.path, "utf-8");
      const parsed = json5.parse(raw);
      const validated = validateConfigObjectRaw(parsed);
      if (!validated.ok) {
        continue;
      }
      // Move corrupted config aside before restoring
      const corruptedPath = `${configPath}.corrupted`;
      if (ioFs.existsSync(configPath)) {
        try {
          await ioFs.promises.rename(configPath, corruptedPath);
        } catch {
          // If rename fails, try copy
          await ioFs.promises.copyFile(configPath, corruptedPath);
        }
      }
      await ioFs.promises.copyFile(candidate.path, configPath);
      return {
        recovered: true,
        candidate: { ...candidate, config: validated.config },
        backupsChecked,
      };
    } catch {
      // backup unreadable or restore failed; try next
    }
  }

  return {
    recovered: false,
    backupsChecked,
    reason:
      backupsChecked === 0 ? "no backup files found" : "all backup files are invalid or unreadable",
  };
}

function buildBackupCandidates(configPath: string): Array<{ path: string; label: string }> {
  const candidates: Array<{ path: string; label: string }> = [];
  candidates.push({ path: `${configPath}.bak`, label: ".bak (most recent)" });
  for (let i = 1; i < CONFIG_BACKUP_COUNT; i++) {
    candidates.push({ path: `${configPath}.bak.${i}`, label: `.bak.${i}` });
  }
  return candidates;
}
