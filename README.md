# google-flow-mcp

REST API server that automates [Google Flow](https://labs.google/fx/tools/flow) image and video generation via browser automation (Playwright).

All generated files are saved to `~/GoogleFlow/{job_id}/`.

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

All files are saved to:

```
~/GoogleFlow/
  jobs.json               ← job history (persists across restarts)
  job-20260505-143022/
    1.png                 ← generated image
    2.png
  job-20260505-150301/
    1.mp4                 ← generated video
```

Each job gets its own folder named by timestamp. `jobs.json` keeps a record of all completed jobs so `/collect` works even after a server restart.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/img/collect/{jobId}/{index}` | Serve a generated image (for browser / n8n download) |
| `GET` | `/video/collect/{jobId}/{index}` | Serve a generated video (for browser / n8n download) |
| `POST` | `/img/generate` | Generate images from a prompt |
| `POST` | `/video/generate` | Generate a video from a prompt (Veo 3.1 Fast, 9:16, Frames) |
| `POST` | `/collect` | Lookup a completed job |
| `POST` | `/img/edit` | Edit images with a new prompt |
| `POST` | `/img/regen` | Regenerate a variation from an existing image |

---

## API Reference

### `GET /health`

```json
{ "status": "ok", "output_dir": "/Users/me/GoogleFlow" }
```

---

### `GET /img/collect/{jobId}/{index}`

Serve a generated image directly — opens in browser or can be downloaded by n8n.

```
GET http://localhost:3000/img/collect/job-20260505-143022/1
```

Returns the PNG image with `Content-Type: image/png`. Cached permanently (immutable).

---

### `GET /video/collect/{jobId}/{index}`

Serve a generated video directly — opens in browser or can be downloaded by n8n.

```
GET http://localhost:3000/video/collect/job-20260505-150301/1
```

Returns the MP4 video with `Content-Type: video/mp4`. Cached permanently (immutable).

---

### `POST /img/generate`

Generate images from a prompt. Blocks until Flow finishes, then saves and returns results.

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
curl -X POST http://localhost:3000/img/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat in watercolor style", "count": 2}'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-143022",
  "images": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-143022/1.png", "url": "/img/collect/job-20260505-143022/1" },
    { "index": 2, "path": "/Users/me/GoogleFlow/job-20260505-143022/2.png", "url": "/img/collect/job-20260505-143022/2" }
  ]
}
```

---

### `POST /video/generate`

Generate a video from a prompt using Veo 3.1 Fast. Fixed settings: Frames output, 9:16 aspect ratio, 1x count. Blocks until Flow finishes (up to 5 min).

Each call navigates to a fresh Flow project to avoid state from previous generations.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | Description of the video to generate |
| `image_paths` | string[] | — | Local file paths of reference images |
| `image_urls` | string[] | — | URLs of reference images (downloaded automatically) |
| `video_start` | string | — | URL of image to use as the first frame |
| `video_end` | string | — | URL of image to use as the last frame |

**Example**

```bash
curl -X POST http://localhost:3000/video/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a dog running on the beach at sunset",
    "video_start": "https://example.com/start-frame.jpg",
    "video_end": "https://example.com/end-frame.jpg"
  }'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-150301",
  "videos": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-150301/1.mp4", "url": "/video/collect/job-20260505-150301/1" }
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
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-143022/1.png", "url": "/img/collect/job-20260505-143022/1" }
  ]
}
```

---

### `POST /img/edit`

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
curl -X POST http://localhost:3000/img/edit \
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
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-150301/1.png", "url": "/img/collect/job-20260505-150301/1" }
  ]
}
```

---

### `POST /img/regen`

Regenerate a variation from an image already generated in the current session. Optionally apply a new prompt.

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `image_index` | number | ✅ | 1-based index of the generated image to regen from |
| `prompt` | string | — | New prompt — omit to regenerate with the original prompt |
| `aspect_ratio` | string | — | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |

**Example**

```bash
curl -X POST http://localhost:3000/img/regen \
  -H "Content-Type: application/json" \
  -d '{"image_index": 1, "prompt": "same but at night"}'
```

**Response `200`**

```json
{
  "success": true,
  "job_id": "job-20260505-150845",
  "images": [
    { "index": 1, "path": "/Users/me/GoogleFlow/job-20260505-150845/1.png", "url": "/img/collect/job-20260505-150845/1" }
  ]
}
```

---

## Typical Workflow

**Image generation:**
```
1. POST /img/generate          → รอ Flow เสร็จ → return { job_id, images: [{ url, path }] }
2. GET  /img/collect/{id}/1    → เปิดดูรูปใน browser หรือให้ n8n download
3. POST /img/edit              → แก้รูปด้วย prompt ใหม่
4. POST /img/regen             → สร้าง variation ใหม่
5. POST /collect               → ดูผลย้อนหลังได้ตลอด
```

**Video generation:**
```
1. POST /video/generate        → รอ Flow เสร็จ (นานกว่า image ~1-3 นาที)
2. GET  /video/collect/{id}/1  → เปิดดูวิดีโอใน browser หรือให้ n8n download
```

---

## Scripts

### Test video generation UI

ใช้สำหรับทดสอบ selector และ flow ของ video generation โดยไม่ต้องรัน server:

```bash
# ใช้ prompt default
node scripts/inspect-video-ui.js

# ส่ง prompt เอง
node scripts/inspect-video-ui.js "a dog running on the beach at sunset"
```

Script จะเปิด Chrome แบบ headful ทำทุก step พร้อม log ผลแต่ละขั้น และบันทึกวิดีโอที่ได้ไว้ที่ `~/GoogleFlow/test-video/test-output.mp4`

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
| `404` | Unknown endpoint or file not found |
| `405` | Method not allowed |
| `500` | Internal error (browser automation failure, session expired, etc.) |

If you get a `500` with a session error, run `node dist/index.js auth` to re-authenticate.

---

## File Structure

```
src/
  index.ts            ← HTTP server, route handlers
  auth-manager.ts     ← Google session management
  flow-driver.ts      ← Playwright browser automation
  file-manager.ts     ← File path utilities, image/video saving
scripts/
  inspect-video-ui.js ← Test script for video generation flow
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
