import crypto from "crypto";
import fs from "fs";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";

const ARCHIVE_BASE = path.join(os.homedir(), "Downloads", "Google Flow");
const TEMP_DIR = path.join(os.tmpdir(), "google-flow");
const MAX_SLUG_LENGTH = 50;

export function getArchiveBaseDir(): string {
  return ARCHIVE_BASE;
}

export function slugify(text: string): string {
  const result = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return result || "untitled";
}

export function buildTempPath(slug: string, variationIndex: number): string {
  const hash = crypto.randomBytes(4).toString("hex");
  return path.join(TEMP_DIR, `${slug}-${hash}-${variationIndex}.png`);
}

export function buildArchivePath(
  projectName: string | null,
  smartName: string,
  variationIndex?: number
): string {
  const folder = projectName ?? "General";
  const suffix = variationIndex !== undefined ? `-${variationIndex}` : "";
  return path.join(ARCHIVE_BASE, folder, `${smartName}${suffix}.png`);
}

export function buildProjectPath(
  projectDir: string,
  smartName: string,
  variationIndex?: number
): string {
  const suffix = variationIndex !== undefined ? `-${variationIndex}` : "";
  return path.join(projectDir, "generated-images", `${smartName}${suffix}.png`);
}

export function nextAvailableName(
  dir: string,
  baseName: string
): { name: string; index: number | undefined } {
  const target = path.join(dir, `${baseName}.png`);
  if (!fs.existsSync(target)) {
    return { name: baseName, index: undefined };
  }
  let i = 2;
  while (fs.existsSync(path.join(dir, `${baseName}-${i}.png`))) {
    i++;
  }
  return { name: `${baseName}-${i}`, index: i };
}

export async function saveImage(
  buffer: Buffer,
  filePath: string
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, buffer);
}

export async function cleanTemp(): Promise<void> {
  try {
    await rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
