#!/usr/bin/env node
import http from "http";
import path from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import crypto from "crypto";
import { AuthManager } from "./auth-manager.js";
import { FlowDriver } from "./flow-driver.js";
import {
  slugify,
  nextAvailableName,
  saveImage,
  cleanTemp,
  getArchiveBaseDir,
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
  // Advance the tail — swallow errors so the queue keeps moving
  queueTail = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function getDriver(): Promise<FlowDriver> {
  if (activeDriver) return activeDriver;

  const context = await authManager.getAuthenticatedContext();
  activeDriver = new FlowDriver(context);
  await activeDriver.init();
  return activeDriver;
}

function getProjectName(): string | null {
  const cwd = process.cwd();
  return path.basename(cwd) || null;
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
  if (!res.ok) throw new Error(`Failed to download image from URL: ${res.status} ${res.statusText}`);
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
 * Body: { prompt, image_paths?, aspect_ratio?, count? }
 * Returns: { success, job_id, message }
 */
async function handleGenerate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { prompt, image_paths, aspect_ratio, count } = body;

  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required");
  }

  try {
    const driver = await getDriver();
    const jobId = await enqueue(() => driver.submitGeneration({
      prompt,
      imagePaths: Array.isArray(image_paths) ? (image_paths as string[]) : undefined,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
      count: typeof count === "number" ? count : 2,
    }));

    send(res, 202, {
      success: true,
      job_id: jobId,
      message: `Generation submitted as ${jobId}: "${prompt}"`,
    });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /collect
 * Body: { project_dir }
 * Returns: { success, images: [{ project_path, archive_path }] }
 */
async function handleCollect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { project_dir } = body;

  if (typeof project_dir !== "string" || !project_dir.trim()) {
    return sendError(res, 400, "project_dir is required");
  }

  try {
    const driver = await getDriver();

    if (!driver.hasPendingJobs) {
      return send(res, 200, {
        success: true,
        images: [],
        message: "No pending generations to collect.",
      });
    }

    const images = await enqueue(() => driver.collectAllImages());
    const projectName = getProjectName();
    const projectImagesDir = path.join(project_dir, "generated-images");
    const saved: { project_path: string; archive_path: string }[] = [];

    for (const image of images) {
      const smartName = `generation-${image.index}`;
      const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");

      const { name: projectFileName } = nextAvailableName(projectImagesDir, smartName);
      const { name: archiveName } = nextAvailableName(archiveDir, smartName);

      const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);
      const archivePath = path.join(archiveDir, `${archiveName}.png`);

      await saveImage(image.buffer, projectPath);
      await saveImage(image.buffer, archivePath);
      saved.push({ project_path: projectPath, archive_path: archivePath });
    }

    send(res, 200, { success: true, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /save
 * Body: { temp_paths, smart_name, project_dir }
 * Returns: { success, saved: [{ project_path, archive_path }] }
 */
async function handleSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { temp_paths, smart_name, project_dir } = body;

  if (!Array.isArray(temp_paths) || temp_paths.length === 0) {
    return sendError(res, 400, "temp_paths must be a non-empty array");
  }
  if (typeof smart_name !== "string" || !smart_name.trim()) {
    return sendError(res, 400, "smart_name is required");
  }
  if (typeof project_dir !== "string" || !project_dir.trim()) {
    return sendError(res, 400, "project_dir is required");
  }

  try {
    const projectName = getProjectName();
    const projectImagesDir = path.join(project_dir, "generated-images");
    const safeName = slugify(smart_name);
    const saved: { project_path: string; archive_path: string }[] = [];

    for (let i = 0; i < temp_paths.length; i++) {
      const buffer = await readFile(temp_paths[i] as string);
      const variationIndex = temp_paths.length > 1 ? i + 1 : undefined;

      const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");
      const archiveName = variationIndex !== undefined
        ? `${safeName}-${variationIndex}`
        : nextAvailableName(archiveDir, safeName).name;
      const projectFileName = variationIndex !== undefined
        ? `${safeName}-${variationIndex}`
        : nextAvailableName(projectImagesDir, safeName).name;

      const archivePath = path.join(archiveDir, `${archiveName}.png`);
      const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);

      await saveImage(Buffer.from(buffer), archivePath);
      await saveImage(Buffer.from(buffer), projectPath);
      saved.push({ project_path: projectPath, archive_path: archivePath });
    }

    await cleanTemp();
    send(res, 200, { success: true, saved });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /edit
 * Body: { image_paths?, image_urls?, prompt, aspect_ratio?, project_dir }
 * At least one of image_paths or image_urls is required.
 * Returns: { success, images: [{ project_path, archive_path }] }
 */
async function handleEdit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { image_paths, image_urls, prompt, aspect_ratio, project_dir } = body;

  const hasPaths = Array.isArray(image_paths) && image_paths.length > 0;
  const hasUrls = Array.isArray(image_urls) && image_urls.length > 0;

  if (!hasPaths && !hasUrls) {
    return sendError(res, 400, "image_paths or image_urls is required");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendError(res, 400, "prompt is required");
  }
  if (typeof project_dir !== "string" || !project_dir.trim()) {
    return sendError(res, 400, "project_dir is required");
  }

  try {
    // Download URL images to temp files first (outside the browser queue)
    const downloadedPaths: string[] = hasUrls
      ? await Promise.all((image_urls as string[]).map(downloadToTemp))
      : [];

    const allPaths = [
      ...(hasPaths ? (image_paths as string[]) : []),
      ...downloadedPaths,
    ];

    const driver = await getDriver();
    const images = await enqueue(() => driver.edit({
      imagePaths: allPaths,
      prompt,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
    }));

    const smartName = slugify(prompt);
    const projectName = getProjectName();
    const projectImagesDir = path.join(project_dir, "generated-images");
    const saved: { project_path: string; archive_path: string }[] = [];

    for (const image of images) {
      const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");
      const { name: projectFileName } = nextAvailableName(projectImagesDir, smartName);
      const { name: archiveName } = nextAvailableName(archiveDir, smartName);

      const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);
      const archivePath = path.join(archiveDir, `${archiveName}.png`);

      await saveImage(image.buffer, projectPath);
      await saveImage(image.buffer, archivePath);
      saved.push({ project_path: projectPath, archive_path: archivePath });
    }

    send(res, 200, { success: true, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /regen
 * Body: { image_index, prompt?, aspect_ratio?, project_dir }
 * Returns: { success, images: [{ project_path, archive_path }] }
 */
async function handleRegen(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await parseJson(req) as Record<string, unknown>;
  const { image_index, prompt, aspect_ratio, project_dir } = body;

  if (typeof image_index !== "number") {
    return sendError(res, 400, "image_index must be a number");
  }
  if (typeof project_dir !== "string" || !project_dir.trim()) {
    return sendError(res, 400, "project_dir is required");
  }

  try {
    const driver = await getDriver();
    const images = await enqueue(() => driver.regen({
      imageIndex: image_index,
      prompt: typeof prompt === "string" ? prompt : undefined,
      aspectRatio: typeof aspect_ratio === "string" ? aspect_ratio : undefined,
    }));

    const smartName = slugify(typeof prompt === "string" ? prompt : `regen-${image_index}`);
    const projectName = getProjectName();
    const projectImagesDir = path.join(project_dir, "generated-images");
    const saved: { project_path: string; archive_path: string }[] = [];

    for (const image of images) {
      const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");
      const { name: projectFileName } = nextAvailableName(projectImagesDir, smartName);
      const { name: archiveName } = nextAvailableName(archiveDir, smartName);

      const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);
      const archivePath = path.join(archiveDir, `${archiveName}.png`);

      await saveImage(image.buffer, projectPath);
      await saveImage(image.buffer, archivePath);
      saved.push({ project_path: projectPath, archive_path: archivePath });
    }

    send(res, 200, { success: true, images: saved });
  } catch (error) {
    activeDriver = null;
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? "";
  const url = req.url ?? "";

  // Health check
  if (method === "GET" && url === "/health") {
    return send(res, 200, { status: "ok" });
  }

  if (method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    if (url === "/generate") return await handleGenerate(req, res);
    if (url === "/collect") return await handleCollect(req, res);
    if (url === "/save") return await handleSave(req, res);
    if (url === "/edit") return await handleEdit(req, res);
    if (url === "/regen") return await handleRegen(req, res);

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
    console.log(`[google-flow-mcp] Endpoints:`);
    console.log(`  GET  /health`);
    console.log(`  POST /generate`);
    console.log(`  POST /collect`);
    console.log(`  POST /save`);
    console.log(`  POST /edit`);
    console.log(`  POST /regen`);
  });
}

main().catch((error) => {
  console.error("[google-flow-mcp] Fatal error:", error);
  process.exit(1);
});
