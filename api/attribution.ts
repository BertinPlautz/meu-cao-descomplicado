/**
 * Simbas Pet — Attribution API v3 (multiproduto, REST API)
 * ==========================================================
 * Usa KV REST API diretamente (sem @vercel/kv) para funcionar
 * com as env vars que Fuka colar no dashboard.
 *
 * Endpoint: POST /api/attribution
 * Corpo:    { session: {...}, events: [...], sent_at: "..." }
 *
 * ENV:
 *   KV_REST_API_URL    — Vercel KV REST API endpoint (obrigatório)
 *   KV_REST_API_TOKEN  — Vercel KV REST API token   (obrigatório)
 *   ALLOWED_ORIGIN     — CORS origin override (default: https://simbaspet.com.br)
 *
 * @version 3.1.0
 */

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://simbaspet.com.br';

const PENDING_KEY = 'queue:pending';
const EVENT_PREFIX = 'event:';
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 dias
const MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB

// ── KV REST helpers ──
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV_REST_API_URL e KV_REST_API_TOKEN obrigatórios');
  const url = `${KV_URL.replace(/\/$/, '')}/set/${encodeURIComponent(key)}`;
  // value já é objeto → JSON.stringify() serializa corretamente
  const body = JSON.stringify(value);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`KV set error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV_REST_API_URL e KV_REST_API_TOKEN obrigatórios');
  const url = `${KV_URL.replace(/\/$/, '')}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${KV_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function kvRpush(key, value) {
  const url = `${KV_URL.replace(/\/$/, '')}/rpush/${encodeURIComponent(key)}`;
  // REST API rpush trata body como RAW — NÃO JSON.stringify em string
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!res.ok) throw new Error(`KV rpush error: ${res.status}`);
  return res.json();
}

async function kvExpire(key, seconds) {
  const url = `${KV_URL.replace(/\/$/, '')}/expire/${encodeURIComponent(key)}/${seconds}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV expire error: ${res.status}`);
  return res.json();
}

// ── CORS ──
function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN
    || (origin || '').startsWith('http://localhost')
    || (origin || '').startsWith('http://127.0.0.1');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── Validate ──
function validate(body) {
  if (!body || typeof body !== 'object') return { valid: false, error: 'Body deve ser JSON' };
  const p = body;
  if (!p.session || typeof p.session !== 'object') return { valid: false, error: 'session obrigatório' };
  if (!p.session.session_id || typeof p.session.session_id !== 'string') return { valid: false, error: 'session_id obrigatório' };
  if (!Array.isArray(p.events) || p.events.length === 0) return { valid: false, error: 'events array não vazio obrigatório' };
  for (let i = 0; i < p.events.length; i++) {
    const e = p.events[i];
    if (!e.event_type || typeof e.event_type !== 'string') return { valid: false, error: `events[${i}].event_type obrigatório` };
    if (!e.timestamp || typeof e.timestamp !== 'string') return { valid: false, error: `events[${i}].timestamp obrigatório` };
  }
  return { valid: true, payload: p };
}

export async function POST(request) {
  const origin = request.headers.get('origin') || '';

  try {
    // Size
    const cl = parseInt(request.headers.get('content-length') || '0', 10);
    if (cl > MAX_PAYLOAD_SIZE) {
      return new Response(JSON.stringify({ error: 'Payload muito grande' }),
        { status: 413, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    // Parse
    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'JSON inválido' }),
        { status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    const v = validate(body);
    if (!v.valid) {
      return new Response(JSON.stringify({ error: v.error }),
        { status: 400, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
    }

    const payload = v.payload;
    const sid = payload.session.session_id;
    const productId = payload.session.product_id || 'unknown';
    const result = { session: 'new', events: [], errors: [] };

    // Store session
    const sessionKey = `session:${sid}`;
    await kvSet(sessionKey, payload.session);  // objeto raw — kvSet faz JSON.stringify

    // Process events
    for (const evt of payload.events) {
      try {
        const idemKey = `${evt.event_type}_${evt.timestamp}_${sid}`;

        // Skip if exists
        const exists = await kvGet(`${EVENT_PREFIX}${idemKey}`);
        if (exists) {
          result.events.push({ event_type: evt.event_type, status: 'skipped', reason: 'duplicate' });
          continue;
        }

        // Store event
        await kvSet(`${EVENT_PREFIX}${idemKey}`, {
          session_id: sid,
          product_id: evt.product_id || productId,
          event_type: evt.event_type,
          event_source: evt.event_source || 'browser',
          timestamp: evt.timestamp,
          url: evt.url || null,
          utm_source: evt.utm_source || null,
          utm_medium: evt.utm_medium || null,
          utm_campaign: evt.utm_campaign || null,
          utm_content: evt.utm_content || null,
          utm_term: evt.utm_term || null,
          cta_text: evt.cta_text || null,
          cta_href: evt.cta_href || null,
          attribution_confidence: evt.attribution_confidence || 'UNKNOWN',
          confidence_reason: evt.confidence_reason || '',
          raw_payload: evt,
        });

        // Queue for VPS sync
        await kvRpush(PENDING_KEY, idemKey);
        await kvExpire(PENDING_KEY, EVENT_TTL_SECONDS);

        result.events.push({ event_type: evt.event_type, status: 'ingested' });
      } catch (e) {
        result.errors.push({ event_type: evt.event_type, error: e.message || String(e) });
      }
    }

    const ingested = result.events.filter(e => e.status === 'ingested').length;
    const skipped = result.events.filter(e => e.status === 'skipped').length;

    return new Response(JSON.stringify({ status: 'ok', ingested, skipped, errors: result.errors.length, events: result.events }),
      { status: 200, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[AttributionAPI] Error:', e.message || String(e));
    return new Response(JSON.stringify({ error: 'Internal server error', detail: e.message || String(e) }),
      { status: 500, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
  }
}

export async function OPTIONS(request) {
  const origin = request.headers.get('origin') || '';
  return new Response(null, { status: 200, headers: corsHeaders(origin) });
}