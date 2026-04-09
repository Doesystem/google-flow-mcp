import { BrowserContext, Page } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const DASHBOARD_SELECTOR = 'button:has-text("New project")';
const PROMPT_SELECTOR = '[data-slate-editor="true"]';
const GENERATED_IMAGE_SELECTOR = 'img[src*="media.getMediaUrlRedirect"]';

export interface GenerateOptions {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
}

export interface EditOptions {
  imagePath: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
}

export interface GeneratedImage {
  buffer: Buffer;
  index: number;
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
      // Try to open the first existing project
      const existingProject = this.page.locator('a[href*="project/"]').first();
      const hasExisting = await existingProject.isVisible().catch(() => false);

      if (hasExisting) {
        await existingProject.click();
        console.error("[google-flow-mcp] Reusing existing Flow project");
      } else {
        await this.page.locator(DASHBOARD_SELECTOR).click();
        console.error("[google-flow-mcp] Created new Flow project");
      }

      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    } else {
      // May already be in a project
      await this.page.waitForSelector(PROMPT_SELECTOR, { timeout: 15_000 });
    }
  }

  async generate(options: GenerateOptions): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    // Open settings panel to set aspect ratio and count
    await this.openSettingsPanel();

    if (options.aspectRatio) {
      await this.setAspectRatio(options.aspectRatio);
    }

    const count = options.count ?? 2;
    await this.setOutputCount(count);

    // Close settings panel by clicking outside
    await this.closeSettingsPanel();

    // Count existing images before generating so we only download new ones
    const existingImages = await this.page.locator(GENERATED_IMAGE_SELECTOR).all();
    const existingSrcs = new Set<string>();
    for (const el of existingImages) {
      const src = await el.getAttribute("src");
      if (src) existingSrcs.add(src);
    }

    await this.typePrompt(options.prompt);
    await this.clickCreate();
    const images = await this.waitAndDownloadNewImages(count, existingSrcs);
    return images;
  }

  async edit(options: EditOptions): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    await this.uploadImage(options.imagePath);

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
    const images = await this.waitAndDownloadNewImages(1, existingSrcs);
    return images;
  }

  private async openSettingsPanel(): Promise<void> {
    // Click the model chip (e.g. "Nano Banana 2") to open settings
    const modelChip = this.page!.locator('button:has-text("Nano Banana")');
    try {
      await modelChip.click({ timeout: 5_000 });
      await this.page!.waitForTimeout(500);
    } catch {
      console.error("[google-flow-mcp] Could not open settings panel");
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

    // Count buttons are Radix tabs with role="tab" and text "x1"-"x4"
    const countButton = this.page!.locator(`button[role="tab"]:text-is("x${count}")`);
    try {
      await countButton.click({ timeout: 5_000 });
    } catch {
      console.error(`[google-flow-mcp] Could not set output count to ${count}`);
    }
  }

  private async clickCreate(): Promise<void> {
    // The submit button has text "arrow_forwardCreate" (material icon + text)
    const createBtn = this.page!.locator('button:has-text("Create")').last();
    try {
      await createBtn.click({ timeout: 5_000 });
    } catch {
      console.error("[google-flow-mcp] Could not click Create button");
    }
  }

  private async waitAndDownloadNewImages(
    expectedCount: number,
    existingSrcs: Set<string>
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
    }

    console.error(`[google-flow-mcp] Found ${newSrcs.length} new generated image(s)`);

    const images: GeneratedImage[] = [];
    for (let i = 0; i < Math.min(newSrcs.length, expectedCount); i++) {
      try {
        const url = newSrcs[i].startsWith("http") ? newSrcs[i] : `https://labs.google${newSrcs[i]}`;
        const response = await this.page!.request.get(url);
        const buffer = Buffer.from(await response.body());
        images.push({ buffer, index: i + 1 });
      } catch (err) {
        console.error(`[google-flow-mcp] Failed to download image ${i + 1}:`, err);
      }
    }

    return images;
  }

  private async uploadImage(imagePath: string): Promise<void> {
    // Click the "+" / "Add Media" button to get file input
    const addBtn = this.page!.locator('button:has-text("Add Media"), button:has-text("add_2Create")').first();
    try {
      await addBtn.click({ timeout: 5_000 });
    } catch {
      // fall through to try file input directly
    }

    const fileInput = this.page!.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(imagePath);
    } catch {
      console.error("[google-flow-mcp] Could not upload image");
    }
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
  }
}
