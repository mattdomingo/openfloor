import { describe, expect, it } from "vitest";
import {
  formatSessionFileSize,
  MAX_SESSION_FILES_PER_UPLOAD,
  sanitizeSessionFileName,
  sessionUploadErrorMessage,
  validateSessionFileUploads,
} from "@/lib/session-file-constraints";

describe("session file constraints and upload error helpers", () => {
  it("formats file sizes cleanly", () => {
    expect(formatSessionFileSize(500)).toBe("1 KB");
    expect(formatSessionFileSize(1024)).toBe("1 KB");
    expect(formatSessionFileSize(50 * 1024)).toBe("50 KB");
    expect(formatSessionFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSessionFileSize(8 * 1024 * 1024)).toBe("8.0 MB");
    expect(formatSessionFileSize(25 * 1024 * 1024)).toBe("25.0 MB");
  });

  it("sanitizes file names to single safe lines", () => {
    expect(sanitizeSessionFileName("simple.png")).toBe("simple.png");
    expect(sanitizeSessionFileName("path/to/nested\\file.txt")).toBe("path to nested file.txt");
    expect(sanitizeSessionFileName("  spaced   name.pdf  ")).toBe("spaced name.pdf");
    expect(sanitizeSessionFileName("")).toBe("file");
  });

  it("validates upload file limits and provides descriptive errors", () => {
    // Valid files
    expect(validateSessionFileUploads([{ name: "doc.pdf", size: 1024 }])).toBeNull();
    expect(validateSessionFileUploads([
      { name: "1.png", size: 100 },
      { name: "2.png", size: 200 },
    ])).toBeNull();

    // Too many files
    const tooMany = Array.from({ length: MAX_SESSION_FILES_PER_UPLOAD + 1 }, (_, i) => ({
      name: `file-${i}.txt`,
      size: 100,
    }));
    expect(validateSessionFileUploads(tooMany)).toBe("You can upload at most 8 files at a time.");

    // Oversized file (e.g. video)
    const oversized = [
      { name: "notes.txt", size: 500 },
      { name: "video.mp4", size: 25 * 1024 * 1024 },
    ];
    expect(validateSessionFileUploads(oversized)).toBe(
      '"video.mp4" is too large (25.0 MB). Files must be 8MB or smaller.',
    );

    // Empty file (0 bytes)
    const emptyFile = [{ name: "empty.log", size: 0 }];
    expect(validateSessionFileUploads(emptyFile)).toBe('"empty.log" is empty. Files must be at least 1 byte.');
  });

  it("translates HTTP status codes into clear human explanations without error codes", () => {
    // Server-provided message takes precedence
    expect(sessionUploadErrorMessage(400, "Each file must be between 1 byte and 8MB")).toBe(
      "Each file must be between 1 byte and 8MB",
    );
    expect(sessionUploadErrorMessage(500, "Storage quota exceeded")).toBe("Storage quota exceeded");

    // Status code fallbacks without raw error codes
    expect(sessionUploadErrorMessage(413)).toBe(
      "The upload is too large. Each file must be 8MB or smaller.",
    );
    expect(sessionUploadErrorMessage(400)).toBe(
      "The upload request was invalid. Each file must be between 1 byte and 8MB.",
    );
    expect(sessionUploadErrorMessage(401)).toBe(
      "You do not have permission to upload files to this session.",
    );
    expect(sessionUploadErrorMessage(403)).toBe(
      "You do not have permission to upload files to this session.",
    );
    expect(sessionUploadErrorMessage(404)).toBe("Session not found.");
    expect(sessionUploadErrorMessage(408)).toBe("The upload timed out. Please try again.");
    expect(sessionUploadErrorMessage(504)).toBe("The upload timed out. Please try again.");
    expect(sessionUploadErrorMessage(502)).toBe(
      "File upload is temporarily unavailable. Please try again shortly.",
    );
    expect(sessionUploadErrorMessage(503)).toBe(
      "File upload is temporarily unavailable. Please try again shortly.",
    );
    expect(sessionUploadErrorMessage(500)).toBe(
      "The upload could not be completed. Please try again.",
    );
  });
});
