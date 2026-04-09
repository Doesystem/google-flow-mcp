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
  "Generate images using Google Flow. Returns variations saved to a temp folder for preview. Use save_selected_images to keep the ones the user picks.",
  {
    prompt: z.string().describe("Description of the image to generate"),
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
  async ({ prompt, aspect_ratio, count }) => {
    try {
      const driver = await getDriver();

      const images = await driver.generate({
        prompt,
        aspectRatio: aspect_ratio,
        count,
      });

      const slug = slugify(prompt);
      const tempPaths: string[] = [];

      for (const image of images) {
        const tempPath = buildTempPath(slug, image.index);
        await saveImage(image.buffer, tempPath);
        tempPaths.push(tempPath);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Generated ${images.length} variation(s) for: "${prompt}"`,
              "",
              "Temp preview paths:",
              ...tempPaths.map((p, i) => `  ${i + 1}. ${p}`),
              "",
              "Use the Read tool on each path to show inline previews.",
              "Then ask the user which to keep and call save_selected_images.",
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      // Reset driver on failure so next call gets a fresh one
      activeDriver = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error generating image: ${message}` }],
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
  "Edit an existing image using Google Flow. Returns variations saved to temp for preview.",
  {
    image_path: z.string().describe("Path to the source image to edit"),
    prompt: z.string().describe("Description of what to change"),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Change aspect ratio: 1:1, 4:3, 3:4, 16:9, or 9:16"),
  },
  async ({ image_path, prompt, aspect_ratio }) => {
    try {
      const driver = await getDriver();

      const images = await driver.edit({
        imagePath: image_path,
        prompt,
        aspectRatio: aspect_ratio,
      });

      const slug = slugify(prompt);
      const tempPaths: string[] = [];

      for (const image of images) {
        const tempPath = buildTempPath(slug, image.index);
        await saveImage(image.buffer, tempPath);
        tempPaths.push(tempPath);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Edited image with prompt: "${prompt}"`,
              "",
              "Temp preview paths:",
              ...tempPaths.map((p, i) => `  ${i + 1}. ${p}`),
              "",
              "Use the Read tool on each path to show inline previews.",
              "Then ask the user which to keep and call save_selected_images.",
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
