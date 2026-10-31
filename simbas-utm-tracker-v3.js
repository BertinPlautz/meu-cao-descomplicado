/**
 * Simbas Pet — Tracker UTM v3 (multiproduto)
 * ============================================
 * product_id vem de data-product na tag <script> (nada fixo no código).
 * Eventos: pageview, scroll_{25|50|75|90}, engaged_30s, cta_click, checkout_click.
 * checkout_click anexa sck + UTMs ao link do checkout.
 * Reaproveita o mesmo endpoint Vercel KV de antes.
 *
 * Uso na landing:
 *   <script src="simbas-utm-tracker-v3.min.js"
 *           data-product="meu-cao-descomplicado"
 *           data-endpoint="https://simbaspet.com.br/api/attribution"
 *           data-checkout-selector="a[href*='pay.hotmart.com']"
 *           defer></script>
 */
(function () {
  'use strict';

  /* ── Config via data attributes ── */
  var scriptTag = document.currentScript || (function () {
    var scripts = document.querySelectorAll('script[data-product]');
    return scripts[scripts.length - 1];
  })();

  var PRODUCT_ID   = scriptTag.getAttribute('data-product') || 'unknown';
  var API_ENDPOINT = scriptTag.getAttribute('data-endpoint') || '/api/attribution';
  var CHECKOUT_SEL = scriptTag.getAttribute('data-checkout-selector') || 'a[href*="pay.hotmart.com"],a[href*="pay.kirvano.com"],a[href*="pay.cakto.com.br"],a[href*="pay.hotmart"]';
  var SCROLL_STEPS = [25, 50, 75, 90];

  /* ── Session ── */
  var sid = null;
  try { sid = sessionStorage.getItem('__simbas_sid'); } catch (e) {}
  if (!sid) {
    sid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
    try { sessionStorage.setItem('__simbas_sid', sid); } catch (e) {}
  }

  /* ── UTMs via URL ── */
  var p = new URLSearchParams(location.search);
  var utmUrl = {
    utm_source:   p.get('utm_source')   || '',
    utm_medium:   p.get('utm_medium')   || '',
    utm_campaign: p.get('utm_campaign') || '',
    utm_content:  p.get('utm_content')  || '',
    utm_term:     p.get('utm_term')     || ''
  };
  var hasUrlUtm = Object.keys(utmUrl).some(function (k) { return utmUrl[k]; });

  /* ── Store UTMs in cookie (30d) ── */
  var storedUtm = {};
  if (hasUrlUtm) {
    try {
      document.cookie = '__simbas_utm=' + encodeURIComponent(JSON.stringify(utmUrl)) +
        '; path=/; max-age=' + (30 * 24 * 60 * 60) + '; SameSite=Lax';
    } catch (e) {}
  }
  try {
    var cm = document.cookie.match(/__simbas_utm=([^;]+)/);
    if (cm) storedUtm = JSON.parse(decodeURIComponent(cm[1]));
  } catch (e) {}

  var ks = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var fu = {};
  ks.forEach(function (k) { fu[k] = utmUrl[k] || storedUtm[k] || null; });

  var fbclid = p.get('fbclid') || null;
  var msclkid = p.get('msclkid') || null;
  var gclid = p.get('gclid') || null;

  var cf = 'UNKNOWN', cr = 'Sem parâmetros de rastreamento';
  if (hasUrlUtm) {
    cf = 'ATTRIBUTED';
    cr = 'UTM: ' + ks.filter(function (k) { return utmUrl[k]; }).join(',');
  } else if (fbclid) {
    cf = 'ATTRIBUTED';
    cr = 'fbclid presente';
  } else if (storedUtm && ks.some(function (k) { return storedUtm[k]; })) {
    cf = 'ATTRIBUTED';
    cr = 'UTM via cookie (cross-page)';
  }

  /* ── Event queue ── */
  var eventQueue = [];
  var INTERVAL_MS = 30000; // auto-send a cada 30s
  var queued = false;

  function track(eventType, extra) {
    var evt = {
      event_type:         eventType,
      event_source:       'browser',
      product_id:         PRODUCT_ID,
      timestamp:          new Date().toISOString(),
      session_id:         sid,
      landing_page:       location.pathname,
      url:                location.href,
      attribution_confidence: cf,
      confidence_reason:  cr,
      utm_source:         fu.utm_source,
      utm_medium:         fu.utm_medium,
      utm_campaign:       fu.utm_campaign,
      utm_content:        fu.utm_content,
      utm_term:           fu.utm_term
    };
    if (extra) Object.assign(evt, extra);
    eventQueue.push(evt);
    if (!queued) {
      queued = true;
      setTimeout(sendEvents, INTERVAL_MS);
    }
  }

  function sendEvents() {
    if (!eventQueue.length) { queued = false; return; }
    var batch = eventQueue.splice(0, eventQueue.length);
    var payload = JSON.stringify({
      session: {
        session_id: sid,
        timestamp: new Date().toISOString(),
        utm_source: fu.utm_source,
        utm_medium: fu.utm_medium,
        utm_campaign: fu.utm_campaign,
        utm_content: fu.utm_content,
        utm_term: fu.utm_term,
        fbclid: fbclid,
        msclkid: msclkid,
        gclid: gclid,
        referrer: document.referrer || null,
        landing_page: location.pathname,
        url: location.href,
        attribution_confidence: cf,
        confidence_reason: cr,
        product_id: PRODUCT_ID
      },
      events: batch,
      sent_at: new Date().toISOString()
    });

    /* sendBeacon (preferido) ou POST */
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API_ENDPOINT, new Blob([payload], { type: 'application/json' }));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', API_ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(payload);
    }

    if (eventQueue.length) {
      setTimeout(sendEvents, INTERVAL_MS);
    } else {
      queued = false;
    }
  }

  /* ── pageview na carga ── */
  track('pageview');

  /* ── Engajamento: scroll depth ── */
  var scrolled = {};
  function getScrollPct() {
    /* window.scrollY não é padrão; usar pageYOffset + fallbacks */
    var sy = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    var sh = document.body.scrollHeight || document.documentElement.scrollHeight || 1;
    if (sh <= window.innerHeight) return 0; /* página inteira na tela */
    return Math.round((sy + window.innerHeight) / sh * 100);
  }
  function onScroll() {
    var scrollPct = getScrollPct();
    SCROLL_STEPS.forEach(function (step) {
      if (scrollPct >= step && !scrolled[step]) {
        scrolled[step] = true;
        track('scroll_' + step);
      }
    });
  }
  /* Instala o listener SEMPRE (sem guarda de scrollHeight, que pode ser
   * artificialmente pequeno antes das imagens carregarem). A função
   * getScrollPct recalcula a altura real a cada evento. */
  if (document.body) {
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ── Engajamento: 30s na página ── */
  var engagedFired = false;
  setTimeout(function () {
    if (!engagedFired) {
      engagedFired = true;
      track('engaged_30s');
    }
  }, 30000);

  /* ── CTA clicks + SCK fix ── */
  /* Na carga da página: substituir sck em TODOS os links de checkout */
  function fixCheckoutLinks() {
    var links = document.querySelectorAll(CHECKOUT_SEL);
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (href.indexOf('sck=') > -1) {
        /* Substitui sck existente pelo session_id real */
        href = href.replace(/sck=[^&]+/, 'sck=' + encodeURIComponent(sid));
        links[i].setAttribute('href', href);
      }
    }
  }

  function onCtaClick(evt) {
    var link = evt.currentTarget;
    var href = link.getAttribute('href') || '';
    var text = (link.textContent || '').trim().substring(0, 60);

    /* Determinar se é checkout_click ou cta_click */
    var isCheckout = href.indexOf('pay.') > -1 || href.indexOf('checkout') > -1;

    if (isCheckout) {
      /* APENAS tracking — o href já foi corrigido por fixCheckoutLinks() na carga da página.
       * NÃO reescrever a URL: o antigo bug removia o ? junto com o sck,
       * quebrando a URL e causando erro 008 no Hotmart. */
      track('checkout_click', {
        cta_text: text,
        cta_href: href.substring(0, 120)
      });
    } else {
      track('cta_click', {
        cta_text: text,
        cta_href: href.substring(0, 120)
      });
    }
  }

  /* ── Inicialização tardia: espera DOM pronto ── */
  function initTracker() {
    /* Corrigir sck em todos os links de checkout já na carga */
    fixCheckoutLinks();

    /* Instalar listeners em todos os links de checkout */
    var allLinks = document.querySelectorAll(CHECKOUT_SEL);
    for (var i = 0; i < allLinks.length; i++) {
      allLinks[i].addEventListener('click', onCtaClick);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTracker);
  } else {
    initTracker(); /* DOM já pronto */
  }

  /* ── sendBeacon no beforeunload (última tentativa) ── */
  window.addEventListener('beforeunload', function () {
    if (eventQueue.length) sendEvents();
  });
})();