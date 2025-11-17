
/*
 * Pagefind Bridge — integra Pagefind à busca existente
 * Patch: filtros da UI também filtram a busca Pagefind.
 *
 * Como o Pagefind requer chaves/valores EXATOS, esta bridge coleta os <select>
 * de filtros e os converte para o objeto { filters } de window.pagefind.search().
 *
 * Regras para mapear cada <select> -> chave do filtro:
 * 1) Se o <select> tiver data-filter-key="chave", usa isso.
 * 2) Senão, se houver window.PAGEFIND_FILTER_MAP, tenta id/name nesse mapa.
 * 3) Senão, aplica sinônimos comuns (esfera|nível|jurisdicao -> orgao; categoria|classe -> tipo; year -> ano).
 * 4) Caso nada corresponda, usa name ou id do próprio select.
 *
 * IMPORTANTE:
 * - Os valores enviados ao Pagefind são os .value das <option>. Portanto, configure os values
 *   para o canônico do índice (ex.: value="CNJ", "Federal", "Estadual", "2021" etc.), deixando o texto
 *   visível livre para acentos e frases como "Legislação Federal".
 * - As páginas indexadas DEVEM fornecer os mesmos filtros via <meta data-pagefind-filter="chave" content="valor">.
 */
(function () {
  // Exposto para o index.html criar o container antes do PagefindUI montar
  // Sem isso, o PagefindUI não encontra #pf-body e não renderiza filtros.
  if (!window.PagefindBridgeEnsureOverlayForUI) {
    window.PagefindBridgeEnsureOverlayForUI = function() {
      // reutiliza a mesma função de injeção, mas sem acoplar eventos duplicados
      try {
        const existing = document.getElementById("pf-overlay");
        if (existing && existing.querySelector("#pf-body")) return existing.querySelector("#pf-body");
      } catch (_) {}
      // cria rapidamente a estrutura básica; listeners serão adicionados no boot normal
      const overlay = document.createElement("div");
      overlay.id = "pf-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.style.display = "none";
      overlay.innerHTML = `
        <div id="pf-overlay-backdrop" class="backdrop"></div>
        <div class="panel">
          <header class="pf-header">
            <h2>Busca no conteúdo <span class="count"></span></h2>
            <button class="pf-close" aria-label="Fechar" title="Fechar">×</button>
          </header>
          <div id="pf-body" role="region" aria-live="polite"></div>
        </div>`;
      document.body.appendChild(overlay);
      return overlay.querySelector("#pf-body");
    };
  }
  
  let pfReady = false;
  let lastPreviewQuery = "";
  let lastPreviewFiltersKey = "";
  let previewTimer = null;
  let deepCount = 0;
  
  // ======= VARIÁVEIS PARA CONTROLE DE LISTENERS =======
  let currentSearchInput = null;
  let currentButton = null;
  let listenersAttached = false;

  function waitForSearchInput() {
    return new Promise(resolve => {
      const existing = document.getElementById("searchInput");
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = document.getElementById("searchInput");
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function findFiltersBlock() {
    let el = document.querySelector("#filters, .filters-row, .filters-container, .filters");
    if (el) return el;
    const selects = Array.from(document.querySelectorAll("select"));
    if (selects.length >= 2) {
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

  function findResultsCounter() {
    const byId = document.querySelector("#resultsCount, .results-count, .results-info");
    if (byId) return byId;
    const candidates = Array.from(document.querySelectorAll("p,div,span"));
    for (const el of candidates) {
      const t = (el.textContent || "").trim();
      if (/^Exibindo\b/i.test(t) && /\batos normativos\b/i.test(t)) return el;
    }
    return null;
  }

  // ---------- Mapeamento de filtros ----------
  function normalizeKey(k) {
    return String(k || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  }

  function mapSelectNameToFilterKey(name, id, el) {
    // Priority 1: data-filter-key explícito
    const dataKey = el?.dataset?.filterKey;
    if (dataKey) return dataKey;

    // Priority 2: mapeamento global configurável
    const map = (window.PAGEFIND_FILTER_MAP || {});
    if (map[name]) return map[name];
    if (map[id]) return map[id];

    // Priority 3: sinônimos comuns
    const nName = normalizeKey(name);
    const nId   = normalizeKey(id);
    const n = nName || nId;

    const synonyms = {
      // "orgao"
      "orgao": "orgao", "órgão": "orgao", "esfera": "orgao", "nivel": "orgao",
      "nível": "orgao", "jurisdicao": "orgao", "jurisdiçao": "orgao", "conselho": "orgao",
      // "tipo"
      "tipo": "tipo", "categoria": "tipo", "classe": "tipo",
      // "ano"
      "ano": "ano", "ano_publicacao": "ano", "ano_publicação": "ano", "year": "ano"
    };

    if (synonyms[n]) return synonyms[n];

    // Priority 4: fallback em name/id crus
    return name || id || "";
  }

  function getActiveFiltersObject() {
    const container = findFiltersBlock() || document;
    const selects = Array.from(container.querySelectorAll("select"));
    const filters = {};
    for (const sel of selects) {
      const key = mapSelectNameToFilterKey(sel.name || "", sel.id || "", sel);
      if (!key) continue;

      // Ignora valores vazios ou placeholders "Todos ..."
      const raw = sel.multiple
        ? Array.from(sel.selectedOptions).map(o => (o.value || "").trim())
        : [(sel.value || "").trim()];

      const values = raw.filter(v => v && !/^todos\b/i.test(v));
      if (!values.length) continue;

      filters[key] = values.length === 1 ? values[0] : values;
    }
    return filters;
  }

  function filtersCacheKey(obj) {
    try { return JSON.stringify(obj, Object.keys(obj).sort()); } catch { return ""; }
  }

  // ======= HANDLERS DE EVENTOS (funções nomeadas para facilitar remoção/readição) =======
  function handleSearchInputChange() {
    if (!currentSearchInput || !currentButton) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updateBadge(currentSearchInput.value.trim(), currentButton), 400);
  }

  function handleButtonClick() {
    if (!currentSearchInput) return;
    performDeepSearch(currentSearchInput.value.trim(), true);
  }

  function handleFiltersChange() {
    if (!currentSearchInput || !currentButton) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => updateBadge(currentSearchInput.value.trim(), currentButton), 250);
  }

  function handleKeyDown(e) {
    if (e.key === "Escape") {
      const overlay = document.getElementById("pf-overlay");
      const backdrop = document.getElementById("pf-overlay-backdrop");
      if (overlay) overlay.style.display = "none";
      if (backdrop) backdrop.style.display = "none";
    }
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      if (currentSearchInput) {
        performDeepSearch(currentSearchInput.value.trim(), true);
      }
    }
  }

  // ---------- UI (botão + modal) ----------
  function injectUI(searchInput) {
    const btn = document.createElement("button");
    btn.id = "pf-trigger";
    btn.type = "button";
    btn.title = "Busca Avançada (Pagefind) – Alt+Enter";
    btn.textContent = "Busca Avançada";

    const backdrop = document.createElement("div");
    backdrop.id = "pf-overlay-backdrop";
    const overlay = document.createElement("div");
    overlay.id = "pf-overlay";
    overlay.innerHTML = `
      <div id="pf-header">
        <div class="title">Resultados no conteúdo <span class="count"></span></div>
        <button id="pf-close" aria-label="Fechar (Esc)">&times;</button>
      </div>
      <div id="pf-body" role="region" aria-live="polite"></div>
    `;
    document.body.append(backdrop, overlay);

    // Preferência: entre filtros e contador
    let placed = false;
    try {
      const filters = findFiltersBlock();
      const counter = findResultsCounter();
      if (counter && counter.parentElement) {
        counter.parentElement.insertBefore(btn, counter);
        placed = true;
      } else if (filters) {
        filters.insertAdjacentElement("afterend", btn);
        placed = true;
      }
    } catch {}
    if (!placed) {
      searchInput.insertAdjacentElement("afterend", btn);
    }

    function close() {
      overlay.style.display = "none";
      backdrop.style.display = "none";
    }
    backdrop.addEventListener("click", close);
    overlay.querySelector("#pf-close").addEventListener("click", close);
    
    // Armazenar referências globais
    currentSearchInput = searchInput;
    currentButton = btn;
    
    // Anexar event listeners usando as funções nomeadas
    attachEventListeners();

    return { btn, overlay, backdrop };
  }

  // ======= FUNÇÃO PARA ANEXAR EVENT LISTENERS =======
  function attachEventListeners() {
    if (listenersAttached) {
      console.log('[Pagefind Bridge] Listeners já anexados, pulando...');
      return;
    }
    
    if (!currentSearchInput || !currentButton) {
      console.warn('[Pagefind Bridge] Elementos não disponíveis para anexar listeners');
      return;
    }
    
    // Adicionar listeners
    currentButton.addEventListener("click", handleButtonClick);
    currentSearchInput.addEventListener("input", handleSearchInputChange);
    document.addEventListener("keydown", handleKeyDown);
    
    // Atualiza badge quando filtros mudam
    const fb = findFiltersBlock();
    if (fb) {
      fb.addEventListener("change", handleFiltersChange);
    }
    
    listenersAttached = true;
    console.log('[Pagefind Bridge] Event listeners anexados com sucesso');
  }

  // ======= FUNÇÃO PARA REMOVER EVENT LISTENERS =======
  function detachEventListeners() {
    if (!listenersAttached) return;
    
    if (currentButton) {
      currentButton.removeEventListener("click", handleButtonClick);
    }
    
    if (currentSearchInput) {
      currentSearchInput.removeEventListener("input", handleSearchInputChange);
    }
    
    document.removeEventListener("keydown", handleKeyDown);
    
    const fb = findFiltersBlock();
    if (fb) {
      fb.removeEventListener("change", handleFiltersChange);
    }
    
    listenersAttached = false;
    console.log('[Pagefind Bridge] Event listeners removidos');
  }

  // ======= OBSERVADOR DE MUDANÇAS NO DOM =======
  function observeSearchInputChanges() {
    const observer = new MutationObserver((mutations) => {
      const searchInput = document.getElementById('searchInput');
      const button = document.getElementById('pf-trigger');
      
      // Se os elementos existem mas os listeners não estão anexados, reanexar
      if (searchInput && button && !listenersAttached) {
        console.log('[Pagefind Bridge] Reanexando event listeners após mudança no DOM');
        currentSearchInput = searchInput;
        currentButton = button;
        attachEventListeners();
      }
      
      // Se os elementos mudaram, atualizar referências
      if (searchInput && searchInput !== currentSearchInput) {
        console.log('[Pagefind Bridge] SearchInput modificado, atualizando referências');
        detachEventListeners();
        currentSearchInput = searchInput;
        attachEventListeners();
      }
    });
    
    // Observar mudanças no container de controles
    const controlsContainer = document.getElementById('searchControls');
    if (controlsContainer) {
      observer.observe(controlsContainer, {
        childList: true,
        subtree: true,
        attributes: false
      });
    }
    
    // Também observar mudanças no body
    observer.observe(document.body, {
      childList: true,
      subtree: false
    });
  }

  async function ensurePagefind() {
    if (pfReady) return true;
    if (!window.pagefind || !window.pagefind.init) return false;
    try {
      await window.pagefind.init();
      pfReady = true;
      return true;
    } catch (e) {
      console.warn("[Pagefind] Falha ao inicializar:", e);
      return false;
    }
  }

  async function updateBadge(query, button) {
    const activeFilters = getActiveFiltersObject();
    const currentFK = filtersCacheKey(activeFilters);

    if (!query || query.length < 2) { setBadgeCount(button, 0); return; }
    if (query === lastPreviewQuery && currentFK === lastPreviewFiltersKey) return;
    lastPreviewQuery = query;
    lastPreviewFiltersKey = currentFK;

    if (!(await ensurePagefind())) { setBadgeCount(button, 0); return; }
    try {
      const result = await window.pagefind.search(query, { filters: activeFilters });
      setBadgeCount(button, result?.results?.length || 0);
    } catch (e) {
      console.warn("[Pagefind] Erro na contagem de preview:", e);
      setBadgeCount(button, 0);
    }
  }

  function setBadgeCount(button, n) {
    deepCount = n;
    const existing = button.querySelector(".badge");
    if (n > 0) {
      if (existing) existing.textContent = `(${n})`;
      else {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = `(${n})`;
        button.appendChild(b);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  async function performDeepSearch(query, openOverlay) {
    const overlay = document.getElementById("pf-overlay");
    const backdrop = document.getElementById("pf-overlay-backdrop");
    const body = overlay.querySelector("#pf-body");
    
    // === [fix:transfer-search-content] Captura valor do input principal se query estiver vazia
    const mainSearchInput = document.getElementById('searchInput');
    if (!query && mainSearchInput) {
      query = mainSearchInput.value.trim();
    }
    
	// Se a UI padrão do Pagefind estiver montada, não renderizamos manualmente os resultados
    if (body && body.querySelector('[data-pagefind-ui]')) {
      overlay.style.display = "block";
      backdrop.style.display = "block";
      const inputUI = body.querySelector('input[type="search"], input[type="text"]');
      if (inputUI) {
        // === [fix:transfer-search-content] Transfere o valor para o input do modal
        if (query) {
          inputUI.value = query;
          inputUI.dispatchEvent(new Event('input', { bubbles: true }));
        }
        inputUI.focus();
      }
      
      // === [fix:transfer-search-content] Limpa o input principal para não interferir na busca do Pagefind
      if (mainSearchInput && query) {
        mainSearchInput.value = '';
        mainSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    const countElement = overlay.querySelector(".count");
    if (!query || query.length < 2) return;

    const activeFilters = getActiveFiltersObject();
    if (!(await ensurePagefind())) {
      countElement.textContent = "";
      body.innerHTML = '<div class="pf-empty">O índice de conteúdo não está disponível.</div>';
      overlay.style.display = "block";
      backdrop.style.display = "block";
      return;
    }
    body.innerHTML = '<div class="pf-empty">Buscando…</div>';
    try {
      const res = await window.pagefind.search(query, { filters: activeFilters });
      const hits = res?.results || [];
      countElement.textContent = hits.length ? `— ${hits.length} resultado(s)` : "— 0 resultados";

      if (hits.length === 0) {
        body.innerHTML = `<div class="pf-empty">Sem resultados no conteúdo para "${escapeHtml(query)}".</div>`;
      } else {
        const items = [];
        for (const r of hits.slice(0, 200)) {
          const data = await r.data();
          items.push(renderHit(data));
        }
        body.innerHTML = items.join("");
      }
      if (openOverlay) {
        overlay.style.display = "block";
        backdrop.style.display = "block";
      }
    } catch (e) {
      console.error("[Pagefind] Erro ao buscar:", e);
      body.innerHTML = '<div class="pf-empty">Erro ao consultar o índice de conteúdo.</div>';
      overlay.style.display = "block";
      backdrop.style.display = "block";
    }
  }

  function renderHit(data) {
    const url = data.url || "#";
    const title = (data.meta && (data.meta.title || data.meta.h1)) || url;
    const excerpt = data.excerpt || "";
    return `
      <a class="pf-hit" href="${url}" target="_blank" rel="noopener noreferrer">
        <div class="pf-title">${escapeHtml(title)}</div>
        ${excerpt ? `<div class="pf-snippet">${excerpt}</div>` : ""}
        <div class="pf-url">${escapeHtml(url)}</div>
      </a>
    `;
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>\"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[m]);
  }

  (async function boot() {
    // Garante que o CSS esteja aplicado (site já inclui, mas deixamos por segurança).
    if (!document.querySelector('link[href$="pagefind-bridge.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "assets/pagefind-bridge.css";
      document.head.appendChild(link);
    }
    const input = await waitForSearchInput();
    const { btn } = injectUI(input);
    if (input.value) updateBadge(input.value.trim(), btn);
    
    // ======= ATIVAR OBSERVADOR DE MUDANÇAS =======
    observeSearchInputChanges();
  })();
})();


// ==== Correção: Remover lupa do placeholder quando o usuário digita ====
// Monitora o input do Pagefind e ajusta o placeholder dinamicamente
(function() {
  function setupSearchIconRemoval() {
    // Aguardar o Pagefind UI ser montado
    const checkInterval = setInterval(() => {
      const pagefindInput = document.querySelector('.pagefind-ui__search-input');
      
      if (pagefindInput) {
        clearInterval(checkInterval);
        
        // Salvar o placeholder original
        const originalPlaceholder = pagefindInput.getAttribute('placeholder') || '';
        const placeholderWithoutIcon = originalPlaceholder.replace(/🔍\s*/g, '');
        
        // Função para atualizar o placeholder
        function updatePlaceholder() {
          if (pagefindInput.value.trim() !== '') {
            // Se houver texto, remover a lupa
            pagefindInput.setAttribute('placeholder', placeholderWithoutIcon);
          } else {
            // Se estiver vazio, restaurar a lupa
            pagefindInput.setAttribute('placeholder', originalPlaceholder);
          }
        }
        
        // Monitorar eventos de input
        pagefindInput.addEventListener('input', updatePlaceholder);
        pagefindInput.addEventListener('change', updatePlaceholder);
        pagefindInput.addEventListener('keyup', updatePlaceholder);
        
        // Verificar estado inicial
        updatePlaceholder();
        
        console.log('[Pagefind] Remoção automática da lupa configurada');
      }
    }, 100); // Verificar a cada 100ms
    
    // Timeout de segurança para não ficar verificando eternamente
    setTimeout(() => clearInterval(checkInterval), 10000); // 10 segundos
  }
  
  // Executar quando o DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSearchIconRemoval);
  } else {
    setupSearchIconRemoval();
  }
})();
