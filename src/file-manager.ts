import crypto from "crypto";
import fs from "fs";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import path from "path";
import os from "os";

export const OUTPUT_BASE = path.join(os.homedir(), "GoogleFlow");
const TEMP_DIR = path.join(os.tmpdir(), "google-flow");
const JOBS_FILE = path.join(OUTPUT_BASE, "jobs.json");

export function getOutputBase(): string {
  return OUTPUT_BASE;
}

/** Generate a job ID based on current timestamp: job-20260505-143022 */
export function generateJobId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  return `job-${date}-${time}`;
}

/** Build path for a generated image inside a job folder */
export function buildJobImagePath(jobId: string, index: number): string {
  return path.join(OUTPUT_BASE, jobId, `${index}.png`);
}

/** Save a buffer to a file, creating parent directories as needed */
export async function saveImage(buffer: Buffer, filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
}

/** Build a temp path for URL-downloaded images */
export function buildTempPath(ext = "png"): string {
  const hash = crypto.randomBytes(6).toString("hex");
  return path.join(TEMP_DIR, `${hash}.${ext}`);
}

/** Clean up the temp directory */
export async function cleanTemp(): Promise<void> {
  try {
    await rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "untitled";
}

// ─── Job store (persisted to ~/GoogleFlow/jobs.json) ─────────────────────────

export interface JobRecord {
  job_id: string;
  images: { index: number; path: string }[];
  completed_at: number;
}

interface JobsFile {
  last_job_id: string | null;
  jobs: Record<string, JobRecord>;
}

async function readJobsFile(): Promise<JobsFile> {
  try {
    const raw = await readFile(JOBS_FILE, "utf-8");
    return JSON.parse(raw) as JobsFile;
  } catch {
    return { last_job_id: null, jobs: {} };
  }
}

async function writeJobsFile(data: JobsFile): Promise<void> {
  await mkdir(OUTPUT_BASE, { recursive: true });
  await writeFile(JOBS_FILE, JSON.stringify(data, null, 2));
}

export async function saveJobRecord(record: JobRecord): Promise<void> {
  const data = await readJobsFile();
  data.jobs[record.job_id] = record;
  data.last_job_id = record.job_id;
  await writeJobsFile(data);
}

export async function getJobRecord(jobId: string): Promise<JobRecord | null> {
  const data = await readJobsFile();
  return data.jobs[jobId] ?? null;
}

export async function getLastJobRecord(): Promise<JobRecord | null> {
  const data = await readJobsFile();
  if (!data.last_job_id) return null;
  return data.jobs[data.last_job_id] ?? null;
}
