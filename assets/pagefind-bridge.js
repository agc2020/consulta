
/*
 * Pagefind Bridge — integra Pagefind ao seu campo de busca
 * e posiciona o botão "Buscar no conteúdo" LOGO ABAIXO dos filtros
 * e ACIMA do contador de resultados, quando esses elementos são encontrados.
 * Mantém fallback: se não achar, injeta logo abaixo do input de busca.
 */
(function () {
  let pfReady = false;
  let lastPreviewQuery = '';
  let previewTimer = null;
  let deepCount = 0;

  function waitForSearchInput() {
    return new Promise(resolve => {
      const existing = document.getElementById('searchInput');
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = document.getElementById('searchInput');
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // Tenta encontrar a "faixa de filtros" (os <select> + botão limpar)
  function findFiltersBlock() {
    // IDs/classes mais prováveis
    let el = document.querySelector('#filters, .filters-row, .filters-container, .filters');
    if (el) return el;

    // Heurística: achar um ancestral comum que contenha 2+ <select>
    const selects = Array.from(document.querySelectorAll('select'));
    if (selects.length >= 2) {
      // primeiro candidato: pai do 1º select
      let ancestor = selects[0].parentElement;
      outer: while (ancestor && ancestor !== document.body) {
        for (const s of selects.slice(0, 2)) {
          if (!ancestor.contains(s)) { ancestor = ancestor.parentElement; continue outer; }
        }
        return ancestor;
      }
    }
    return null;
  }

  // Tenta achar o elemento que exibe "Exibindo X de Y atos normativos"
  function findResultsCounter() {
    const byId = document.querySelector('#resultsCount, .results-count, .results-info');
    if (byId) return byId;

    // Fallback textual
    const candidates = Array.from(document.querySelectorAll('p,div,span'));
    for (const el of candidates) {
      const t = (el.textContent || '').trim();
      if (/^Exibindo\b/i.test(t) && /\batos normativos\b/i.test(t)) return el;
    }
    return null;
  }

  // Cria UI (botão + modal) e posiciona o botão
  function injectUI(searchInput) {
    const btn = document.createElement('button');
    btn.id = 'pf-trigger';
    btn.type = 'button';
    btn.title = 'Buscar no conteúdo (Pagefind) – Alt+Enter';
    btn.textContent = 'Buscar no conteúdo';

    // Overlay do modal
    const backdrop = document.createElement('div');
    backdrop.id = 'pf-overlay-backdrop';
    const overlay = document.createElement('div');
    overlay.id = 'pf-overlay';
    overlay.innerHTML = `
      <div id="pf-header">
        <div class="title">Resultados no conteúdo <span class="count"></span></div>
        <button id="pf-close" aria-label="Fechar (Esc)">&times;</button>
      </div>
      <div id="pf-body" role="region" aria-live="polite"></div>
    `;
    document.body.append(backdrop, overlay);

    // Posicionamento preferencial: depois do bloco de filtros e ANTES do contador
    let placed = false;
    try {
      const filters = findFiltersBlock();
      const counter = findResultsCounter();
      if (counter && counter.parentElement) {
        counter.parentElement.insertBefore(btn, counter);
        placed = true;
      } else if (filters) {
        filters.insertAdjacentElement('afterend', btn);
        placed = true;
      }
    } catch (e) {
      // silencioso; cairemos no fallback
    }
    if (!placed) {
      // Fallback: logo abaixo do input de busca
      searchInput.insertAdjacentElement('afterend', btn);
    }

    // Handlers do modal
    function close() {
      overlay.style.display = 'none';
      backdrop.style.display = 'none';
    }
    backdrop.addEventListener('click', close);
    overlay.querySelector('#pf-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        performDeepSearch(searchInput.value.trim(), true);
      }
    });

    btn.addEventListener('click', () => performDeepSearch(searchInput.value.trim(), true));
    searchInput.addEventListener('input', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => updateBadge(searchInput.value.trim(), btn), 400);
    });

    return { btn, overlay, backdrop };
  }

  async function ensurePagefind() {
    if (pfReady) return true;
    if (!window.pagefind || !window.pagefind.init) return false;
    try {
      await window.pagefind.init();
      pfReady = true;
      return true;
    } catch (e) {
      console.warn('[Pagefind] Falha ao inicializar:', e);
      return false;
    }
  }

  async function updateBadge(query, button) {
    if (!query || query.length < 2) { setBadgeCount(button, 0); return; }
    if (query === lastPreviewQuery) return;
    lastPreviewQuery = query;
    if (!(await ensurePagefind())) { setBadgeCount(button, 0); return; }
    try {
      const result = await window.pagefind.search(query);
      setBadgeCount(button, result?.results?.length || 0);
    } catch (e) {
      console.warn('[Pagefind] Erro na contagem de preview:', e);
      setBadgeCount(button, 0);
    }
  }

  function setBadgeCount(button, n) {
    deepCount = n;
    const existing = button.querySelector('.badge');
    if (n > 0) {
      if (existing) existing.textContent = `(${n})`;
      else {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = `(${n})`;
        button.appendChild(b);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  async function performDeepSearch(query, openOverlay) {
    const overlay = document.getElementById('pf-overlay');
    const backdrop = document.getElementById('pf-overlay-backdrop');
    const body = overlay.querySelector('#pf-body');
    const countElement = overlay.querySelector('.count');
    if (!query || query.length < 2) return;
    if (!(await ensurePagefind())) {
      countElement.textContent = '';
      body.innerHTML = '<div class="pf-empty">O índice de conteúdo não está disponível.</div>';
      overlay.style.display = 'block';
      backdrop.style.display = 'block';
      return;
    }
    body.innerHTML = '<div class="pf-empty">Buscando…</div>';
    try {
      const res = await window.pagefind.search(query);
      const hits = res?.results || [];
      countElement.textContent = hits.length ? `— ${hits.length} resultado(s)` : '— 0 resultados';
      if (hits.length === 0) {
        body.innerHTML = `<div class="pf-empty">Sem resultados no conteúdo para “${escapeHtml(query)}”.</div>`;
      } else {
        const items = [];
        for (const r of hits.slice(0, 200)) {
          const data = await r.data();
          items.push(renderHit(data));
        }
        body.innerHTML = items.join('');
      }
      if (openOverlay) {
        overlay.style.display = 'block';
        backdrop.style.display = 'block';
      }
    } catch (e) {
      console.error('[Pagefind] Erro ao buscar:', e);
      body.innerHTML = '<div class="pf-empty">Erro ao consultar o índice de conteúdo.</div>';
      overlay.style.display = 'block';
      backdrop.style.display = 'block';
    }
  }

  function renderHit(data) {
    const url = data.url || '#';
    const title = (data.meta && (data.meta.title || data.meta.h1)) || url;
    const excerpt = data.excerpt || '';
    return `
      <a class="pf-hit" href="${url}">
        <div class="pf-title">${escapeHtml(title)}</div>
        ${excerpt ? `<div class="pf-snippet">${excerpt}</div>` : ''}
        <div class="pf-url">${escapeHtml(url)}</div>
      </a>
    `;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[m]);
  }

  (async function boot() {
    // Garante que o CSS esteja aplicado (proteção extra, embora já esteja no HTML)
    if (!document.querySelector('link[href$="pagefind-bridge.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'assets/pagefind-bridge.css';
      document.head.appendChild(link);
    }

    const input = await waitForSearchInput();
    const { btn } = injectUI(input);
    if (input.value) updateBadge(input.value.trim(), btn);
  })();
})();
