#!/usr/bin/env python3
"""
Script para adicionar novo atributo ordem[content] aos arquivos HTML com peso calculado
Cria meta tag com data-pagefind-filter="ordem[content]" contendo o peso calculado
Usa data-pagefind-sort="ordem[content]" para ordenação no Pagefind

Exemplos de transformações:
  <meta content="2013" data-pagefind-filter="ano[content]" />
  →
  <meta content="2013" data-pagefind-filter="ano[content]" />
  <meta content="9013000100000000" data-pagefind-filter="ordem[content]" data-pagefind-sort="ordem[content]" />

Sistema de pesos para ordenação de atos normativos:
  - Extrai o tipo de ato do nome do arquivo (adct, cf, ce, decreto, decreto-judiciario, lei, lei-complementar, decreto-lei, in, resolucao, resolucao-cnj, provimento, portaria, oc)
  - Prioriza Constituição (cf, ce, adct) > Leis Federais (lei, lei-complementar, decreto-lei) > Leis Estaduais > Atos de Tribunais
  - Ordena por ano (descendente: 2025 > 2024 > ...)
  - Ordena por número do ato (descendente dentro do mesmo ano/tipo)
  
O cálculo de peso é independente do contexto geral, avaliando cada norma individualmente com base no arquivo.
"""

import os
import re
import sys
from pathlib import Path
from datetime import datetime

def extract_file_type(filename):
    """
    Extrai o tipo de ato normativo do nome do arquivo.
    
    Tipos reconhecidos:
    - cf: Constituição Federal
    - ce: Constituição Estadual
    - adct: Ato das Disposições Constitucionais Transitórias
    - decreto
    - decreto-judiciario
    - lei
    - lc: Lei Complementar (alias para lei-complementar)
    - decreto-lei
    - in: Instrução Normativa
    - inc: Instrução Normativa (alias para in)
    - resolucao
    - resolucao-cnj
    - provimento
    - portaria
    - oc: Ofício Circular
    
    Args:
        filename: Nome do arquivo (ex: lei-123-2025 ou lei-123-2025.html)
        
    Returns:
        str: Tipo de ato normativo encontrado, ou desconhecido se não identificado
    """
    filename_lower = filename.lower()
    
    # Lista de tipos em ordem de prioridade (mais específicos primeiro)
    # Tuplas: (padrao_busca, tipo_normalizado)
    type_patterns = [
        ('resolucao-cnj', 'resolucao-cnj'),
        ('decreto-judiciario', 'decreto-judiciario'),
        ('lei-complementar', 'lei-complementar'),
        ('lc-', 'lei-complementar'),  # Alias: lc (lei complementar)
        ('decreto-lei', 'decreto-lei'),
        ('adct', 'adct'),
        ('resolucao', 'resolucao'),
        ('decreto', 'decreto'),
        ('lei', 'lei'),
        ('inc-', 'in'),  # Alias: inc (instrucao normativa)
        ('in-', 'in'),
        ('ce-', 'ce'),  # Constituição Estadual
        ('ce', 'ce'),
        ('provimento', 'provimento'),
        ('portaria', 'portaria'),
        ('oc-', 'oc'),  # Ofício Circular
        ('oc', 'oc'),
        ('cf', 'cf'),
    ]
    
    for pattern, normalized_type in type_patterns:
        if pattern in filename_lower:
            return normalized_type
    
    return 'desconhecido'


def extract_year_and_number(filename):
    """
    Extrai o ano e número do ato do nome do arquivo.
    
    Suporta padrões como:
    - lei-3039-1956 (número-ano)
    - lei-3270-1957.html (número-ano com extensão)
    - lc-109-2001 (lei complementar)
    
    Args:
        filename: Nome do arquivo
        
    Returns:
        tuple: (year, number) ou (1900, 0) se não encontrado
    """
    # Remove extensão se houver
    name_without_ext = os.path.splitext(filename)[0]
    
    # Padrão: tipo-numero-ano (ex: lei-3039-1956)
    match = re.search(r'-(\d+)-(\d{4})$', name_without_ext)
    if match:
        number = int(match.group(1))
        year = int(match.group(2))
        return year, number
    
    # Se não encontrar, retorna padrão
    return 1900, 0


def calculate_normative_weight(filename, year=None, number=None):
    """
    Calcula um peso numérico para ordenação de atos normativos.
    
    Retorna um valor que permite ordenação descendente por:
    1. Constituição (cf, ce, adct) - prioridade máxima
    2. Leis Federais (lei, lei-complementar, decreto-lei)
    3. Leis Estaduais (não aplicável neste contexto)
    4. Atos de Tribunais (resolucao, resolucao-cnj, decreto-judiciario, provimento, in, portaria, oc)
    5. Ano (descendente: 2025 > 2024 > ...)
    6. Número do ato (descendente dentro do mesmo ano/tipo)
    
    O cálculo é independente do contexto geral, baseado apenas no arquivo individual.
    
    Args:
        filename: Nome do arquivo para extrair o tipo de ato
        year: Ano extraído do conteúdo (ex: 2025). Se None, extrai do nome do arquivo
        number: Número do ato extraído do conteúdo (ex: 109). Se None, extrai do nome do arquivo
        
    Returns:
        int: Peso calculado para ordenação (maior = mais prioritário)
    """
    
    file_type = extract_file_type(filename)
    
    # Se year ou number não foram fornecidos, tenta extrair do nome do arquivo
    if year is None or number is None:
        extracted_year, extracted_number = extract_year_and_number(filename)
        if year is None:
            year = extracted_year
        if number is None:
            number = extracted_number
    
    # Define pesos base para tipos de atos
    # Estrutura: peso_base * 10^15 + ano * 10^12 + tipo * 10^8 + número
    # Usa ano com multiplicador 10^12 para garantir prioridade absoluta sobre o número
    
    # Constituição Federal
    if file_type == 'cf':
        base_weight = 9 * (10**15)
        tipo_peso = 1
    
    # Constituição Estadual
    elif file_type == 'ce':
        base_weight = 8.5 * (10**15)
        tipo_peso = 1
    
    # Ato das Disposições Constitucionais Transitórias
    elif file_type == 'adct':
        base_weight = 8 * (10**15)
        tipo_peso = 1
    
    # Leis Federais (Lei, Lei Complementar, Decreto-Lei)
    elif file_type in ['lei', 'lei-complementar', 'decreto-lei']:
        base_weight = 7 * (10**15)
        if file_type == 'lei-complementar':
            tipo_peso = 3  # Lei Complementar tem prioridade dentro de leis
        elif file_type == 'decreto-lei':
            tipo_peso = 2  # Decreto-Lei
        else:
            tipo_peso = 1  # Lei comum
    
    # Decretos (genéricos)
    elif file_type == 'decreto':
        base_weight = 6 * (10**15)
        tipo_peso = 1
    
    # Resoluções (atos normativos de tribunais - colegiados, decisões, alterações regimentais)
    # Prioridade máxima entre atos de tribunais
    elif file_type == 'resolucao':
        base_weight = 5.5 * (10**15)
        tipo_peso = 1
    
    # Resolução CNJ (atos normativos do CNJ - mesma categoria que resoluções de tribunais)
    elif file_type == 'resolucao-cnj':
        base_weight = 5.5 * (10**15)
        tipo_peso = 2  # Ligeiramente acima de resoluções comuns
    
    # Decreto Judiciário (ato administrativo da Presidência)
    elif file_type == 'decreto-judiciario':
        base_weight = 5 * (10**15)
        tipo_peso = 1
    
    # Provimento (norma geral/correcional do Corregedor-Geral)
    elif file_type == 'provimento':
        base_weight = 4.5 * (10**15)
        tipo_peso = 1
    
    # Instrução Normativa (ato complementar/orientativo de execução)
    elif file_type == 'in':
        base_weight = 4 * (10**15)
        tipo_peso = 1
    
    # Portaria (ato operacional: determinações internas, designações, aplicação em casos concretos)
    elif file_type == 'portaria':
        base_weight = 3.5 * (10**15)
        tipo_peso = 1
    
    # Ofício Circular (menor prioridade)
    elif file_type == 'oc':
        base_weight = 3 * (10**15)
        tipo_peso = 1
    
    # Tipo desconhecido: trata como lei
    else:
        base_weight = 7 * (10**15)
        tipo_peso = 1
    
    # Calcula o peso final
    # Usa year com multiplicador 10^12 para ordenação descendente por ano (2025 > 2024 > 2022)
    # Garante que o ano sempre tem prioridade sobre o número
    # Usa number diretamente para ordenação descendente por número
    weight = base_weight + year * (10**12) + tipo_peso * (10**8) + number
    
    return int(weight)


def generate_log_filename():
    """
    Gera o nome do arquivo de log no padrão: YYYY MM DDD DD - LogSort.txt
    Exemplo: 2025 12 DEZ 17 - LogSort.txt
    
    Returns:
        str: Nome do arquivo de log
    """
    now = datetime.now()
    year = now.year
    month = now.month
    day = now.day
    
    # Nomes dos meses em português
    months_pt = {
        1: 'JAN', 2: 'FEV', 3: 'MAR', 4: 'ABR', 5: 'MAI', 6: 'JUN',
        7: 'JUL', 8: 'AGO', 9: 'SET', 10: 'OUT', 11: 'NOV', 12: 'DEZ'
    }
    
    month_name = months_pt[month]
    
    # Formato: YYYY MM DDD DD - LogSort.txt
    log_filename = f"{year} {month:02d} {month_name} {day:02d} - LogSort.txt"
    
    return log_filename


def update_html_files(folder_path):
    """
    Procura por arquivos .html na pasta e cria novo atributo para ordenação
    Lida com diferentes ordens de atributos
    Cria meta tag com data-pagefind-filter="ordem[content]" contendo o peso calculado
    Adiciona data-pagefind-sort="ordem[content]" para ordenação no Pagefind
    Remove duplicatas de atributos ordem[content]
    Gera um arquivo de log com os resultados
    """
    folder = Path(folder_path)
    
    if not folder.exists():
        error_msg = f"❌ Erro: Pasta '{folder_path}' não existe"
        print(error_msg)
        return False
    
    if not folder.is_dir():
        error_msg = f"❌ Erro: '{folder_path}' não é uma pasta"
        print(error_msg)
        return False
    
    # Encontra todos os arquivos .html
    html_files = list(folder.glob("*.html"))
    
    if not html_files:
        error_msg = f"⚠️  Nenhum arquivo .html encontrado em '{folder_path}'"
        print(error_msg)
        return False
    
    # Gera nome do arquivo de log
    log_filename = generate_log_filename()
    log_filepath = folder / log_filename
    
    # Abre arquivo de log para escrita
    log_file = open(log_filepath, 'w', encoding='utf-8')
    
    def log_print(message):
        """Imprime no console e escreve no arquivo de log"""
        print(message)
        log_file.write(message + '\n')
    
    try:
        log_print(f"🔍 Buscando arquivos HTML em: {os.path.abspath(folder_path)}\n")
        log_print(f"📁 Processando {len(html_files)} arquivo(s) HTML...\n")
        
        modified_count = 0
        not_modified_count = 0
        error_count = 0
        
        for html_file in html_files:
            try:
                # Lê o conteúdo do arquivo
                with open(html_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                original_content = content
                
                # Extrai ano e número do conteúdo HTML
                # Procura por meta tags com data-pagefind-filter="ano[content]"
                year_match = re.search(r'data-pagefind-filter="ano\[content\]"\s+content="(\d+)"', content)
                if not year_match:
                    year_match = re.search(r'content="(\d+)"\s+data-pagefind-filter="ano\[content\]"', content)
                
                year = int(year_match.group(1)) if year_match else None
                
                # Extrai número do ato (padrão número/ano ou primeiro número)
                number_match = re.search(r'(\d+)/(\d{4})', content)
                if number_match:
                    number = int(number_match.group(1))
                else:
                    number_match = re.search(r'(\d+)', content)
                    number = int(number_match.group(1)) if number_match else None
                
                # Calcula o peso (usa valores do HTML se disponíveis, senão extrai do nome)
                weight = calculate_normative_weight(html_file.name, year, number)
                weight_str = str(weight)
                
                # Remove qualquer meta tag de ordem[content] existente (duplicata)
                new_content = re.sub(r'\n?\s*<meta\s+[^>]*data-pagefind-filter="ordem\[content\]"[^>]*/?>', '', content)
                
                # Remove TODOS os data-pagefind-sort="ano[content]" da meta tag de ano (pode haver multiplos)
                new_content = re.sub(r'\s+data-pagefind-sort="ano\[content\]"', '', new_content)
                
                # Encontra a posição da meta tag de ano[content] para inserir a tag de ordem após ela
                ano_tag_match = re.search(r'<meta\s+[^>]*data-pagefind-filter="ano\[content\]"[^>]*/?>', new_content)
                
                if ano_tag_match:
                    # Posição após a tag de ano
                    insert_position = ano_tag_match.end()
                    
                    # Cria a nova meta tag com ordem[content] (sem indentacao extra)
                    new_ordem_tag = f'\n<meta content="{weight_str}" data-pagefind-filter="ordem[content]" data-pagefind-sort="ordem[content]" />'
                    
                    # Insere a nova tag de ordem após a tag de ano
                    new_content = new_content[:insert_position] + new_ordem_tag + new_content[insert_position:]
                
                # Se houve mudança, salva o arquivo
                if new_content != original_content:
                    with open(html_file, 'w', encoding='utf-8') as f:
                        f.write(new_content)
                    
                    modified_count += 1
                    year_str = str(year) if year else '?'
                    number_str = str(number) if number else '?'
                    log_print(f"✅ {html_file.name:40s} | Tipo: {extract_file_type(html_file.name):20s} | Ano: {year_str:>4s} | Número: {number_str:>8s} | Peso: {weight}")
                else:
                    not_modified_count += 1
                    log_print(f"⏭️  {html_file.name:40s} | Nenhuma alteração necessária")
            
            except Exception as e:
                error_count += 1
                log_print(f"❌ Erro ao processar {html_file.name}: {e}")
        
        log_print(f"\n{'='*120}")
        log_print(f"✨ Resumo da Execução:")
        log_print(f"   📝 Total de arquivos processados: {len(html_files)}")
        log_print(f"   ✅ Arquivos modificados: {modified_count}")
        log_print(f"   ⏭️  Arquivos sem alteração: {not_modified_count}")
        log_print(f"   ❌ Erros encontrados: {error_count}")
        log_print(f"{'='*120}")
        log_print(f"\n📄 Log salvo em: {log_filepath}")
        
    finally:
        log_file.close()
    
    return True

if __name__ == "__main__":
    # Se um argumento foi passado, usa como caminho da pasta
    if len(sys.argv) > 1:
        folder = sys.argv[1]
    else:
        # Caso contrário, usa a pasta atual
        folder = "."
    
    print(f"🔍 Buscando arquivos HTML em: {os.path.abspath(folder)}\n")
    update_html_files(folder)
