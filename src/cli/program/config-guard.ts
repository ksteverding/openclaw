import { loadAndMaybeMigrateDoctorConfig } from "../../commands/doctor-config-flow.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { tryRecoverConfigFromBackup } from "../../config/recovery.js";
import type { RuntimeEnv } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { shouldMigrateStateFromPath } from "../argv.js";
import { formatCliCommand } from "../command-format.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function formatConfigIssues(issues: Array<{ path: string; message: string }>): string[] {
  return issues.map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`);
}

async function getConfigSnapshot() {
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  configSnapshotPromise ??= readConfigFileSnapshot();
  return configSnapshotPromise;
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
}): Promise<void> {
  const commandPath = params.commandPath ?? [];
  if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
    didRunDoctorConfigFlow = true;
    await loadAndMaybeMigrateDoctorConfig({
      options: { nonInteractive: true },
      confirm: async () => false,
    });
  }

  const snapshot = await getConfigSnapshot();
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const allowInvalid = commandName
    ? ALLOWED_INVALID_COMMANDS.has(commandName) ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const issues = snapshot.exists && !snapshot.valid ? formatConfigIssues(snapshot.issues) : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0
      ? snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`)
      : [];

  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    return;
  }

  // Attempt auto-recovery from backup before failing
  const recovery = await tryRecoverConfigFromBackup(snapshot.path);
  if (recovery.recovered) {
    const rich = isRich();
    const muted = (value: string) => colorize(rich, theme.muted, value);
    const heading = (value: string) => colorize(rich, theme.heading, value);
    const commandText = (value: string) => colorize(rich, theme.command, value);
    params.runtime.error(
      heading("Config was invalid — automatically restored from backup"),
    );
    params.runtime.error(
      `${muted("Restored from:")} ${muted(recovery.candidate.label)}`,
    );
    params.runtime.error(
      `${muted("The corrupted config was saved to:")} ${muted(shortenHomePath(`${snapshot.path}.corrupted`))}`,
    );
    params.runtime.error(
      `${muted("Run")} ${commandText(formatCliCommand("openclaw doctor --fix"))} ${muted("to review.")}`,
    );
    // Reset cached snapshot so subsequent reads pick up the restored config
    configSnapshotPromise = null;
    return;
  }

  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("Config invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (recovery.backupsChecked > 0) {
    params.runtime.error(
      muted(`Checked ${recovery.backupsChecked} backup(s) but none were valid.`),
    );
  } else {
    params.runtime.error(muted("No backup files available for recovery."));
  }
  params.runtime.error("");
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`,
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}
