/**
 * The organiser's uploaded replay (Nov 10, 2026): which pasted links are a Vimeo video, and the
 * player address built from them. The address is built from the parsed id, never from the pasted
 * text, so nothing an organiser (or another settings writer) stores can become an arbitrary iframe.
 */
import { describe, it, expect } from "vitest";
import { isValidReplayUrl, parseReplayVideo, replayLinkField } from "@/lib/webinar/replay-video";

const embed = (raw: string) => parseReplayVideo(raw)?.embedUrl ?? null;

describe("parseReplayVideo: the Vimeo link shapes an organiser copies", () => {
  it.each([
    ["the video page", "https://vimeo.com/123456789", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["with www and a trailing slash", "https://www.vimeo.com/123456789/", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["an unlisted video: the hash in the path", "https://vimeo.com/123456789/abcdef1234", "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1"],
    ["an unlisted video: the hash as ?h=", "https://vimeo.com/123456789?h=ABCDEF1234", "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1"],
    ["the player address", "https://player.vimeo.com/video/123456789?h=abcdef1234&autoplay=1", "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1"],
    ["the manage page, as copied from the address bar", "https://vimeo.com/manage/videos/123456789", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["the manage page with its hash", "https://vimeo.com/manage/videos/123456789/abcdef1234", "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1"],
    ["a video inside a showcase", "https://vimeo.com/showcase/7654321/video/123456789", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["a video in a channel", "https://vimeo.com/channels/staffpicks/123456789", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["surrounding spaces", "  https://vimeo.com/123456789  ", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["typed without https://", "vimeo.com/123456789/abcdef1234", "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1"],
    ["typed with www and no https://", "www.vimeo.com/123456789", "https://player.vimeo.com/video/123456789?dnt=1"],
    ["a junk ?h= does not hide the hash in the path", "https://vimeo.com/123456789/abcdef1234?h=zz", "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1"],
  ])("%s", (_label, raw, expected) => {
    expect(embed(raw)).toBe(expected);
  });

  it("a page word after the id is not taken for a hash", () => {
    expect(parseReplayVideo("https://vimeo.com/123456789/settings")).toMatchObject({ id: "123456789", hash: null });
    expect(parseReplayVideo("https://vimeo.com/manage/videos/123456789/privacy")?.hash).toBeNull();
  });

  it.each([
    ["a showcase, not a video", "https://vimeo.com/showcase/7654321"],
    ["a live event", "https://vimeo.com/event/7654321"],
    ["a folder", "https://vimeo.com/manage/folders/7654321"],
    ["a profile", "https://vimeo.com/meetingminds"],
    ["the player without /video/", "https://player.vimeo.com/123456789"],
    ["YouTube: it cannot be limited to this site", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["a look-alike host", "https://vimeo.com.evil.example/123456789"],
    ["a host that only ends in vimeo.com", "https://notvimeo.com/123456789"],
    ["Vimeo named in the path of another site", "https://evil.example/vimeo.com/123456789"],
    ["a script address", "javascript:alert(1)//vimeo.com/123456789"],
    ["a data address", "data:text/html,<script>alert(1)</script>"],
    ["not an address", "vimeo 123456789"],
    ["another site typed without a scheme", "evil.example/vimeo.com/123456789"],
    ["a look-alike typed without a scheme", "vimeo.com.evil.example/123456789"],
    ["Vimeo's embed code, not its link", '<iframe src="https://player.vimeo.com/video/123456789"></iframe>'],
    ["empty", ""],
  ])("refuses %s", (_label, raw) => {
    expect(parseReplayVideo(raw)).toBeNull();
    expect(isValidReplayUrl(raw)).toBe(false);
  });

  it("refuses null, undefined and an over-long value", () => {
    expect(parseReplayVideo(null)).toBeNull();
    expect(parseReplayVideo(undefined)).toBeNull();
    expect(parseReplayVideo(`https://vimeo.com/123456789?x=${"a".repeat(500)}`)).toBeNull();
  });

  it("nothing from the pasted text reaches the player address but the id and the hash", () => {
    const url = embed('https://vimeo.com/123456789/abcdef1234?autoplay=1&x="><script>alert(1)</script>#frag');
    expect(url).toBe("https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1");
  });
});

describe("replayLinkField: the settings field", () => {
  it("takes a Vimeo video link, trims it, and takes an empty string to clear", () => {
    expect(replayLinkField.parse("  https://vimeo.com/123456789 ")).toBe("https://vimeo.com/123456789");
    expect(replayLinkField.parse("")).toBe("");
  });

  it("refuses anything else, with a message that says what to paste", () => {
    const bad = replayLinkField.safeParse("https://zoom.us/rec/play/abc");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toContain("Vimeo video link");
  });
});
