
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
  
  // ======= CORREÇÃO: Variáveis para rastrear estado do Pagefind =======
  let pagefindInitAttempts = 0;
  const MAX_INIT_ATTEMPTS = 3;

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
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        performDeepSearch(searchInput.value.trim(), true);
      }
    });

    // Atualiza badge quando filtros mudam
    const fb = findFiltersBlock();
    if (fb) {
      fb.addEventListener("change", () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => updateBadge(searchInput.value.trim(), btn), 250);
      });
    }

    btn.addEventListener("click", () => performDeepSearch(searchInput.value.trim(), true));
    searchInput.addEventListener("input", () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => updateBadge(searchInput.value.trim(), btn), 400);
    });

    return { btn, overlay, backdrop };
  }

  // ======= CORREÇÃO: Função simplificada para garantir que o Pagefind está pronto =======
  async function ensurePagefind() {
    // Se já está marcado como pronto, retorna true
    if (pfReady) return true;
    
    // Verifica se window.pagefind está disponível
    if (!window.pagefind || !window.pagefind.init) {
      console.warn("[Pagefind Bridge] window.pagefind não está disponível");
      return false;
    }
    
    // Limita tentativas de inicialização para evitar loop infinito
    if (pagefindInitAttempts >= MAX_INIT_ATTEMPTS) {
      console.error("[Pagefind Bridge] Máximo de tentativas de inicialização atingido");
      return false;
    }
    
    try {
      pagefindInitAttempts++;
      console.log(`[Pagefind Bridge] Tentando inicializar Pagefind (tentativa ${pagefindInitAttempts}/${MAX_INIT_ATTEMPTS})...`);
      await window.pagefind.init();
      pfReady = true;
      console.log("[Pagefind Bridge] Pagefind inicializado com sucesso");
      return true;
    } catch (e) {
      console.error("[Pagefind Bridge] Erro ao inicializar Pagefind:", e);
      pfReady = false;
      return false;
    }
  }
  
  // ======= CORREÇÃO: Função para forçar reinicialização do Pagefind =======
  async function reinitializePagefind() {
    console.log("[Pagefind Bridge] Forçando reinicialização do Pagefind...");
    pfReady = false;
    pagefindInitAttempts = 0;
    return await ensurePagefind();
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
    
    // ======= CORREÇÃO: Tenta reinicializar se o Pagefind não estiver disponível =======
    let pagefindReady = await ensurePagefind();
    if (!pagefindReady) {
      console.warn("[Pagefind Bridge] Primeira tentativa falhou, tentando reinicializar...");
      pagefindReady = await reinitializePagefind();
    }
    
    if (!pagefindReady) {
      countElement.textContent = "";
      // ======= CORREÇÃO: Botão estilizado com as classes do site =======
      body.innerHTML = `
        <div class="pf-empty">
          O índice de conteúdo não está disponível.
          <button class="pf-reload-btn" onclick="location.reload()">Recarregar página</button>
        </div>
      `;
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
      // ======= CORREÇÃO: Botão estilizado com as classes do site =======
      body.innerHTML = `
        <div class="pf-empty">
          Erro ao consultar o índice de conteúdo.
          <button class="pf-reload-btn" onclick="location.reload()">Recarregar página</button>
        </div>
      `;
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

  // ======= CORREÇÃO: Observador de mudanças no tema =======
  function observeThemeChanges() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          console.log("[Pagefind Bridge] Mudança de tema detectada, verificando integridade do Pagefind...");
          // Reseta o estado para forçar verificação na próxima busca
          pfReady = false;
          pagefindInitAttempts = 0;
        }
      }
    });
    
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    
    console.log("[Pagefind Bridge] Observador de mudanças de tema ativado");
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
    
    // ======= CORREÇÃO: Ativa observador de mudanças de tema =======
    observeThemeChanges();
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
