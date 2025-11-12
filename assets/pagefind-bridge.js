/*
 * Pagefind Bridge — integra Pagefind à busca existente
 * VERSÃO CORRIGIDA FINAL: Suporte a seleção múltipla de filtros com lógica OR
 *
 * Mudanças principais:
 * 1. Intercepta eventos nos filtros para evitar conflito com search-filter.js
 * 2. Coleta múltiplas seleções de filtros e cria badges visuais
 * 3. Aplica filtros com lógica OR na página principal (filtra os atos visíveis)
 * 4. Passa filtros para Pagefind como arrays para lógica OR nativa no modal
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
  
  // Referência aos dados extraídos pelo search-filter.js
  let allAtos = [];

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

  /**
   * Extrai os dados dos atos da página (similar ao search-filter.js)
   */
  function extractAtosData() {
    const articles = document.querySelectorAll('.ato-line');
    allAtos = [];
    
    articles.forEach((article, index) => {
      const titleElement = article.querySelector('.ato-title a:first-child');
      const descriptionElement = article.querySelector('.ato-description');
      const orgaoSection = article.closest('.org-group');
      const orgaoElement = orgaoSection ? orgaoSection.querySelector('.org-title h2') : null;
      
      const title = titleElement ? titleElement.textContent.trim() : '';
      const description = descriptionElement ? descriptionElement.textContent.trim() : '';
      const orgaoRaw = orgaoElement ? orgaoElement.textContent.trim() : '';
      const orgao = normalizeOrgao(orgaoRaw);
      
      // Extrair tipo de ato (Lei, Resolução, Decreto, etc.)
      const tipo = extractTipoAto(title);
      
      // Extrair ano do título
      const ano = extractAno(title);
      
      allAtos.push({
        index: index,
        element: article,
        title: title,
        description: description,
        orgao: orgao,
        tipo: tipo,
        ano: ano
      });
    });
  }

  function normalizeOrgao(orgao) {
    const normalized = orgao.toLowerCase().trim();
    
    if (normalized.includes('federal')) return 'Federal';
    if (normalized.includes('cnj')) return 'CNJ';
    if (normalized.includes('tjpr')) return 'TJPR';
    if (normalized.includes('paraná') || normalized.includes('parana')) return 'TJPR';
    
    return orgao;
  }

  function extractTipoAto(title) {
    const tipos = [
      'Constituição',
      'Lei Complementar',
      'Lei',
      'Decreto-Lei',
      'Decreto',
      'Resolução',
      'Portaria',
      'Instrução Normativa',
      'Provimento',
      'Ato Normativo',
      'Ato Conjunto',
      'Código'
    ];
    
    for (let tipo of tipos) {
      if (title.toLowerCase().includes(tipo.toLowerCase())) {
        return tipo;
      }
    }
    
    return 'Outro';
  }

  function extractAno(title) {
    const match = title.match(/[nº°]\s*[\d.]+\/(\d{4})|[\(\[](\d{4})[\)\]]/);
    if (match) {
      return match[1] || match[2];
    }
    
    const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      return yearMatch[1];
    }
    
    return '';
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
      // Adiciona o valor ao Set (não permite duplicatas)
      activeMultiFilters[filterKey].add(value);
      
      // Reseta o select para permitir nova seleção
      select.value = '';
    }

    // Atualiza a UI de badges/chips
    updateFilterBadges(filterKey);
    
    // NOVO: Aplica os filtros na página principal
    applyMultiFiltersToPage();
    
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
        
        // NOVO: Reaplica os filtros
        applyMultiFiltersToPage();
        
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

  /**
   * NOVA FUNÇÃO: Aplica filtros múltiplos com lógica OR na página principal
   * Esta é a função que estava faltando!
   */
  function applyMultiFiltersToPage() {
    // Se não há filtros ativos, mostra todos os atos
    const hasActiveFilters = Object.values(activeMultiFilters).some(set => set.size > 0);
    
    if (!hasActiveFilters) {
      // Mostra todos os atos
      allAtos.forEach(ato => {
        ato.element.style.display = '';
        ato.element.classList.remove('hidden-by-filter');
      });
      updateSectionVisibility();
      updateResultCount(allAtos.length);
      return;
    }

    // Aplica filtros com lógica OR
    let visibleCount = 0;
    
    allAtos.forEach(ato => {
      let matches = true;
      
      // Para cada tipo de filtro (tipo, orgao, ano)
      for (const [filterKey, valueSet] of Object.entries(activeMultiFilters)) {
        if (valueSet.size === 0) continue; // Pula filtros vazios
        
        // Lógica OR: o ato deve corresponder a PELO MENOS UM dos valores selecionados
        const atoValue = ato[filterKey];
        if (!valueSet.has(atoValue)) {
          matches = false;
          break;
        }
      }
      
      if (matches) {
        ato.element.style.display = '';
        ato.element.classList.remove('hidden-by-filter');
        visibleCount++;
      } else {
        ato.element.style.display = 'none';
        ato.element.classList.add('hidden-by-filter');
      }
    });
    
    // Atualiza visibilidade das seções
    updateSectionVisibility();
    
    // Atualiza contador
    updateResultCount(visibleCount);
  }

  /**
   * Atualiza a visibilidade das seções baseado nos atos visíveis
   */
  function updateSectionVisibility() {
    const sections = document.querySelectorAll('.org-group');
    
    sections.forEach(section => {
      // Primeiro, ocultar cada suborg sem atos visíveis
      const suborgs = section.querySelectorAll('.suborg');
      suborgs.forEach(suborg => {
        const visibleAtosInSub = suborg.querySelectorAll('.ato-line:not(.hidden-by-filter)');
        if (visibleAtosInSub.length === 0) {
          suborg.style.display = 'none';
        } else {
          suborg.style.display = '';
        }
      });
      
      // Em seguida, ocultar a seção inteira se não houver atos visíveis
      const visibleAtos = section.querySelectorAll('.ato-line:not(.hidden-by-filter)');
      if (visibleAtos.length === 0) {
        section.style.display = 'none';
      } else {
        section.style.display = '';
      }
    });
  }

  /**
   * Atualiza o contador de resultados
   */
  function updateResultCount(count) {
    const resultCount = findResultsCounter();
    if (!resultCount) return;
    
    const total = allAtos.length;
    const displayCount = count !== undefined ? count : total;
    
    if (displayCount === total) {
      resultCount.textContent = `Exibindo todos os ${total} atos normativos`;
      resultCount.className = 'result-count-all';
    } else {
      resultCount.textContent = `Exibindo ${displayCount} de ${total} atos normativos`;
      resultCount.className = 'result-count-filtered';
    }
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

    // Cria o botão de busca avançada
    btn = document.createElement("button");
    btn.id = "pf-trigger";
    btn.className = "pf-trigger-btn";
    btn.type = "button";
    btn.innerHTML = `
      <span class="icon">🔍</span>
      <span class="label">Busca Avançada</span>
      <span class="badge"></span>
    `;
    btn.title = "Buscar dentro do conteúdo dos documentos";

    // Insere o botão após o input de busca
    const searchBox = searchInput.parentElement;
    searchBox.appendChild(btn);

    // Configura o modal
    const overlayBody = window.PagefindBridgeEnsureOverlayForUI();
    const overlay = overlayBody.closest("#pf-overlay");

    // Event listeners
    btn.addEventListener("click", () => openModal(searchInput, overlayBody));
    
    const closeBtn = overlay.querySelector(".pf-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => closeModal());
    }

    const backdrop = overlay.querySelector("#pf-overlay-backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", () => closeModal());
    }

    // Fechar com ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.style.display !== "none") {
        closeModal();
      }
    });

    return { btn, overlayBody, overlay };
  }

  /**
   * Abre o modal de busca avançada
   */
  async function openModal(searchInput, overlayBody) {
    const overlay = overlayBody.closest("#pf-overlay");
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";

    const query = searchInput.value.trim();
    const filters = getActiveFiltersObject();

    // Inicializa o Pagefind se necessário
    if (!pagefindInitialized) {
      overlayBody.innerHTML = '<p class="loading">Carregando índice de busca...</p>';
      const ready = await ensurePagefind();
      if (!ready) {
        overlayBody.innerHTML = '<p class="error">Erro ao carregar o sistema de busca.</p>';
        return;
      }
      pagefindInitialized = true;
    }

    // Executa a busca
    await performSearch(query, filters, overlayBody);
  }

  /**
   * Fecha o modal
   */
  function closeModal() {
    const overlay = document.getElementById("pf-overlay");
    if (overlay) {
      overlay.style.display = "none";
      document.body.style.overflow = "";
    }
  }

  /**
   * Executa a busca no Pagefind
   */
  async function performSearch(query, filters, container) {
    try {
      deepCount++;
      const currentDeep = deepCount;

      // Busca no Pagefind com filtros
      const results = await window.pagefind.search(query, { filters });

      // Verifica se ainda é a busca mais recente
      if (currentDeep !== deepCount) return;

      // Renderiza os resultados
      if (results.results.length === 0) {
        container.innerHTML = '<p class="no-results">Nenhum resultado encontrado.</p>';
        updateCountBadge(0);
        return;
      }

      // Carrega os dados dos resultados
      const items = await Promise.all(
        results.results.slice(0, 50).map(r => r.data())
      );

      // Renderiza
      renderResults(items, container);
      updateCountBadge(results.results.length);

    } catch (error) {
      console.error("[Pagefind] Erro na busca:", error);
      container.innerHTML = '<p class="error">Erro ao realizar a busca.</p>';
    }
  }

  /**
   * Renderiza os resultados da busca
   */
  function renderResults(items, container) {
    const html = items.map(item => {
      const url = item.url || '#';
      const title = item.meta?.title || 'Sem título';
      const excerpt = item.excerpt || '';
      
      return `
        <article class="pf-result">
          <h3><a href="${url}" target="_blank">${title}</a></h3>
          <p>${excerpt}</p>
          <a href="${url}" target="_blank" class="pf-link">Ver documento completo →</a>
        </article>
      `;
    }).join('');

    container.innerHTML = html;
  }

  /**
   * Atualiza o badge de contagem no botão
   */
  function updateCountBadge(count) {
    const countSpan = document.querySelector("#pf-overlay .pf-header .count");
    if (countSpan) {
      countSpan.textContent = count > 0 ? `(${count})` : '';
    }
  }

  /**
   * Atualiza o badge de preview no botão de busca avançada
   */
  async function updateBadge(query, btn) {
    if (!btn) return;
    
    const badge = btn.querySelector(".badge");
    if (!badge) return;

    const filters = getActiveFiltersObject();
    const filtersKey = filtersCacheKey(filters);

    // Verifica cache
    if (query === lastPreviewQuery && filtersKey === lastPreviewFiltersKey) {
      return;
    }

    lastPreviewQuery = query;
    lastPreviewFiltersKey = filtersKey;

    // Se não há query nem filtros, limpa o badge
    if (!query && Object.keys(filters).length === 0) {
      badge.textContent = "";
      badge.style.display = "none";
      return;
    }

    // Tenta obter preview
    try {
      if (!pfReady) await ensurePagefind();
      if (!pfReady) return;

      const results = await window.pagefind.search(query, { filters });
      const count = results.results.length;

      if (count > 0) {
        badge.textContent = count;
        badge.style.display = "inline-block";
      } else {
        badge.textContent = "0";
        badge.style.display = "inline-block";
      }
    } catch (e) {
      console.warn("[Pagefind] Erro ao atualizar preview:", e);
    }
  }

  // ========== INICIALIZAÇÃO ==========
  
  /**
   * Inicializa o bridge após o DOM estar pronto
   */
  async function boot() {
    // Aguarda o input de busca estar disponível
    const searchInput = await waitForSearchInput();
    
    // Aguarda um pouco para o search-filter.js extrair os dados
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Extrai os dados dos atos
    extractAtosData();
    
    // Injeta a UI do modal
    const { btn } = injectUI(searchInput);
    
    // Configura interceptação de filtros
    setupFilterInterception();
    
    // Atualiza o preview inicial
    updateBadge(searchInput.value.trim(), btn);
    
    // Monitora mudanças no input de busca
    searchInput.addEventListener("input", () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        updateBadge(searchInput.value.trim(), btn);
      }, CONFIG.previewDebounce);
    });
  }

  // Inicia quando o DOM estiver pronto
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
