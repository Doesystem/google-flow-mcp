import { BrowserContext, Page } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const DASHBOARD_SELECTOR = 'button:has-text("New project")';
const PROMPT_SELECTOR = '[data-slate-editor="true"]';
const GENERATED_IMAGE_SELECTOR = 'img[src*="media.getMediaUrlRedirect"]';
const GENERATED_VIDEO_SELECTOR = 'video[src*="media.getMediaUrlRedirect"], video[src*="labs.google"]';

export interface GenerateOptions {
  prompt: string;
  imagePaths?: string[];
  aspectRatio?: string;
  count?: number;
}

export interface GenerateVideoOptions {
  prompt: string;
  imagePaths?: string[];
  videoStartPath?: string;
  videoEndPath?: string;
  jobId: string;
}

export interface EditOptions {
  imagePaths: string[];
  prompt: string;
  aspectRatio?: string;
}

export interface RegenOptions {
  imageIndex: number;
  prompt?: string;
  aspectRatio?: string;
}

export interface GeneratedImage {
  buffer: Buffer;
  index: number;
  jobId: string;
}

export class FlowDriver {
  private context: BrowserContext;
  private page: Page | null = null;

  constructor(context: BrowserContext) {
    this.context = context;
  }

  async init(): Promise<void> {
    this.page = await this.context.newPage();
    await this.page.goto(FLOW_URL, { waitUntil: "networkidle" });

    const onDashboard = await this.page
      .waitForSelector(DASHBOARD_SELECTOR, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (onDashboard) {
      await this.page.locator(DASHBOARD_SELECTOR).click();
      console.error("[google-flow-mcp] Created new Flow project");
      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    } else {
      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    }
  }

  async generate(options: GenerateOptions & { jobId: string }): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    if (options.imagePaths && options.imagePaths.length > 0) {
      await this.uploadImages(options.imagePaths);
    }

    await this.openSettingsPanel();
    if (options.aspectRatio) {
      await this.setAspectRatio(options.aspectRatio);
    }
    const count = options.count ?? 2;
    await this.setOutputCount(count);
    await this.closeSettingsPanel();

    const existingImages = await this.page.locator(GENERATED_IMAGE_SELECTOR).all();
    const beforeSrcs = new Set<string>();
    for (const el of existingImages) {
      const src = await el.getAttribute("src");
      if (src) beforeSrcs.add(src);
    }

    await this.typePrompt(options.prompt);
    await this.clickCreate();

    console.error(`[google-flow-mcp] Generating "${options.prompt}" as ${options.jobId} (expecting ${count} images)`);
    return this.waitAndDownloadNewImages(count, beforeSrcs, options.jobId);
  }

  async generateVideo(options: GenerateVideoOptions): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    // Always start fresh — navigate to Flow dashboard and create a new project
    await this.resetToNewProject();

    // Configure settings first (before any uploads)
    await this.openSettingsPanel();
    await this.selectVideoMode();
    await this.selectVideoFrames();
    await this.setVideoAspectRatio();
    await this.setVideoCount();
    await this.selectVeoModel();
    await this.closeSettingsPanel();

    // Upload start/end frames after settings are configured
    if (options.videoStartPath || options.videoEndPath) {
      await this.uploadVideoFrames(options.videoStartPath, options.videoEndPath);
    }

    const existingVideos = await this.page.locator(GENERATED_VIDEO_SELECTOR).all();
    const beforeSrcs = new Set<string>();
    for (const el of existingVideos) {
      const src = await el.getAttribute("src");
      if (src) beforeSrcs.add(src);
    }

    await this.typePrompt(options.prompt);
    await this.clickCreate();

    console.error(`[google-flow-mcp] Generating video "${options.prompt}" as ${options.jobId}`);
    return this.waitAndDownloadNewVideos(beforeSrcs, options.jobId);
  }

  async edit(options: EditOptions & { jobId: string }): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    await this.returnToCanvas();
    await this.uploadImages(options.imagePaths);

    await this.openSettingsPanel();
    if (options.aspectRatio) {
      await this.setAspectRatio(options.aspectRatio);
    }
    await this.closeSettingsPanel();

    const existingImages = await this.page.locator(GENERATED_IMAGE_SELECTOR).all();
    const existingSrcs = new Set<string>();
    for (const el of existingImages) {
      const src = await el.getAttribute("src");
      if (src) existingSrcs.add(src);
    }

    await this.typePrompt(options.prompt);
    await this.clickCreate();
    return this.waitAndDownloadNewImages(1, existingSrcs, options.jobId);
  }

  async regen(options: RegenOptions & { jobId: string }): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    const allImages = await this.page.locator(GENERATED_IMAGE_SELECTOR).all();
    const targetIndex = options.imageIndex - 1;

    if (targetIndex < 0 || targetIndex >= allImages.length) {
      throw new Error(
        `Image index ${options.imageIndex} out of range. There are ${allImages.length} generated image(s).`
      );
    }

    await allImages[targetIndex].click();
    console.error(`[google-flow-mcp] Clicked generated image #${options.imageIndex} to open edit view`);

    await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 10_000 });
    await this.page.waitForTimeout(1_000);

    if (options.aspectRatio) {
      await this.openSettingsPanel();
      await this.setAspectRatio(options.aspectRatio);
      await this.closeSettingsPanel();
    }

    const existingImages = await this.page.locator(GENERATED_IMAGE_SELECTOR).all();
    const existingSrcs = new Set<string>();
    for (const el of existingImages) {
      const src = await el.getAttribute("src");
      if (src) existingSrcs.add(src);
    }

    if (options.prompt) {
      await this.typePrompt(options.prompt);
    }
    await this.clickCreate();
    return this.waitAndDownloadNewImages(1, existingSrcs, options.jobId);
  }

  private async resetToNewProject(): Promise<void> {
    console.error("[google-flow-mcp] Navigating to Flow dashboard for new project...");
    await this.page!.goto(FLOW_URL, { waitUntil: "networkidle" });

    const onDashboard = await this.page!
      .waitForSelector(DASHBOARD_SELECTOR, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (onDashboard) {
      await this.page!.locator(DASHBOARD_SELECTOR).click();
      console.error("[google-flow-mcp] Created new Flow project");
      await this.page!.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    } else {
      await this.page!.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    }
  }

  private async uploadVideoFrames(startPath?: string, endPath?: string): Promise<void> {
    // Helper: upload one image and wait for it to appear in media library
    const uploadAndWait = async (filePath: string, label: string): Promise<string | null> => {
      // Snapshot existing srcs before upload
      const beforeImgs = await this.page!.locator(GENERATED_IMAGE_SELECTOR).all();
      const beforeSrcs = new Set<string>();
      for (const img of beforeImgs) {
        const src = await img.getAttribute("src");
        if (src) beforeSrcs.add(src);
      }

      const addBtn = this.page!.locator('button:has-text("Add Media"), button:has-text("add_2Create")').first();
      try {
        await addBtn.click({ timeout: 5_000 });
        await this.page!.waitForTimeout(500);
      } catch { /* fall through */ }

      const fileInput = this.page!.locator('input[type="file"]').first();
      try {
        await fileInput.setInputFiles(filePath);
        console.error(`[google-flow-mcp] Uploading ${label}...`);
      } catch {
        console.error(`[google-flow-mcp] Could not upload ${label}`);
        return null;
      }

      // Wait for new media.getMediaUrlRedirect src to appear (same as /img/edit)
      const deadline = Date.now() + 30_000;
      let uploadedSrc: string | null = null;
      while (!uploadedSrc && Date.now() < deadline) {
        await this.page!.waitForTimeout(1_000);
        const allImgs = await this.page!.locator(GENERATED_IMAGE_SELECTOR).all();
        for (const img of allImgs) {
          const src = await img.getAttribute("src");
          if (src && !beforeSrcs.has(src)) {
            uploadedSrc = src;
            break;
          }
        }
      }

      if (uploadedSrc) {
        console.error(`[google-flow-mcp] ${label} upload complete`);
        await this.page!.waitForTimeout(2_000); // let Flow finish processing
      } else {
        console.error(`[google-flow-mcp] ${label} upload timed out`);
      }
      return uploadedSrc;
    };

    // Upload both images first
    const startSrc = startPath ? await uploadAndWait(startPath, "start frame") : null;
    const endSrc   = endPath   ? await uploadAndWait(endPath,   "end frame")   : null;

    // Wait for Start/End buttons to appear
    console.error("[google-flow-mcp] Waiting for Start/End frame buttons...");
    try {
      await this.page!.waitForSelector('div[type="button"]:has-text("Start")', { timeout: 10_000 });
    } catch {
      console.error("[google-flow-mcp] Start/End buttons not found — skipping frame selection");
      return;
    }

    // Click "Start" → dialog opens → click the row div (sc-1dc6bdcb-15) of the start image
    if (startSrc) {
      console.error("[google-flow-mcp] Clicking 'Start' to select start frame...");
      try {
        await this.page!.locator('div[type="button"]:has-text("Start")').click({ timeout: 5_000 });
        await this.page!.waitForTimeout(1_000);
        await this.page!.waitForSelector('[data-testid="virtuoso-item-list"]', { timeout: 10_000 });

        const nameId = startSrc.split("name=")[1];
        // Target the row div (parent is div, not button/a) that contains the start image
        const row = this.page!.locator(`[data-testid="virtuoso-item-list"] div[class*="sc-1dc6bdcb-15"]:has(img[src*="${nameId}"])`);
        await row.click({ timeout: 5_000 });
        await this.page!.waitForTimeout(500);
        console.error("[google-flow-mcp] Selected start frame");
      } catch {
        console.error("[google-flow-mcp] Could not select start frame");
      }
    }

    // Click "End" → dialog opens → click the row div of the end image
    if (endSrc) {
      console.error("[google-flow-mcp] Clicking 'End' to select end frame...");
      try {
        await this.page!.locator('div[type="button"]:has-text("End")').click({ timeout: 5_000 });
        await this.page!.waitForTimeout(1_000);
        await this.page!.waitForSelector('[data-testid="virtuoso-item-list"]', { timeout: 10_000 });

        const nameId = endSrc.split("name=")[1];
        const row = this.page!.locator(`[data-testid="virtuoso-item-list"] div[class*="sc-1dc6bdcb-15"]:has(img[src*="${nameId}"])`);
        await row.click({ timeout: 5_000 });
        await this.page!.waitForTimeout(500);
        console.error("[google-flow-mcp] Selected end frame");
      } catch {
        console.error("[google-flow-mcp] Could not select end frame");
      }
    }
  }

  private async returnToCanvas(): Promise<void> {
    const currentUrl = this.page!.url();
    if (!currentUrl.includes("/edit/")) return;

    const canvasUrl = currentUrl.replace(/\/edit\/[^/]+$/, "");
    console.error(`[google-flow-mcp] Returning to canvas: ${canvasUrl}`);
    await this.page!.goto(canvasUrl, { waitUntil: "networkidle" });
    await this.page!.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    await this.page!.waitForTimeout(500);
    console.error("[google-flow-mcp] Back on main canvas");
  }

  private async openSettingsPanel(): Promise<void> {
    const allButtons = await this.page!.locator("button").all();
    const buttonTexts: string[] = [];
    for (const btn of allButtons) {
      const text = (await btn.textContent())?.trim().replace(/\s+/g, " ") ?? "";
      if (text) buttonTexts.push(`"${text}"`);
    }
    console.error(`[google-flow-mcp] Visible buttons on page: ${buttonTexts.join(", ")}`);

    const modelChip = this.page!.locator('button:has-text("Nano Banana")');
    const chipCount = await modelChip.count();
    console.error(`[google-flow-mcp] Found ${chipCount} button(s) matching "Nano Banana"`);
    try {
      await modelChip.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
      console.error("[google-flow-mcp] Settings panel opened");
    } catch {
      console.error("[google-flow-mcp] Could not open settings panel — dumping page HTML snippet");
      const html = await this.page!.content();
      console.error("[google-flow-mcp] PAGE HTML (first 3000 chars):\n" + html.slice(0, 3000));
    }
  }

  private async closeSettingsPanel(): Promise<void> {
    // Press Escape first to close any open Radix popper/dropdown
    await this.page!.keyboard.press("Escape");
    await this.page!.waitForTimeout(500);
    // Then click the prompt editor to restore focus
    const editor = this.page!.locator(PROMPT_SELECTOR);
    try {
      await editor.click({ timeout: 5_000 });
    } catch {
      // ignore — editor may not be visible in all contexts
    }
    await this.page!.waitForTimeout(300);
  }

  private async typePrompt(prompt: string): Promise<void> {
    const editor = this.page!.locator(PROMPT_SELECTOR);

    await editor.click();
    await this.page!.waitForTimeout(500);
    await this.page!.keyboard.press("Control+a");
    await this.page!.waitForTimeout(200);
    await this.page!.keyboard.press("Backspace");
    await this.page!.waitForTimeout(300);

    await this.page!.evaluate((text) => navigator.clipboard.writeText(text), prompt);
    await this.page!.keyboard.press("Control+v");
    await this.page!.waitForTimeout(500);

    const typed = await editor.textContent();
    console.error(`[google-flow-mcp] Prompt field content after typing: "${typed?.slice(0, 80)}"`);
  }

  private async setAspectRatio(ratio: string): Promise<void> {
    const validRatios = ["16:9", "4:3", "1:1", "3:4", "9:16"];
    if (!validRatios.includes(ratio)) {
      console.error(`[google-flow-mcp] Unknown aspect ratio: ${ratio}, skipping`);
      return;
    }
    const ratioButton = this.page!.locator(`button:has-text("${ratio}")`).first();
    try {
      await ratioButton.click({ timeout: 5_000 });
    } catch {
      console.error(`[google-flow-mcp] Could not find aspect ratio button for ${ratio}`);
    }
  }

  private async setOutputCount(count: number): Promise<void> {
    if (count < 1 || count > 4) {
      console.error(`[google-flow-mcp] Count must be 1-4, got ${count}`);
      return;
    }

    const allTabs = await this.page!.locator("[role='tab']").all();
    const tabTexts: string[] = [];
    for (const tab of allTabs) {
      const text = (await tab.textContent())?.trim().replace(/\s+/g, " ") ?? "";
      if (text) tabTexts.push(`"${text}"`);
    }
    console.error(`[google-flow-mcp] Visible [role=tab] elements: ${tabTexts.join(", ") || "(none)"}`);

    const label = count === 1 ? "1x" : `x${count}`;
    const countButton = this.page!.locator(`button[role="tab"]:text-is("${label}")`);
    const btnCount = await countButton.count();
    console.error(`[google-flow-mcp] Found ${btnCount} tab button(s) matching "${label}"`);
    try {
      await countButton.click({ timeout: 5_000 });
      console.error(`[google-flow-mcp] Set output count to ${count}`);
    } catch {
      console.error(`[google-flow-mcp] Could not set output count to ${count}`);
    }
  }

  private async clickCreate(): Promise<void> {
    const editor = this.page!.locator(PROMPT_SELECTOR);
    try {
      await editor.click({ timeout: 3_000 });
      await this.page!.waitForTimeout(300);
    } catch {
      console.error("[google-flow-mcp] Could not re-focus prompt editor before Create");
    }

    console.error("[google-flow-mcp] Submitting via Enter key");
    await this.page!.keyboard.press("Enter");
    await this.page!.waitForTimeout(1_000);

    const createBtn = this.page!.locator('button:has-text("Create")').last();
    const btnCount = await createBtn.count();
    console.error(`[google-flow-mcp] Found ${btnCount} button(s) matching "Create"`);
    try {
      await createBtn.click({ timeout: 5_000 });
      console.error("[google-flow-mcp] Clicked Create button");
      await this.page!.waitForTimeout(2_000);
    } catch {
      console.error("[google-flow-mcp] Could not click Create button");
    }
  }

  private async waitAndDownloadNewImages(
    expectedCount: number,
    existingSrcs: Set<string>,
    jobId: string
  ): Promise<GeneratedImage[]> {
    const deadline = Date.now() + 120_000;
    let newSrcs: string[] = [];

    while (newSrcs.length < expectedCount && Date.now() < deadline) {
      await this.page!.waitForTimeout(5_000);
      const allElements = await this.page!.locator(GENERATED_IMAGE_SELECTOR).all();
      newSrcs = [];
      for (const el of allElements) {
        const src = await el.getAttribute("src");
        if (src && !existingSrcs.has(src)) {
          newSrcs.push(src);
        }
      }
      console.error(`[google-flow-mcp]   Polling: found ${newSrcs.length}/${expectedCount} new image(s) (total imgs on page: ${allElements.length})`);

      if (newSrcs.length === 0 && allElements.length === 0) {
        const allImgs = await this.page!.locator("img").all();
        const srcs: string[] = [];
        for (const img of allImgs) {
          const src = await img.getAttribute("src");
          if (src) srcs.push(src.slice(0, 120));
        }
        if (srcs.length > 0) {
          console.error(`[google-flow-mcp]   All img srcs on page (${srcs.length}):`);
          srcs.forEach((s, i) => console.error(`    [${i}] ${s}`));
        } else {
          console.error(`[google-flow-mcp]   No <img> elements found on page at all`);
        }
      }
    }

    console.error(`[google-flow-mcp] Found ${newSrcs.length} new generated image(s)`);

    const images: GeneratedImage[] = [];
    for (let i = 0; i < Math.min(newSrcs.length, expectedCount); i++) {
      try {
        const url = newSrcs[i].startsWith("http") ? newSrcs[i] : `https://labs.google${newSrcs[i]}`;
        console.error(`[google-flow-mcp] Downloading image ${i + 1}: ${url}`);
        const response = await this.page!.request.get(url);
        console.error(`[google-flow-mcp] Download status: ${response.status()}`);
        const buffer = Buffer.from(await response.body());
        images.push({ buffer, index: i + 1, jobId });
      } catch (err) {
        console.error(`[google-flow-mcp] Failed to download image ${i + 1}:`, err);
      }
    }

    return images;
  }

  private async waitAndDownloadNewVideos(
    existingSrcs: Set<string>,
    jobId: string
  ): Promise<GeneratedImage[]> {
    const deadline = Date.now() + 300_000; // 5 min — video takes longer
    let newSrcs: string[] = [];

    while (newSrcs.length < 1 && Date.now() < deadline) {
      await this.page!.waitForTimeout(5_000);
      const allElements = await this.page!.locator(GENERATED_VIDEO_SELECTOR).all();
      newSrcs = [];
      for (const el of allElements) {
        const src = await el.getAttribute("src");
        if (src && !existingSrcs.has(src)) {
          newSrcs.push(src);
        }
      }
      console.error(`[google-flow-mcp]   Polling video: found ${newSrcs.length}/1 new video(s) (total on page: ${allElements.length})`);
    }

    console.error(`[google-flow-mcp] Found ${newSrcs.length} new video(s)`);

    const images: GeneratedImage[] = [];
    for (let i = 0; i < newSrcs.length; i++) {
      try {
        const url = newSrcs[i].startsWith("http") ? newSrcs[i] : `https://labs.google${newSrcs[i]}`;
        console.error(`[google-flow-mcp] Downloading video ${i + 1}: ${url}`);
        const response = await this.page!.request.get(url);
        console.error(`[google-flow-mcp] Download status: ${response.status()}`);
        const buffer = Buffer.from(await response.body());
        images.push({ buffer, index: i + 1, jobId });
      } catch (err) {
        console.error(`[google-flow-mcp] Failed to download video ${i + 1}:`, err);
      }
    }

    return images;
  }

  private async uploadImages(imagePaths: string[]): Promise<void> {
    const beforeImgs = await this.page!.locator(GENERATED_IMAGE_SELECTOR).all();
    const beforeSrcs = new Set<string>();
    for (const img of beforeImgs) {
      const src = await img.getAttribute("src");
      if (src) beforeSrcs.add(src);
    }

    const addBtn = this.page!.locator('button:has-text("Add Media"), button:has-text("add_2Create")').first();
    try {
      await addBtn.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
    } catch {
      // fall through
    }

    const fileInput = this.page!.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(imagePaths);
      console.error(`[google-flow-mcp] Uploading ${imagePaths.length} image(s)...`);
    } catch {
      console.error("[google-flow-mcp] Could not upload images");
      return;
    }

    console.error("[google-flow-mcp] Waiting for upload to complete...");
    let uploadedSrc: string | null = null;
    const deadline = Date.now() + 30_000;
    while (!uploadedSrc && Date.now() < deadline) {
      await this.page!.waitForTimeout(1_000);
      const allImgs = await this.page!.locator(GENERATED_IMAGE_SELECTOR).all();
      for (const img of allImgs) {
        const src = await img.getAttribute("src");
        if (src && !beforeSrcs.has(src)) {
          uploadedSrc = src;
          break;
        }
      }
    }

    if (uploadedSrc) {
      console.error("[google-flow-mcp] Upload complete, waiting 5s for image to render...");
      await this.page!.waitForTimeout(5_000);
      console.error("[google-flow-mcp] Clicking uploaded image to activate edit mode...");
      const uploadedImg = this.page!.locator(`img[src="${uploadedSrc}"]`).first();
      try {
        await uploadedImg.click({ timeout: 5_000 });
        await this.page!.waitForTimeout(500);
        console.error("[google-flow-mcp] Clicked uploaded image");
      } catch {
        console.error("[google-flow-mcp] Could not click uploaded image");
      }
    } else {
      console.error("[google-flow-mcp] Upload timed out — proceeding anyway");
    }
  }

  private async selectVideoMode(): Promise<void> {
    const videoTab = this.page!.locator('[role="tab"][id*="trigger-VIDEO"]:not([id*="VIDEO_FRAMES"]):not([id*="VIDEO_REFERENCES"])');
    try {
      await videoTab.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(800);
      console.error("[google-flow-mcp] Selected Video mode");
    } catch {
      console.error("[google-flow-mcp] Could not select Video mode");
    }
  }

  private async selectVideoFrames(): Promise<void> {
    const framesTab = this.page!.locator('[role="tab"][id*="VIDEO_FRAMES"]');
    try {
      await framesTab.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
      console.error("[google-flow-mcp] Selected Frames output type");
    } catch {
      console.error("[google-flow-mcp] Could not select Frames output type");
    }
  }

  private async setVideoAspectRatio(): Promise<void> {
    const portraitTab = this.page!.locator('[role="tab"][id*="PORTRAIT"]:has-text("9:16")');
    try {
      await portraitTab.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
      console.error("[google-flow-mcp] Selected 9:16 aspect ratio");
    } catch {
      console.error("[google-flow-mcp] Could not select 9:16 aspect ratio");
    }
  }

  private async setVideoCount(): Promise<void> {
    const countTab = this.page!.locator('[role="tab"]:text-is("1x")');
    try {
      await countTab.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
      console.error("[google-flow-mcp] Selected 1x count");
    } catch {
      console.error("[google-flow-mcp] Could not select 1x count");
    }
  }

  private async selectVeoModel(): Promise<void> {
    const veoChip = this.page!.locator('button[aria-haspopup="menu"]:has-text("Veo")');
    try {
      await veoChip.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(800);
      console.error("[google-flow-mcp] Opened Veo model menu");
    } catch {
      console.error("[google-flow-mcp] Could not open Veo model menu");
      return;
    }

    const veoFast = this.page!.locator('[role="menuitem"]:has-text("Veo 3.1 - Fast"), [role="option"]:has-text("Veo 3.1 - Fast")');
    try {
      await veoFast.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
      console.error("[google-flow-mcp] Selected Veo 3.1 - Fast");
    } catch {
      console.error("[google-flow-mcp] Could not select Veo 3.1 - Fast — using current model");
    }
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
  }
}
