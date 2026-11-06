/**
 * Static product search for the mirror.
 *
 * The origin's search box is Woodmart's AJAX autocomplete: it POSTs to
 * /wp-admin/admin-ajax.php?action=woodmart_ajax_search, and a static host has no PHP
 * to answer, so the box produced a spinner and nothing else. Pressing Enter submitted
 * GET /?s=query, which Pages resolves to the homepage file while discarding the query
 * - the visitor lands back where they started with no explanation.
 *
 * This replaces that round trip with a local index (search.json, built by
 * tools/mirror.mjs from the rendered product pages) and matches in the browser. The
 * result markup reuses the theme's own class names, so the theme's stylesheet paints
 * it; only the panel's visibility is ours, in site-search.css, because the rule that
 * revealed the original dropdown could not be located and an invisible feature is
 * indistinguishable from a missing one.
 *
 * The pure half is exported and imported by tools/ingest/wp/search-index.test.mjs, so
 * ranking can be tested without a browser. The DOM half only runs when a document
 * exists, which keeps this file importable from Node.
 *
 * This file must not import anything. An earlier version imported normalise() from
 * tools/ingest/wp/search-index.js, which is a repository path, not a URL: the browser
 * requested /tools/ingest/wp/search-index.js, got a 404, and the whole module failed to
 * evaluate - so the search box was dead on every page while every unit test passed.
 * The dependency now runs the other way: the build imports normalise() from here, so
 * the shipped file is self-contained and the index is guaranteed to be normalised the
 * same way the query is.
 */

/**
 * Fold a string down to what both the index and the query are compared on.
 *
 * The width and quote folding matters specifically: product titles carry the prime
 * character from the Chinese slug (1.28″), a customer types 1.28" or 1.28in, and NFKC
 * pulls both toward the same form.
 */
export function normalise(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2032\u2033\u201c\u201d\u3001\u3002]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Two characters, not the three the AJAX search demanded: that limit existed to keep
 * server queries cheap, and here the whole catalogue is 34 products already in memory.
 * Chinese queries are shorter than English ones, so 串口 would have been blocked by a
 * rule copied for the wrong reason.
 */
export const MIN_QUERY = 2;

/** Twelve suggestions fit the desktop grid at three columns without a scrollbar. */
export const LIMIT = 12;

/**
 * Field weights.
 *
 * The title dominates and the spec table is nearly worthless on its own, because every
 * product page on this site carries the same 产品尺寸 value (2.1"TFT round display) - a
 * known content defect. Weighting specs like the title would make "2.1" return the
 * entire catalogue ranked as if those were forty distinct matches; with these weights it
 * still returns everything, but only after the products that say 2.1 in their name.
 */
export const WEIGHTS = {
  titleExact: 120,
  titlePrefix: 70,
  titleContains: 45,
  categoryContains: 25,
  skuContains: 40,
  textContains: 6,
};

/**
 * Rank one entry against a query, or reject it.
 *
 * Every term must appear somewhere (AND), otherwise "3.5 hdmi" would list products
 * matching only the 3.5. A term missing from the entry scores zero and the whole query
 * fails, which is what makes multi-word queries narrow instead of widen.
 */
export function score(entry, query) {
  const terms = normalise(query).split(' ').filter(Boolean);
  if (terms.length === 0) return 0;

  const title = normalise(entry.title);
  const categories = normalise(entry.categories.join(' '));
  const sku = normalise(entry.sku);
  const text = entry.text;

  let total = 0;

  for (const term of terms) {
    let best = 0;

    if (title === term) best = WEIGHTS.titleExact;
    else if (title.startsWith(term)) best = WEIGHTS.titlePrefix;
    else if (title.includes(term)) best = WEIGHTS.titleContains;

    if (best === 0 && categories.includes(term)) best = WEIGHTS.categoryContains;
    if (best === 0 && sku && sku.includes(term)) best = WEIGHTS.skuContains;
    if (best === 0 && text.includes(term)) best = WEIGHTS.textContains;

    // A term nothing in this entry contains disqualifies it outright.
    if (best === 0) return 0;
    total += best;
  }

  return total;
}

/**
 * Rank the index for a query in one language.
 *
 * Language is a filter rather than a score: an English page must not offer a Chinese
 * product page, because the visitor cannot read it and the mirror keeps the two trees
 * entirely separate.
 */
export function search(entries, query, { lang = 'zh', limit = LIMIT } = {}) {
  if (normalise(query).length < MIN_QUERY) return [];

  return entries
    .filter((entry) => entry.lang === lang)
    .map((entry) => ({ entry, value: score(entry, query) }))
    .filter((hit) => hit.value > 0)
    // Ties break on the title so the ordering never depends on index order.
    .sort((a, b) => b.value - a.value || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit);
}

/**
 * Split a title into the pieces the renderer will join with <strong>.
 *
 * The theme underlines `strong` inside a suggestion title, so this is how the original
 * showed what matched. Returning plain strings rather than HTML keeps escaping the
 * renderer's job and this function's job testable.
 *
 * Positions are found in the lowercased title, not the normalised one. normalise folds
 * the prime in "1.28″" to a space, which shortens the string and shifts every later
 * index away from the original text - so highlighting off it would underline the wrong
 * characters for any term that sits after a ″. The trade is that a term only matchable
 * after normalisation will not be underlined, while still ranking: a missing underline
 * is cosmetic, an underline on the wrong letters reads as a broken page.
 */
export function highlight(title, query) {
  const terms = normalise(query).split(' ').filter((term) => term.length > 0);
  if (terms.length === 0) return [{ text: title, hit: false }];

  const lower = String(title).toLowerCase();
  const ranges = [];

  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at !== -1) {
      ranges.push([at, at + term.length]);
      at = lower.indexOf(term, at + term.length);
    }
  }

  if (ranges.length === 0) return [{ text: title, hit: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: title.slice(cursor, start), hit: false });
    parts.push({ text: title.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < title.length) parts.push({ text: title.slice(cursor), hit: false });

  return parts;
}

const STRINGS = {
  zh: { none: '没有匹配的产品', all: '浏览全部产品', loading: '正在载入索引…' },
  en: { none: 'No matching products', all: 'Browse all products', loading: 'Loading index…' },
};

/* ------------------------------------------------------------------------- */
/* Everything below touches the document, so it only runs in the browser.     */
/* ------------------------------------------------------------------------- */

export function boot(document, { indexUrl = '/search.json' } = {}) {
  if (!document.querySelector) return { forms: 0 };

  const forms = [...document.querySelectorAll('form.searchform')].filter((form) => {
    const type = form.querySelector('input[name="post_type"]');
    return type && type.value === 'product';
  });

  for (const form of forms) attach(form, document, indexUrl);

  return { forms: forms.length };
}

function attach(form, document, indexUrl) {
  const container = form.closest('.wd-search-form') ?? form.parentElement;
  const wrapper = container?.querySelector('.search-results-wrapper');
  const panel = wrapper?.querySelector('.wd-scroll-content');
  const dropdown = wrapper?.querySelector('.wd-dropdown-results');
  if (!panel || !dropdown) return;

  const input = form.querySelector('input[type="text"]');
  if (!input) return;

  const lang = document.location.pathname.startsWith('/en/') ? 'en' : 'zh';
  const strings = STRINGS[lang];

  container.classList.add('wd-static-search');

  let entries = null;
  let loading = null;
  let selected = -1;

  const load = () => {
    if (entries) return Promise.resolve(entries);
    if (!loading) {
      form.classList.add('search-loading');
      loading = fetch(indexUrl)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`search index ${response.status}`))))
        .then((data) => {
          entries = data;
          form.classList.remove('search-loading');
          return entries;
        })
        .catch((error) => {
          // A failed index must not look like "no products match", so say which it was
          // and drop the loading state rather than spinning forever.
          form.classList.remove('search-loading');
          entries = null;
          loading = null;
          message(`${strings.none} (${error.message})`);
          return [];
        });
    }
    return loading;
  };

  const close = () => {
    container.classList.remove('wd-opened');
    // The theme reveals the panel with `.wd-dropdown.wd-opened`, so the class has to go
    // on the dropdown itself; putting it only on the form matched none of the theme's
    // selectors and left the results rendered into the DOM but invisible on screen.
    dropdown.classList.remove('wd-opened');
    selected = -1;
  };

  const open = () => {
    container.classList.add('wd-opened');
    dropdown.classList.add('wd-opened');
  };

  const message = (text) => {
    panel.textContent = '';
    const list = document.createElement('ul');
    list.className = 'autocomplete-suggestions';
    const line = document.createElement('li');
    line.className = 'autocomplete-suggestion suggestion-no-found';
    line.textContent = text;
    list.append(line);
    panel.append(list);
    open();
  };

  const render = (hits, query) => {
    panel.textContent = '';

    const list = document.createElement('ul');
    list.className = 'autocomplete-suggestions';

    if (hits.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'autocomplete-suggestion suggestion-no-found';
      empty.textContent = strings.none;
      list.append(empty);
    }

    for (const [index, hit] of hits.entries()) {
      list.append(item(hit.entry, query, index, strings, document));
    }

    // Only offer the catalog link when the list was truncated; otherwise it promises
    // more results than exist.
    if (hits.length === LIMIT) {
      const more = document.createElement('li');
      more.className = 'autocomplete-suggestion view-all-results';
      const link = document.createElement('a');
      link.href = lang === 'en' ? '/en/%E4%BA%A7%E5%93%81%E4%B8%AD%E5%BF%83/' : '/%E4%BA%A7%E5%93%81%E4%B8%AD%E5%BF%83/';
      link.textContent = strings.all;
      more.append(link);
      list.append(more);
    }

    panel.append(list);
    open();
    container.classList.toggle('wd-no-results', hits.length === 0);
  };

  const run = () => {
    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      close();
      panel.textContent = '';
      return;
    }

    load().then(() => {
      const hits = search(entries, query, { lang });
      selected = -1;
      render(hits, query);
    });
  };

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= MIN_QUERY) run();
  });
  input.addEventListener('input', run);

  // Enter must not fall through to the form's own GET, which would reload the
  // homepage: it picks the highlighted suggestion, or just keeps the list open.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const hits = search(entries ?? [], input.value.trim(), { lang });
    const chosen = selected >= 0 ? hits[selected] : hits[0];
    if (chosen?.entry.url) document.location.href = chosen.entry.url;
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();

    const items = [...panel.querySelectorAll('.autocomplete-suggestion')].filter((li) => li.dataset.url);
    if (items.length === 0) return;

    selected = event.key === 'ArrowDown'
      ? (selected + 1) % items.length
      : (selected - 1 + items.length) % items.length;

    items.forEach((item, at) => item.classList.toggle('autocomplete-selected', at === selected));
    items[selected].scrollIntoView({ block: 'nearest' });
  });

  document.addEventListener('click', (event) => {
    if (!container.contains(event.target)) close();
  });

  input.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') close();
  });
}

function item(entry, query, index, strings, document) {
  const li = document.createElement('li');
  li.className = 'autocomplete-suggestion';
  li.dataset.url = entry.url;

  if (entry.image) {
    const thumb = document.createElement('div');
    thumb.className = 'suggestion-thumb';
    const img = document.createElement('img');
    img.src = entry.image;
    img.alt = '';
    img.width = 65;
    img.height = 65;
    img.loading = 'lazy';
    thumb.append(img);
    li.append(thumb);
  }

  const title = document.createElement('div');
  title.className = 'wd-entities-title';
  for (const part of highlight(entry.title, query)) {
    if (part.hit) {
      const strong = document.createElement('strong');
      strong.textContent = part.text;
      title.append(strong);
    } else {
      title.append(part.text);
    }
  }
  li.append(title);

  const meta = entry.sku || entry.categories[0];
  if (meta) {
    const sku = document.createElement('div');
    sku.className = 'suggestion-sku';
    sku.textContent = meta;
    li.append(sku);
  }

  li.addEventListener('click', () => {
    document.location.href = entry.url;
  });

  return li;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const start = () => boot(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
