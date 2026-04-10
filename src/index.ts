#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import { readFile } from "fs/promises";
import { AuthManager } from "./auth-manager.js";
import { FlowDriver } from "./flow-driver.js";
import {
  slugify,
  buildTempPath,
  buildArchivePath,
  buildProjectPath,
  nextAvailableName,
  saveImage,
  cleanTemp,
  getArchiveBaseDir,
} from "./file-manager.js";

const server = new McpServer({
  name: "google-flow",
  version: "1.0.0",
});

const authManager = new AuthManager();

// Reuse a single browser + driver across calls — no re-launching per request
let activeDriver: FlowDriver | null = null;

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

server.tool(
  "generate_image",
  "Generate images using Google Flow. Optionally upload reference images to guide generation. Returns variations saved to a temp folder for preview. Use save_selected_images to keep the ones the user picks.",
  {
    prompt: z.string().describe("Description of the image to generate"),
    image_paths: z
      .array(z.string())
      .optional()
      .describe("Optional array of reference image file paths to guide generation"),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Aspect ratio: 1:1, 4:3, 3:4, 16:9, or 9:16"),
    count: z
      .number()
      .optional()
      .default(2)
      .describe("Number of variations to generate (1-4, default: 2)"),
  },
  async ({ prompt, image_paths, aspect_ratio, count }) => {
    try {
      const driver = await getDriver();

      const jobId = await driver.submitGeneration({
        prompt,
        imagePaths: image_paths,
        aspectRatio: aspect_ratio,
        count,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Generation submitted as ${jobId}: "${prompt}" (${count ?? 2} variation(s))`,
              "",
              "Image is now generating in the background.",
              "Submit more generate_image calls, or call collect_images to wait for results.",
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      activeDriver = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error submitting generation: ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "collect_images",
  "Wait for all pending image generations to complete, download and save them to the project's generated-images/ directory and archive. Call this after submitting one or more generate_image requests.",
  {
    project_dir: z
      .string()
      .describe("The project's root directory where generated-images/ will be created"),
  },
  async ({ project_dir }) => {
    try {
      const driver = await getDriver();

      if (!driver.hasPendingJobs) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pending generations to collect. Submit generate_image calls first.",
            },
          ],
        };
      }

      const images = await driver.collectAllImages();
      const projectName = getProjectName();
      const projectImagesDir = path.join(project_dir, "generated-images");
      const savedPaths: string[] = [];

      for (const image of images) {
        const smartName = `generation-${image.index}`;
        const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");

        const { name: projectFileName } = nextAvailableName(projectImagesDir, smartName);
        const { name: archiveName } = nextAvailableName(archiveDir, smartName);

        const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);
        const archivePath = path.join(archiveDir, `${archiveName}.png`);

        await saveImage(image.buffer, projectPath);
        await saveImage(image.buffer, archivePath);
        savedPaths.push(projectPath);
      }

      const lines: string[] = [`Collected and saved ${images.length} image(s):`, ""];
      for (let i = 0; i < savedPaths.length; i++) {
        lines.push(`  ${i + 1}. ${savedPaths[i]}`);
      }
      lines.push("");
      lines.push("Use the Read tool on each path to preview and identify which is which.");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (error) {
      activeDriver = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error collecting images: ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "save_selected_images",
  "Save user-selected images to the project directory and archive. Only saves the images the user chose to keep.",
  {
    temp_paths: z
      .array(z.string())
      .describe("Array of temp file paths for the selected images"),
    smart_name: z
      .string()
      .describe("Short 2-3 word descriptive name for the files (e.g. 'watercolor-cat', 'neon-city')"),
    project_dir: z
      .string()
      .describe("The project's root directory"),
  },
  async ({ temp_paths, smart_name, project_dir }) => {
    try {
      const projectName = getProjectName();
      const savedPaths: { archive: string; project: string }[] = [];

      const projectImagesDir = path.join(project_dir, "generated-images");

      for (let i = 0; i < temp_paths.length; i++) {
        const buffer = await readFile(temp_paths[i]);
        const variationIndex = temp_paths.length > 1 ? i + 1 : undefined;

        const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");
        const { name: archiveName } = variationIndex !== undefined
          ? { name: `${smart_name}-${variationIndex}` }
          : nextAvailableName(archiveDir, smart_name);

        const { name: projectFileName } = variationIndex !== undefined
          ? { name: `${smart_name}-${variationIndex}` }
          : nextAvailableName(projectImagesDir, smart_name);

        const archivePath = path.join(archiveDir, `${archiveName}.png`);
        const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);

        await saveImage(Buffer.from(buffer), archivePath);
        await saveImage(Buffer.from(buffer), projectPath);
        savedPaths.push({ archive: archivePath, project: projectPath });
      }

      await cleanTemp();

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Saved selected images:",
              "",
              ...savedPaths.map((p, i) => [
                `  ${i + 1}. Project: ${p.project}`,
                `     Archive: ${p.archive}`,
              ].join("\n")),
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error saving images: ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "edit_image",
  "Edit one or more images using Google Flow. Upload reference images and describe the changes. Returns variations saved to temp for preview.",
  {
    image_paths: z
      .array(z.string())
      .describe("Array of file paths to the source image(s) to edit"),
    prompt: z.string().describe("Description of what to change"),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Change aspect ratio: 1:1, 4:3, 3:4, 16:9, or 9:16"),
    project_dir: z
      .string()
      .describe("The project's root directory where generated-images/ will be created"),
  },
  async ({ image_paths, prompt, aspect_ratio, project_dir }) => {
    try {
      const driver = await getDriver();

      const images = await driver.edit({
        imagePaths: image_paths,
        prompt,
        aspectRatio: aspect_ratio,
      });

      const smartName = slugify(prompt);
      const projectName = getProjectName();
      const projectImagesDir = path.join(project_dir, "generated-images");
      const savedPaths: string[] = [];

      for (const image of images) {
        const { name: projectFileName } = nextAvailableName(projectImagesDir, smartName);
        const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");
        const { name: archiveName } = nextAvailableName(archiveDir, smartName);

        const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);
        const archivePath = path.join(archiveDir, `${archiveName}.png`);

        await saveImage(image.buffer, projectPath);
        await saveImage(image.buffer, archivePath);
        savedPaths.push(projectPath);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Edited image with prompt: "${prompt}"`,
              "",
              "Saved to:",
              ...savedPaths.map((p, i) => `  ${i + 1}. ${p}`),
              "",
              "Use the Read tool on each path to show inline previews.",
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      activeDriver = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error editing image: ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "regen_image",
  "Regenerate from an existing generated image in the current Flow session. Clicks on the image by index to open the edit view, then optionally applies a new prompt. Omit the prompt to regenerate a new variation with the original prompt. Use this to iterate on a previously generated image without re-uploading.",
  {
    image_index: z
      .number()
      .describe("1-based index of the generated image to regen from (e.g. 1 for first image)"),
    prompt: z.string().optional().describe("New prompt to edit the image. Omit to regenerate a new variation with the original prompt."),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Change aspect ratio: 1:1, 4:3, 3:4, 16:9, or 9:16"),
    project_dir: z
      .string()
      .describe("The project's root directory where generated-images/ will be created"),
  },
  async ({ image_index, prompt, aspect_ratio, project_dir }) => {
    try {
      const driver = await getDriver();

      const images = await driver.regen({
        imageIndex: image_index,
        prompt,
        aspectRatio: aspect_ratio,
      });

      const smartName = slugify(prompt ?? `regen-${image_index}`);
      const projectName = getProjectName();
      const projectImagesDir = path.join(project_dir, "generated-images");
      const savedPaths: string[] = [];

      for (const image of images) {
        const { name: projectFileName } = nextAvailableName(projectImagesDir, smartName);
        const archiveDir = path.join(getArchiveBaseDir(), projectName ?? "General");
        const { name: archiveName } = nextAvailableName(archiveDir, smartName);

        const projectPath = path.join(projectImagesDir, `${projectFileName}.png`);
        const archivePath = path.join(archiveDir, `${archiveName}.png`);

        await saveImage(image.buffer, projectPath);
        await saveImage(image.buffer, archivePath);
        savedPaths.push(projectPath);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              prompt
                ? `Regenerated from image #${image_index} with prompt: "${prompt}"`
                : `Regenerated a new variation from image #${image_index}`,
              "",
              "Saved to:",
              ...savedPaths.map((p, i) => `  ${i + 1}. ${p}`),
              "",
              "Use the Read tool on each path to show inline previews.",
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      activeDriver = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error regenerating image: ${message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const command = process.argv[2];

  if (command === "auth") {
    await authManager.launchForAuth();
    process.exit(0);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[google-flow-mcp] Server started. Waiting for requests...");
}

main().catch((error) => {
  console.error("[google-flow-mcp] Fatal error:", error);
  process.exit(1);
});
