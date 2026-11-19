import { describe, expect, it } from "vitest";
import {
  PRESENTATION_MAX_BYTES,
  presentationFileProblem,
  presentationSignatureMatches,
  presentationSlotKey,
  presentationTypeFor,
} from "@/lib/speaker-presentations";

/**
 * The rules of a speaker's presentation upload (Nov 19, 2026;
 * docs/SPEAKER_PRESENTATIONS_PLAN.md): which files, how large, and whether a
 * file is what its name says.
 */
const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? Array.from(p, (c) => c.charCodeAt(0)) : p)));

describe("which files are taken", () => {
  it("decides the type from the extension, whatever its case", () => {
    expect(presentationTypeFor("Deck.PPTX")?.mimeType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(presentationTypeFor("talk.final.mov")?.kind).toBe("video");
    expect(presentationTypeFor("notes.docx")).toBeNull();
    expect(presentationTypeFor("no-extension")).toBeNull();
  });

  it("refuses a type it does not take, an empty file, and one over its cap", () => {
    expect(presentationFileProblem("a.exe", 10)?.code).toBe("TYPE_NOT_ALLOWED");
    expect(presentationFileProblem("a.pdf", 0)?.code).toBe("FILE_EMPTY");
    expect(presentationFileProblem("a.pdf", PRESENTATION_MAX_BYTES.slides + 1)?.code).toBe("FILE_TOO_LARGE");
    expect(presentationFileProblem("a.pdf", PRESENTATION_MAX_BYTES.slides)).toBeNull();
    // Owner, Nov 19, 2026: 200 MB slides, 500 MB video.
    expect(PRESENTATION_MAX_BYTES).toEqual({ slides: 200 * 1024 * 1024, video: 500 * 1024 * 1024 });
    expect(presentationFileProblem("a.mp4", PRESENTATION_MAX_BYTES.slides + 1)).toBeNull();
  });
});

describe("whether a file is what its name says", () => {
  it("knows each type's signature", () => {
    expect(presentationSignatureMatches("pdf", bytes("%PDF-1.7"))).toBe(true);
    expect(presentationSignatureMatches("pptx", bytes([0x50, 0x4b, 0x03, 0x04], "rest"))).toBe(true);
    expect(presentationSignatureMatches("key", bytes([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(presentationSignatureMatches("mp4", bytes([0, 0, 0, 0x20], "ftypisom"))).toBe(true);
  });

  // Review of the plan's first draft: both were wrongly refused.
  it("takes a legacy .ppt (OLE2, not a zip) and a classic QuickTime .mov (no ftyp)", () => {
    expect(presentationSignatureMatches("ppt", bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(true);
    expect(presentationSignatureMatches("ppt", bytes([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    for (const atom of ["moov", "mdat", "wide", "free", "skip", "ftyp"]) {
      expect(presentationSignatureMatches("mov", bytes([0, 0, 0, 8], atom))).toBe(true);
    }
  });

  // A password-protected .pptx is an OLE2 container, not a zip (review of be777c01).
  it("takes a password-protected .pptx, and still not a .key that is not a zip", () => {
    expect(presentationSignatureMatches("pptx", bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(true);
    expect(presentationSignatureMatches("key", bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(false);
  });

  it("refuses text under a slide's name, a short file, and an unknown extension", () => {
    expect(presentationSignatureMatches("pdf", bytes("just some text"))).toBe(false);
    expect(presentationSignatureMatches("mp4", bytes("ftyp"))).toBe(false);
    expect(presentationSignatureMatches("pdf", bytes("%PD"))).toBe(false);
    expect(presentationSignatureMatches("docx", bytes([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });
});

describe("the talk a file is for", () => {
  it("is the topic, else the session, else the general slot", () => {
    expect(presentationSlotKey({ sessionId: "s1", topicId: "t1" })).toBe("topic:t1");
    expect(presentationSlotKey({ sessionId: "s1", topicId: null })).toBe("session:s1");
    expect(presentationSlotKey({ sessionId: null, topicId: null })).toBe("general");
  });
});
