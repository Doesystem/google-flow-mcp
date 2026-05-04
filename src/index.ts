#!/usr/bin/env node
import http from "http";
import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import crypto from "crypto";
import { AuthManager } from "./auth-manager.js";
import { FlowDriver } from "./flow-driver.js";
import {
  generateJobId,
  buildJobImagePath,
  saveImage,
  getOutputBase,
} from "./file-manager.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const authManager = new AuthManager();

// Reuse a single browser + driver across calls — no re-launching per request
let activeDriver: FlowDriver | null = null;

// ─── Request queue ────────────────────────────────────────────────────────────
// Browser automation is single-threaded — serialize all operations to prevent
// concurrent Playwright actions from corrupting each other.

let queueTail: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(() => fn());
  queueTail = result.then(() => {}, () => {});
  return result;
}

async function getDriver(): Promise<FlowDriver> {
  if (activeDriver) return activeDriver;
  const context = await authManager.getAuthenticatedContext();
  activeDriver = new FlowDriver(context);
  await activeDriver.init();
  return activeDriver;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  send(res, status, { success: false, error: message });
}

async function parseJson(req: http.IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf-8"));
}

/**
 * Download an image from a URL and save it to a temp file.
 * Returns the local file path.
 */
async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText} — ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const dir = path.join(tmpdir(), "google-flow-url");
  await mkdir(dir, { recursive: true });
  const ext = url.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "png";
  const filePath = path.join(dir, `${crypto.randomBytes(6).toString("hex")}.${ext}`);
  await writeFile(filePath, buffer);
  console.error(`[google-flow-mcp] Downloaded URL to temp: ${filePath}`);
  return filePath;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /generate
 * Body: { prompt, image_paths?, image_urls?, aspect_ratio?, count? }
 * Returns: { success, job_id }
 */
async function handleGenerate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { prompt, image_paths, image_urls, aspect_ratio, count } = body;

  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required");
  }

  try {
    // Download URL images before entering the browser queue
    const downloadedPaths: string[] = Array.isArray(image_urls)
      ? await Promise.all((image_urls as string[]).map(downloadToTemp))
      : [];

    const allPaths = [
      ...(Array.isArray(image_paths) ? (image_paths as string[]) : []),
      ...downloadedPaths,
    ];

    const driver = await getDriver();
    const jobId = await enqueue(() => driver.submitGeneration({
      prompt,
      imagePaths: allPaths.length > 0 ? allPaths : undefined,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
      count: typeof count === "number" ? count : 2,
    }));

    send(res, 202, { success: true, job_id: jobId });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /collect
 * Body: {} (empty)
 * Returns: { success, jobs: [{ job_id, images: [{ index, path }] }] }
 */
async function handleCollect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const driver = await getDriver();

    if (!driver.hasPendingJobs) {
      return send(res, 200, { success: true, jobs: [], message: "No pending generations." });
    }

    const { images, jobIds } = await enqueue(() => driver.collectAllImages());
    const outputBase = getOutputBase();

    // Group images by job_id
    const jobMap = new Map<string, { index: number; path: string }[]>();
    for (const jobId of jobIds) {
      jobMap.set(jobId, []);
    }

    for (const image of images) {
      const jobId = image.jobId;
      const filePath = buildJobImagePath(jobId, image.index);
      await saveImage(image.buffer, filePath);
      jobMap.get(jobId)?.push({ index: image.index, path: filePath });
    }

    const jobs = Array.from(jobMap.entries()).map(([job_id, imgs]) => ({
      job_id,
      images: imgs,
    }));

    console.error(`[google-flow-mcp] Saved images to: ${outputBase}`);
    send(res, 200, { success: true, jobs });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /edit
 * Body: { image_paths?, image_urls?, prompt, aspect_ratio? }
 * At least one of image_paths or image_urls is required.
 * Returns: { success, job_id, images: [{ index, path }] }
 */
async function handleEdit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { image_paths, image_urls, prompt, aspect_ratio } = body;

  const hasPaths = Array.isArray(image_paths) && image_paths.length > 0;
  const hasUrls = Array.isArray(image_urls) && image_urls.length > 0;

  if (!hasPaths && !hasUrls) {
    return sendError(res, 400, "image_paths or image_urls is required");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required");
  }

  try {
    const downloadedPaths: string[] = hasUrls
      ? await Promise.all((image_urls as string[]).map(downloadToTemp))
      : [];

    const allPaths = [
      ...(hasPaths ? (image_paths as string[]) : []),
      ...downloadedPaths,
    ];

    const jobId = generateJobId();
    const driver = await getDriver();
    const images = await enqueue(() => driver.edit({
      imagePaths: allPaths,
      prompt,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
      jobId,
    }));

    const saved: { index: number; path: string }[] = [];
    for (const image of images) {
      const filePath = buildJobImagePath(jobId, image.index);
      await saveImage(image.buffer, filePath);
      saved.push({ index: image.index, path: filePath });
    }

    send(res, 200, { success: true, job_id: jobId, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /regen
 * Body: { image_index, prompt?, aspect_ratio? }
 * Returns: { success, job_id, images: [{ index, path }] }
 */
async function handleRegen(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { image_index, prompt, aspect_ratio } = body;

  if (typeof image_index !== "number") {
    return sendError(res, 400, "image_index must be a number");
  }

  try {
    const jobId = generateJobId();
    const driver = await getDriver();
    const images = await enqueue(() => driver.regen({
      imageIndex: image_index,
      prompt: typeof prompt === "string" ? prompt : undefined,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
      jobId,
    }));

    const saved: { index: number; path: string }[] = [];
    for (const image of images) {
      const filePath = buildJobImagePath(jobId, image.index);
      await saveImage(image.buffer, filePath);
      saved.push({ index: image.index, path: filePath });
    }

    send(res, 200, { success: true, job_id: jobId, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "";
  const url = req.url ?? "";

  if (method === "GET" && url === "/health") {
    return send(res, 200, { status: "ok", output_dir: getOutputBase() });
  }

  if (method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    if (url === "/generate") return await handleGenerate(req, res);
    if (url === "/collect") return await handleCollect(req, res);
    if (url === "/edit")     return await handleEdit(req, res);
    if (url === "/regen")    return await handleRegen(req, res);

    sendError(res, 404, `Unknown endpoint: ${url}`);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "auth") {
    await authManager.launchForAuth();
    process.exit(0);
  }

  const server = http.createServer((req, res) => {
    router(req, res).catch((err) => {
      console.error("[google-flow-mcp] Unhandled error:", err);
      if (!res.headersSent) sendError(res, 500, "Internal server error");
    });
  });

  server.listen(PORT, () => {
    console.log(`[google-flow-mcp] REST API listening on http://localhost:${PORT}`);
    console.log(`[google-flow-mcp] Output directory: ${getOutputBase()}`);
    console.log(`[google-flow-mcp] Endpoints:`);
    console.log(`  GET  /health`);
    console.log(`  POST /generate`);
    console.log(`  POST /collect`);
    console.log(`  POST /edit`);
    console.log(`  POST /regen`);
  });
}

main().catch((error) => {
  console.error("[google-flow-mcp] Fatal error:", error);
  process.exit(1);
});
