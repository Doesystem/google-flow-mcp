# google-flow-mcp

REST API server that automates [Google Flow](https://labs.google/fx/tools/flow) image generation via browser automation (Playwright). Exposes generate, collect, edit, and regen as simple HTTP endpoints.

All generated images are saved to `~/GoogleFlow/{job_id}/`.

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
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Common pm2 commands:

```bash
pm2 logs google-flow-mcp
pm2 restart google-flow-mcp
pm2 stop google-flow-mcp
pm2 status
```

---

## Output

All images are saved to:

```
~/GoogleFlow/
  jobs.json             ← job history (persists across restarts)
  job-20260505-143022/
    1.png
    2.png
  job-20260505-150301/
    1.png
```

Each job gets its own folder named by timestamp. `jobs.json` keeps a record of all completed jobs so `/collect` works even after a server restart.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/generate` | Submit an image generation job (non-blocking) |
| `POST` | `/collect` | Wait for all pending jobs and save results |
| `POST` | `/edit` | Edit images with a new prompt |
| `POST` | `/regen` | Regenerate a variation from an existing image |

---

## API Reference

### `GET /health`

```json
{ "status": "ok", "output_dir": "/Users/me/GoogleFlow" }
```

---

### `POST /generate`

Submit a generation job. Returns immediately with a `job_id` — call `/collect` to wait for results.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | Description of the image to generate |
| `image_paths` | string[] | — | Local file paths of reference images |
| `image_urls` | string[] | — | URLs of reference images (downloaded automatically) |
| `aspect_ratio` | string | — | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |
| `count` | number | — | Number of variations (1–4, default: `2`) |

**Example**

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat in watercolor style", "count": 2}'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-143022",
  "images": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-143022/1.png" },
    { "index": 2, "path": "/Users/me/GoogleFlow/job-20260505-143022/2.png" }
  ]
}
```

---

### `POST /collect`

Lookup a completed job. Works across server restarts — job history is persisted in `~/GoogleFlow/jobs.json`.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `job_id` | string | — | Job ID to look up — omit to get the most recent job |

**Example — get most recent job**

```bash
curl -X POST http://localhost:3000/collect
```

**Example — get specific job**

```bash
curl -X POST http://localhost:3000/collect \
  -H "Content-Type: application/json" \
  -d '{"job_id": "job-20260505-143022"}'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-143022",
  "images": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-143022/1.png" },
    { "index": 2, "path": "/Users/me/GoogleFlow/job-20260505-143022/2.png" }
  ]
}
```

---

### `POST /edit`

Upload one or more images and apply an edit prompt. Saves results immediately — no separate `/collect` needed.

**Body**
| Field | Type | Required | Description |
|---|---|---|---|
| `image_paths` | string[] | — | Local file paths of images to edit |
| `image_urls` | string[] | — | URLs of images to edit (downloaded automatically) |
| `prompt` | string | ✅ | Description of the changes to apply |
| `aspect_ratio` | string | — | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |

At least one of `image_paths` or `image_urls` is required.

**Example**

```bash
curl -X POST http://localhost:3000/edit \
  -H "Content-Type: application/json" \
  -d '{
    "image_urls": ["https://example.com/photo.jpg"],
    "prompt": "make it look like a painting"
  }'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-150301",
  "images": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-150301/1.png" }
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

**Example**

```bash
curl -X POST http://localhost:3000/regen \
  -H "Content-Type: application/json" \
  -d '{"image_index": 1, "prompt": "same but at night"}'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-150845",
  "images": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-150845/1.png" }
  ]
}
```

---

## Typical Workflow

```
1. POST /generate   → รอ Flow เสร็จ → return { job_id, images }
2. POST /edit       → แก้รูปด้วย prompt ใหม่ → return { job_id, images }
3. POST /regen      → สร้าง variation ใหม่ → return { job_id, images }
4. POST /collect    → ดูผลย้อนหลังได้ตลอด (ไม่ต้อง generate ใหม่)
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

## File Structure

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
ecosystem.config.cjs  ← pm2 config
```

---

## Session Storage

```
~/.google-flow-mcp/
  state.json          ← saved Google session (cookies + localStorage)
  chrome-profile/     ← persistent Chrome profile used during auth
```
