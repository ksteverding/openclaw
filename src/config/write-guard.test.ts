import { describe, expect, it } from "vitest";
import { formatWriteGuardError, validateConfigWriteIntegrity } from "./write-guard.js";

describe("validateConfigWriteIntegrity", () => {
  it("passes when proposed config retains all critical keys", () => {
    const current = {
      meta: { lastTouchedVersion: "1.0" },
      agents: { list: [{ id: "default" }] },
      gateway: { mode: "local", port: 18789 },
      models: { aliases: {} },
      channels: { discord: {} },
    };
    const proposed = {
      ...current,
      gateway: { mode: "local", port: 18790, auth: { mode: "token" } },
    };
    const result = validateConfigWriteIntegrity(current, proposed);
    expect(result.safe).toBe(true);
  });

  it("blocks when critical top-level keys are dropped", () => {
    const current = {
      agents: { list: [{ id: "default" }] },
      gateway: { mode: "local" },
      models: { aliases: {} },
      channels: { discord: {} },
    };
    const proposed = {
      gateway: { mode: "remote" },
    };
    const result = validateConfigWriteIntegrity(current, proposed);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("dropped-critical-keys");
      const droppedMsg = result.violations.find((v) => v.code === "dropped-critical-keys");
      expect(droppedMsg?.message).toContain("agents");
      expect(droppedMsg?.message).toContain("models");
      expect(droppedMsg?.message).toContain("channels");
    }
  });

  it("blocks when >60% of top-level keys are lost", () => {
    const current = {
      agents: {},
      gateway: {},
      models: {},
      channels: {},
      auth: {},
      plugins: {},
      tools: {},
    };
    const proposed = {
      agents: {},
    };
    const result = validateConfigWriteIntegrity(current, proposed);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("excessive-key-loss");
    }
  });

  it("blocks when config size drops >70%", () => {
    const current = {
      agents: { list: [{ id: "default", dir: "/some/path" }] },
      gateway: { mode: "local", port: 18789, bind: "0.0.0.0" },
      models: {
        aliases: { fast: "anthropic/claude", smart: "openai/gpt-4o" },
      },
      channels: {
        discord: { token: "abc123xyz" },
        telegram: { token: "tg-token-here" },
        slack: { token: "slack-token" },
      },
      auth: { mode: "token", token: "gw-token-value" },
      plugins: { entries: { mem: { enabled: true } } },
      tools: { exec: { node: true } },
      skills: { entries: { research: {} } },
      longContent: "x".repeat(600),
    };
    const proposed = {
      agents: { list: [{ id: "default" }] },
    };
    const result = validateConfigWriteIntegrity(current, proposed);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("excessive-size-drop");
    }
  });

  it("passes with force=true even on destructive writes", () => {
    const current = {
      agents: {},
      gateway: {},
      models: {},
      channels: {},
    };
    const proposed = {};
    const result = validateConfigWriteIntegrity(current, proposed, {
      force: true,
    });
    expect(result.safe).toBe(true);
  });

  it("includes source label in violation messages", () => {
    const current = { agents: {}, gateway: {}, models: {} };
    const proposed = {};
    const result = validateConfigWriteIntegrity(current, proposed, {
      source: "config.apply",
    });
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.violations[0].message).toContain("config.apply");
    }
  });

  it("passes when both current and proposed are empty", () => {
    const result = validateConfigWriteIntegrity({}, {});
    expect(result.safe).toBe(true);
  });

  it("passes when current is non-object", () => {
    const result = validateConfigWriteIntegrity(null, { agents: {} });
    expect(result.safe).toBe(true);
  });

  it("warns about non-critical key drops", () => {
    const current = {
      agents: {},
      gateway: {},
      ui: { seamColor: "#ff0000" },
      wizard: { lastRunAt: "2024-01-01" },
    };
    const proposed = { agents: {}, gateway: {} };
    const result = validateConfigWriteIntegrity(current, proposed);
    expect(result.safe).toBe(true);
    if (result.safe) {
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("ui");
      expect(result.warnings[0]).toContain("wizard");
    }
  });
});

describe("formatWriteGuardError", () => {
  it("returns empty string for no violations", () => {
    expect(formatWriteGuardError([])).toBe("");
  });

  it("formats single violation", () => {
    const msg = formatWriteGuardError([{ code: "dropped-critical-keys", message: "lost agents" }]);
    expect(msg).toContain("Config write blocked");
    expect(msg).toContain("lost agents");
  });

  it("formats multiple violations", () => {
    const msg = formatWriteGuardError([
      { code: "dropped-critical-keys", message: "lost agents" },
      { code: "excessive-key-loss", message: "too many keys lost" },
    ]);
    expect(msg).toContain("2 violations");
    expect(msg).toContain("lost agents");
    expect(msg).toContain("too many keys lost");
  });
});
