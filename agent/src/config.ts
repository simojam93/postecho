import { z } from "zod";

/**
 * Environment contract for the agent process (see .env.example). Every
 * field has a sane default except AGENT_TOKEN, which is the one thing a
 * misconfigured checkout truly cannot run without.
 */
const EnvSchema = z.object({
  POSTECHO_URL: z.string().min(1, "POSTECHO_URL must not be blank").default("http://localhost:3210"),
  AGENT_TOKEN: z.string().min(1, "AGENT_TOKEN is required"),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  CLAUDE_MODEL: z.string().min(1).default("sonnet"),
  POLL_WAIT_SECONDS: z.coerce.number().int().min(0).max(25).default(25),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
});

export type Config = {
  postechoUrl: string;
  agentToken: string;
  claudeBin: string;
  claudeModel: string;
  pollWaitSeconds: number;
  claudeTimeoutMs: number;
};

/**
 * Thrown by loadConfig with every offending env var listed by name, so a
 * misconfigured `.env` fails with one clear message instead of a generic
 * zod dump or (worse) a null-reference deep inside main().
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `  - ${key}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid agent configuration:\n${lines.join("\n")}`);
  }

  const e = parsed.data;
  return {
    postechoUrl: e.POSTECHO_URL,
    agentToken: e.AGENT_TOKEN,
    claudeBin: e.CLAUDE_BIN,
    claudeModel: e.CLAUDE_MODEL,
    pollWaitSeconds: e.POLL_WAIT_SECONDS,
    claudeTimeoutMs: e.CLAUDE_TIMEOUT_MS,
  };
}
