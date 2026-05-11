#!/usr/bin/env node
import http from "http";
import path from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import crypto from "crypto";
import { AuthManager } from "./auth-manager.js";
import { FlowDriver } from "./flow-driver.js";
import {
  generateJobId,
  buildJobImagePath,
  saveImage,
  getOutputBase,
  saveJobRecord,
  getJobRecord,
  getLastJobRecord,
} from "./file-manager.js";

// Video files use .mp4 extension
function buildJobVideoPath(jobId: string, index: number): string {
  return buildJobImagePath(jobId, index).replace(/\.png$/, ".mp4");
}

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

function imageUrl(jobId: string, index: number): string {
  return `/img/collect/${jobId}/${index}`;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /img/generate
 * Body: { prompt, image_paths?, image_urls?, aspect_ratio?, count? }
 * Returns: { success, job_id, images: [{ index, path, url }] }
 */
async function handleGenerate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { prompt, image_paths, image_urls, aspect_ratio, count } = body;

  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required");
  }

  try {
    const downloadedPaths: string[] = Array.isArray(image_urls)
      ? await Promise.all((image_urls as string[]).map(downloadToTemp))
      : [];

    const allPaths = [
      ...(Array.isArray(image_paths) ? (image_paths as string[]) : []),
      ...downloadedPaths,
    ];

    const jobId = generateJobId();
    const driver = await getDriver();
    const images = await enqueue(() => driver.generate({
      prompt,
      imagePaths: allPaths.length > 0 ? allPaths : undefined,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
      count: typeof count === "number" ? count : 2,
      jobId,
    }));

    const saved: { index: number; path: string; url: string }[] = [];
    for (const image of images) {
      const filePath = buildJobImagePath(jobId, image.index);
      await saveImage(image.buffer, filePath);
      saved.push({ index: image.index, path: filePath, url: imageUrl(jobId, image.index) });
    }

    await saveJobRecord({ job_id: jobId, images: saved, completed_at: Date.now() });
    await authManager.saveStateAfterOperation();
    send(res, 200, { success: true, job_id: jobId, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /collect
 * Body: { job_id? }
 * - no job_id → return the most recent job
 * - with job_id → return that specific job
 * Returns: { success, job_id, images: [{ index, path, url }] }
 */
async function handleCollect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { job_id } = body;

  if (typeof job_id === "string") {
    const result = await getJobRecord(job_id);
    if (!result) {
      return sendError(res, 404, `Job "${job_id}" not found`);
    }
    return send(res, 200, { success: true, job_id: result.job_id, images: result.images });
  }

  const result = await getLastJobRecord();
  if (!result) {
    return send(res, 200, { success: true, job_id: null, images: [], message: "No jobs completed yet." });
  }
  send(res, 200, { success: true, job_id: result.job_id, images: result.images });
}

/**
 * POST /img/edit
 * Body: { image_paths?, image_urls?, prompt, aspect_ratio? }
 * At least one of image_paths or image_urls is required.
 * Returns: { success, job_id, images: [{ index, path, url }] }
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

    const saved: { index: number; path: string; url: string }[] = [];
    for (const image of images) {
      const filePath = buildJobImagePath(jobId, image.index);
      await saveImage(image.buffer, filePath);
      saved.push({ index: image.index, path: filePath, url: imageUrl(jobId, image.index) });
    }

    await saveJobRecord({ job_id: jobId, images: saved, completed_at: Date.now() });
    await authManager.saveStateAfterOperation();
    send(res, 200, { success: true, job_id: jobId, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /img/regen
 * Body: { image_index, prompt?, aspect_ratio? }
 * Returns: { success, job_id, images: [{ index, path, url }] }
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

    const saved: { index: number; path: string; url: string }[] = [];
    for (const image of images) {
      const filePath = buildJobImagePath(jobId, image.index);
      await saveImage(image.buffer, filePath);
      saved.push({ index: image.index, path: filePath, url: imageUrl(jobId, image.index) });
    }

    await saveJobRecord({ job_id: jobId, images: saved, completed_at: Date.now() });
    await authManager.saveStateAfterOperation();
    send(res, 200, { success: true, job_id: jobId, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /video/generate
 * Body: { prompt, image_paths?, image_urls?, video_start?, video_end? }
 * video_start / video_end: URL of image to use as first/last frame
 * Returns: { success, job_id, videos: [{ index, path, url }] }
 */
async function handleGenerateVideo(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { prompt, image_paths, image_urls, video_start, video_end } = body;

  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required");
  }

  try {
    // Download reference images
    const downloadedPaths: string[] = Array.isArray(image_urls)
      ? await Promise.all((image_urls as string[]).map(downloadToTemp))
      : [];

    const allPaths = [
      ...(Array.isArray(image_paths) ? (image_paths as string[]) : []),
      ...downloadedPaths,
    ];

    // Download video start/end frame images
    const videoStartPath = typeof video_start === "string"
      ? await downloadToTemp(video_start)
      : undefined;
    const videoEndPath = typeof video_end === "string"
      ? await downloadToTemp(video_end)
      : undefined;

    const jobId = generateJobId();
    const driver = await getDriver();
    const videos = await enqueue(() => driver.generateVideo({
      prompt,
      imagePaths: allPaths.length > 0 ? allPaths : undefined,
      videoStartPath,
      videoEndPath,
      jobId,
    }));

    const saved: { index: number; path: string; url: string }[] = [];
    for (const video of videos) {
      const filePath = buildJobVideoPath(jobId, video.index);
      await saveImage(video.buffer, filePath);
      saved.push({ index: video.index, path: filePath, url: `/video/collect/${jobId}/${video.index}` });
    }

    await saveJobRecord({ job_id: jobId, images: saved, completed_at: Date.now() });
    await authManager.saveStateAfterOperation();
    send(res, 200, { success: true, job_id: jobId, videos: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

// Match GET /img/collect/{jobId}/{index}
const IMG_ROUTE = /^\/img\/collect\/(job-[\w-]+)\/(\d+)$/;

// Match GET /video/collect/{jobId}/{index}
const VIDEO_ROUTE = /^\/video\/collect\/(job-[\w-]+)\/(\d+)$/;

async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "";
  const url = req.url ?? "";

  // Health check
  if (method === "GET" && url === "/health") {
    return send(res, 200, { status: "ok", output_dir: getOutputBase() });
  }

  // Image serving — GET /img/collect/{jobId}/{index}
  if (method === "GET") {
    const imgMatch = IMG_ROUTE.exec(url);
    if (imgMatch) {
      const [, jobId, indexStr] = imgMatch;
      const filePath = buildJobImagePath(jobId, parseInt(indexStr, 10));
      try {
        const buffer = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": buffer.length,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(buffer);
      } catch {
        sendError(res, 404, `Image not found: ${jobId}/${indexStr}`);
      }
      return;
    }

    const videoMatch = VIDEO_ROUTE.exec(url);
    if (videoMatch) {
      const [, jobId, indexStr] = videoMatch;
      const filePath = buildJobVideoPath(jobId, parseInt(indexStr, 10));
      try {
        const buffer = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": buffer.length,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(buffer);
      } catch {
        sendError(res, 404, `Video not found: ${jobId}/${indexStr}`);
      }
      return;
    }

    return sendError(res, 404, `Not found: ${url}`);
  }

  if (method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    if (url === "/img/generate") return await handleGenerate(req, res);
    if (url === "/collect")      return await handleCollect(req, res);
    if (url === "/img/edit")     return await handleEdit(req, res);
    if (url === "/img/regen")    return await handleRegen(req, res);
    if (url === "/video/generate") return await handleGenerateVideo(req, res);

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
    console.log(`  GET  /img/collect/{jobId}/{index}  (serve image)`);
    console.log(`  GET  /video/collect/{jobId}/{index}  (serve video)`);
    console.log(`  POST /img/generate`);
    console.log(`  POST /video/generate`);
    console.log(`  POST /collect`);
    console.log(`  POST /img/edit`);
    console.log(`  POST /img/regen`);
  });
}

main().catch((error) => {
  console.error("[google-flow-mcp] Fatal error:", error);
  process.exit(1);
});
