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

const HOTTOK = (process.env.HOTMART_HOTTOK || '').trim();
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

// ── Normalizador (Hotmart v2.0.0) ──
// A Hotmart v2.0.0 envia payload aninhado em {"data": {...}, "event": "...", "id": "...", "version": "2.0.0"}
// Campos relevantes:
//   - event:   payload.event (top-level)
//   - transação: payload.data.purchase.transaction (ou payload.data.purchase.order_date)
//   - produto:  payload.data.product.name + product.external_id
//   - valor:    payload.data.purchase.price.value (em centavos? depende do produto)
//   - buyer:    payload.data.buyer.email
//   - sck:      payload.data.purchase.sckPaymentLink
//   - affiliate: payload.data.affiliates[].affiliate.code — onde vêm UTMs (se houver)
function normalize(payload) {
  const p = payload;
  const eventType = (p.event || p.type || p.status || 'unknown').toLowerCase();

  // Extrair do data wrapper
  const data = p.data || {};
  const purchase = data.purchase || {};
  const product = data.product || {};
  const buyer = data.buyer || {};

  const orderId = purchase.transaction || purchase.order_date?.toString?.() || p.id || `raw_${Date.now()}`;
  const productId = product.external_id || product.ucode || (product.id && product.id !== 0 ? String(product.id) : null) || 'unknown';
  const productName = product.name || '';
  const buyerEmail = buyer.email || '';
  const utm = data.affiliates?.[0]?.affiliate || {};

  return {
    event_type: `webhook_hotmart_${eventType}`,
    event_source: 'webhook_hotmart',
    product_id: productId,
    product_name: productName,
    transaction: orderId,
    value: purchase.price?.value || purchase.original_offer_price?.value || p.commission || 0,
    currency: purchase.price?.currency_value || purchase.original_offer_price?.currency_value || 'BRL',
    utm_source: utm.source || utm.utm_source || utm.src || '',
    utm_campaign: utm.campaign || utm.utm_campaign || '',
    utm_content: utm.content || utm.utm_content || '',
    sck: purchase.sckPaymentLink || p.sck || '',
    buyer_hash: buyerEmail ? sha256(buyerEmail) : '',
    raw_payload: p,
    timestamp: new Date().toISOString(),
  };
}

export async function POST(request) {
  try {
    // ── Validar hottok ──
    const params = new URL(request.url).searchParams;
    // Hotmart v2.0.0 envia X-HOTMART-HOTTOK; fallback para query param e x-hottok legado
    const hottokHeaders = [
      request.headers.get('x-hotmart-hottok') || '',
      request.headers.get('x-hotmart-hot-token') || '',
      request.headers.get('x-hottok') || '',
    ];
    const receivedHottok = params.get('hottok') || hottokHeaders.find(h => h.length > 0) || '';

    // Se HOTMART_HOTTOK está configurado, validar
    if (HOTTOK && receivedHottok !== HOTTOK) {
      console.warn('[WebhookHotmart] hottok inválido ou ausente (len:' + String(receivedHottok.length) + ')');
      return new Response(JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Parse ──
    let payload;
    try { payload = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Log seguro (apenas metadados, sem PII) ──
    const rawEvent = (payload.event || 'unknown').toString().toLowerCase();
    const rawTxn = payload.data?.purchase?.transaction || payload.id || '';
    const rawProd = payload.data?.product?.name || '';
    console.log('[WebhookHotmart] evento=' + rawEvent + ' txn=' + String(rawTxn).substring(0, 30) + ' prod=' + rawProd);

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