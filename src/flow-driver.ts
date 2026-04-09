import { BrowserContext, Page } from "playwright";

const FLOW_URL = "https://labs.google/fx/tools/flow";
const LOGGED_IN_SELECTOR = '[data-slate-editor="true"]';

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
    await this.page.goto(FLOW_URL, { waitUntil: "domcontentloaded" });
    await this.page.waitForSelector(LOGGED_IN_SELECTOR, { timeout: 30_000 });
  }

  async generate(options: GenerateOptions): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    if (options.aspectRatio) {
      await this.setAspectRatio(options.aspectRatio);
    }

    if (options.count !== undefined) {
      await this.setOutputCount(options.count);
    }

    await this.typePrompt(options.prompt);
    await this.clickGenerate();
    const images = await this.waitAndDownloadImages(options.count ?? 4);
    return images;
  }

  async edit(options: EditOptions): Promise<GeneratedImage[]> {
    if (!this.page) throw new Error("FlowDriver not initialized. Call init() first.");

    await this.uploadImage(options.imagePath);
    await this.typePrompt(options.prompt);

    if (options.aspectRatio) {
      await this.setAspectRatio(options.aspectRatio);
    }

    await this.clickGenerate();
    const images = await this.waitAndDownloadImages(1);
    return images;
  }

  private async typePrompt(prompt: string): Promise<void> {
    const editor = this.page!.locator(LOGGED_IN_SELECTOR);
    await editor.click();
    await this.page!.keyboard.press("Meta+a");
    await this.page!.keyboard.press("Backspace");
    await this.page!.keyboard.type(prompt, { delay: 10 });
  }

  private async setAspectRatio(ratio: string): Promise<void> {
    const ratioMap: Record<string, string> = {
      "1:1": "1:1",
      "4:3": "4:3",
      "3:4": "3:4",
      "16:9": "16:9",
      "9:16": "9:16",
    };

    const label = ratioMap[ratio];
    if (!label) {
      console.error(`[google-flow-mcp] Unknown aspect ratio: ${ratio}, skipping`);
      return;
    }

    const ratioButton = this.page!.locator(
      `button:has-text("${label}"), [aria-label*="${label}"]`
    ).first();

    try {
      await ratioButton.click({ timeout: 5_000 });
    } catch {
      console.error(`[google-flow-mcp] Could not find aspect ratio button for ${label}`);
    }
  }

  private async setOutputCount(count: number): Promise<void> {
    const slider = this.page!.locator('input[type="range"]').first();
    try {
      await slider.fill(String(count));
    } catch {
      console.error(`[google-flow-mcp] Could not set output count to ${count}`);
    }
  }

  private async clickGenerate(): Promise<void> {
    const generateBtn = this.page!.locator(
      'button:has-text("Generate"), button:has-text("Create"), button[aria-label*="Generate"]'
    ).first();

    try {
      await generateBtn.click({ timeout: 5_000 });
    } catch {
      await generateBtn.dispatchEvent("click");
    }
  }

  private async waitAndDownloadImages(expectedCount: number): Promise<GeneratedImage[]> {
    await this.page!.waitForTimeout(3_000);

    const imageSelector = 'img[src*="blob:"], img[src*="lh3.googleusercontent"], img[src*="generated"]';
    await this.page!.waitForSelector(imageSelector, {
      timeout: 120_000,
      state: "attached",
    });

    await this.page!.waitForTimeout(5_000);

    const imageElements = await this.page!.locator(imageSelector).all();
    const images: GeneratedImage[] = [];

    for (let i = 0; i < Math.min(imageElements.length, expectedCount); i++) {
      try {
        const src = await imageElements[i].getAttribute("src");
        if (!src) continue;

        let buffer: Buffer;
        if (src.startsWith("blob:")) {
          const base64 = await this.page!.evaluate(async (blobUrl: string) => {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            return new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
          }, src);
          const data = base64.split(",")[1];
          buffer = Buffer.from(data, "base64");
        } else {
          const response = await this.page!.request.get(src);
          buffer = Buffer.from(await response.body());
        }

        images.push({ buffer, index: i + 1 });
      } catch (err) {
        console.error(`[google-flow-mcp] Failed to download image ${i + 1}:`, err);
      }
    }

    return images;
  }

  private async uploadImage(imagePath: string): Promise<void> {
    const fileInput = this.page!.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(imagePath);
    } catch {
      const uploadBtn = this.page!.locator(
        'button:has-text("Upload"), button:has-text("Edit"), button[aria-label*="Upload"]'
      ).first();
      await uploadBtn.click({ timeout: 5_000 });

      const input = this.page!.locator('input[type="file"]').first();
      await input.setInputFiles(imagePath);
    }
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
  }
}
