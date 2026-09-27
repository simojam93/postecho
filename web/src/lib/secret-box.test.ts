import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "@/lib/secret-box";

const envOf = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const env = envOf({ SESSION_SECRET: "s".repeat(40) });

describe("secret-box", () => {
  it("round-trips a secret, and never stores it in the clear", () => {
    const sealed = sealSecret("AAAA%2Fbearer-token-1234", env);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("bearer-token");
    expect(openSecret(sealed, env)).toBe("AAAA%2Fbearer-token-1234");
  });

  it("seals the same secret differently every time (random IV)", () => {
    expect(sealSecret("same", env)).not.toBe(sealSecret("same", env));
  });

  it("opens nothing for empty, foreign, tampered or other-key values", () => {
    const sealed = sealSecret("secret", env);
    expect(openSecret("", env)).toBeNull();
    expect(openSecret(null, env)).toBeNull();
    expect(openSecret("plain-token", env)).toBeNull();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(openSecret(parts.join("."), env)).toBeNull();
    expect(openSecret(sealed, envOf({ SESSION_SECRET: "t".repeat(40) }))).toBeNull();
    expect(openSecret(sealed, envOf({}))).toBeNull();
  });

  it("refuses to seal without a usable SESSION_SECRET", () => {
    expect(() => sealSecret("x", envOf({ SESSION_SECRET: "short" }))).toThrow(/SESSION_SECRET/);
  });
});
