import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import { AuthManager } from "./auth-manager.js";
import { FlowDriver } from "./flow-driver.js";
import {
  slugify,
  buildArchivePath,
  buildProjectPath,
  saveImage,
} from "./file-manager.js";

const server = new McpServer({
  name: "google-flow",
  version: "1.0.0",
});

const authManager = new AuthManager();

function getProjectName(): string | null {
  const cwd = process.cwd();
  return path.basename(cwd) || null;
}

server.tool(
  "generate_image",
  "Generate images using Google Flow. Returns 4 variations saved to an archive folder. Ask the user which ones to keep in the project.",
  {
    prompt: z.string().describe("Description of the image to generate"),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Aspect ratio: 1:1, 4:3, 3:4, 16:9, or 9:16"),
    resolution: z
      .string()
      .optional()
      .describe("Resolution like 1024x1024 or 1920x1080 (if supported by Flow)"),
    project_path: z
      .string()
      .optional()
      .describe("Custom subdirectory in the project for saving selected images (default: assets/images)"),
    count: z
      .number()
      .optional()
      .default(4)
      .describe("Number of variations to generate (default: 4)"),
  },
  async ({ prompt, aspect_ratio, resolution, project_path, count }) => {
    try {
      const context = await authManager.getAuthenticatedContext();
      const driver = new FlowDriver(context);
      await driver.init();

      const images = await driver.generate({
        prompt,
        aspectRatio: aspect_ratio,
        resolution,
        count,
      });

      await driver.close();

      const slug = slugify(prompt);
      const projectName = getProjectName();
      const savedPaths: string[] = [];

      for (const image of images) {
        const archivePath = buildArchivePath(projectName, slug, image.index);
        await saveImage(image.buffer, archivePath);
        savedPaths.push(archivePath);
      }

      await authManager.close();

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Generated ${images.length} variation(s) for: "${prompt}"`,
              "",
              "Saved to archive:",
              ...savedPaths.map((p, i) => `  ${i + 1}. ${p}`),
              "",
              "Which image(s) would you like to keep in the project?",
              `(They will be saved to ${project_path ?? "assets/images/"})`,
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
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
  "Save user-selected images from the archive to the project directory.",
  {
    archive_paths: z
      .array(z.string())
      .describe("Array of archive file paths to copy to the project"),
    project_dir: z
      .string()
      .describe("The project's root directory"),
    project_path: z
      .string()
      .optional()
      .describe("Custom subdirectory in the project (default: assets/images)"),
  },
  async ({ archive_paths, project_dir, project_path }) => {
    const { readFile } = await import("fs/promises");
    const savedPaths: string[] = [];

    for (const archivePath of archive_paths) {
      const filename = path.basename(archivePath);
      const destPath = path.join(
        project_dir,
        project_path ?? path.join("assets", "images"),
        filename
      );

      const buffer = await readFile(archivePath);
      await saveImage(Buffer.from(buffer), destPath);
      savedPaths.push(destPath);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Saved to project:",
            ...savedPaths.map((p) => `  - ${p}`),
          ].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "edit_image",
  "Edit an existing image using Google Flow's inpainting/editing feature.",
  {
    image_path: z.string().describe("Path to the source image to edit"),
    prompt: z.string().describe("Description of what to change"),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Change aspect ratio: 1:1, 4:3, 3:4, 16:9, or 9:16"),
    resolution: z
      .string()
      .optional()
      .describe("Change resolution (if supported by Flow)"),
    project_path: z
      .string()
      .optional()
      .describe("Custom subdirectory in the project for saving the result"),
  },
  async ({ image_path, prompt, aspect_ratio, resolution, project_path }) => {
    try {
      const context = await authManager.getAuthenticatedContext();
      const driver = new FlowDriver(context);
      await driver.init();

      const images = await driver.edit({
        imagePath: image_path,
        prompt,
        aspectRatio: aspect_ratio,
        resolution,
      });

      await driver.close();

      const slug = slugify(prompt);
      const projectName = getProjectName();
      const savedPaths: string[] = [];

      for (const image of images) {
        const archivePath = buildArchivePath(projectName, slug, image.index);
        await saveImage(image.buffer, archivePath);
        savedPaths.push(archivePath);
      }

      await authManager.close();

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Edited image with prompt: "${prompt}"`,
              "",
              "Saved to archive:",
              ...savedPaths.map((p, i) => `  ${i + 1}. ${p}`),
              "",
              "Which result(s) would you like to keep in the project?",
              `(They will be saved to ${project_path ?? "assets/images/"})`,
            ].join("\n"),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error editing image: ${message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[google-flow-mcp] Server started. Waiting for requests...");
}

main().catch((error) => {
  console.error("[google-flow-mcp] Fatal error:", error);
  process.exit(1);
});
