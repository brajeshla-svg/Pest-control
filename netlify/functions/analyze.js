// AgriVision AI - serverless proxy to the Gemini API.
// The API key lives ONLY in the Netlify environment variable GEMINI_API_KEY.
// It is never sent to the browser.

const MODELS = [
  process.env.GEMINI_MODEL,          // optional override
  'gemini-flash-lite-latest',        // fastest, tried first to avoid timeouts
  'gemini-flash-latest',
  'gemini-2.5-flash',
].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BASE64_LEN = 3_000_000;   // ~2.2 MB image after the browser resizes it
const PER_IP_PER_MINUTE = 6;

// Best-effort rate limit (memory is per function instance, so it is soft).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_IP_PER_MINUTE) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const PROMPT = `You are an agricultural plant-protection assistant. Look carefully at the photo.

Decide the status:
- "ok": the photo shows a crop pest/insect OR visible damage/disease symptoms on a leaf, stem, or fruit, and you can name a most-likely cause.
- "healthy": a plant is visible and looks healthy, with no clear pest or damage.
- "not_plant": the photo is not of a plant or insect (people, objects, screenshots, etc).
- "unclear": it is a plant/insect but the photo is too blurry, dark, far away, or ambiguous to say anything reliable.

Rules:
- NEVER guess. If unsure, use "unclear" and explain what photo would help (close-up, good light, affected part, whole plant).
- Report an honest confidencePercent (0-100). Use below 60 when the symptoms could have several causes, and list the other possibilities in otherPossibilities.
- Symptoms can be caused by nutrient deficiency, disease, or weather, not only pests. If so, say that in "symptom" and name the likely cause.
- Put organic / IPM / cultural controls first. For chemicals, suggest only commonly registered active ingredients and typical label dose ranges (per acre, India context), and always say the label of the product must be followed.
- Keep each text field short (under 220 characters). Write in simple English a farmer can understand.
- Do not invent species names. If the exact species is uncertain, give the genus or the symptom name.
- For status other than "ok", put a helpful explanation in "message" and leave the other fields as empty strings or empty arrays.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    status: { type: 'STRING', enum: ['ok', 'healthy', 'not_plant', 'unclear'] },
    message: { type: 'STRING' },
    crop: { type: 'STRING' },
    detectionType: { type: 'STRING' },
    name: { type: 'STRING' },
    latin: { type: 'STRING' },
    confidencePercent: { type: 'INTEGER' },
    symptom: { type: 'STRING' },
    otherPossibilities: { type: 'STRING' },
    threat: { type: 'STRING', enum: ['Low Risk', 'Moderate Risk', 'High Risk'] },
    target: { type: 'STRING' },
    spread: { type: 'STRING' },
    organic: { type: 'ARRAY', items: { type: 'STRING' } },
    pesticide: { type: 'STRING' },
    dosage: { type: 'STRING' },
    instructions: { type: 'STRING' },
    lifecycle: { type: 'STRING' },
    climate: { type: 'STRING' },
    predators: { type: 'STRING' },
  },
  required: ['status', 'message'],
};

const s = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function clean(raw) {
  const status = ['ok', 'healthy', 'not_plant', 'unclear'].includes(raw.status) ? raw.status : 'unclear';
  const conf = Math.max(0, Math.min(100, parseInt(raw.confidencePercent, 10) || 0));
  return {
    status,
    message: s(raw.message, 600),
    crop: s(raw.crop, 60) || 'Unknown crop',
    detectionType: s(raw.detectionType, 60) || 'Symptom',
    name: s(raw.name, 120) || 'Unidentified',
    latin: s(raw.latin, 120),
    confidencePercent: conf,
    symptom: s(raw.symptom, 400),
    otherPossibilities: s(raw.otherPossibilities, 300),
    threat: ['Low Risk', 'Moderate Risk', 'High Risk'].includes(raw.threat) ? raw.threat : 'Moderate Risk',
    target: s(raw.target, 80) || 'Not specified',
    spread: s(raw.spread, 80) || 'Not specified',
    organic: Array.isArray(raw.organic) ? raw.organic.slice(0, 6).map((x) => s(x, 250)).filter(Boolean) : [],
    pesticide: s(raw.pesticide, 160) || 'Consult local agriculture officer',
    dosage: s(raw.dosage, 160) || 'Follow product label',
    instructions: s(raw.instructions, 300),
    lifecycle: s(raw.lifecycle, 100) || 'Not specified',
    climate: s(raw.climate, 100) || 'Not specified',
    predators: s(raw.predators, 160) || 'Not specified',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST.' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return reply(500, { error: 'Server is not configured yet (missing GEMINI_API_KEY).' });

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) return reply(429, { error: 'Too many scans in a short time. Please wait a minute and try again.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request.' }); }

  const { image, mimeType } = body;
  if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image) || image.length < 100) {
    return reply(400, { error: 'No valid image received.' });
  }
  if (image.length > MAX_BASE64_LEN) return reply(413, { error: 'Image is too large.' });
  if (!ALLOWED_MIME.includes(mimeType)) return reply(400, { error: 'Unsupported image type. Use JPG, PNG or WebP.' });

  const payload = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: image } }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  };

  const deadline = Date.now() + 8500;
  let busy = false;

  for (const model of MODELS) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(remaining, 6500));
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (r.ok) {
        const data = await r.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        if (!text) {
          return reply(200, { status: 'unclear', message: 'The AI could not analyse this photo. Please try a clearer one.' });
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch { continue; }
        return reply(200, clean(parsed));
      }
      if ([404, 429, 500, 503].includes(r.status)) { busy = busy || r.status === 429 || r.status === 503; continue; }
      if (r.status === 400 || r.status === 403) {
        console.error('Gemini rejected request', r.status, await r.text());
        return reply(502, { error: 'The AI service rejected the request. The site owner should check the API key.' });
      }
    } catch (e) {
      clearTimeout(timer);
      console.error('Gemini call failed', model, e.name);
    }
  }

  return reply(503, {
    error: busy
      ? 'The free AI quota is busy right now. Please try again in a minute (or tomorrow if the daily limit is used up).'
      : 'The AI took too long to respond. Please try again.',
  });
};
