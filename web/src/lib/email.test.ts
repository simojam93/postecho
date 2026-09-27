import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FROM, MAIL_DISABLED_REASON, MailError, sendMail, type MailClient } from "@/lib/email";

const message = { to: "owner@example.com", subject: "Post at 17:00", html: "<p>hi</p>", text: "hi" };

function fakeResend(result: Awaited<ReturnType<MailClient["emails"]["send"]>> = { data: { id: "em_1" }, error: null }) {
  return { emails: { send: vi.fn(async () => result) } };
}

describe("sendMail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the text and reports not sent when RESEND_API_KEY is unset", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = fakeResend();
    const result = await sendMail(message, { env: {}, client });
    expect(result).toEqual({ sent: false, reason: MAIL_DISABLED_REASON });
    expect(client.emails.send).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const logged = String(info.mock.calls[0][0]);
    expect(logged).toContain("Post at 17:00");
    expect(logged).toContain("owner@example.com");
    expect(logged).toContain("\n\nhi");
    expect(logged).not.toContain("<p>");
  });

  it("sends through Resend from the shared test sender by default", async () => {
    const client = fakeResend();
    const result = await sendMail(message, { env: { RESEND_API_KEY: "re_test" }, client });
    expect(result).toEqual({ sent: true, id: "em_1" });
    expect(client.emails.send).toHaveBeenCalledWith({
      from: DEFAULT_FROM, to: "owner@example.com", subject: "Post at 17:00", html: "<p>hi</p>", text: "hi",
    });
    expect(DEFAULT_FROM).toBe("PostEcho <onboarding@resend.dev>");
  });

  it("uses RESEND_FROM when set (blank falls back)", async () => {
    const client = fakeResend();
    await sendMail(message, { env: { RESEND_API_KEY: "re_test", RESEND_FROM: "Me <me@mydomain.dev>" }, client });
    expect(client.emails.send).toHaveBeenCalledWith(expect.objectContaining({ from: "Me <me@mydomain.dev>" }));
    await sendMail(message, { env: { RESEND_API_KEY: "re_test", RESEND_FROM: "  " }, client });
    expect(client.emails.send).toHaveBeenLastCalledWith(expect.objectContaining({ from: DEFAULT_FROM }));
  });

  it("throws a MailError carrying Resend's message on an error response", async () => {
    const client = fakeResend({ data: null, error: { message: "You can only send testing emails to your own email address" } });
    await expect(sendMail(message, { env: { RESEND_API_KEY: "re_test" }, client }))
      .rejects.toThrow(MailError);
    await expect(sendMail(message, { env: { RESEND_API_KEY: "re_test" }, client }))
      .rejects.toThrow(/own email address/);
  });
});
