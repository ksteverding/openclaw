import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { findValidBackup, tryRecoverConfigFromBackup } from "./recovery.js";

describe("findValidBackup", () => {
  it("returns null when no backup files exist", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const result = findValidBackup(configPath);
      expect(result).toBeNull();
    });
  });

  it("finds the most recent valid backup (.bak)", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, "INVALID JSON {{{", "utf-8");
      await fs.writeFile(
        `${configPath}.bak`,
        JSON.stringify({ gateway: { mode: "local" } }),
        "utf-8",
      );
      const result = findValidBackup(configPath);
      expect(result).not.toBeNull();
      expect(result?.label).toBe(".bak (most recent)");
      expect(result?.config.gateway?.mode).toBe("local");
    });
  });

  it("skips invalid backups and finds the next valid one", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, "INVALID", "utf-8");
      await fs.writeFile(`${configPath}.bak`, "ALSO INVALID {{{", "utf-8");
      await fs.writeFile(`${configPath}.bak.1`, "STILL INVALID", "utf-8");
      await fs.writeFile(
        `${configPath}.bak.2`,
        JSON.stringify({ agents: { list: [{ id: "recovered" }] } }),
        "utf-8",
      );
      const result = findValidBackup(configPath);
      expect(result).not.toBeNull();
      expect(result?.label).toBe(".bak.2");
    });
  });

  it("returns null when all backups are invalid", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(`${configPath}.bak`, "INVALID", "utf-8");
      await fs.writeFile(`${configPath}.bak.1`, "ALSO INVALID", "utf-8");
      const result = findValidBackup(configPath);
      expect(result).toBeNull();
    });
  });
});

describe("tryRecoverConfigFromBackup", () => {
  it("recovers from the most recent valid backup", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, "CORRUPT CONFIG", "utf-8");
      await fs.writeFile(
        `${configPath}.bak`,
        JSON.stringify({ gateway: { mode: "local" } }),
        "utf-8",
      );

      const result = await tryRecoverConfigFromBackup(configPath);
      expect(result.recovered).toBe(true);
      if (result.recovered) {
        expect(result.candidate.config.gateway?.mode).toBe("local");
      }

      // Verify config file was restored
      const restored = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(restored.gateway?.mode).toBe("local");

      // Verify corrupted file was saved
      const corrupted = await fs.readFile(`${configPath}.corrupted`, "utf-8");
      expect(corrupted).toBe("CORRUPT CONFIG");
    });
  });

  it("reports failure when no backups exist", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, "CORRUPT", "utf-8");

      const result = await tryRecoverConfigFromBackup(configPath);
      expect(result.recovered).toBe(false);
      if (!result.recovered) {
        expect(result.backupsChecked).toBe(0);
        expect(result.reason).toContain("no backup files found");
      }
    });
  });

  it("reports failure when all backups are invalid", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, "CORRUPT", "utf-8");
      await fs.writeFile(`${configPath}.bak`, "ALSO CORRUPT", "utf-8");
      await fs.writeFile(`${configPath}.bak.1`, "STILL CORRUPT", "utf-8");

      const result = await tryRecoverConfigFromBackup(configPath);
      expect(result.recovered).toBe(false);
      if (!result.recovered) {
        expect(result.backupsChecked).toBe(2);
        expect(result.reason).toContain("invalid or unreadable");
      }
    });
  });

  it("skips invalid backups and recovers from the next valid one", async () => {
    await withTempHome("openclaw-recovery-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, "CORRUPT", "utf-8");
      await fs.writeFile(`${configPath}.bak`, "BAD BACKUP", "utf-8");
      await fs.writeFile(
        `${configPath}.bak.1`,
        JSON.stringify({ models: { aliases: { fast: "test" } } }),
        "utf-8",
      );

      const result = await tryRecoverConfigFromBackup(configPath);
      expect(result.recovered).toBe(true);
      if (result.recovered) {
        expect(result.candidate.label).toBe(".bak.1");
        expect(result.backupsChecked).toBe(2);
      }
    });
  });
});
