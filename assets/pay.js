(function () {
  'use strict';
  var API = (window.TRAFFIALERT_PAY_API || 'https://traffialert-pay.onrender.com').replace(/\/$/, '');
  var PRICES = { monthly: 'GH₵12', yearly: 'GH₵100', founding: 'GH₵199' };
  var $ = function (id) { return document.getElementById(id); };
  var form = $('pay-form'), btn = $('pay-btn'), msg = $('pay-msg');

  function show(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (text ? ' show ' + (kind || 'err') : '');
  }
  function plan() {
    var r = form.querySelector('input[name="plan"]:checked');
    return r ? r.value : 'monthly';
  }
  // Ghana mobile numbers (MTN, Telecel, AirtelTigo): 020 023 024 025 026 027 028 050 053 054 055 056 057 059.
  // Accepts 0XX XXX XXXX, +233 XX XXX XXXX, +233 0XX … and the 9 digits without the leading 0.
  var GH_MOBILE = /^(?:20|23|24|25|26|27|28|50|53|54|55|56|57|59)[0-9]{7}$/;
  function phoneOk(v) {
    var d = String(v || '').replace(/[^0-9]/g, '');
    if (d.length === 13 && d.indexOf('2330') === 0) d = d.slice(4); // +233 024 …
    else if (d.length === 12 && d.indexOf('233') === 0) d = d.slice(3);
    else if (d.length === 10 && d.charAt(0) === '0') d = d.slice(1);
    return GH_MOBILE.test(d);
  }

  // A payment started on this phone is remembered so a reload (for example after switching to the
  // MoMo app) can pick it up again instead of losing the code.
  var PENDING_KEY = 'ta_pending_ref', LAST_KEY = 'ta_last_payment', PENDING_MAX_MS = 24 * 60 * 60 * 1000;
  function readPending() {
    var raw = null;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return null; }
    if (!raw) return null;
    var p = null;
    try { p = JSON.parse(raw); } catch (e) { p = { ref: raw, at: 0 }; } // older pages stored the bare reference
    if (!p || typeof p.ref !== 'string' || !/^TA-[A-Za-z0-9-]{6,60}$/.test(p.ref)) { clearPending(); return null; }
    if (p.at && Date.now() - p.at > PENDING_MAX_MS) { clearPending(); return null; }
    return p.ref;
  }
  function savePending(ref) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ref: ref, at: Date.now() })); } catch (e) {}
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }
  function lastPaidRef() {
    try { var l = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); return l && l.ref; } catch (e) { return null; }
  }
  function api(path, opts, tries) {
    tries = tries == null ? 2 : tries;
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
    }).catch(function (e) {
      if (tries > 0) return new Promise(function (ok) { setTimeout(ok, 4000); }).then(function () { return api(path, opts, tries - 1); });
      throw e;
    });
  }
  function busy(on, text) {
    btn.disabled = on;
    // Lock the plan while a payment is being set up or paid, so the price cannot change underneath it.
    Array.prototype.forEach.call(form.querySelectorAll('input[name="plan"]'), function (r) { r.disabled = on; });
    btn.textContent = on ? (text || 'Please wait…') : 'Pay ' + PRICES[plan()] + ' with MoMo';
  }

  // Wake the payment service early and show the practice banner when not live.
  api('/healthz', {}, 3).then(function (j) { if (j.mode === 'test') $('testbar').className = 'testbar show'; }).catch(function () {});

  Array.prototype.forEach.call(form.querySelectorAll('input[name="plan"]'), function (r) {
    r.addEventListener('change', function () {
      if (btn.disabled) return;
      Array.prototype.forEach.call(form.querySelectorAll('.plan'), function (l) {
        l.classList.toggle('sel', l.querySelector('input').checked);
      });
      busy(false);
    });
  });

  function showCode(code, ref) {
    $('buy').hidden = true; $('waiting').hidden = true; $('done').hidden = false;
    $('code').textContent = code;
    $('done-ref').textContent = ref;
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ code: code, ref: ref })); } catch (e) {}
    if (readPending() === ref) clearPending();
    $('done').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function verify(ref, resumed) {
    $('buy').hidden = true; $('waiting').hidden = false;
    $('waiting-text').textContent = (resumed
      ? 'Checking the payment you started earlier on this phone. '
      : 'Approve the payment on your phone if you have not done so yet. ') +
      'This page will update by itself. Your payment number is ' + ref + '.';
    var started = Date.now();
    (function poll() {
      api('/api/pay/verify?reference=' + encodeURIComponent(ref), {}, 2).then(function (j) {
        if (j.status === 'success' && j.code) return showCode(j.code, ref);
        var unsure = j.status === 'pending' || j._status >= 500 || j._status === 429;
        if (unsure && Date.now() - started < 3 * 60 * 1000) return setTimeout(poll, 4000);
        $('waiting').hidden = true; $('buy').hidden = false;
        busy(false);
        if (!unsure) clearPending(); // definitely not paid: do not keep asking on every visit
        show(msg, unsure
          ? 'Your payment is still being confirmed. Please check again in a few minutes using “Lost your code?” with payment number ' + ref + '.'
          : (resumed ? 'Your earlier payment (' + ref + ') was not completed, so no money was taken.' : 'The payment was not completed, so no money was taken. Please try again.'),
          unsure || !resumed ? 'err' : 'info');
      }).catch(function () {
        if (Date.now() - started < 3 * 60 * 1000) return setTimeout(poll, 5000);
        $('waiting').hidden = true; $('buy').hidden = false; busy(false);
        show(msg, 'We could not confirm your payment yet. Use “Lost your code?” with payment number ' + ref + ' in a few minutes.');
      });
    })();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    show(msg, '');
    var phone = $('phone').value.trim();
    if (!phoneOk(phone)) { show(msg, 'Please enter a Ghana phone number, like 024 123 4567.'); $('phone').focus(); return; }
    if (!window.PaystackPop) { show(msg, 'The payment window is still loading. Please try again in a moment.'); return; }
    busy(true, 'Opening payment…');
    $('pay-ref').hidden = true;
    // No automatic retry: a second init could start a second payment.
    api('/api/pay/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: plan(), phone: phone, email: $('email').value.trim() }),
    }, 0).then(function (j) {
      if (!j.access_code) {
        busy(false);
        if (j.error === 'founding_full') return show(msg, 'Sorry, all Founding Driver places are taken. Monthly and Yearly are still open.');
        if (j.error === 'phone') return show(msg, 'Please enter a Ghana phone number, like 024 123 4567.');
        if (j._status === 429) return show(msg, 'Too many tries. Please wait a few minutes and try again.');
        return show(msg, 'Payment is not available right now. Please try again shortly.');
      }
      var ref = j.reference;
      savePending(ref);
      $('pay-ref-num').textContent = ref;
      $('pay-ref').hidden = false;
      busy(true, 'Finish in the payment window…');
      new window.PaystackPop().resumeTransaction(j.access_code, {
        onSuccess: function () { verify(ref); },
        onCancel: function () { clearPending(); busy(false); show(msg, 'Payment cancelled. No money was taken.', 'info'); },
        onError: function () { busy(false); show(msg, 'The payment window had a problem. Please try again.'); },
      });
    }).catch(function () {
      busy(false);
      show(msg, 'Could not reach the payment service. Check your internet and try again.');
    });
  });

  $('copy-btn').addEventListener('click', function () {
    var code = $('code').textContent;
    var done = function () { $('copy-btn').textContent = 'Copied'; setTimeout(function () { $('copy-btn').textContent = 'Copy code'; }, 2000); };
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, function () {});
  });

  $('find-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var fm = $('find-msg');
    var ref = $('find-ref').value.trim().toUpperCase();
    var phone = $('find-phone').value.trim();
    if (!/^TA-[A-Z0-9-]{6,60}$/.test(ref) || !phoneOk(phone)) { show(fm, 'Enter the payment number (TA-…) and the phone number you used.'); return; }
    show(fm, 'Looking…', 'info');
    api('/api/pay/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: ref, phone: phone }) }, 2)
      .then(function (j) {
        if (j.code) { show(fm, ''); return showCode(j.code, ref); }
        show(fm, j._status === 429 ? 'Too many tries. Please wait an hour and try again.' : 'We could not find a paid order with those details.');
      }).catch(function () { show(fm, 'Could not reach the payment service. Please try again.'); });
  });

  // Back from a redirect (?reference= / ?trxref=) or a page reload mid-payment.
  var qs = new URLSearchParams(location.search);
  var back = qs.get('reference') || qs.get('trxref');
  var pending = readPending();
  if (back && /^TA-[A-Za-z0-9-]{6,60}$/.test(back)) {
    history.replaceState(null, '', location.pathname);
    verify(back);
  } else if (pending && pending !== lastPaidRef()) {
    verify(pending, true);
  } else if (pending) {
    clearPending();
  }
})();
