require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const axios   = require('axios');
const FormData = require('form-data');

const PORT          = process.env.PORT || 3001;
const API_TOKEN     = process.env.SIGNEASY_API_TOKEN;
const SIGNEASY_BASE = 'https://api.signeasy.com/v3';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — Signeasy hard limit
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIME_TYPES.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only PDF, DOC, and DOCX files are allowed.'));
  },
});

const app = express();
app.use(cors());
app.use(express.json());

// Retries on network errors or 5xx. Never retries 4xx (caller's fault).
// Backoff: 1s → 2s → 4s.
async function callWithRetry(axiosConfig, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await axios(axiosConfig);
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status && status >= 400 && status < 500) throw err;
      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(`[Retry] Attempt ${attempt} failed (status=${status ?? 'network'}). Retrying in ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

function signeasyHeaders(extra = {}) {
  return { Authorization: `Bearer ${API_TOKEN}`, ...extra };
}

// Handles Signeasy's { message }, { error }, and { errors: [] } response shapes.
function extractErrorMessage(err) {
  const data = err.response?.data;
  if (data) {
    if (typeof data.message === 'string') return data.message;
    if (typeof data.error   === 'string') return data.error;
    if (Array.isArray(data.errors) && data.errors.length > 0)
      return data.errors.map((e) => (typeof e === 'string' ? e : e.message)).join(', ');
  }
  return err.message || 'An unknown error occurred.';
}

// Accepts both numeric and string-encoded IDs; rejects 0, negatives, non-numeric.
function parsePositiveInt(value) {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/health — verifies token against Signeasy /me
app.get('/api/health', async (_req, res) => {
  if (!API_TOKEN || API_TOKEN === 'your_sandbox_token_here') {
    return res.status(503).json({ ok: false, error: 'API token is not configured on the server.' });
  }
  try {
    const { data } = await callWithRetry({ method: 'GET', url: `${SIGNEASY_BASE}/me/`, headers: signeasyHeaders() });
    res.json({
      ok: true,
      user: {
        email: data.email,
        first_name: data.first_name,
        last_name: data.last_name,
        envelope_credits_available: data.envelope_credits_available,
      },
    });
  } catch (err) {
    console.error('[Health]', err.response?.data ?? err.message);
    res.status(err.response?.status ?? 502).json({ ok: false, error: extractErrorMessage(err) });
  }
});

// POST /api/upload — uploads document to Signeasy as an "original"
// Returns: { original_id, name }
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });

  const file = req.file;
  const form = new FormData();
  form.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });
  form.append('name', file.originalname);
  form.append('rename_if_exists', 'true');

  try {
    const { data } = await callWithRetry({
      method: 'POST',
      url: `${SIGNEASY_BASE}/original/`,
      headers: { ...signeasyHeaders(), ...form.getHeaders() },
      data: form,
    });
    console.log(`[Upload] id=${data.id}, name=${data.name}`);
    res.json({ original_id: data.id, name: data.name });
  } catch (err) {
    console.error('[Upload]', err.response?.data ?? err.message);
    res.status(err.response?.status ?? 502).json({ error: extractErrorMessage(err) });
  }
});

// POST /api/send — creates envelope and emails signer
// Body:    { original_id, signer_first_name, signer_last_name, signer_email }
// Returns: { envelope_id }
app.post('/api/send', async (req, res) => {
  const { original_id, signer_first_name, signer_last_name, signer_email } = req.body;
  const errors = {};

  const originalId = parsePositiveInt(original_id);
  if (!originalId) errors.original_id = 'original_id is required and must be a positive integer.';

  const firstName = (signer_first_name ?? '').trim();
  if (!firstName)
    errors.signer_first_name = 'Signer first name is required.';
  else if (/[,|#@!$%]/.test(firstName))
    errors.signer_first_name = 'First name contains invalid characters (, | # @ ! $ %).';

  const lastName = (signer_last_name ?? '').trim();
  if (lastName && /[,|#@!$%]/.test(lastName))
    errors.signer_last_name = 'Last name contains invalid characters (, | # @ ! $ %).';

  const email = (signer_email ?? '').trim().toLowerCase();
  if (!email)
    errors.signer_email = 'Signer email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.signer_email = 'Signer email is not a valid email address.';

  if (Object.keys(errors).length > 0)
    return res.status(400).json({ error: 'Validation failed.', details: errors });

  const recipient = { email, first_name: firstName, recipient_id: 1 };
  if (lastName) recipient.last_name = lastName;

  const payload = {
    embedded_signing: false, // Signeasy emails the signer directly
    is_ordered: false,
    sources: [{ id: originalId, type: 'original', source_id: 1 }],
    recipients: [recipient],
    // Signature field at fixed coordinates on page 1 (bottom-left origin)
    fields_payload: [{
      recipient_id: 1,
      source_id: 1,
      type: 'signature',
      required: true,
      page_number: '1',
      position: { mode: 'fixed', x: 100, y: 100, height: 50, width: 200 },
    }],
  };

  try {
    const { data } = await callWithRetry({
      method: 'POST',
      url: `${SIGNEASY_BASE}/rs/envelope/`,
      headers: signeasyHeaders({ 'Content-Type': 'application/json' }),
      data: payload,
    });
    console.log(`[Send] envelope_id=${data.id}, signer=${email}`);
    res.json({ envelope_id: data.id });
  } catch (err) {
    console.error('[Send]', err.response?.data ?? err.message);
    res.status(err.response?.status ?? 502).json({ error: extractErrorMessage(err) });
  }
});

// GET /api/status/:envelope_id — polls envelope and recipient status
app.get('/api/status/:envelope_id', async (req, res) => {
  const envelopeId = parsePositiveInt(req.params.envelope_id);
  if (!envelopeId)
    return res.status(400).json({ error: 'Invalid envelope_id: must be a positive integer.' });

  try {
    const { data } = await callWithRetry({
      method: 'GET',
      url: `${SIGNEASY_BASE}/rs/envelope/${envelopeId}/`,
      headers: signeasyHeaders(),
    });
    const recipient = data.recipients?.[0];
    res.json({
      envelope_id:       data.id,
      status:            data.status,            // incomplete | complete | recipient_declined | canceled
      recipient_status:  recipient?.status ?? null, // not_viewed | viewed | finalized | declined
      recipient_email:   recipient?.email  ?? null,
      sources:           data.sources,            // needed by the download route
      created_time:      data.created_time,
      last_modified_time: data.last_modified_time,
    });
  } catch (err) {
    console.error('[Status]', err.response?.data ?? err.message);
    res.status(err.response?.status ?? 502).json({ error: extractErrorMessage(err) });
  }
});

// GET /api/download/:envelope_id/:source_id — downloads the signed PDF
app.get('/api/download/:envelope_id/:source_id', async (req, res) => {
  const envelopeId = parsePositiveInt(req.params.envelope_id);
  const sourceId   = parsePositiveInt(req.params.source_id);

  if (!envelopeId) return res.status(400).json({ error: 'Invalid envelope_id: must be a positive integer.' });
  if (!sourceId)   return res.status(400).json({ error: 'Invalid source_id: must be a positive integer.' });

  try {
    const { data } = await callWithRetry({
      method: 'GET',
      url: `${SIGNEASY_BASE}/rs/envelope/signed/${envelopeId}/${sourceId}/download`,
      headers: signeasyHeaders(),
      responseType: 'arraybuffer',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="signed-document-${envelopeId}.pdf"`);
    res.send(Buffer.from(data));
  } catch (err) {
    console.error('[Download]', err.response?.status ?? err.message);
    if (!res.headersSent)
      res.status(err.response?.status ?? 502).json({ error: extractErrorMessage(err) });
  }
});

// Global error handler — covers multer errors and anything else thrown by middleware
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum allowed size is 25 MB.'
      : err.message;
    return res.status(400).json({ error: msg });
  }
  res.status(err?.status ?? 400).json({ error: err?.message ?? 'Internal server error.' });
});

// Only bind to a port when run directly; when required by tests, just export.
if (require.main === module) {
  if (!API_TOKEN || API_TOKEN === 'your_sandbox_token_here') {
    console.error('[FATAL] SIGNEASY_API_TOKEN is not set in .env');
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`[Server] http://localhost:${PORT}`));
}

module.exports = { app, callWithRetry, extractErrorMessage, parsePositiveInt };
