/* מגזין 42 - סקריפט אתר */
(function () {
  'use strict';

  /* --- תפריט מובייל --- */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* --- פרמטרי UTM (נשמרים לטובת טפסי לידים) --- */
  var utm = {};
  try {
    var params = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
      if (params.get(k)) utm[k] = params.get(k);
    });
    if (Object.keys(utm).length) {
      sessionStorage.setItem('utm42', JSON.stringify(utm));
    } else {
      var saved = sessionStorage.getItem('utm42');
      if (saved) utm = JSON.parse(saved);
    }
  } catch (e) { /* אחסון חסום - ממשיכים בלי */ }

  /* --- שליחת טופס לידים --- */
  document.querySelectorAll('form.lead-form').forEach(function (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();

      var webhook = (window.SITE && window.SITE.leadWebhook) || '';
      var box = form.closest('.lead-box');
      var successEl = box ? box.querySelector('.lead-success') : null;
      var errorEl = box ? box.querySelector('.lead-error') : null;
      var btn = form.querySelector('button[type="submit"]');

      if (!webhook) {
        if (errorEl) {
          errorEl.textContent = 'טופס הלידים עדיין לא חובר (יש להגדיר leadWebhook בקובץ data/site.json).';
          errorEl.style.display = 'block';
        }
        return;
      }

      var qs = new URLSearchParams();
      qs.set('action', 'addLead');
      qs.set('article', form.dataset.article || '');
      qs.set('campaign', form.dataset.campaign || '');
      qs.set('page', location.href.split('?')[0]);
      Object.keys(utm).forEach(function (k) { qs.set(k, utm[k]); });

      var valid = true;
      form.querySelectorAll('input, select').forEach(function (el) {
        if (el.required && !el.value.trim()) valid = false;
        qs.set(el.name, el.value.trim());
      });
      if (!valid) return;

      if (btn) { btn.disabled = true; btn.dataset.orig = btn.textContent; btn.textContent = 'שולח...'; }
      if (errorEl) errorEl.style.display = 'none';

      fetch(webhook + '?' + qs.toString(), { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.success) {
            form.style.display = 'none';
            if (successEl) successEl.style.display = 'block';
          } else {
            throw new Error((data && data.message) || 'server error');
          }
        })
        .catch(function () {
          if (errorEl) {
            errorEl.textContent = 'משהו השתבש בשליחה. נסו שוב בעוד רגע.';
            errorEl.style.display = 'block';
          }
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
