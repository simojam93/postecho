import { beforeEach, describe, expect, it, vi } from "vitest";
import { YoutubeTranscript } from "youtube-transcript";
import {
  fetchTranscript,
  normalizeTranscript,
  TRANSCRIPT_CHAR_CAP,
  TranscriptUnavailable,
} from "./transcript.js";

vi.mock("youtube-transcript", () => ({
  YoutubeTranscript: { fetchTranscript: vi.fn() },
}));

const mockFetch = vi.mocked(YoutubeTranscript.fetchTranscript);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("normalizeTranscript", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeTranscript("  hello   world\n\nfoo\tbar  ")).toEqual({
      text: "hello world foo bar",
      truncated: false,
    });
  });

  it("caps at TRANSCRIPT_CHAR_CAP and reports truncation", () => {
    const long = "a".repeat(TRANSCRIPT_CHAR_CAP + 500);
    const result = normalizeTranscript(long);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(TRANSCRIPT_CHAR_CAP);
  });

  it("does not report truncation exactly at the cap", () => {
    const exact = "b".repeat(TRANSCRIPT_CHAR_CAP);
    const result = normalizeTranscript(exact);
    expect(result.truncated).toBe(false);
    expect(result.text).toHaveLength(TRANSCRIPT_CHAR_CAP);
  });
});

describe("fetchTranscript", () => {
  it("joins segments with spaces and tries English first by default", async () => {
    mockFetch.mockResolvedValueOnce([
      { text: "hello", duration: 1, offset: 0 },
      { text: "world", duration: 1, offset: 1 },
    ]);

    const result = await fetchTranscript("https://youtu.be/abc123");

    expect(result).toEqual({ text: "hello world", truncated: false, lang: "en" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("https://youtu.be/abc123", { lang: "en" });
  });

  it("falls back to the next language when the first one fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("no english captions"));
    mockFetch.mockResolvedValueOnce([{ text: "ciao", duration: 1, offset: 0 }]);

    const result = await fetchTranscript("https://youtu.be/abc123");

    expect(result).toEqual({ text: "ciao", truncated: false, lang: "it" });
    expect(mockFetch).toHaveBeenNthCalledWith(1, "https://youtu.be/abc123", { lang: "en" });
    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://youtu.be/abc123", { lang: "it" });
  });

  it("also falls back when a language call resolves with an empty transcript", async () => {
    mockFetch.mockResolvedValueOnce([]);
    mockFetch.mockResolvedValueOnce([{ text: "ciao", duration: 1, offset: 0 }]);

    const result = await fetchTranscript("https://youtu.be/abc123");
    expect(result.text).toBe("ciao");
  });

  it("honors a custom langs list, in order", async () => {
    mockFetch.mockRejectedValueOnce(new Error("nope"));
    mockFetch.mockResolvedValueOnce([{ text: "bonjour", duration: 1, offset: 0 }]);

    const result = await fetchTranscript("https://youtu.be/abc123", { langs: ["de", "fr"] });

    expect(result.text).toBe("bonjour");
    expect(mockFetch).toHaveBeenNthCalledWith(1, "https://youtu.be/abc123", { lang: "de" });
    expect(mockFetch).toHaveBeenNthCalledWith(2, "https://youtu.be/abc123", { lang: "fr" });
  });

  it("then takes whatever track the video has — its own captions in the language spoken (2026-09-27)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("no english")).mockRejectedValueOnce(new Error("no italian"));
    mockFetch.mockResolvedValueOnce([{ text: "hola a todos", duration: 1, offset: 0 }]);

    const result = await fetchTranscript("https://youtu.be/abc123");

    expect(result.text).toBe("hola a todos");
    expect(mockFetch).toHaveBeenNthCalledWith(3, "https://youtu.be/abc123", undefined);
  });

  it("throws TranscriptUnavailable with the exact user-facing message when every language fails", async () => {
    mockFetch.mockRejectedValue(new Error("no captions at all"));

    await expect(fetchTranscript("https://youtu.be/abc123")).rejects.toThrow(TranscriptUnavailable);
    await expect(fetchTranscript("https://youtu.be/abc123")).rejects.toThrow(
      "transcript unavailable — paste it in the app",
    );
  });

  it("caps a very long fetched transcript", async () => {
    const segments = Array.from({ length: 20_000 }, (_, i) => ({ text: `word${i}`, duration: 1, offset: i }));
    mockFetch.mockResolvedValueOnce(segments);

    const result = await fetchTranscript("https://youtu.be/abc123");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(TRANSCRIPT_CHAR_CAP);
  });
});
