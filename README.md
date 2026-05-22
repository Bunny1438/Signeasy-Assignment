# Signeasy eSignature Demo

A simple single-page app that demonstrates an end-to-end eSignature workflow using the Signeasy API v3.

## Workflow

```
Upload document → Send to signer (email) → Track status → Download signed PDF
```

## Project structure

```
├── backend/
│   ├── server.js        # Express proxy server (holds API token, never exposed to browser)
│   ├── .env.example     # Copy to .env and add your token
│   └── package.json
├── frontend/
│   └── index.html       # Single-page app (open in browser, no build step)
├── .gitignore
└── README.md
```

## Prerequisites

- Node.js 18 or later
- A Signeasy sandbox account and access token (see below)

## Getting your sandbox token

1. Sign up at https://app.signeasy.com
2. Go to **Apps → Sandbox tab → Create Application**
3. Under **Authentication → Generate Access Token**, copy your token

## Setup & run

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Configure your token (never commit .env)
cp .env.example .env
# Open .env and replace 'your_sandbox_token_here' with your actual token

# 3. Start the backend
npm start
# Server runs on http://localhost:3001

# 4. Open the frontend (in a separate terminal or just double-click)
open ../frontend/index.html
# Or navigate to the file in your browser
```

## How to use the app

1. **Upload & Send** — Pick a PDF/DOC/DOCX (max 25 MB), enter signer name and email, click Send
2. **Sent** — Confirms the request was sent; the signer gets an email from Signeasy
3. **Track Status** — Auto-polls every 15 seconds; shows envelope and signer status
4. **Download** — Available once the envelope status is `complete`; downloads the signed PDF

## API endpoints used

| Method | Signeasy endpoint | Purpose |
|--------|------------------|---------|
| GET  | `/v3/me/` | Health check / verify token |
| POST | `/v3/original/` | Upload document |
| POST | `/v3/rs/envelope/` | Create & send signature request |
| GET  | `/v3/rs/envelope/{id}/` | Fetch status |
| GET  | `/v3/rs/envelope/signed/{id}/{source_id}/download` | Download signed PDF |

## Error handling & retries

- **Frontend**: validates file type, file size, first name (required), last name (optional), and email (required, format-checked) before any API call is made
- **Backend**: re-validates inputs server-side; surfaces Signeasy error messages cleanly
- **Retry logic**: network errors and 5xx responses are retried up to 3 times with exponential backoff (1s → 2s → 4s); 4xx errors are not retried (they're the caller's fault)

## Assumptions

- Single signer per request
- `embedded_signing: false` — Signeasy emails the signer directly; no iframe embedding needed
- Signature field is placed at fixed coordinates (x=100, y=100, 200×50px) on page 1. This is the simplest approach since we don't know the document contents at upload time

## What is not implemented

- Webhooks for real-time status push (using polling at 15s intervals instead)
- Multi-signer flows
- Template-based documents
- Custom signature field placement UI (field is auto-placed on page 1)
