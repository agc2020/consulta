#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Orquestrador de updates para o projeto 'consulta'.

Mudanças desta versão:
- Slug agora é extraído APENAS do link de TÍTULO (não-badge) com href em /consulta/*.html
- Fonte oficial sempre extraída do <p class="ato-source"> do MESMO <article>
- Continua executando snapshot.py e html_para_json.py da mesma pasta do run_updates.py
- Saídas em ./update/

Fluxo por item:
  1) snapshot.py <url_oficial> <saida.html>
  2) html_para_json.py <saida.html> <saida.json>
  Fontes:
- index.html: extrai lista de atos, slugs e fontes oficiais. (lê <article.ato-line>)
- snapshot.py: captura HTML espelho.  (deve terminar antes do próximo passo)
- html_para_json.py: converte HTML espelho em JSON (usa classes do snapshot).

Uso:
  cd scripts
  python run_updates.py --all
  python run_updates.py --only lei-13709-2018,lei-13105-2015
  python run_updates.py --limit 5 --dry-run

Requisitos:
  - Este arquivo dentro de 'scripts/'
  - 'snapshot.py' e 'html_para_json.py' no mesmo diretório 'scripts/'
  - 'index.html' no diretório raiz do site (../index.html por padrão)

Opções:
  --all              Processa todos os atos encontrados.
  --only A,B,C       Processa apenas os slugs listados (sem extensão).
  --skip A,B,C       Ignora os slugs listados.
  --limit N          Limita a N itens (após filtros).
  --start-at SLUG    Começa a partir deste slug (inclusivo).
  --dry-run          Não executa subprocessos; apenas mostra o plano.
  --index PATH       Caminho customizado p/ index.html (default: ../index.html)

Saídas; gravação:
  - HTML:  <repo_root>/consulta/<slug>.html
  - JSON:  <repo_root>/consulta/<slug>.json
"""

from __future__ import annotations
import argparse
import sys
import subprocess
from pathlib import Path
from typing import List, Tuple, Dict, Optional
from bs4 import BeautifulSoup  # pip install beautifulsoup4
import re
from urllib.parse import urlparse

# --- Tudo relativo à pasta do próprio run_updates.py
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INDEX = SCRIPT_DIR / "index.html"
OUT_DIR = SCRIPT_DIR / "update"

SNAPSHOT = SCRIPT_DIR / "snapshot.py"
HTML2JSON = SCRIPT_DIR / "html_para_json.py"

BADGE_CLASS_PREFIX = "badge-"  # classes a ignorar na área do título (JSON/TXT/RAW)


def _slug_from_consulta_href(href: str) -> Optional[str]:
    """
    Recebe '/consulta/lei-13709-2018.html' e retorna 'lei-13709-2018'.
    """
    if not href:
        return None
    m = re.search(r'^/consulta/([^/]+)\.html$', href.strip())
    return m.group(1) if m else None


def _expected_domain_for_slug(slug: str) -> Optional[str]:
    """
    Heurística só para aviso em logs (não barra execução).
    """
    s = slug.lower()
    if "cnj" in s or s.startswith("resolucao-cnj"):
        return "atos.cnj.jus.br"
    if s.startswith(("decreto-judiciario", "in-", "inc-", "resolucao-")) and "cnj" not in s:
        return "tjpr.jus.br"
    if s.startswith(("lei-", "decreto-lei", "cf-")):
        return "planalto.gov.br"
    return None  # sem validação específica


def _first_title_anchor(art) -> Optional[object]:
    """
    Dentro do <h4 class="ato-title">, retorna o PRIMEIRO <a> que:
      - NÃO possui classe iniciando com 'badge-'
      - href começa com /consulta/ e termina com .html
    """
    title = art.select_one("h4.ato-title")
    if not title:
        return None
    for a in title.select("a[href]"):
        classes = a.get("class") or []
        is_badge = any((isinstance(c, str) and c.startswith(BADGE_CLASS_PREFIX)) for c in classes)
        href = (a.get("href") or "").strip()
        if not is_badge and re.match(r"^/consulta/[^/]+\.html$", href):
            return a
    return None


def _json_badge_anchor(art) -> Optional[object]:
    """
    Retorna o <a> da badge JSON, se existir (p/ fins de checagem opcional).
    """
    # preferencialmente classe 'badge-json'; fallback genérico .json
    a = art.select_one("h4.ato-title a.badge-json[href$='.json']")
    if a:
        return a
    return art.select_one("h4.ato-title a[href$='.json']")


def parse_index(index_path: Path) -> List[Dict]:
    """
    Constrói lista de itens:
    - slug: derivado do link de título (não-badge) em /consulta/*.html
    - title: texto do link de título
    - source_url: primeiro <a href> dentro de <p class="ato-source">
    - json_href: se badge existir; caso contrário, '/consulta/<slug>.json' (apenas p/ referência nos logs)
    """
    html = index_path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")

    items: List[Dict] = []

    for art in soup.select("article.ato-line"):
        a_title = _first_title_anchor(art)
        if not a_title:
            continue

        href_html = (a_title.get("href") or "").strip()
        slug = _slug_from_consulta_href(href_html)
        if not slug:
            continue

        title_text = a_title.get_text(" ", strip=True)

        # Fonte oficial: primeiro link dentro do <p class="ato-source">
        a_src = art.select_one("p.ato-source a[href]")
        source_url = (a_src.get("href").strip() if a_src else "")

        # Badge JSON apenas p/ referência/checagem
        a_json = _json_badge_anchor(art)
        json_href = (a_json.get("href").strip() if a_json else f"/consulta/{slug}.json")

        if not source_url:
            # Sem fonte oficial não executamos (não temos de onde fazer snapshot)
            continue

        items.append({
            "slug": slug,
            "title": title_text,
            "html_href": href_html,
            "json_href": json_href,
            "source_url": source_url,
        })

    return items


def build_paths_for_item(item: Dict) -> Tuple[Path, Path]:
    """
    Saídas em ./update/<slug>.html e ./update/<slug>.json
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = item["slug"]
    html_out = OUT_DIR / f"{slug}.html"
    json_out = OUT_DIR / f"{slug}.json"
    return html_out, json_out


def run_snapshot(source_url: str, html_out: Path) -> int:
    """
    Executa snapshot.py <url> <html_out>.
    """
    html_out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(SNAPSHOT), source_url, str(html_out)]
    print(f"▶ snapshot: {' '.join(cmd)}")
    proc = subprocess.run(cmd)
    return proc.returncode


def run_html2json(html_in: Path, json_out: Path) -> int:
    """
    Executa html_para_json.py <html_in> <json_out>.
    """
    json_out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(HTML2JSON), str(html_in), str(json_out)]
    print(f"▶ html2json: {' '.join(cmd)}")
    proc = subprocess.run(cmd)
    return proc.returncode


def main():
    ap = argparse.ArgumentParser(description="Atualiza espelhos HTML/JSON a partir do index.html")
    ap.add_argument("--all", action="store_true", help="Processa todos os itens")
    ap.add_argument("--only", type=str, default="", help="Lista de slugs separados por vírgula (sem extensão)")
    ap.add_argument("--skip", type=str, default="", help="Lista de slugs a ignorar")
    ap.add_argument("--limit", type=int, default=0, help="Limite de itens a processar")
    ap.add_argument("--start-at", type=str, default="", help="Começa a partir deste slug (inclusivo)")
    ap.add_argument("--dry-run", action="store_true", help="Apenas imprime o plano, não executa")
    ap.add_argument("--index", type=str, default=str(DEFAULT_INDEX), help="Caminho do index.html (default: ./index.html)")
    args = ap.parse_args()

    index_path = Path(args.index).resolve()
    if not index_path.exists():
        print(f"ERRO: index.html não encontrado em {index_path}")
        return 2

    if not SNAPSHOT.exists():
        print(f"ERRO: snapshot.py não encontrado em {SNAPSHOT}")
        return 2
    if not HTML2JSON.exists():
        print(f"ERRO: html_para_json.py não encontrado em {HTML2JSON}")
        return 2

    items = parse_index(index_path)
    if not items:
        print("Nada para processar (verifique se há .ato-line com fonte oficial).")
        return 0

    only = set([s.strip() for s in args.only.split(",") if s.strip()]) if args.only else set()
    skip = set([s.strip() for s in args.skip.split(",") if s.strip()]) if args.skip else set()

    # Ordenação previsível por slug
    items.sort(key=lambda it: it["slug"])

    # start-at
    if args.start_at:
        started = False
        filtered = []
        for it in items:
            if not started and it["slug"] == args.start_at:
                started = True
            if started:
                filtered.append(it)
        items = filtered

    # filtros only/skip
    if only:
        items = [it for it in items if it["slug"] in only]
    if skip:
        items = [it for it in items if it["slug"] not in skip]

    # limit
    if args.limit and args.limit > 0:
        items = items[:args.limit]

    if not items:
        print("Nenhum item após filtros.")
        return 0

    print(f"Encontrados {len(items)} item(s) para processar.\n")

    # Plano com checagens e avisos
    plan = []
    for it in items:
        slug = it["slug"]
        src = it["source_url"]
        title = it.get("title") or slug
        html_out, json_out = build_paths_for_item(it)
        plan.append((slug, title, src, html_out, json_out, it["json_href"]))

    for (slug, title, src, html_out, json_out, json_href_in_index) in plan:
        domain = urlparse(src).netloc.lower().replace("www.", "") if src else ""
        expected = _expected_domain_for_slug(slug) or "(qualquer)"
        warn_domain = ""
        if expected != "(qualquer)" and domain and expected not in domain:
            warn_domain = f"  ⚠️ fonte com domínio inesperado para slug ({expected} ≠ {domain})"

        # Checagem opcional: badge JSON aponta para o mesmo slug?
        slug_from_json = None
        m = re.search(r'^/consulta/([^/]+)\.json$', json_href_in_index or "")
        if m:
            slug_from_json = m.group(1)
        warn_json = ""
        if slug_from_json and slug_from_json != slug:
            warn_json = f"  ⚠️ badge JSON difere do slug do título ({slug_from_json} ≠ {slug})"

        print(f"- {slug} — {title}")
        print(f"  fonte: {src}  [{domain}]")
        if warn_domain:
            print(warn_domain)
        if warn_json:
            print(warn_json)
        print(f"  html : {html_out}")
        print(f"  json : {json_out}")

    if args.dry_run:
        print("\n(DRY-RUN) Nenhuma execução realizada.")
        return 0

    print("\nIniciando execuções...\n")

    processed = 0
    errors = 0
    for (slug, _title, src, html_out, json_out, _json_href_in_index) in plan:
        print("=" * 80)
        print(f"[{slug}] 1/2 snapshot")
        rc1 = run_snapshot(src, html_out)
        if rc1 != 0:
            errors += 1
            print(f"[{slug}] ERRO no snapshot (rc={rc1}). Pulando conversão JSON.")
            continue

        print(f"[{slug}] 2/2 html→json")
        rc2 = run_html2json(html_out, json_out)
        if rc2 != 0:
            errors += 1
            print(f"[{slug}] ERRO na conversão html→json (rc={rc2}).")
            continue

        processed += 1
        print(f"[{slug}] OK.")

    print("\nResumo:")
    print(f"- Processados com sucesso: {processed}")
    print(f"- Ocorrências com erro    : {errors}")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
