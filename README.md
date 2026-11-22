# mech-ocr

OCR pipeline for [mech-kb](../mech-kb) — fully decoupled, runs as independent process.

## What this is

- **GLM-OCR** (local, via Ollama, 0.9B, MIT, zero token) — primary engine
- **tesseract.js** (local WASM, chi_sim) — fallback engine
- **Doc2X / TextIn** (cloud) — optional fallbacks
- Four-step pipeline: initial OCR → quality review → precise extraction → common-sense review → queue ingest tasks

## Architecture

```
mech-kb/              ← KB core (independent repo, no OCR code)
  core/ops.js         ← ocr_start spawns mech-ocr/pipeline.js
  studio/server.js    ← HTTP API (:7350)
    POST /api/ocr_report   ← OCR reports progress
    POST /api/llm_complete  ← OCR calls author model
    POST /api/task_add     ← OCR queues ingest tasks

mech-ocr/             ← this repo (no KB code required)
  pipeline.js         ← OCR pipeline (reads KB files, calls KB HTTP API)
  engines.js          ← unified engine interface (GLM-OCR / Doc2X / TextIn / tesseract)
  kb-client.js        ← KB HTTP API client (http module, not fetch)
  package.json        ← pdf-to-img, tesseract.js
```

KB and OCR communicate via:
1. **HTTP API** — task_add (queue tasks), ocr_report (progress), llm_complete (LLM agent)
2. **File system** — pipeline reads `MECH_KB_RAW/original/` PDFs, writes `pages/`, reads `toc.json`

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) with `glm-ocr` model pulled
- mech-kb running (Studio on :7350)

## Setup

```bash
# 1. Clone both repos side by side
git clone <mech-kb-url> mech-kb
git clone <mech-ocr-url> mech-ocr

# 2. Install OCR dependencies
cd mech-ocr
npm install

# 3. Start Ollama + pull model
ollama serve &
ollama pull glm-ocr

# 4. Start KB Studio
cd ../mech-kb
node bin/mech-kb.js studio --open

# 5. In KB web UI (Sources page), click OCR button
#    KB ocr_start spawns mech-ocr/pipeline.js automatically
```

## Environment variables (injected by KB ocr_start)

| Var | Description |
|---|---|
| `MECH_KB_ROOT` | KB root directory (for `.state/ocr.json` credentials) |
| `MECH_KB_RAW` | raw directory (for `original/` PDFs, `pages/`, `toc.json`) |
| `MECH_KB_URL` | KB Studio HTTP API URL (`http://127.0.0.1:7350`) |
| `OCR_ROOT` | Where KB looks for mech-ocr (default: `../mech-ocr`) |

## Engine credentials

In `mech-kb/.state/ocr.json` (not in git):

```json
{
  "ollama_url": "http://127.0.0.1:11434",
  "ollama_model": "glm-ocr",
  "doc2x_token": "",
  "textin_app_id": "",
  "textin_secret_code": ""
}
```

Local GLM-OCR needs no credentials. Doc2X/TextIn are optional cloud fallbacks.

## Lazy pack

See `ocr-pack/` for one-click deploy/build scripts (bundles Ollama + model + tessdata + this repo into a zip).
