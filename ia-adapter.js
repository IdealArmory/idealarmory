/**
 * Ideal Armory Data Adapter  v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Bridges the retailer data feed (JSON) with each category page's rendering
 * engine. Pages call IA.fetchFeed() or IA.loadFeed() to replace their static
 * PRODUCTS array with live data from the aggregator pipeline.
 *
 * Feed contract: ia-schema.json
 * Sample feed:   feeds/ia-feed-sample.json
 *
 * ─── Quick-start ─────────────────────────────────────────────────────────────
 *
 * 1. Add this before your page's <script> block:
 *
 *      <script src="ia-adapter.js"></script>
 *
 * 2. Inside your page script, replace the static array init block:
 *
 *      // OLD (static):
 *      var filteredProducts = [...PRODUCTS];
 *      sortAndRender();
 *
 *      // NEW (live feed):
 *      var filteredProducts = [];
 *      IA.fetchFeed('feeds/ia-feed.json', 'handguns', function(products) {
 *        PRODUCTS = products;
 *        filteredProducts = products.slice();
 *        sortAndRender();
 *        renderSuggested();
 *      }, function(err) {
 *        // Feed unavailable — fall back to the static PRODUCTS array
 *        console.warn('[IA] Falling back to static data:', err.message);
 *        filteredProducts = PRODUCTS.slice();
 *        sortAndRender();
 *        renderSuggested();
 *      });
 *
 * ─── Category slugs ───────────────────────────────────────────────────────────
 *   handguns | rifles | shotguns | ammunition | optics
 *   holsters | ar-parts | magazines | cleaning | gun-safes
 *
 * ─── Dev helpers (browser console) ──────────────────────────────────────────
 *   IA.feedSummary(feedJson)   — count products by category
 *   IA.clearCache()            — force next fetchFeed to bypass localStorage
 *   IA.version                 — adapter version string
 * ─────────────────────────────────────────────────────────────────────────────
 */

var IA = (function () {
  'use strict';

  var ADAPTER_VERSION = '1.0';

  // Feed cache TTL: 15 minutes. Prevents redundant fetches on page navigation.
  var CACHE_TTL_MS    = 15 * 60 * 1000;
  var CACHE_PREFIX    = 'ia_feed_v1_';

  // Valid category slugs — used for validation warnings only.
  var VALID_CATEGORIES = [
    'handguns','rifles','shotguns','ammunition','optics',
    'holsters','ar-parts','magazines','cleaning','gun-safes'
  ];

  // Valid stock values accepted by the rendering engine.
  var VALID_STOCK = ['in','low','out'];


  // ── Logging ──────────────────────────────────────────────────────────────────

  function _log(msg)        { console.log('[IA]  ' + msg); }
  function _warn(msg)       { console.warn('[IA]  ' + msg); }
  function _err(msg, e)     { console.error('[IA]  ' + msg, e || ''); }


  // ── Seller normalization ─────────────────────────────────────────────────────

  /**
   * Normalizes a single seller entry.
   * Returns null if the seller is fatally malformed (skipped by the caller).
   */
  function _normalizeSeller(s, productId) {
    if (!s || typeof s !== 'object') {
      _warn('Product ' + productId + ': seller is not an object — skipped');
      return null;
    }
    var price = parseFloat(s.price);
    if (isNaN(price) || price < 0) {
      _warn('Product ' + productId + ': seller "' + s.name + '" has invalid price — skipped');
      return null;
    }
    return {
      name:        String(s.name        || ''),
      price:       price,
      stock:       VALID_STOCK.indexOf(s.stock) >= 0 ? s.stock : 'in',
      url:         String(s.url         || ''),
      fflRequired: Boolean(s.fflRequired),
      updatedAt:   s.updatedAt          || null
    };
  }


  // ── Product normalization ────────────────────────────────────────────────────

  /**
   * Converts a raw feed product object into the shape expected by the
   * category-page rendering and filter engine.
   *
   * Strategy: all fields in raw.specs are flattened directly onto the product
   * object so that existing filter code (p.caliber, p.action, etc.) works
   * without modification.
   */
  function _normalize(raw) {
    var specs   = (raw.specs && typeof raw.specs === 'object') ? raw.specs : {};

    // Normalize sellers and sort cheapest first
    var sellers = (Array.isArray(raw.sellers) ? raw.sellers : [])
      .map(function(s) { return _normalizeSeller(s, raw.id); })
      .filter(Boolean)
      .sort(function(a, b) { return a.price - b.price; });

    // Core product shape — matches what renderGrid() and filterProducts() expect
    var p = {
      id:          raw.id,
      category:    String(raw.category    || ''),
      brand:       String(raw.brand       || ''),
      name:        String(raw.name        || ''),
      sub:         String(raw.sub         || ''),
      description: String(raw.description || ''),
      img:         String(raw.img         || ''),
      stars:       Math.min(5, Math.max(0, parseFloat(raw.stars)   || 0)),
      reviews:     Math.max(0, parseInt(raw.reviews, 10)           || 0),
      badge:       String(raw.badge || ''),
      sellers:     sellers
    };

    // Flatten every spec field onto p (e.g. p.caliber, p.action, p.qty …).
    // We skip any key that would overwrite a core field defined above.
    var coreKeys = Object.keys(p);
    Object.keys(specs).forEach(function(k) {
      if (coreKeys.indexOf(k) < 0) {
        p[k] = specs[k];
      }
    });

    return p;
  }


  // ── Validation ───────────────────────────────────────────────────────────────

  /**
   * Validates required fields on a raw (pre-normalization) product object.
   * Throws a descriptive Error on failure; the caller catches and skips.
   */
  function _validate(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Product is not an object');
    }
    if (!raw.id) {
      throw new Error('Missing required field: id');
    }
    if (!raw.brand) {
      throw new Error('id=' + raw.id + ': missing required field: brand');
    }
    if (!raw.name) {
      throw new Error('id=' + raw.id + ': missing required field: name');
    }
    if (!Array.isArray(raw.sellers) || raw.sellers.length === 0) {
      throw new Error('id=' + raw.id + ': must have at least one seller');
    }
    // Category is not required but emit a warning if unrecognized
    if (raw.category && VALID_CATEGORIES.indexOf(raw.category) < 0) {
      _warn('id=' + raw.id + ': unrecognized category "' + raw.category + '"');
    }
  }


  // ── localStorage cache ───────────────────────────────────────────────────────

  function _readCache(url) {
    try {
      var entry = JSON.parse(localStorage.getItem(CACHE_PREFIX + url));
      if (!entry || !entry.ts || !entry.data) return null;
      if (Date.now() - entry.ts > CACHE_TTL_MS) {
        localStorage.removeItem(CACHE_PREFIX + url);
        return null;
      }
      return entry.data;
    } catch (e) {
      return null;
    }
  }

  function _writeCache(url, feedJson) {
    try {
      localStorage.setItem(
        CACHE_PREFIX + url,
        JSON.stringify({ ts: Date.now(), data: feedJson })
      );
    } catch (e) {
      // localStorage full or unavailable — silently skip caching
    }
  }


  // ── PUBLIC API ───────────────────────────────────────────────────────────────

  /**
   * loadFeed(feedJson, category?)
   * ─────────────────────────────
   * Normalizes an already-parsed feed JSON object into a PRODUCTS-compatible
   * array. Call this when you have the JSON in memory (e.g. from your own
   * fetch, or from an import pipeline).
   *
   * @param  {Object}  feedJson  — Parsed feed object matching ia-schema.json
   * @param  {string}  [category] — If provided, only products of this category
   *                               are returned (e.g. 'handguns')
   * @returns {Array}  Normalized product array, ready for: PRODUCTS = result
   */
  function loadFeed(feedJson, category) {
    if (!feedJson || !Array.isArray(feedJson.products)) {
      _err('Feed JSON must have a "products" array');
      return [];
    }

    var raw = feedJson.products;
    if (category) {
      raw = raw.filter(function(p) { return p.category === category; });
    }

    var normalized = [];
    raw.forEach(function(item, i) {
      try {
        _validate(item);
        normalized.push(_normalize(item));
      } catch (e) {
        _warn('Skipping product at index ' + i + ': ' + e.message);
      }
    });

    _log(
      'Loaded ' + normalized.length + ' product(s)' +
      (category ? ' [' + category + ']' : ' [all categories]') +
      ' from feed v' + (feedJson.version || '?')
    );
    return normalized;
  }


  /**
   * fetchFeed(url, category, onSuccess, onError?, skipCache?)
   * ──────────────────────────────────────────────────────────
   * Fetches a feed JSON file by URL, normalizes it, and calls onSuccess.
   * Results are cached in localStorage for CACHE_TTL_MS (15 min) to avoid
   * redundant network requests as the user navigates between category pages.
   *
   * @param  {string}   url        — Relative or absolute URL of the feed JSON
   * @param  {string}   category   — Category slug to filter (e.g. 'handguns')
   * @param  {Function} onSuccess  — Called with (normalizedProducts, rawFeedJson)
   * @param  {Function} [onError]  — Called with (Error) on network/parse failure
   * @param  {boolean}  [skipCache]— Pass true to force a fresh network request
   */
  function fetchFeed(url, category, onSuccess, onError, skipCache) {
    // ── Cache hit ────────────────────────────────────────────────────────────
    if (!skipCache) {
      var cached = _readCache(url);
      if (cached) {
        _log('Cache hit for ' + url);
        try {
          var cachedProducts = loadFeed(cached, category);
          if (typeof onSuccess === 'function') onSuccess(cachedProducts, cached);
          return;
        } catch (e) {
          _warn('Cache parse error — re-fetching: ' + e.message);
        }
      }
    }

    // ── Network fetch ────────────────────────────────────────────────────────
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var feedJson = JSON.parse(xhr.responseText);
          _writeCache(url, feedJson);
          var products = loadFeed(feedJson, category);
          if (typeof onSuccess === 'function') onSuccess(products, feedJson);
        } catch (e) {
          _err('Failed to parse feed at ' + url, e);
          if (typeof onError === 'function') onError(e);
        }

      } else {
        var httpErr = new Error('HTTP ' + xhr.status + ' fetching ' + url);
        _err(httpErr.message);
        if (typeof onError === 'function') onError(httpErr);
      }
    };

    xhr.onerror = function () {
      var netErr = new Error('Network error fetching ' + url);
      _err(netErr.message);
      if (typeof onError === 'function') onError(netErr);
    };

    xhr.send();
  }


  /**
   * clearCache()
   * ─────────────
   * Removes all Ideal Armory feed cache entries from localStorage.
   * Run this from the browser console to force a fresh fetch:
   *   IA.clearCache()
   */
  function clearCache() {
    var removed = 0;
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); removed++; });
    } catch (e) { /* noop */ }
    _log('Cleared ' + removed + ' cache entry/entries');
  }


  /**
   * getLowestPrice(product)
   * ────────────────────────
   * Returns the lowest seller price for a normalized product.
   * Mirrors the getLowestPrice() helper defined in each category page.
   * Use this in pipeline scripts or the console — pages use their own copy.
   */
  function getLowestPrice(p) {
    if (!p || !p.sellers || !p.sellers.length) return 0;
    return Math.min.apply(null, p.sellers.map(function (s) { return s.price; }));
  }


  /**
   * getPricePerRound(product)
   * ─────────────────────────
   * Returns price-per-round in CENTS for an ammunition product.
   * Requires p.qty (rounds per package) to be set in specs.
   */
  function getPricePerRound(p) {
    var low = getLowestPrice(p);
    var qty = parseInt(p.qty, 10) || 1;
    return (low / qty) * 100;
  }


  /**
   * feedSummary(feedJson)
   * ─────────────────────
   * Returns a diagnostic object describing feed contents.
   * Useful during QA and retailer onboarding:
   *   fetch('feeds/ia-feed.json').then(r=>r.json()).then(IA.feedSummary)
   *
   * @param  {Object} feedJson — Parsed feed JSON
   * @returns {Object} Summary with version, totalProducts, byCategory counts
   */
  function feedSummary(feedJson) {
    if (!feedJson || !Array.isArray(feedJson.products)) {
      return { error: 'Invalid feed — missing products array' };
    }
    var byCategory = {};
    var missingFields = [];
    feedJson.products.forEach(function (p, i) {
      var cat = p.category || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (!p.id)      missingFields.push('index ' + i + ': missing id');
      if (!p.brand)   missingFields.push((p.id || 'index ' + i) + ': missing brand');
      if (!p.name)    missingFields.push((p.id || 'index ' + i) + ': missing name');
      if (!p.sellers || !p.sellers.length)
                      missingFields.push((p.id || 'index ' + i) + ': no sellers');
    });
    return {
      version:       feedJson.version   || 'n/a',
      generated:     feedJson.generated || 'n/a',
      source:        feedJson.source    || 'n/a',
      totalProducts: feedJson.products.length,
      byCategory:    byCategory,
      warnings:      missingFields
    };
  }


  // ── Expose public API ────────────────────────────────────────────────────────
  return {
    version:         ADAPTER_VERSION,
    loadFeed:        loadFeed,
    fetchFeed:       fetchFeed,
    clearCache:      clearCache,
    getLowestPrice:  getLowestPrice,
    getPricePerRound:getPricePerRound,
    feedSummary:     feedSummary
  };

}());
