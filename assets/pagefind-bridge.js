
/*
 * Pagefind Bridge — integra Pagefind à busca existente
 * VERSÃO CORRIGIDA: Suporte a seleção múltipla de filtros com lógica OR
 *
 * Mudanças principais:
 * 1. Intercepta eventos nos filtros para evitar conflito com search-filter.js
 * 2. Coleta múltiplas seleções de filtros (converte select em multiple quando necessário)
 * 3. Passa filtros para Pagefind como arrays para lógica OR nativa
 * 4. Adiciona UI de checkboxes no modal para seleção múltipla intuitiva
 */
(function () {
  'use strict';

  // ========== CONFIGURAÇÃO ==========
  const CONFIG = {
    // Mapeamento de IDs dos selects da página principal para chaves do Pagefind
    filterMapping: {
      'filterTipo': 'tipo',
      'filterOrgao': 'orgao',
      'filterAno': 'ano'
    },
    // Filtros que devem permitir seleção múltipla
    multiSelectFilters: ['tipo', 'orgao'],
    // Debounce para atualização de preview
    previewDebounce: 400
  };

  // ========== ESTADO GLOBAL ==========
  let pfReady = false;
  let pagefindInitialized = false;
  let lastPreviewQuery = "";
  let lastPreviewFiltersKey = "";
  let previewTimer = null;
  let deepCount = 0;
  let activeMultiFilters = {
    tipo: new Set(),
    orgao: new Set(),
    ano: new Set()
  };

  // ========== FUNÇÕES UTILITÁRIAS ==========
  
  /**
   * Aguarda o input de busca principal estar disponível no DOM
   */
  function waitForSearchInput() {
    return new Promise(resolve => {
      const existing = document.getElementById("searchInput");
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = document.getElementById("searchInput");
        if (el) { 
          observer.disconnect(); 
          resolve(el); 
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  /**
   * Encontra o container de filtros na página
   */
  function findFiltersBlock() {
    return document.querySelector("#searchControls, .filters-row, .controls-container");
  }

  /**
   * Encontra o contador de resultados
   */
  function findResultsCounter() {
    return document.querySelector("#resultCount, .result-info, .results-count");
  }

  /**
   * Gera uma chave de cache para os filtros ativos
   */
  function filtersCacheKey(obj) {
    try { 
      return JSON.stringify(obj, Object.keys(obj).sort()); 
    } catch { 
      return ""; 
    }
  }

  /**
   * Inicializa o Pagefind se ainda não foi feito
   */
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

  // ========== GERENCIAMENTO DE FILTROS MÚLTIPLOS ==========

  /**
   * Coleta os filtros ativos em formato compatível com Pagefind
   * Retorna objeto com arrays para lógica OR: { tipo: ["Lei", "Decreto"], orgao: ["Federal"] }
   */
  function getActiveFiltersObject() {
    const filters = {};
    
    // Converte Sets em arrays, filtrando valores vazios
    for (const [key, valueSet] of Object.entries(activeMultiFilters)) {
      const values = Array.from(valueSet).filter(v => v && v.trim() && !/^todos\b/i.test(v));
      if (values.length > 0) {
        // Pagefind aceita array para OR, string única para match exato
        filters[key] = values.length === 1 ? values[0] : values;
      }
    }
    
    return filters;
  }

  /**
   * Atualiza o estado dos filtros múltiplos baseado nos selects da página
   */
  function updateMultiFiltersFromSelects() {
    const filtersBlock = findFiltersBlock();
    if (!filtersBlock) return;

    // Limpa os filtros atuais
    for (const key in activeMultiFilters) {
      activeMultiFilters[key].clear();
    }

    // Lê os valores dos selects
    for (const [selectId, filterKey] of Object.entries(CONFIG.filterMapping)) {
      const select = document.getElementById(selectId);
      if (!select) continue;

      const value = select.value.trim();
      if (value && !/^todos\b/i.test(value)) {
        activeMultiFilters[filterKey].add(value);
      }
    }
  }

  /**
   * Intercepta eventos de mudança nos filtros para evitar conflito com search-filter.js
   * e permitir seleção múltipla
   */
  function setupFilterInterception() {
    const filtersBlock = findFiltersBlock();
    if (!filtersBlock) return;

    // Para cada filtro que deve ser multi-seleção
    CONFIG.multiSelectFilters.forEach(filterKey => {
      const selectId = Object.keys(CONFIG.filterMapping).find(
        id => CONFIG.filterMapping[id] === filterKey
      );
      if (!selectId) return;

      const select = document.getElementById(selectId);
      if (!select) return;

      // Adiciona listener com captura para interceptar antes do search-filter.js
      select.addEventListener('change', handleMultiFilterChange, true);
      
      // Marca o select para indicar que está sob controle do bridge
      select.dataset.pagefindBridgeManaged = 'true';
    });
  }

  /**
   * Handler para mudanças nos filtros com suporte a multi-seleção
   */
  function handleMultiFilterChange(event) {
    const select = event.target;
    const selectId = select.id;
    const filterKey = CONFIG.filterMapping[selectId];
    
    if (!filterKey || !CONFIG.multiSelectFilters.includes(filterKey)) {
      // Não é um filtro multi-seleção, deixa o comportamento padrão
      return;
    }

    // Impede propagação para o search-filter.js não processar
    event.stopPropagation();
    event.stopImmediatePropagation();

    const value = select.value.trim();
    
    if (!value || /^todos\b/i.test(value)) {
      // "Todos" foi selecionado - limpa o filtro
      activeMultiFilters[filterKey].clear();
      select.value = ''; // Reseta o select
    } else {
      // Adiciona ou remove o valor do Set (toggle)
      if (activeMultiFilters[filterKey].has(value)) {
        activeMultiFilters[filterKey].delete(value);
      } else {
        activeMultiFilters[filterKey].add(value);
      }
      
      // Reseta o select para permitir nova seleção
      select.value = '';
    }

    // Atualiza a UI de badges/chips
    updateFilterBadges(filterKey);
    
    // Atualiza o preview do botão de busca avançada
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        updateBadge(searchInput.value.trim(), document.getElementById('pf-trigger'));
      }, CONFIG.previewDebounce);
    }

    // Previne o comportamento padrão completamente
    return false;
  }

  /**
   * Cria e atualiza badges visuais para mostrar filtros ativos
   */
  function updateFilterBadges(filterKey) {
    const selectId = Object.keys(CONFIG.filterMapping).find(
      id => CONFIG.filterMapping[id] === filterKey
    );
    if (!selectId) return;

    const select = document.getElementById(selectId);
    if (!select) return;

    // Remove badges existentes
    let badgesContainer = select.parentElement.querySelector('.filter-badges');
    if (!badgesContainer) {
      badgesContainer = document.createElement('div');
      badgesContainer.className = 'filter-badges';
      select.parentElement.appendChild(badgesContainer);
    }
    badgesContainer.innerHTML = '';

    // Adiciona badges para cada valor ativo
    const values = Array.from(activeMultiFilters[filterKey]);
    values.forEach(value => {
      const badge = document.createElement('span');
      badge.className = 'filter-badge';
      badge.innerHTML = `
        ${value}
        <button type="button" class="badge-remove" data-filter="${filterKey}" data-value="${value}" aria-label="Remover ${value}">×</button>
      `;
      badgesContainer.appendChild(badge);

      // Handler para remover o badge
      badge.querySelector('.badge-remove').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activeMultiFilters[filterKey].delete(value);
        updateFilterBadges(filterKey);
        
        // Atualiza preview
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
          clearTimeout(previewTimer);
          previewTimer = setTimeout(() => {
            updateBadge(searchInput.value.trim(), document.getElementById('pf-trigger'));
          }, CONFIG.previewDebounce);
        }
      });
    });
  }

  // ========== UI DO MODAL ==========

  /**
   * Garante que o overlay do modal existe (chamado pelo index.html)
   */
  if (!window.PagefindBridgeEnsureOverlayForUI) {
    window.PagefindBridgeEnsureOverlayForUI = function() {
      try {
        const existing = document.getElementById("pf-overlay");
        if (existing && existing.querySelector("#pf-body")) {
          return existing.querySelector("#pf-body");
        }
      } catch (_) {}
      
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

  /**
   * Injeta o botão de busca avançada e configura o modal
   */
  function injectUI(searchInput) {
    // Verifica se já existe um botão
    let btn = document.getElementById("pf-trigger");
    if (btn) return { btn };

    btn = document.createElement("button");
    btn.id = "pf-trigger";
    btn.type = "button";
    btn.className = "btn-outline";
    btn.title = "Busca Avançada (Pagefind) – Alt+Enter";
    btn.textContent = "Busca Avançada";

    // Posiciona o botão próximo ao contador de resultados
    let placed = false;
    try {
      const counter = findResultsCounter();
      if (counter && counter.parentElement) {
        counter.parentElement.insertBefore(btn, counter);
        placed = true;
      } else {
        const filters = findFiltersBlock();
        if (filters) {
          filters.insertAdjacentElement("afterend", btn);
          placed = true;
        }
      }
    } catch {}
    
    if (!placed) {
      searchInput.insertAdjacentElement("afterend", btn);
    }

    // Event listeners do botão
    btn.addEventListener("click", () => {
      const query = searchInput.value.trim();
      openAdvancedSearch(query);
    });

    // Atalho Alt+Enter
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        const query = searchInput.value.trim();
        openAdvancedSearch(query);
      }
    });

    // Atualiza badge quando input muda
    searchInput.addEventListener("input", () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        updateBadge(searchInput.value.trim(), btn);
      }, CONFIG.previewDebounce);
    });

    // Atualiza badge quando filtros mudam
    const filtersBlock = findFiltersBlock();
    if (filtersBlock) {
      filtersBlock.addEventListener("change", () => {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
          updateBadge(searchInput.value.trim(), btn);
        }, 250);
      });
    }

    return { btn };
  }

  /**
   * Abre o modal de busca avançada
   */
  function openAdvancedSearch(query) {
    // Garante que o PagefindUI foi inicializado
    if (window.initPagefindUI && typeof window.initPagefindUI === 'function') {
      window.initPagefindUI();
    }

    const overlay = document.getElementById('pf-overlay');
    const backdrop = document.getElementById('pf-overlay-backdrop');
    
    if (overlay) overlay.style.display = 'block';
    if (backdrop) backdrop.style.display = 'block';

    // Aguarda um pouco para o PagefindUI renderizar
    setTimeout(() => {
      const input = document.querySelector('.pagefind-ui__search-input');
      if (input && query) {
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (input) input.focus();

      // Aplica os filtros ativos ao Pagefind
      applyFiltersToPagefindUI();
    }, 300);
  }

  /**
   * Aplica os filtros ativos à UI do Pagefind
   * Nota: A PagefindUI gerencia seus próprios filtros internamente,
   * então precisamos injetar os valores nos elementos de filtro dela
   */
  function applyFiltersToPagefindUI() {
    const filters = getActiveFiltersObject();
    
    // A PagefindUI cria seus próprios elementos de filtro
    // Precisamos encontrá-los e marcá-los como selecionados
    const pfBody = document.getElementById('pf-body');
    if (!pfBody) return;

    // Aguarda os filtros do Pagefind serem renderizados
    setTimeout(() => {
      for (const [filterKey, filterValues] of Object.entries(filters)) {
        const values = Array.isArray(filterValues) ? filterValues : [filterValues];
        
        // Encontra os checkboxes/inputs do Pagefind para este filtro
        const filterInputs = pfBody.querySelectorAll(`[data-pagefind-filter="${filterKey}"]`);
        
        filterInputs.forEach(input => {
          if (input.type === 'checkbox') {
            const inputValue = input.value || input.dataset.value;
            if (values.includes(inputValue)) {
              input.checked = true;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
      }
    }, 500);
  }

  /**
   * Atualiza o badge de contagem no botão de busca avançada
   */
  async function updateBadge(query, button) {
    if (!button) return;

    updateMultiFiltersFromSelects();
    const activeFilters = getActiveFiltersObject();
    const currentFK = filtersCacheKey(activeFilters);

    if (!query || query.length < 2) { 
      setBadgeCount(button, 0); 
      return; 
    }
    
    if (query === lastPreviewQuery && currentFK === lastPreviewFiltersKey) {
      return;
    }
    
    lastPreviewQuery = query;
    lastPreviewFiltersKey = currentFK;

    if (!(await ensurePagefind())) { 
      setBadgeCount(button, 0); 
      return; 
    }
    
    try {
      const result = await window.pagefind.search(query, { filters: activeFilters });
      setBadgeCount(button, result?.results?.length || 0);
    } catch (e) {
      console.warn("[Pagefind] Erro na contagem de preview:", e);
      setBadgeCount(button, 0);
    }
  }

  /**
   * Define a contagem no badge do botão
   */
  function setBadgeCount(button, n) {
    deepCount = n;
    const existing = button.querySelector(".badge");
    
    if (n > 0) {
      if (existing) {
        existing.textContent = `(${n})`;
      } else {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = `(${n})`;
        button.appendChild(b);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  // ========== INICIALIZAÇÃO ==========

  /**
   * Inicializa o bridge quando o DOM estiver pronto
   */
  async function boot() {
    try {
      const searchInput = await waitForSearchInput();
      
      // Configura interceptação de filtros
      setupFilterInterception();
      
      // Injeta UI
      injectUI(searchInput);
      
      // Atualiza badge inicial
      updateBadge(searchInput.value.trim(), document.getElementById('pf-trigger'));
      
      console.log("[Pagefind Bridge] Inicializado com sucesso (multi-select habilitado)");
    } catch (e) {
      console.error("[Pagefind Bridge] Erro na inicialização:", e);
    }
  }

  // Aguarda o DOM estar pronto
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})();
