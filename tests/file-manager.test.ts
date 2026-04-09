import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import {
  buildArchivePath,
  buildProjectPath,
  slugify,
  saveImage,
  getArchiveBaseDir,
} from "../src/file-manager.js";

describe("slugify", () => {
  test("converts prompt to filename-safe slug", () => {
    expect(slugify("A Hero Banner with Mountains!")).toBe(
      "a-hero-banner-with-mountains"
    );
  });

  test("collapses multiple spaces and special chars", () => {
    expect(slugify("hello   world---foo")).toBe("hello-world-foo");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("truncates long slugs to 50 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(50);
  });
});

describe("buildArchivePath", () => {
  test("uses project name and date subfolder", () => {
    const result = buildArchivePath("My Website", "hero-banner", 1);
    const downloadsDir = path.join(os.homedir(), "Downloads", "Google Flow");
    const today = new Date().toISOString().split("T")[0];
    expect(result).toBe(
      path.join(downloadsDir, "My Website", today, "hero-banner-1.png")
    );
  });

  test("falls back to General when no project name", () => {
    const result = buildArchivePath(null, "hero-banner", 1);
    expect(result).toContain(path.join("Google Flow", "General"));
  });
});

describe("buildProjectPath", () => {
  test("uses default assets/images directory", () => {
    const result = buildProjectPath("/projects/my-site", "hero-banner", 1);
    expect(result).toBe(
      path.join("/projects/my-site", "assets", "images", "hero-banner-1.png")
    );
  });

  test("uses custom subpath when provided", () => {
    const result = buildProjectPath(
      "/projects/my-site",
      "hero-banner",
      1,
      "public/img"
    );
    expect(result).toBe(
      path.join("/projects/my-site", "public", "img", "hero-banner-1.png")
    );
  });
});

describe("saveImage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  test("writes buffer to disk and creates directories", async () => {
    const filePath = path.join(tmpDir, "sub", "dir", "test.png");
    const buffer = Buffer.from("fake-image-data");
    await saveImage(buffer, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath)).toEqual(buffer);
  });
});
