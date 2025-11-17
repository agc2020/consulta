// ======= SISTEMA DE BUSCA E FILTROS =======
// Desenvolvido para otimizar a navegação em listas longas de atos normativos

(function() {
  'use strict';

  // Configuração do Fuse.js para busca fuzzy
  const fuseOptions = {
    keys: [
      { name: 'title', weight: 0.5 },
      { name: 'description', weight: 0.3 },
      { name: 'orgao', weight: 0.1 },
      { name: 'tipo', weight: 0.1 }
    ],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2
  };

  let fuse = null;
  let allAtos = [];
  let currentFilters = {
    search: '',
    orgao: '',
    tipo: '',
    ano: ''
  };

  // ======= INICIALIZAÇÃO =======
  function init() {
    // Aguardar carregamento do DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setup);
    } else {
      setup();
    }
  }

  function setup() {
    // Extrair dados dos atos normativos
    extractAtos();
    
    // Criar interface de controles
    createControlsUI();
    
    // Inicializar Fuse.js
    fuse = new Fuse(allAtos, fuseOptions);
    
    // Configurar event listeners
    setupEventListeners();
    
    // Atualizar contador inicial
    updateResultCount();
  }

  // ======= EXTRAÇÃO DE DADOS =======
  // Normaliza o nome do órgão para corresponder aos valores canônicos do Pagefind
  function normalizeOrgao(orgao) {
    const normalized = orgao.toLowerCase().trim();
    
    if (normalized.includes('federal')) return 'Federal';
    if (normalized.includes('cnj')) return 'CNJ';
    if (normalized.includes('tjpr')) return 'TJPR';
    if (normalized.includes('paraná') || normalized.includes('parana')) return 'TJPR';
    
    return orgao; // Retorna original se não encontrar correspondência
  }

  function extractAtos() {
    const articles = document.querySelectorAll('.ato-line');
    
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

  function extractTipoAto(title) {
    const tipos = [
      'Constituição',
      'Lei Complementar',
      'Lei',
      'Decreto-Lei',
      'Decreto',
	  'Decreto Judiciário',
      'Resolução',
      'Portaria',
      'Instrução Normativa',
      'Provimento',
      'Ato Normativo',
      'Ato Conjunto',
	  'Ofício-Circular',
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
    // Procurar padrões como "nº 123/2020" ou "(2020)"
    const match = title.match(/[nº°]\s*[\d.]+\/(\d{4})|[\(\[](\d{4})[\)\]]/);
    if (match) {
      return match[1] || match[2];
    }
    
    // Procurar ano de 4 dígitos
    const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      return yearMatch[1];
    }
    
    return '';
  }

  // ======= CRIAÇÃO DA INTERFACE =======
  function createControlsUI() {
    const container = document.querySelector('.container');
    const header = document.querySelector('header');
    
    // Criar container de controles
    const controlsHTML = `
      <div class="controls-container" id="searchControls">
        <div class="filters-row">
          <select id="filterOrgao" class="filter-select" data-filter-key="orgao">
            <option value="">Todos os Órgãos</option>
          </select>
          
          <select id="filterTipo" class="filter-select" data-filter-key="tipo">
            <option value="">Todos os Tipos</option>
          </select>
          
          <select id="filterAno" class="filter-select" data-filter-key="ano">
            <option value="">Todos os Anos</option>
          </select>
          
          <button id="resetFilters" class="reset-btn">Limpar Filtros</button>
        </div>
        
        <div class="result-info">
          <p id="resultCount"></p>
        </div>
      </div>
    `;
    
    // Inserir após o header
    header.insertAdjacentHTML('afterend', controlsHTML);
    
    // Preencher opções dos filtros
    populateFilterOptions();
  }

  function populateFilterOptions() {
    const orgaos = new Set();
    const tipos = new Set();
    const anos = new Set();
    
    allAtos.forEach(ato => {
      if (ato.orgao) orgaos.add(ato.orgao);
      if (ato.tipo) tipos.add(ato.tipo);
      if (ato.ano) anos.add(ato.ano);
    });
    
    // Ordenar e preencher select de órgãos
    const orgaoSelect = document.getElementById('filterOrgao');
    Array.from(orgaos).sort().forEach(orgao => {
      const option = document.createElement('option');
      option.value = orgao;
      option.textContent = orgao;
      orgaoSelect.appendChild(option);
    });
    
    // Ordenar e preencher select de tipos
    const tipoSelect = document.getElementById('filterTipo');
    Array.from(tipos).sort().forEach(tipo => {
      const option = document.createElement('option');
      option.value = tipo;
      option.textContent = tipo;
      tipoSelect.appendChild(option);
    });
    
    // Ordenar e preencher select de anos (decrescente)
    const anoSelect = document.getElementById('filterAno');
    Array.from(anos).sort((a, b) => b - a).forEach(ano => {
      const option = document.createElement('option');
      option.value = ano;
      option.textContent = ano;
      anoSelect.appendChild(option);
    });
  }

  // ======= EVENT LISTENERS =======
  function setupEventListeners() {
    const filterOrgao = document.getElementById('filterOrgao');
    const filterTipo = document.getElementById('filterTipo');
    const filterAno = document.getElementById('filterAno');
    const resetBtn = document.getElementById('resetFilters');
    
    // Filtros
    filterOrgao.addEventListener('change', (e) => {
      currentFilters.orgao = e.target.value;
      applyFilters();
    });
    
    filterTipo.addEventListener('change', (e) => {
      currentFilters.tipo = e.target.value;
      applyFilters();
    });
    
    filterAno.addEventListener('change', (e) => {
      currentFilters.ano = e.target.value;
      applyFilters();
    });
    
    // Reset
    resetBtn.addEventListener('click', resetFilters);
  }

  // ======= APLICAÇÃO DE FILTROS =======
  function applyFilters() {
    let filteredAtos = allAtos;
    
    // Aplicar busca fuzzy se houver texto
    if (currentFilters.search) {
      const results = fuse.search(currentFilters.search);
      filteredAtos = results.map(result => result.item);
    }
    
    // Aplicar filtros de categoria
    if (currentFilters.orgao) {
      filteredAtos = filteredAtos.filter(ato => ato.orgao === currentFilters.orgao);
    }
    
    if (currentFilters.tipo) {
      filteredAtos = filteredAtos.filter(ato => ato.tipo === currentFilters.tipo);
    }
    
    if (currentFilters.ano) {
      filteredAtos = filteredAtos.filter(ato => ato.ano === currentFilters.ano);
    }
    
    // Atualizar visualização
    updateDisplay(filteredAtos);
    updateResultCount(filteredAtos.length);
    
    // Gerenciar visibilidade das seções
    updateSectionVisibility();
  }

  function updateDisplay(filteredAtos) {
    const filteredIndexes = new Set(filteredAtos.map(ato => ato.index));
    
    allAtos.forEach(ato => {
      if (filteredIndexes.has(ato.index)) {
        ato.element.style.display = '';
        ato.element.classList.remove('hidden-by-filter');
      } else {
        ato.element.style.display = 'none';
        ato.element.classList.add('hidden-by-filter');
      }
    });
  }

  function updateSectionVisibility() {
    // Ocultar seções e sub-seções que não têm atos visíveis
    const sections = document.querySelectorAll('.org-group');
    
    sections.forEach(section => {
      // Primeiro, ocultar cada suborg sem atos visíveis
      const suborgs = section.querySelectorAll('.suborg');
      suborgs.forEach(suborg => {
        // Seleciona apenas os atos visíveis (não escondidos por filtros)
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

  function updateResultCount(count) {
    const resultCount = document.getElementById('resultCount');
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

  function resetFilters() {
    // Limpar inputs
    document.getElementById('filterOrgao').value = '';
    document.getElementById('filterTipo').value = '';
    document.getElementById('filterAno').value = '';
    
    // Resetar filtros
    currentFilters = {
      search: '',
      orgao: '',
      tipo: '',
      ano: ''
    };
    
    // Mostrar todos os atos
    allAtos.forEach(ato => {
      ato.element.style.display = '';
      ato.element.classList.remove('hidden-by-filter');
    });
    
    // Mostrar todas as seções
    const sections = document.querySelectorAll('.org-group');
    sections.forEach(section => {
      section.style.display = '';
    });
    
    // Atualizar contador
    updateResultCount();
  }

  // Iniciar quando o script carregar
  init();
})();

