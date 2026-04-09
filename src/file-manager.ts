import fs from "fs";
import path from "path";
import os from "os";

const ARCHIVE_BASE = path.join(os.homedir(), "Downloads", "Google Flow");
const DEFAULT_PROJECT_SUBDIR = path.join("assets", "images");
const MAX_SLUG_LENGTH = 50;

export function getArchiveBaseDir(): string {
  return ARCHIVE_BASE;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}

export function buildArchivePath(
  projectName: string | null,
  slug: string,
  variationIndex: number
): string {
  const folder = projectName ?? "General";
  const today = new Date().toISOString().split("T")[0];
  return path.join(ARCHIVE_BASE, folder, today, `${slug}-${variationIndex}.png`);
}

export function buildProjectPath(
  projectDir: string,
  slug: string,
  variationIndex: number,
  customSubpath?: string
): string {
  const subdir = customSubpath ?? DEFAULT_PROJECT_SUBDIR;
  return path.join(projectDir, subdir, `${slug}-${variationIndex}.png`);
}

export async function saveImage(
  buffer: Buffer,
  filePath: string
): Promise<void> {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buffer);
}
