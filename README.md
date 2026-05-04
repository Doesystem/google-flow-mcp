# google-flow-mcp

REST API server that automates [Google Flow](https://labs.google/fx/tools/flow) image generation via browser automation (Playwright). Exposes generate, collect, edit, and regen as simple HTTP endpoints.

## Requirements

- Node.js 18+
- Google Chrome installed
- Google account with AI Pro access (required for Google Flow)

## Setup

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Authenticate

Run once to sign in with your Google account:

```bash
node dist/index.js auth
```

Chrome will open — sign in, wait for Flow to load, then Chrome closes automatically.  
Session is saved to `~/.google-flow-mcp/state.json` and reused on every start.

If the session expires, run `auth` again.

### 3. Start the server

```bash
node dist/index.js
```

Server starts on `http://localhost:3000` by default.

To use a different port:

```bash
PORT=8080 node dist/index.js
```

### Using pm2

```bash
pm2 start dist/index.js --name google-flow-mcp
pm2 save
pm2 startup
```

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/generate` | Submit an image generation job |
| `POST` | `/collect` | Wait for pending jobs and save results |
| `POST` | `/save` | Save selected images from temp to project |
| `POST` | `/edit` | Edit images with a new prompt |
| `POST` | `/regen` | Regenerate a variation from an existing image |

---

## API Reference

### `GET /health`

```
200 OK
{ "status": "ok" }
```

---

### `POST /generate`

Submit a generation job. Returns immediately with a `job_id` — call `/collect` to wait for results.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | Description of the image to generate |
| `image_paths` | string[] | — | Local file paths of reference images |
| `aspect_ratio` | string | — | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |
| `count` | number | — | Number of variations (1–4, default: `2`) |

**Example**

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat in watercolor style", "count": 2}'
```

**Response `202`**

```json
{
  "success": true,
  "job_id": "job-1",
  "message": "Generation submitted as job-1: \"a cat in watercolor style\""
}
```

---

### `POST /collect`

Wait for all pending generations to finish, then download and save images.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `project_dir` | string | ✅ | Root directory of your project |

**Example**

```bash
curl -X POST http://localhost:3000/collect \
  -H "Content-Type: application/json" \
  -d '{"project_dir": "C:/Users/me/my-project"}'
```

**Response `200`**

```json
{
  "success": true,
  "images": [
    {
      "project_path": "C:/Users/me/my-project/generated-images/generation-1.png",
      "archive_path": "C:/Users/me/Downloads/Google Flow/my-project/generation-1.png"
    },
    {
      "project_path": "C:/Users/me/my-project/generated-images/generation-2.png",
      "archive_path": "C:/Users/me/Downloads/Google Flow/my-project/generation-2.png"
    }
  ]
}
```

Images are saved to two locations:
- `{project_dir}/generated-images/` — inside your project
- `~/Downloads/Google Flow/{project_name}/` — archive

---

### `POST /save`

Save specific images from temp storage to the project and archive. Call this after previewing results from `/collect` and picking the ones to keep. Cleans up temp files after saving.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `temp_paths` | string[] | ✅ | Temp file paths returned by a previous collect |
| `smart_name` | string | ✅ | Short descriptive name used as filename (e.g. `watercolor-cat`) |
| `project_dir` | string | ✅ | Root directory of your project |

**Example**

```bash
curl -X POST http://localhost:3000/save \
  -H "Content-Type: application/json" \
  -d '{
    "temp_paths": ["/tmp/google-flow/watercolor-cat-abc1-1.png"],
    "smart_name": "watercolor-cat",
    "project_dir": "C:/Users/me/my-project"
  }'
```

**Response `200`**

```json
{
  "success": true,
  "saved": [
    {
      "project_path": "C:/Users/me/my-project/generated-images/watercolor-cat.png",
      "archive_path": "C:/Users/me/Downloads/Google Flow/my-project/watercolor-cat.png"
    }
  ]
}
```

---

### `POST /edit`

Upload one or more images and apply an edit prompt. Saves results directly (no separate collect step).

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `image_paths` | string[] | ✅ | Local file paths of images to edit |
| `prompt` | string | ✅ | Description of the changes to apply |
| `aspect_ratio` | string | — | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |
| `project_dir` | string | ✅ | Root directory of your project |

**Example**

```bash
curl -X POST http://localhost:3000/edit \
  -H "Content-Type: application/json" \
  -d '{
    "image_paths": ["C:/Users/me/my-project/generated-images/generation-1.png"],
    "prompt": "make it look like a painting",
    "project_dir": "C:/Users/me/my-project"
  }'
```

**Response `200`**

```json
{
  "success": true,
  "images": [
    {
      "project_path": "C:/Users/me/my-project/generated-images/make-it-look-like-a-painting.png",
      "archive_path": "C:/Users/me/Downloads/Google Flow/my-project/make-it-look-like-a-painting.png"
    }
  ]
}
```

---

### `POST /regen`

Regenerate a variation from an image already generated in the current session. Optionally apply a new prompt.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `image_index` | number | ✅ | 1-based index of the generated image to regen from |
| `prompt` | string | — | New prompt — omit to regenerate with the original prompt |
| `aspect_ratio` | string | — | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |
| `project_dir` | string | ✅ | Root directory of your project |

**Example**

```bash
curl -X POST http://localhost:3000/regen \
  -H "Content-Type: application/json" \
  -d '{
    "image_index": 1,
    "prompt": "same but at night",
    "project_dir": "C:/Users/me/my-project"
  }'
```

**Response `200`**

```json
{
  "success": true,
  "images": [
    {
      "project_path": "C:/Users/me/my-project/generated-images/same-but-at-night.png",
      "archive_path": "C:/Users/me/Downloads/Google Flow/my-project/same-but-at-night.png"
    }
  ]
}
```

---

## Typical Workflow

```
1. POST /generate   → get job_id (non-blocking)
2. POST /generate   → submit more jobs while first is generating (optional)
3. POST /collect    → wait for all jobs, get saved image paths
4. POST /regen      → iterate on a result you like
5. POST /save       → keep only the images you want, clean up temp
```

---

## File Structure

```
~/.google-flow-mcp/
  state.json          ← saved Google session (cookies + localStorage)
  chrome-profile/     ← persistent Chrome profile used during auth

~/Downloads/Google Flow/
  {project_name}/     ← archive of all generated images

{project_dir}/
  generated-images/   ← images saved per project
```

---

## Error Responses

All errors return JSON with `success: false`:

```json
{
  "success": false,
  "error": "prompt is required"
}
```

| Status | Meaning |
|---|---|
| `400` | Missing or invalid request body |
| `404` | Unknown endpoint |
| `405` | Method not allowed |
| `500` | Internal error (browser automation failure, session expired, etc.) |

If you get a `500` with a session error, run `node dist/index.js auth` to re-authenticate.

---

## Project Structure

```
src/
  index.ts          ← HTTP server, route handlers
  auth-manager.ts   ← Google session management
  flow-driver.ts    ← Playwright browser automation
  file-manager.ts   ← File path utilities, image saving
tests/
  auth-manager.test.ts
  file-manager.test.ts
  flow-driver.test.ts
```
