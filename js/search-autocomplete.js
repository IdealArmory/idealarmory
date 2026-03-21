/* ============================================================
   Ideal Armory — Global Search Autocomplete
   Attaches to #nav-srch and #mob-srch on every page.
   Lazily loads /data/search-index.json on first focus.
   ============================================================ */
(function () {
  'use strict';

  var INDEX = null;
  var INDEX_LOADING = false;
  var INDEX_CALLBACKS = [];

  /* ── Utilities ── */
  function slugify(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function getUrl(p) {
    if (p.src === 'eurooptic') {
      return '/product.html?src=eurooptic&id=' + p.id.replace('eo_', '') + '&cat=' + (p.category || '');
    }
    return '/product.html?p=' + slugify(p.name);
  }

  function escape(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── Index loading ── */
  function loadIndex(cb) {
    if (INDEX) { cb(INDEX); return; }
    INDEX_CALLBACKS.push(cb);
    if (INDEX_LOADING) return;
    INDEX_LOADING = true;
    fetch('/data/search-index.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        INDEX = data;
        INDEX_LOADING = false;
        INDEX_CALLBACKS.forEach(function (fn) { fn(INDEX); });
        INDEX_CALLBACKS = [];
      })
      .catch(function () {
        INDEX = [];
        INDEX_LOADING = false;
        INDEX_CALLBACKS.forEach(function (fn) { fn([]); });
        INDEX_CALLBACKS = [];
      });
  }

  /* ── Search ── */
  function search(q, limit) {
    if (!q || !INDEX || !INDEX.length) return [];
    var ql = q.toLowerCase().trim();
    var brandExact = [], nameStart = [], partial = [];
    for (var i = 0; i < INDEX.length; i++) {
      var p = INDEX[i];
      var name = (p.name || '').toLowerCase();
      var brand = (p.brand || '').toLowerCase();
      var haystack = name + ' ' + brand;
      if (brand === ql) {
        brandExact.push(p);
      } else if (name.indexOf(ql) === 0 || brand.indexOf(ql) === 0) {
        nameStart.push(p);
      } else if (haystack.indexOf(ql) >= 0) {
        partial.push(p);
      }
      if (brandExact.length + nameStart.length + partial.length >= (limit || 10) * 4) break;
    }
    return brandExact.concat(nameStart).concat(partial).slice(0, limit || 10);
  }

  /* ── CSS (injected once) ── */
  var CSS_DONE = false;
  function injectCSS() {
    if (CSS_DONE) return;
    CSS_DONE = true;
    var s = document.createElement('style');
    s.textContent =
      '.ia-drop{display:none;position:absolute;top:calc(100% + 3px);left:0;right:0;' +
        'background:#fff;border:1px solid rgba(0,0,0,.14);' +
        'box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:99999;' +
        'border-radius:0 0 3px 3px;overflow:hidden;max-height:540px;overflow-y:auto;}' +
      '.ia-drop.ia-open{display:block;}' +
      '.ia-sug{display:flex;align-items:center;gap:11px;padding:9px 14px;cursor:pointer;' +
        'border-bottom:1px solid #f2f2f0;transition:background .1s;text-decoration:none;}' +
      '.ia-sug:last-of-type{border-bottom:none;}' +
      '.ia-sug:hover,.ia-sug.ia-active{background:#f7f6f3;}' +
      '.ia-sug-img{width:46px;height:46px;object-fit:contain;flex-shrink:0;' +
        'background:#f7f6f3;border-radius:2px;display:block;}' +
      '.ia-sug-ph{width:46px;height:46px;flex-shrink:0;background:#f0efec;border-radius:2px;}' +
      '.ia-sug-body{flex:1;min-width:0;}' +
      '.ia-sug-name{font-size:12.5px;font-weight:600;color:#1b2a3b;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
        'font-family:Inter,sans-serif;line-height:1.3;}' +
      '.ia-sug-meta{font-size:10.5px;color:#888;margin-top:2px;' +
        'display:flex;align-items:center;gap:5px;font-family:Inter,sans-serif;}' +
      '.ia-sug-cat{background:#eee;padding:1px 6px;border-radius:2px;' +
        'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#555;}' +
      '.ia-sug-price{font-size:12.5px;font-weight:700;color:#c49a2a;' +
        'white-space:nowrap;flex-shrink:0;font-family:Inter,sans-serif;}' +
      '.ia-drop-footer{padding:11px 14px;border-top:2px solid #f0efec;' +
        'font-size:12px;font-weight:600;color:#1b2a3b;cursor:pointer;' +
        'text-align:center;background:#fafaf8;font-family:Inter,sans-serif;' +
        'transition:background .1s;}' +
      '.ia-drop-footer:hover{background:#f0efec;}' +
      '.ia-drop-spin{padding:16px;text-align:center;font-size:12px;' +
        'color:#aaa;font-family:Inter,sans-serif;}';
    document.head.appendChild(s);
  }

  /* ── Attach to one input ── */
  function attach(input) {
    injectCSS();

    /* find the wrapper that holds the input for absolute positioning */
    var wrap = input.closest('.nav-search') ||
               input.closest('.mobile-search-wrap') ||
               input.parentElement;
    if (getComputedStyle(wrap).position === 'static') {
      wrap.style.position = 'relative';
    }

    var drop = document.createElement('div');
    drop.className = 'ia-drop';
    wrap.appendChild(drop);

    var debounce = null;
    var activeIdx = -1;

    function close() {
      drop.classList.remove('ia-open');
      activeIdx = -1;
    }

    function getItems() { return drop.querySelectorAll('.ia-sug'); }

    function setActive(idx) {
      var items = getItems();
      items.forEach(function (el, i) {
        el.classList.toggle('ia-active', i === idx);
      });
      activeIdx = idx;
    }

    function navigate(url) {
      if (url) window.location.href = url;
    }

    function render(q) {
      var results = search(q, 10);
      if (!results.length) { close(); return; }

      var html = results.map(function (p) {
        var price = (p.price != null) ? '$' + Number(p.price).toFixed(2) : '';
        var cat = (p.category || '').replace(/-/g, ' ');
        var imgEl = p.img
          ? '<img class="ia-sug-img" src="' + escape(p.img) + '" alt="" loading="lazy">'
          : '<div class="ia-sug-ph"></div>';
        var url = getUrl(p);
        return '<div class="ia-sug" data-href="' + escape(url) + '">'
          + imgEl
          + '<div class="ia-sug-body">'
          + '<div class="ia-sug-name">' + escape(p.name) + '</div>'
          + '<div class="ia-sug-meta">'
          + '<span>' + escape(p.brand) + '</span>'
          + (cat ? '<span class="ia-sug-cat">' + escape(cat) + '</span>' : '')
          + '</div>'
          + '</div>'
          + (price ? '<div class="ia-sug-price">' + price + '</div>' : '')
          + '</div>';
      }).join('');

      var allUrl = '/all-products.html?q=' + encodeURIComponent(q);
      html += '<div class="ia-drop-footer" data-href="' + escape(allUrl) + '">'
        + 'See all results for &ldquo;' + escape(q) + '&rdquo; &rarr;</div>';

      drop.innerHTML = html;

      drop.querySelectorAll('[data-href]').forEach(function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault(); /* prevent input blur before click */
          navigate(el.getAttribute('data-href'));
        });
      });

      drop.classList.add('ia-open');
      activeIdx = -1;
    }

    /* Input handler */
    input.addEventListener('input', function () {
      clearTimeout(debounce);
      var q = input.value.trim();
      if (!q) { close(); return; }
      if (INDEX) {
        debounce = setTimeout(function () { render(q); }, 150);
      } else {
        drop.innerHTML = '<div class="ia-drop-spin">Searching&hellip;</div>';
        drop.classList.add('ia-open');
        loadIndex(function () { render(q); });
      }
    });

    /* Keyboard navigation */
    input.addEventListener('keydown', function (e) {
      var items = getItems();
      var isOpen = drop.classList.contains('ia-open');

      if (e.key === 'ArrowDown') {
        if (!isOpen) return;
        e.preventDefault();
        setActive(Math.min(activeIdx + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        if (!isOpen) return;
        e.preventDefault();
        setActive(Math.max(activeIdx - 1, -1));
      } else if (e.key === 'Enter') {
        if (isOpen && activeIdx >= 0 && items[activeIdx]) {
          e.preventDefault();
          e.stopPropagation();
          navigate(items[activeIdx].getAttribute('data-href'));
        }
        /* if no item highlighted, let page's own Enter handler run */
        close();
      } else if (e.key === 'Escape') {
        close();
        input.blur();
      }
    });

    /* Close on outside click */
    document.addEventListener('mousedown', function (e) {
      if (!wrap.contains(e.target)) close();
    });

    /* Re-open if input already has value and gets focus again */
    input.addEventListener('focus', function () {
      var q = input.value.trim();
      if (q && INDEX) render(q);
      loadIndex(function () {}); /* pre-warm on first focus */
    });
  }

  /* ── Init ── */
  function init() {
    ['nav-srch', 'mob-srch'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) attach(el);
    });
    /* Silently pre-load index 1.5s after page load so it's ready when needed */
    setTimeout(function () { loadIndex(function () {}); }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
