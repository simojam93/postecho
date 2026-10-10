import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("applies defaults when only the required AGENT_TOKEN is set", () => {
    const config = loadConfig({ AGENT_TOKEN: "secret-token" } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      postechoUrl: "http://localhost:3210",
      agentToken: "secret-token",
      claudeBin: "claude",
      claudeModel: "sonnet",
      pollWaitSeconds: 0,
      pollIdleSeconds: 5,
      claudeTimeoutMs: 180000,
      wakePort: 47321,
      awakeMinutes: 10,
      idleCheckMinutes: 0,
    });
  });

  it("reads the wake settings, with 0 turning the wake server off", () => {
    const config = loadConfig({
      AGENT_TOKEN: "t",
      AGENT_WAKE_PORT: "0",
      AGENT_AWAKE_MINUTES: "3",
      AGENT_IDLE_CHECK_MINUTES: "30",
    } as NodeJS.ProcessEnv);

    expect(config.wakePort).toBe(0);
    expect(config.awakeMinutes).toBe(3);
    expect(config.idleCheckMinutes).toBe(30);
  });

  it("rejects a wake port out of range and an awake time under a minute", () => {
    expect(() => loadConfig({ AGENT_TOKEN: "t", AGENT_WAKE_PORT: "70000" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ AGENT_TOKEN: "t", AGENT_AWAKE_MINUTES: "0" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ AGENT_TOKEN: "t", AGENT_IDLE_CHECK_MINUTES: "-1" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });

  it("honors overrides and coerces numeric strings", () => {
    const config = loadConfig({
      POSTECHO_URL: "https://postecho.example.com",
      AGENT_TOKEN: "secret-token",
      CLAUDE_BIN: "/usr/local/bin/claude",
      CLAUDE_MODEL: "opus",
      POLL_WAIT_SECONDS: "10",
      POLL_IDLE_SECONDS: "30",
      CLAUDE_TIMEOUT_MS: "5000",
    } as NodeJS.ProcessEnv);

    expect(config.postechoUrl).toBe("https://postecho.example.com");
    expect(config.claudeBin).toBe("/usr/local/bin/claude");
    expect(config.claudeModel).toBe("opus");
    expect(config.pollWaitSeconds).toBe(10);
    expect(config.pollIdleSeconds).toBe(30);
    expect(config.claudeTimeoutMs).toBe(5000);
  });

  it("throws a ConfigError listing the missing required var", () => {
    try {
      loadConfig({} as NodeJS.ProcessEnv);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("AGENT_TOKEN");
    }
  });

  it("rejects an out-of-range POLL_WAIT_SECONDS", () => {
    expect(() =>
      loadConfig({ AGENT_TOKEN: "t", POLL_WAIT_SECONDS: "999" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("rejects a POLL_IDLE_SECONDS under 1", () => {
    expect(() =>
      loadConfig({ AGENT_TOKEN: "t", POLL_IDLE_SECONDS: "0" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("rejects a non-positive CLAUDE_TIMEOUT_MS", () => {
    expect(() =>
      loadConfig({ AGENT_TOKEN: "t", CLAUDE_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it("rejects a blank AGENT_TOKEN", () => {
    expect(() => loadConfig({ AGENT_TOKEN: "" } as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});
