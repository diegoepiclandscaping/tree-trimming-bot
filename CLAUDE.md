# CLAUDE.md — Tree Trimming Bot

## Project Overview

A single-file Telegram bot for **Epic Landscaping**, a tree trimming company in South Florida. Users send an estimate document (photo or PDF) to the bot; it uses the Claude AI vision API to extract key fields, lets the user review/edit them through an inline keyboard flow, and then creates a Notion database page with the extracted data and the original file attached.

## Repository Structure

```
tree-trimming-bot/
├── bot.js          # Entire application (single file, ~454 lines)
└── package.json    # Node.js manifest and dependency list
```

There is no build step, test suite, linter config, or bundler. The app runs directly with Node.js.

## Tech Stack

| Concern | Library / Service |
|---|---|
| Telegram messaging | `node-telegram-bot-api` ^0.66 (polling mode) |
| HTTP requests | `node-fetch` ^2 (CommonJS-compatible) |
| Multipart file uploads | `form-data` ^4 |
| Environment variables | `dotenv` ^16 |
| AI extraction | Anthropic Messages API (`claude-sonnet-4-20250514`) |
| Data storage | Notion API v2022-06-28 |

## Environment Variables

The bot exits immediately at startup if any required variable is missing.

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `NOTION_TOKEN` | Yes | Notion integration token |
| `NOTION_PROJECTS_DB` | No | Notion database ID (defaults to `9ae58454-87ec-4ac1-8460-496c51dcb323`) |

Create a `.env` file at the repo root (never commit it):

```
TELEGRAM_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
NOTION_TOKEN=...
NOTION_PROJECTS_DB=...   # optional
```

## Running the Bot

```bash
npm install
npm start          # runs: node bot.js
```

The bot uses **long-polling** (`{ polling: true }`), so no webhook or public URL is needed.

## Architecture — Data Flow

```
User sends photo/PDF
        │
        ▼
  handleFile()
  ├── downloadTelegramFile()   — fetches raw bytes from Telegram CDN
  ├── extractEstimateData()    — sends base64 content to Claude API, returns JSON
  └── stores result in session → step = "confirm"
        │
        ▼
  formatConfirmationMessage() → bot sends inline keyboard (confirm / edit / cancel)
        │
        ├── "confirm" callback
        │   ├── uploadFileToNotion()   — 2-step: POST /file_uploads, then POST multipart
        │   └── createNotionProject()  — POST /pages with all fields + file reference
        │
        ├── "edit" callback → editFieldKeyboard (field selector)
        │   ├── text fields → awaiting_input step → text message handler updates form
        │   ├── "edit_city" → cityKeyboard() inline picker
        │   └── "edit_manager" → managerKeyboard() inline picker
        │
        └── "cancel" callback → clearSession()
```

## Session Management

Sessions are stored **in-memory** in a plain `sessions` object keyed by Telegram `chatId`. Sessions are not persisted — a bot restart clears all in-progress workflows.

Session shape:
```js
{
  step: "idle" | "confirm" | "editing" | "awaiting_input",
  form: {
    projectName, address, city, price,
    estimateNumber, description, manager
  },
  fileBuffer: Buffer | null,
  fileName: string | null,
  fileType: string | null,   // MIME type, e.g. "image/jpeg"
  editingField: string | null
}
```

`getSession(chatId)` lazily initialises a session. `clearSession(chatId)` resets it to the idle default.

## Notion Integration

### Database Properties Expected

| Property name | Notion type | Notes |
|---|---|---|
| `Project Name` | title | Required — used as page title |
| `Address` | rich_text | Full street address |
| `Estimate Number` | rich_text | |
| `Descripción del trabajo` | rich_text | Work description (Spanish column name) |
| `Status` | status | Set to `"Not started"` on creation |
| `Price` | number | Only set when non-zero |
| `City` | select | Must match one of the 18 city options |
| `Manager` | select | Must match one of the 15 manager names |
| `Estimate` | files | Attached via Notion file upload API |

### File Upload Flow (2 steps)
1. `POST /v1/file_uploads` — initialise upload session, get `id` + `upload_url`
2. `POST {upload_url}` — multipart upload of the file bytes
3. Reference the `id` in the page's `Estimate` files property

Upload failures are non-fatal: the Notion page is still created, but a warning is shown to the user.

## Claude API Usage

Model: `claude-sonnet-4-20250514`

The bot sends the document as a base64-encoded `document` block (PDFs) or `image` block (photos) with a text prompt requesting structured JSON output. The prompt:
- Lists exact JSON field names and types
- Constrains `city` to the 18 valid South Florida cities
- Instructs the model to return **only** raw JSON (no markdown fences)

Response parsing strips any residual ` ```json ``` ` fences before `JSON.parse()`.

## Hardcoded Business Data

### Managers (15)
Alex Collier, Andrea Trivino, Andres Collier, Andres Muneton, Carlos Telechea, Claudia Monterrosa, Diego Echeverry, Faren Alvarez, Jose Barquero, Josué Morales, Luciano Jarama, Nicole Wolmers, Ronald Ramirez, Sara Castillo, Victor Muñoz

### Cities (18 — South Florida)
Boca Raton, Coral Springs, Davie, Delray Beach, Hollywood, Lauderhill, Lighthouse Point, Margate, Miami, Miami Beach, Miami Gardens, Miramar, Pembroke Pines, Plantation, Southwest Ranches, Sunrise, Tamarac, Weston

To add/remove managers or cities, edit the `MANAGERS` and `CITIES` arrays at the top of `bot.js`.

## Bot Commands

| Command | Behaviour |
|---|---|
| `/start` | Clears session, sends welcome message |
| `/cancelar` | Clears session, sends cancellation message |

## Telegram Event Handlers

| Event | Handler |
|---|---|
| `photo` | Extracts highest-resolution photo, calls `handleFile()` |
| `document` | Passes file metadata to `handleFile()` (PDFs and image docs) |
| `message` | Handles free-text input when `step === "awaiting_input"` |
| `callback_query` | Drives the entire inline-keyboard state machine |
| `polling_error` | Logs error message to stderr |

## Key Conventions

- **Language**: Bot messages to users are in **Spanish**. Code comments and variable names are in English.
- **Error handling**: API errors are caught and surfaced to the user as Telegram messages. The bot never crashes silently.
- **File type detection**: Telegram photos always arrive as JPEG. Documents may be PDF or image; MIME type comes from Telegram's `document.mime_type`. Images with no/unknown MIME are treated as JPEG.
- **Inline keyboard editing**: City and Manager fields use inline button pickers. All other fields accept free-text input.
- **Confirmation required before saving**: The bot never writes to Notion without an explicit "✅ Confirmar y guardar" button press.

## Common Development Tasks

### Add a new editable field
1. Add the field to the `form` object in `getSession()` and `clearSession()`.
2. Add a button to `editFieldKeyboard`.
3. Add a label in `fieldLabel()`.
4. Add the Notion property mapping in `createNotionProject()`.
5. Add the field to the Claude extraction prompt in `extractEstimateData()`.
6. Update `formatConfirmationMessage()` to display it.

### Change the Claude model
Update the `model` string in `extractEstimateData()` (line ~88). Always verify the new model supports vision/document inputs.

### Add a new city or manager
Append to the `CITIES` or `MANAGERS` array near the top of `bot.js`. No other changes needed — keyboards are generated dynamically.

### Deploy
The bot only needs Node.js and outbound HTTPS. No inbound ports. Suitable for any VPS, Docker container, or PaaS that can run a persistent Node process. Use a process manager (e.g. `pm2`) for production restarts.
