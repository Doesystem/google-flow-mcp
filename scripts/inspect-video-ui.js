#!/usr/bin/env node
/**
 * Test script for video generation flow.
 * Mirrors the generateVideo() steps in flow-driver.ts so you can
 * visually verify each selector works before running the real server.
 *
 * Run: node scripts/inspect-video-ui.js
 */
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "fs/promises";
import path from "path";
import os from "os";

const STATE_FILE = path.join(os.homedir(), ".google-flow-mcp", "state.json");
const FLOW_URL = "https://labs.google/fx/tools/flow";
const PROMPT_SELECTOR = '[data-slate-editor="true"]';
const GENERATED_VIDEO_SELECTOR = 'video[src*="media.getMediaUrlRedirect"], video[src*="labs.google"]';
const TEST_PROMPT = process.argv[2] || "a cat walking in a garden, cinematic";

// Parse --start and --end flags
// Usage: node scripts/inspect-video-ui.js "prompt" --start https://... --end https://...
const args = process.argv.slice(3);
let VIDEO_START_URL = null;
let VIDEO_END_URL = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--start" && args[i + 1]) VIDEO_START_URL = args[++i];
  if (args[i] === "--end"   && args[i + 1]) VIDEO_END_URL   = args[++i];
}

log(`Prompt: "${TEST_PROMPT}"`);
if (VIDEO_START_URL) log(`Start frame: ${VIDEO_START_URL}`);
if (VIDEO_END_URL)   log(`End frame:   ${VIDEO_END_URL}`);
const OUT_DIR = path.join(os.homedir(), "GoogleFlow", "test-video");

// ─── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[test] ${msg}`);
}

async function step(name, fn) {
  log(`▶ ${name}`);
  try {
    await fn();
    log(`✅ ${name}`);
  } catch (err) {
    log(`❌ ${name}: ${err.message}`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

const state = JSON.parse(await readFile(STATE_FILE, "utf-8"));

const browser = await chromium.launch({
  headless: false,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,900",
  ],
});

const context = await browser.newContext({
  storageState: state,
  viewport: { width: 1280, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => false });
});

const page = await context.newPage();

// ── 1. Navigate ───────────────────────────────────────────────────────────────
await step("Navigate to Flow", async () => {
  await page.goto(FLOW_URL, { waitUntil: "networkidle" });
});

// ── 2. Open / create project ──────────────────────────────────────────────────
await step("Open project", async () => {
  const onDashboard = await page
    .waitForSelector('button:has-text("New project")', { timeout: 10_000 })
    .then(() => true).catch(() => false);

  if (onDashboard) {
    await page.locator('button:has-text("New project")').click();
    log("  Created new project");
  }
  await page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
});

// ── 3. Open settings panel ────────────────────────────────────────────────────
await step("Open settings panel (click model chip)", async () => {
  const chip = page.locator('button:has-text("Nano Banana"), button:has-text("Veo")').first();
  await chip.click({ timeout: 5_000 });
  await page.waitForTimeout(800);
  log(`  Chip text: "${(await chip.textContent())?.trim().replace(/\s+/g, " ")}"`);
});

// ── 4. Switch to Video tab ────────────────────────────────────────────────────
await step("Click Video tab", async () => {
  const videoTab = page.locator('[role="tab"][id*="trigger-VIDEO"]:not([id*="VIDEO_FRAMES"]):not([id*="VIDEO_REFERENCES"])');
  const count = await videoTab.count();
  log(`  Found ${count} Video tab(s)`);
  await videoTab.click({ timeout: 5_000 });
  await page.waitForTimeout(800);
});

// ── 5. Select Frames ──────────────────────────────────────────────────────────
await step("Click Frames tab", async () => {
  const framesTab = page.locator('[role="tab"][id*="VIDEO_FRAMES"]');
  const count = await framesTab.count();
  log(`  Found ${count} Frames tab(s)`);
  await framesTab.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
});

// ── 6. Select 9:16 aspect ratio ───────────────────────────────────────────────
await step("Click 9:16 aspect ratio", async () => {
  const portraitTab = page.locator('[role="tab"][id*="PORTRAIT"]:has-text("9:16")');
  const count = await portraitTab.count();
  log(`  Found ${count} 9:16 tab(s)`);
  await portraitTab.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
});

// ── 7. Select 1x count ────────────────────────────────────────────────────────
await step("Click 1x count", async () => {
  const countTab = page.locator('[role="tab"]:text-is("1x")');
  const count = await countTab.count();
  log(`  Found ${count} 1x tab(s)`);
  await countTab.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
});

// ── 8. Select Veo 3.1 - Fast model ───────────────────────────────────────────
await step("Select Veo 3.1 - Fast model", async () => {
  const veoChip = page.locator('button[aria-haspopup="menu"]:has-text("Veo")');
  const chipCount = await veoChip.count();
  log(`  Found ${chipCount} Veo chip(s)`);
  await veoChip.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Log available models
  const items = await page.locator('[role="menuitem"], [role="option"]').all();
  log(`  Available models (${items.length}):`);
  for (const item of items) {
    log(`    - "${(await item.textContent())?.trim().replace(/\s+/g, " ")}"`);
  }

  const veoFast = page.locator('[role="menuitem"]:has-text("Veo 3.1 - Fast"), [role="option"]:has-text("Veo 3.1 - Fast")');
  const fastCount = await veoFast.count();
  log(`  Found ${fastCount} "Veo 3.1 - Fast" option(s)`);
  await veoFast.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
});

// ── 9. Close settings panel ───────────────────────────────────────────────────
await step("Close settings panel (Escape then click prompt editor)", async () => {
  // First press Escape to close the Radix popper/dropdown
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  // Then click the prompt editor to restore focus
  const editor = page.locator(PROMPT_SELECTOR);
  await editor.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
});

// ── 10. Upload video start/end frames (if provided) ──────────────────────────
if (VIDEO_START_URL || VIDEO_END_URL) {
  await step("Upload and select video start/end frames", async () => {

    // Helper: upload one image and wait for media.getMediaUrlRedirect src to appear
    const uploadAndWait = async (url, label) => {
      log(`  Downloading ${label}: ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download ${label}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = url.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "png";
      const tmpPath = path.join(os.tmpdir(), `video-frame-${Date.now()}.${ext}`);
      await writeFile(tmpPath, buf);

      // Snapshot existing srcs
      const beforeImgs = await page.locator('img[src*="media.getMediaUrlRedirect"]').all();
      const beforeSrcs = new Set();
      for (const img of beforeImgs) {
        const src = await img.getAttribute("src");
        if (src) beforeSrcs.add(src);
      }

      // Upload via Add Media
      const addBtn = page.locator('button:has-text("Add Media"), button:has-text("add_2Create")').first();
      await addBtn.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(500);
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmpPath);
      log(`  Uploaded ${label}, waiting for media.getMediaUrlRedirect src...`);

      // Wait for new src
      const deadline = Date.now() + 30_000;
      let uploadedSrc = null;
      while (!uploadedSrc && Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        const allImgs = await page.locator('img[src*="media.getMediaUrlRedirect"]').all();
        for (const img of allImgs) {
          const src = await img.getAttribute("src");
          if (src && !beforeSrcs.has(src)) { uploadedSrc = src; break; }
        }
      }
      if (uploadedSrc) {
        log(`  ${label} upload complete: ${uploadedSrc.slice(0, 80)}`);
        await page.waitForTimeout(2_000);
      } else {
        log(`  ${label} upload timed out`);
      }
      return uploadedSrc;
    };

    const startSrc = VIDEO_START_URL ? await uploadAndWait(VIDEO_START_URL, "start frame") : null;
    const endSrc   = VIDEO_END_URL   ? await uploadAndWait(VIDEO_END_URL,   "end frame")   : null;

    // Wait for Start button
    log(`  Waiting for 'Start' button...`);
    await page.waitForSelector('div[type="button"]:has-text("Start")', { timeout: 10_000 });

    // Click Start → select start image row (div.sc-1dc6bdcb-15)
    if (startSrc) {
      log(`  Clicking 'Start' button...`);
      await page.locator('div[type="button"]:has-text("Start")').click({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
      await page.waitForSelector('[data-testid="virtuoso-item-list"]', { timeout: 10_000 });

      const nameId = startSrc.split("name=")[1];
      log(`  Looking for row with img name=${nameId}`);
      const row = page.locator(`[data-testid="virtuoso-item-list"] div[class*="sc-1dc6bdcb-15"]:has(img[src*="${nameId}"])`);
      const rowCount = await row.count();
      log(`  Found ${rowCount} matching row(s)`);
      await row.click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      log(`  Selected start frame`);
    }

    // Click End → select end image row (div.sc-1dc6bdcb-15)
    if (endSrc) {
      log(`  Clicking 'End' button...`);
      await page.locator('div[type="button"]:has-text("End")').click({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
      await page.waitForSelector('[data-testid="virtuoso-item-list"]', { timeout: 10_000 });

      const nameId = endSrc.split("name=")[1];
      log(`  Looking for row with img name=${nameId}`);
      const row = page.locator(`[data-testid="virtuoso-item-list"] div[class*="sc-1dc6bdcb-15"]:has(img[src*="${nameId}"])`);
      const rowCount = await row.count();
      log(`  Found ${rowCount} matching row(s)`);
      await row.click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      log(`  Selected end frame`);
    }
  });
}

// ── 11. Snapshot existing videos ─────────────────────────────────────────────
const existingVideos = await page.locator(GENERATED_VIDEO_SELECTOR).all();
const beforeSrcs = new Set();
for (const el of existingVideos) {
  const src = await el.getAttribute("src");
  if (src) beforeSrcs.add(src);
}
log(`Snapshot: ${beforeSrcs.size} existing video(s) on page`);

// ── 12. Type prompt ───────────────────────────────────────────────────────────
await step(`Type prompt: "${TEST_PROMPT}"`, async () => {
  const editor = page.locator(PROMPT_SELECTOR);
  await editor.click();
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(200);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await page.evaluate((text) => navigator.clipboard.writeText(text), TEST_PROMPT);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(500);
  const typed = await editor.textContent();
  log(`  Prompt field: "${typed?.slice(0, 80)}"`);
});

// ── 13. Click Create ──────────────────────────────────────────────────────────
await step("Click Create", async () => {
  const editor = page.locator(PROMPT_SELECTOR);
  await editor.click({ timeout: 3_000 });
  await page.waitForTimeout(300);
  log("  Pressing Enter...");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);
  const createBtn = page.locator('button:has-text("Create")').last();
  const btnCount = await createBtn.count();
  log(`  Found ${btnCount} Create button(s)`);
  await createBtn.click({ timeout: 5_000 });
  await page.waitForTimeout(2_000);
});

// ── 14. Poll for video ────────────────────────────────────────────────────────
log("Polling for new video (max 5 min)...");
const deadline = Date.now() + 300_000;
let newSrcs = [];

while (newSrcs.length < 1 && Date.now() < deadline) {
  await page.waitForTimeout(5_000);
  const allElements = await page.locator(GENERATED_VIDEO_SELECTOR).all();
  newSrcs = [];
  for (const el of allElements) {
    const src = await el.getAttribute("src");
    if (src && !beforeSrcs.has(src)) newSrcs.push(src);
  }
  log(`  Found ${newSrcs.length}/1 new video(s) (total on page: ${allElements.length})`);
}

if (newSrcs.length === 0) {
  log("❌ No video generated within timeout");
  log("Keeping browser open for 60s for manual inspection...");
  await page.waitForTimeout(60_000);
  await browser.close();
  process.exit(1);
}

// ── 15. Download video ────────────────────────────────────────────────────────
await step("Download video", async () => {
  const url = newSrcs[0].startsWith("http") ? newSrcs[0] : `https://labs.google${newSrcs[0]}`;
  log(`  URL: ${url}`);
  const response = await page.request.get(url);
  log(`  Status: ${response.status()}`);
  const buffer = Buffer.from(await response.body());
  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "test-output.mp4");
  await writeFile(outPath, buffer);
  log(`  Saved to: ${outPath} (${buffer.length} bytes)`);
});

log("✅ All steps complete! Keeping browser open 30s...");
await page.waitForTimeout(30_000);
await browser.close();
