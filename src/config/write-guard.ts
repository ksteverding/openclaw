type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Top-level keys whose removal during a config write is considered destructive.
 * If the existing config has any of these and the new config drops them,
 * the write guard blocks the operation.
 */
const CRITICAL_TOP_LEVEL_KEYS = new Set([
  "agents",
  "gateway",
  "models",
  "channels",
  "auth",
  "plugins",
  "tools",
  "skills",
  "session",
  "messages",
  "commands",
]);

export type WriteGuardViolation = {
  code: "dropped-critical-keys" | "excessive-key-loss" | "excessive-size-drop";
  message: string;
  details?: Record<string, unknown>;
};

export type WriteGuardResult =
  | { safe: true; warnings: string[] }
  | { safe: false; violations: WriteGuardViolation[]; warnings: string[] };

export type WriteGuardOptions = {
  /** Skip all guard checks (e.g. for intentional full-config replacements). */
  force?: boolean;
  /**
   * Source label for better error messages.
   * @example "config.apply", "config.patch", "CLI"
   */
  source?: string;
};

/**
 * Validates that a config write is structurally safe by comparing
 * the proposed config against the current config snapshot.
 *
 * Guards against:
 * 1. Dropping critical top-level keys that were present before
 * 2. Losing >60% of top-level keys
 * 3. Config size dropping >70% (when existing config is non-trivial)
 */
export function validateConfigWriteIntegrity(
  current: unknown,
  proposed: unknown,
  options: WriteGuardOptions = {},
): WriteGuardResult {
  if (options.force) {
    return { safe: true, warnings: [] };
  }

  if (!isPlainObject(current) || !isPlainObject(proposed)) {
    return { safe: true, warnings: [] };
  }

  const currentKeys = new Set(Object.keys(current));
  const proposedKeys = new Set(Object.keys(proposed));
  const violations: WriteGuardViolation[] = [];
  const warnings: string[] = [];
  const sourceLabel = options.source ? ` (source: ${options.source})` : "";

  // Guard 1: detect dropped critical top-level keys
  const droppedCritical: string[] = [];
  for (const key of CRITICAL_TOP_LEVEL_KEYS) {
    if (currentKeys.has(key) && !proposedKeys.has(key)) {
      droppedCritical.push(key);
    }
  }
  if (droppedCritical.length > 0) {
    violations.push({
      code: "dropped-critical-keys",
      message:
        `Config write would remove critical top-level keys: ${droppedCritical.join(", ")}${sourceLabel}. ` +
        "Use config.patch for partial updates instead of replacing the entire config.",
      details: { droppedKeys: droppedCritical },
    });
  }

  // Guard 2: detect excessive key loss (>60% of existing top-level keys removed)
  if (currentKeys.size >= 3) {
    const retained = [...currentKeys].filter((key) => proposedKeys.has(key)).length;
    const retentionRatio = retained / currentKeys.size;
    if (retentionRatio < 0.4) {
      violations.push({
        code: "excessive-key-loss",
        message:
          `Config write would drop ${currentKeys.size - retained} of ${currentKeys.size} top-level keys${sourceLabel}. ` +
          "This looks like an accidental overwrite. Use config.patch for partial updates.",
        details: {
          currentKeyCount: currentKeys.size,
          retainedKeyCount: retained,
          retentionRatio,
        },
      });
    }
  }

  // Guard 3: detect excessive size drop
  const currentJson = JSON.stringify(current);
  const proposedJson = JSON.stringify(proposed);
  if (currentJson.length >= 512 && proposedJson.length < currentJson.length * 0.3) {
    violations.push({
      code: "excessive-size-drop",
      message:
        `Config write would shrink config from ${currentJson.length} to ${proposedJson.length} bytes${sourceLabel}. ` +
        "This looks like an accidental overwrite.",
      details: {
        previousSize: currentJson.length,
        proposedSize: proposedJson.length,
      },
    });
  }

  // Soft warnings for non-critical key drops
  const droppedNonCritical: string[] = [];
  for (const key of currentKeys) {
    if (!CRITICAL_TOP_LEVEL_KEYS.has(key) && !proposedKeys.has(key) && key !== "meta") {
      droppedNonCritical.push(key);
    }
  }
  if (droppedNonCritical.length > 0) {
    warnings.push(`Config write will remove non-critical keys: ${droppedNonCritical.join(", ")}`);
  }

  if (violations.length > 0) {
    return { safe: false, violations, warnings };
  }
  return { safe: true, warnings };
}

/**
 * Formats write guard violations into a single error message
 * suitable for throwing or returning to callers.
 */
export function formatWriteGuardError(violations: WriteGuardViolation[]): string {
  if (violations.length === 0) {
    return "";
  }
  if (violations.length === 1) {
    return `Config write blocked: ${violations[0].message}`;
  }
  const details = violations.map((v) => `- ${v.message}`).join("\n");
  return `Config write blocked (${violations.length} violations):\n${details}`;
}
