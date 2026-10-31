/**
 * Simbas Pet — Webhook Hotmart v1
 * ================================
 * Vercel Serverless Function — recebe notificações da Hotmart.
 *
 * Fluxo:
 *   1. Hotmart envia POST com JSON
 *   2. Valida hottok contra HOTMART_HOTTOK (env var)
 *   3. Respond 200 rápido
 *   4. Armazena raw no KV → kv_sync_v3.py processa para orders
 *
 * ENV:
 *   HOTMART_HOTTOK      — Token de validação (Fuka cola no painel Vercel)
 *   KV_REST_API_URL     — Vercel KV REST API (obrigatório)
 *   KV_REST_API_TOKEN   — Vercel KV REST API token
 *
 * @version 1.0.0
 * @date    2026-10-30
 */

const HOTTOK = process.env.HOTMART_HOTTOK || '';
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 dias (webhooks têm mais valor)
const PENDING_KEY = 'queue:pending';

// ── Crypto ──
const crypto = require('crypto');
function sha256(text) {
  return crypto.createHash('sha256', text).digest('hex');
}

// ── KV REST helpers ──
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return; // sem KV = registra só no response
  const url = `${KV_URL.replace(/\/$/, '')}/set/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) console.error('KV set error:', res.status, await res.text());
}

async function kvRpush(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  const url = `${KV_URL.replace(/\/$/, '')}/rpush/${encodeURIComponent(key)}`;
  // REST API espera o valor RAW (sem JSON.stringify), senão a string fica com quotes
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!res.ok) console.error('KV rpush error:', res.status, await res.text());
}

// ── Normalizador (inicial) ──
// NOTA: Os mapeamentos abaixo são PRELIMINARES.
// Fuka precisa enviar um webhook de teste da Hotmart para confirmar
// os nomes reais dos campos e eventos.
function normalize(payload) {
  const p = payload;
  const eventType = (p.event || p.type || p.status || 'unknown').toLowerCase();
  const orderId = p.transaction || p.order_id || p.id || p.hotmart_order || `raw_${Date.now()}`;
  const productId = (p.product || p.prod || {}).id || p.product_id || p.prod_id || 'unknown';
  const productName = (p.product || p.prod || {}).name || p.product_name || '';

  // Extrai UTMs se vierem aninhadas
  const utm = p.utm || p.affiliate || {};
  const buyerEmail = p.buyer && p.buyer.email ? p.buyer.email : (p.email || p.customer && p.customer.email || '');

  return {
    event_type: `webhook_hotmart_${eventType}`,
    event_source: 'webhook_hotmart',
    product_id: productId,
    product_name: productName,
    transaction: orderId,
    value: p.price || p.value || p.commission || p.total || 0,
    currency: p.currency || 'BRL',
    utm_source: utm.source || utm.utm_source || utm.src || '',
    utm_campaign: utm.campaign || utm.utm_campaign || '',
    utm_content: utm.content || utm.utm_content || '',
    sck: p.sck || p.session_id || p.session || '',
    buyer_hash: buyerEmail ? sha256(buyerEmail) : '',
    raw_payload: p,
    timestamp: p.created_at || p.date || p.timestamp || new Date().toISOString(),
  };
}

export async function POST(request) {
  try {
    // ── Validar hottok ──
    const params = new URL(request.url).searchParams;
    const receivedHottok = params.get('hottok') || request.headers.get('x-hottok') || '';

    // Se HOTMART_HOTTOK está configurado, validar
    if (HOTTOK && receivedHottok !== HOTTOK) {
      console.warn('[WebhookHotmart] hottok inválido ou ausente:', receivedHottok ? receivedHottok.substring(0, 10) : '(vazio)');
      return new Response(JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Parse ──
    let payload;
    try { payload = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Log para debug (sempre, mesmo sem KV) ──
    console.log('[WebhookHotmart] RAW PAYLOAD:', JSON.stringify(payload));

    // ── Normalizar ──
    const normalized = normalize(payload);
    const idemKey = `webhook_hotmart_${normalized.transaction}_${Date.now()}`;

    // ── Armazenar no KV ──
    await kvSet(`event:${idemKey}`, {
      event_type: normalized.event_type,
      event_source: 'webhook_hotmart',
      product_id: normalized.product_id,
      product_name: normalized.product_name,
      timestamp: normalized.timestamp,
      session_id: normalized.sck || null,
      transaction: normalized.transaction,
      value: normalized.value,
      currency: normalized.currency,
      utm_source: normalized.utm_source,
      utm_campaign: normalized.utm_campaign,
      utm_content: normalized.utm_content,
      sck: normalized.sck,
      buyer_hash: normalized.buyer_hash,
      raw_payload: payload,
      attribution_confidence: 'ATTRIBUTED',
      confidence_reason: 'hotmart_webhook',
    });
    await kvRpush(PENDING_KEY, idemKey);

    // ── Respond 200 rápido ──
    console.log('[WebhookHotmart] OK:', normalized.event_type, normalized.transaction);
    return new Response(JSON.stringify({ status: 'ok' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[WebhookHotmart] Error:', e.message || String(e));
    // Sempre retorna 200 para evitar reenvio infinito da Hotmart
    return new Response(JSON.stringify({ status: 'ok', note: 'logged' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
}

export async function GET(request) {
  return new Response(JSON.stringify({ status: 'webhook_hotmart_active', hottok_configured: !!HOTTOK }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}