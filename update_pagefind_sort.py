#!/usr/bin/env python3
"""
Script para adicionar data-pagefind-sort aos arquivos HTML
Modifica tags meta com data-pagefind-filter="ano[content]" independentemente da ordem dos atributos

Exemplos de transformações:
  <meta data-pagefind-filter="ano[content]" content="2013" />
  →
  <meta data-pagefind-filter="ano[content]" data-pagefind-sort="ano[content]" content="2013" />

  <meta content="2013" data-pagefind-filter="ano[content]" />
  →
  <meta content="2013" data-pagefind-filter="ano[content]" data-pagefind-sort="ano[content]" />
"""

import os
import re
import sys
from pathlib import Path

def update_html_files(folder_path):
    """
    Procura por arquivos .html na pasta e modifica as tags de ano
    Lida com diferentes ordens de atributos
    """
    folder = Path(folder_path)
    
    if not folder.exists():
        print(f"❌ Erro: Pasta '{folder_path}' não existe")
        return False
    
    if not folder.is_dir():
        print(f"❌ Erro: '{folder_path}' não é uma pasta")
        return False
    
    # Encontra todos os arquivos .html
    html_files = list(folder.glob("*.html"))
    
    if not html_files:
        print(f"⚠️  Nenhum arquivo .html encontrado em '{folder_path}'")
        return False
    
    print(f"📁 Processando {len(html_files)} arquivo(s) HTML...\n")
    
    modified_count = 0
    
    for html_file in html_files:
        try:
            # Lê o conteúdo do arquivo
            with open(html_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            original_content = content
            
            # Padrão 1: data-pagefind-filter antes de content
            # <meta data-pagefind-filter="ano[content]" content="XXXX" />
            pattern1 = r'<meta\s+data-pagefind-filter="ano\[content\]"\s+content='
            replacement1 = r'<meta data-pagefind-filter="ano[content]" data-pagefind-sort="ano[content]" content='
            
            # Padrão 2: content antes de data-pagefind-filter
            # <meta content="XXXX" data-pagefind-filter="ano[content]" />
            pattern2 = r'<meta\s+content="([^"]+)"\s+data-pagefind-filter="ano\[content\]"'
            replacement2 = r'<meta content="\1" data-pagefind-filter="ano[content]" data-pagefind-sort="ano[content]"'
            
            # Padrão 3: Outras variações com espaços variáveis
            # Captura qualquer meta tag que contenha data-pagefind-filter="ano[content]" e content=
            # mas ainda não tenha data-pagefind-sort
            pattern3 = r'<meta\s+([^>]*?)data-pagefind-filter="ano\[content\]"([^>]*?)content=([^>]*?)(?<!data-pagefind-sort="ano\[content\]"\s)(/?>)'
            
            # Faz as substituições
            new_content = re.sub(pattern1, replacement1, content)
            new_content = re.sub(pattern2, replacement2, new_content)
            
            # Padrão 3 mais sofisticado: encontra meta tags com ano[content] que não têm sort
            def add_sort_to_meta(match):
                full_tag = match.group(0)
                # Se já tem data-pagefind-sort, não faz nada
                if 'data-pagefind-sort' in full_tag:
                    return full_tag
                # Caso contrário, adiciona antes do fechamento
                return full_tag.replace('/>', ' data-pagefind-sort="ano[content]" />')
            
            new_content = re.sub(
                r'<meta\s+[^>]*data-pagefind-filter="ano\[content\]"[^>]*>',
                add_sort_to_meta,
                new_content
            )
            
            # Se houve mudança, salva o arquivo
            if new_content != original_content:
                with open(html_file, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                
                modified_count += 1
                print(f"✅ {html_file.name}")
            else:
                print(f"⏭️  {html_file.name} (nenhuma alteração necessária)")
        
        except Exception as e:
            print(f"❌ Erro ao processar {html_file.name}: {e}")
    
    print(f"\n{'='*60}")
    print(f"✨ Resumo: {modified_count}/{len(html_files)} arquivo(s) modificado(s)")
    print(f"{'='*60}")
    
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
