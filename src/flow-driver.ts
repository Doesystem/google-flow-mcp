import { BrowserContext, Page } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const DASHBOARD_SELECTOR = 'button:has-text("New project")';
const PROMPT_SELECTOR = '[data-slate-editor="true"]';
const GENERATED_IMAGE_SELECTOR = 'img[src*="media.getMediaUrlRedirect"]';

export interface GenerateOptions {
  prompt: string;
  imagePaths?: string[];
  aspectRatio?: string;
  resolution?: string;
  count?: number;
}

export interface EditOptions {
  imagePaths: string[];
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
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

    // Flow lands on project dashboard — reuse first existing project or create new
    const onDashboard = await this.page
      .waitForSelector(DASHBOARD_SELECTOR, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (onDashboard) {
      // Always create a new project to start with a clean canvas
      await this.page.locator(DASHBOARD_SELECTOR).click();
      console.error("[google-flow-mcp] Created new Flow project");

      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    } else {
      // May already be in a project
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

  async edit(options: EditOptions & { jobId: string }): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

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

    // Click on the nth generated image to open the edit view
    const allImages = await this.page.locator(GENERATED_IMAGE_SELECTOR).all();
    const targetIndex = options.imageIndex - 1; // 1-based to 0-based

    if (targetIndex < 0 || targetIndex >= allImages.length) {
      throw new Error(
        `Image index ${options.imageIndex} out of range. There are ${allImages.length} generated image(s).`
      );
    }

    await allImages[targetIndex].click();
    console.error(`[google-flow-mcp] Clicked generated image #${options.imageIndex} to open edit view`);

    // Wait for the edit view prompt to appear
    await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 10_000 });
    await this.page.waitForTimeout(1_000);

    if (options.aspectRatio) {
      await this.openSettingsPanel();
      await this.setAspectRatio(options.aspectRatio);
      await this.closeSettingsPanel();
    }

    // Snapshot existing images before creating
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

  private async openSettingsPanel(): Promise<void> {
    // Dump all visible buttons to help identify the correct selector
    const allButtons = await this.page!.locator("button").all();
    const buttonTexts: string[] = [];
    for (const btn of allButtons) {
      const text = (await btn.textContent())?.trim().replace(/\s+/g, " ") ?? "";
      if (text) buttonTexts.push(`"${text}"`);
    }
    console.error(`[google-flow-mcp] Visible buttons on page: ${buttonTexts.join(", ")}`);

    // Click the model chip (e.g. "Nano Banana 2") to open settings
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
      // Print first 3000 chars to avoid flooding logs
      console.error("[google-flow-mcp] PAGE HTML (first 3000 chars):\n" + html.slice(0, 3000));
    }
  }

  private async closeSettingsPanel(): Promise<void> {
    // Press Escape to dismiss the Radix popover
    await this.page!.keyboard.press("Escape");
    await this.page!.waitForTimeout(500);
  }

  private async typePrompt(prompt: string): Promise<void> {
    const editor = this.page!.locator(PROMPT_SELECTOR);
    await editor.click();
    await this.page!.keyboard.press("Meta+a");
    await this.page!.keyboard.press("Backspace");
    await this.page!.keyboard.type(prompt, { delay: 10 });
  }

  private async setAspectRatio(ratio: string): Promise<void> {
    const validRatios = ["16:9", "4:3", "1:1", "3:4", "9:16"];
    if (!validRatios.includes(ratio)) {
      console.error(`[google-flow-mcp] Unknown aspect ratio: ${ratio}, skipping`);
      return;
    }

    // Aspect ratio buttons are inside the settings panel with text like "16:9", "4:3", etc.
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

    // Dump all tabs/buttons visible after settings panel opens
    const allTabs = await this.page!.locator("[role='tab']").all();
    const tabTexts: string[] = [];
    for (const tab of allTabs) {
      const text = (await tab.textContent())?.trim().replace(/\s+/g, " ") ?? "";
      if (text) tabTexts.push(`"${text}"`);
    }
    console.error(`[google-flow-mcp] Visible [role=tab] elements: ${tabTexts.join(", ") || "(none)"}`);

    // Count buttons are tabs with text "1x"-"4x"
    const countButton = this.page!.locator(`button[role="tab"]:text-is("${count}x")`);
    const btnCount = await countButton.count();
    console.error(`[google-flow-mcp] Found ${btnCount} tab button(s) matching "${count}x"`);
    try {
      await countButton.click({ timeout: 5_000 });
      console.error(`[google-flow-mcp] Set output count to ${count}`);
    } catch {
      console.error(`[google-flow-mcp] Could not set output count to ${count}`);
    }
  }

  private async clickCreate(): Promise<void> {
    // The submit button has text "arrow_forwardCreate" (material icon + text)
    const createBtn = this.page!.locator('button:has-text("Create")').last();
    const btnCount = await createBtn.count();
    console.error(`[google-flow-mcp] Found ${btnCount} button(s) matching "Create"`);
    try {
      await createBtn.click({ timeout: 5_000 });
      console.error("[google-flow-mcp] Clicked Create button");
    } catch {
      console.error("[google-flow-mcp] Could not click Create button");
    }
  }

  private async waitAndDownloadNewImages(
    expectedCount: number,
    existingSrcs: Set<string>,
    jobId: string
  ): Promise<GeneratedImage[]> {
    // Poll for new images that weren't on the page before generation
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

  private async uploadImages(imagePaths: string[]): Promise<void> {
    // Click the "+" / "Add Media" button to get file input
    const addBtn = this.page!.locator('button:has-text("Add Media"), button:has-text("add_2Create")').first();
    try {
      await addBtn.click({ timeout: 5_000 });
    } catch {
      // fall through to try file input directly
    }

    const fileInput = this.page!.locator('input[type="file"]').first();
    try {
      // Playwright setInputFiles accepts an array for multi-file upload
      await fileInput.setInputFiles(imagePaths);
    } catch {
      console.error("[google-flow-mcp] Could not upload images");
    }
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
  }
}
