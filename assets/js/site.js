/* Channel 18 - סקריפט אתר */
(function () {
  'use strict';

  var SITE = window.SITE || {};
  var TRACK = SITE.tracking || {};

  /* --- תפריט מובייל --- */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* --- פרמטרי קמפיין (UTM + מזהי קליק של טאבולה/אאוטבריין/מטא/גוגל) - נשמרים לטובת טפסי הלידים --- */
  var CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'tblci', 'ob_click_id', 'fbclid', 'gclid', 'ttclid'];
  var campaign = {};
  try {
    var params = new URLSearchParams(location.search);
    CAMPAIGN_KEYS.forEach(function (k) {
      if (params.get(k)) campaign[k] = params.get(k).slice(0, 200);
    });
    if (Object.keys(campaign).length) {
      sessionStorage.setItem('c18_campaign', JSON.stringify(campaign));
    } else {
      var saved = sessionStorage.getItem('c18_campaign');
      if (saved) campaign = JSON.parse(saved);
    }
  } catch (e) { /* אחסון חסום - ממשיכים בלי */ }

  /* --- אירוע "ליד" לפיקסלים (נשלח רק לפיקסלים שהוגדרו ב-data/site.json) --- */
  function fireLeadEvent(name) {
    try {
      if (TRACK.taboolaId && window._tfa) {
        window._tfa.push({ notify: 'event', name: TRACK.taboolaLeadEvent || 'lead', id: Number(TRACK.taboolaId) });
      }
      if (TRACK.outbrainId && window.obApi) window.obApi('track', TRACK.outbrainLeadEvent || 'Lead');
      if (TRACK.metaPixelId && window.fbq) window.fbq('track', 'Lead', { content_name: name });
      if (TRACK.ga4Id && window.gtag) window.gtag('event', 'generate_lead', { campaign: name });
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'lead_submitted', campaign: name });
    } catch (e) { /* פיקסל שנפל לא מפריע למשתמש */ }
  }

  /* --- טלפון ישראלי: מחזיר ספרות מנורמלות (05XXXXXXXX / 0XXXXXXXX) או '' --- */
  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('972') === 0) d = '0' + d.slice(3);
    if (/^0[57]\d{8}$/.test(d) || /^0[23489]\d{7}$/.test(d)) return d;
    return '';
  }

  var uid = function () { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); };
  var wait = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };

  /**
   * שליחת ליד: POST כ-JSON (text/plain - בלי preflight), ואם נכשל - GET.
   * עד 3 ניסיונות עם המתנה. leadId זהה בכל הניסיונות כדי שהשרת לא ירשום כפילות.
   */
  function sendLead(webhook, payload) {
    var ok = function (data) {
      if (data && data.success) return data;
      throw new Error((data && data.message) || 'server error');
    };
    var viaPost = function () {
      return fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); }).then(ok);
    };
    var viaGet = function () {
      var qs = new URLSearchParams();
      Object.keys(payload).forEach(function (k) {
        if (payload[k] !== undefined && payload[k] !== null) qs.set(k, String(payload[k]));
      });
      return fetch(webhook + '?' + qs.toString(), { method: 'GET' })
        .then(function (r) { return r.json(); }).then(ok);
    };
    var attempt = 0;
    var run = function () {
      attempt++;
      return viaPost()
        .catch(function () { return viaGet(); })
        .catch(function (err) {
          if (attempt >= 3) throw err;
          return wait(attempt * 1500).then(run);
        });
    };
    return run();
  }

  /* --- טפסי לידים --- */
  document.querySelectorAll('form.lead-form').forEach(function (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();

      var webhook = SITE.leadWebhook || '';
      var box = form.closest('.lead-box');
      var successEl = box ? box.querySelector('.lead-success') : null;
      var errorEl = box ? box.querySelector('.lead-error') : null;
      var btn = form.querySelector('button[type="submit"]');
      var showError = function (msg) {
        if (!errorEl) return;
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
      };

      if (!webhook) {
        showError('טופס הלידים עדיין לא חובר (יש להגדיר leadWebhook בקובץ data/site.json).');
        return;
      }

      var payload = {
        action: 'addLead',
        leadId: uid(),
        article: form.dataset.article || '',
        campaign: form.dataset.campaign || '',
        page: location.href.split('?')[0],
        pageUrl: location.href.slice(0, 500),
        referrer: (document.referrer || '').slice(0, 300)
      };
      Object.keys(campaign).forEach(function (k) { payload[k] = campaign[k]; });

      var valid = true;
      form.querySelectorAll('input, select').forEach(function (el) {
        var v = el.value.trim();
        if (el.required && !v) valid = false;
        if (el.type === 'tel' && v) {
          var phone = normalizePhone(v);
          if (!phone) {
            valid = false;
            showError('מספר הטלפון לא נראה תקין - בדקו ונסו שוב.');
            el.focus();
          } else {
            v = phone;
          }
        }
        payload[el.name] = v;
      });
      if (!valid) return;

      if (btn) { btn.disabled = true; btn.dataset.orig = btn.textContent; btn.textContent = 'שולח...'; }
      if (errorEl) errorEl.style.display = 'none';

      sendLead(webhook, payload)
        .then(function () {
          form.style.display = 'none';
          if (successEl) successEl.style.display = 'block';
          fireLeadEvent(payload.campaign || payload.article);
        })
        .catch(function () {
          showError('משהו השתבש בשליחה. נסו שוב בעוד רגע.');
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset.orig; }
        });
    });
  });

  /* --- כפתורי שיתוף --- */
  document.querySelectorAll('[data-share]').forEach(function (btn) {
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      var url = encodeURIComponent(location.href);
      var title = encodeURIComponent(document.title);
      var net = btn.dataset.share;
      var target = '';
      if (net === 'whatsapp') target = 'https://api.whatsapp.com/send?text=' + title + '%20' + url;
      if (net === 'facebook') target = 'https://www.facebook.com/sharer/sharer.php?u=' + url;
      if (net === 'telegram') target = 'https://t.me/share/url?url=' + url + '&text=' + title;
      if (net === 'x') target = 'https://twitter.com/intent/tweet?url=' + url + '&text=' + title;
      if (net === 'copy') {
        navigator.clipboard && navigator.clipboard.writeText(location.href);
        btn.textContent = '✓';
        setTimeout(function () { btn.textContent = '🔗'; }, 1500);
        return;
      }
      if (target) window.open(target, '_blank', 'noopener,width=600,height=500');
    });
  });
})();
