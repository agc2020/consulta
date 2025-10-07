#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Orquestrador de updates para o projeto 'consulta' (paths dinâmicos).

Mudanças desta versão:
- Base padrão = diretório de trabalho atual (CWD), não mais caminhos estáticos.
- Descoberta automática de index.html, snapshot.py e html_para_json.py procurando em:
  (1) CWD, (2) pasta do script, (3) pai da pasta do script.
- OUT_DIR padrão = ./update (relativo ao CWD).
- Mantido o fallback html→json apenas se o snapshot não gerar o JSON.
- Mantido o parsing do index.html (lista de <article class="ato-line">).

Uso típico:
  python run_updates.py --all
  python run_updates.py --only lei-13709-2018,lei-13105-2015
  python run_updates.py --limit 5 --dry-run
  python run_updates.py --index ./index.html

Opções:
  --all              Processa todos os atos encontrados.
  --only A,B,C       Processa apenas os slugs listados (sem extensão).
  --skip A,B,C       Ignora os slugs listados.
  --limit N          Limita a N itens (após filtros).
  --start-at SLUG    Começa a partir deste slug (inclusivo).
  --dry-run          Não executa subprocessos; apenas mostra o plano.
  --index PATH       Caminho do index.html (default: procura automática).
  --force-fallback   Força rodar html_para_json.py mesmo se o JSON já existir.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

from bs4 import BeautifulSoup  # pip install beautifulsoup4

# --------------------------------------------------------------------------------------
# Resolução dinâmica de caminhos
# --------------------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
CWD = Path.cwd()

BADGE_CLASS_PREFIX = "badge-"


# --------------------------------------------------------------------------------------
# Resolução de caminhos
# --------------------------------------------------------------------------------------

# --------------------- [post-compare helpers] ---------------------

import difflib
import shutil

_VOLATILE_JSON_KEYS = {"generated_at", "content_hash"}
_VOLATILE_JSON_PATHS = [
    ("processing_info", "statistics"),  # ex.: processamento pode oscilar
]

def _drop_volatile_json(d: dict) -> dict:
    # Remove chaves voláteis de 1º nível
    res = {}
    for k, v in d.items():
        if k in _VOLATILE_JSON_KEYS:
            continue
        res[k] = v
    # Remoções profundas opcionais
    try:
        pi = res.get("metadata", {}).get("processing_info", {})
        for path in _VOLATILE_JSON_PATHS:
            try:
                cur = res
                parents = path[:-1]
                leaf = path[-1]
                for p in parents:
                    if isinstance(cur, dict):
                        cur = cur.get(p, {})
                    else:
                        cur = {}
                if isinstance(cur, dict) and leaf in cur:
                    del cur[leaf]
            except Exception:
                pass
    except Exception:
        pass
    return res

_re_ws = re.compile(r"\s+", re.UNICODE)
_re_iso_like = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?")
_re_hash16 = re.compile(r"\b[a-f0-9]{8,16}\b", re.IGNORECASE)

def _normalize_html_or_txt(s: str) -> str:
    # Remove timestamps ISO e pequenos hashes recorrentes
    s = _re_iso_like.sub(" ", s)
    s = _re_hash16.sub(" ", s)
    # Colapsa espaços
    s = _re_ws.sub(" ", s).strip()
    return s

def _normalize_json_text(s: str) -> str:
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            obj = _drop_volatile_json(obj)
        s = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        # Se falhar o parse, aplica normalização genérica
        s = _normalize_html_or_txt(s)
    return s

def _normalize_for_compare(s: str, ext: str) -> str:
    ext = (ext or "").lower()
    if ext == ".json":
        return _normalize_json_text(s)
    else:
        return _normalize_html_or_txt(s)

_token_re = re.compile(r"\w+", re.UNICODE)

def _word_ratio(a: str, b: str) -> float:
    ta = _token_re.findall(a)
    tb = _token_re.findall(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return difflib.SequenceMatcher(None, ta, tb).ratio()

def _safe_replace(dst: Path, src: Path, backup: bool=False) -> None:
    dst_parent = dst.parent
    tmp = dst_parent / (dst.name + ".tmp")
    data = src.read_bytes()
    if backup and dst.exists():
        bak = dst.with_suffix(dst.suffix + ".bak")
        try:
            shutil.copy2(dst, bak)
        except Exception:
            pass
    tmp.write_bytes(data)
    tmp.replace(dst)

def _post_compare_and_replace(update_dir: Path, index_dir: Path, thr_html: float, thr_json: float, thr_txt: float, dry_run: bool, backup: bool) -> None:
    exts = (".html", ".json", ".txt")
    if not update_dir.exists():
        print("🔍 [post-check] pasta ./update inexistente — nada a comparar.")
        return
    files = sorted([p for p in update_dir.iterdir() if p.is_file() and p.suffix.lower() in exts])
    if not files:
        print("🔍 [post-check] nenhum arquivo em ./update para comparar.")
        return
    print("\n🔎 Pós-processamento: comparação com arquivos ao lado do index.html")
    for f in files:
        target = index_dir / f.name
        if not target.exists():
            print(f"   • {f.name}: alvo não existe em {index_dir.name} → mantido em update.")
            continue
        try:
            a = _normalize_for_compare(f.read_text(encoding='utf-8', errors='replace'), f.suffix.lower())
            b = _normalize_for_compare(target.read_text(encoding='utf-8', errors='replace'), target.suffix.lower())
            # Heurística rápida por tamanho
            la, lb = max(len(a), 1), max(len(b), 1)
            min_ratio_by_len = min(la, lb) / max(la, lb)
            if min_ratio_by_len < 0.60:
                ratio = 0.0
            else:
                ratio = _word_ratio(a, b)
            thr = thr_json if f.suffix.lower()==".json" else (thr_txt if f.suffix.lower()==".txt" else thr_html)
            status = "substituir" if ratio >= thr else "manter"
            print(f"   • {f.name}: similaridade={ratio:.3f} (thr={thr:.2f}) → {status}.")
            if ratio >= thr:
                if dry_run:
                    continue
                _safe_replace(target, f, backup=backup)
                # Após substituir no diretório do index, remover o arquivo da pasta ./update
                try:
                    f.unlink(missing_ok=True)
                    print(f"      ↳ removido de {update_dir.name}: {f.name}")
                except Exception as _del_e:
                    print(f"      ↳ aviso: não foi possível remover {f.name} de {update_dir.name} ({_del_e})")
            # caso contrário, mantemos no update para revisão manual
        except Exception as e:
            print(f"   • {f.name}: erro na comparação ({e}) — mantido em update.")
            
def first_existing(*candidates: Path) -> Optional[Path]:
    for p in candidates:
        if p and p.exists():
            return p.resolve()
    return None


def resolve_index_path(user_arg: Optional[str]) -> Path:
    """
    Se o usuário passou --index, usa-o. Caso contrário, tenta:
      1) ./index.html (CWD)
      2) SCRIPT_DIR/../index.html
      3) SCRIPT_DIR/index.html
    """

    if user_arg:
        p = Path(user_arg).expanduser().resolve()
        if not p.exists():
            print(f"ERRO: index.html não encontrado em {p}")
            sys.exit(2)
        return p

    candidate = first_existing(
        CWD / "index.html",
        SCRIPT_DIR.parent / "index.html",
        SCRIPT_DIR / "index.html",
    )
    if not candidate:
        print("ERRO: index.html não encontrado (tente usar --index PATH)")
        sys.exit(2)
    return candidate


def resolve_tool(name: str) -> Path:
    """
    Localiza snapshot.py e html_para_json.py nesta ordem:
    1) SCRIPT_DIR
    2) CWD
    3) SCRIPT_DIR.parent
    """
    candidate = first_existing(
        SCRIPT_DIR / name,
        CWD / name,
        SCRIPT_DIR.parent / name,
    )
    if not candidate:
        print(f"ERRO: {name} não encontrado (procurei em: {CWD}, {SCRIPT_DIR}, {SCRIPT_DIR.parent})")
        sys.exit(2)
    return candidate


def resolve_out_dir() -> Path:
    """
    Diretório de saída padrão: ./update (relativo ao CWD).
    """
    out = CWD / "update"
    out.mkdir(parents=True, exist_ok=True)
    return out


# --------------------------------------------------------------------------------------
# Utilidades
# --------------------------------------------------------------------------------------
def _json_valid_and_nonempty(path: Path) -> Tuple[bool, str]:
    if not path.exists():
        return False, "inexistente"
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").strip()
        if not raw:
            return False, "vazio"
        data = json.loads(raw)
        if not isinstance(data, dict):
            return False, "não é objeto JSON"
        meta = data.get("metadata")
        content = data.get("content")
        if not isinstance(meta, dict):
            return False, "metadata ausente/ inválido"
        if not isinstance(content, dict) or not isinstance(content.get("sections"), list):
            return False, "content.sections ausente/ inválido"
        return True, "ok"
    except Exception as e:
        return False, f"inválido: {e}"


def _file_nonempty(path: Path) -> bool:
    try:
        return path.exists() and path.stat().st_size > 0
    except Exception:
        return False


# --------------------------------------------------------------------------------------
# Parsing do index
# --------------------------------------------------------------------------------------
def _slug_from_consulta_href(href: str) -> Optional[str]:
    """
    Recebe '/consulta/lei-13709-2018.html' e retorna 'lei-13709-2018'.
    Aceita também 'lei-13709-2018.html' (relativo) por robustez.
    """
    if not href:
        return None
    href = href.strip()
    # formato absoluto no site
    m = re.search(r"^/consulta/([^/]+)\.html$", href)
    if m:
        return m.group(1)
    # formato relativo local
    m = re.search(r"^([^/\\]+)\.html$", href)
    if m:
        return m.group(1)
    return None


def _expected_domain_for_slug(slug: str) -> Optional[str]:
    """
    Heurística de domínio esperado pela natureza do slug.
    Usado apenas para avisos (não bloqueia execução).
    """
    s = slug.lower()
    if s.startswith("resolucao-cnj-"):
        return "atos.cnj.jus.br"
    if s.startswith("lei-"):
        return "planalto.gov.br"
    if s.startswith(("decreto-", "in-", "inc-", "instrucao-", "resolucao-")):
        return "tjpr.jus.br"
    return None


def parse_index(index_path: Path) -> List[Dict]:
    """
    Lê o index.html e retorna itens com:
      - slug
      - title
      - source_url (oficial)
      - json_href (do badge JSON, se presente — apenas para checagem)
    """
    html = index_path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")

    items: List[Dict] = []
    for article in soup.select("article.ato-line"):
        # Link principal do título (ignora badges JSON/TXT/RAW)
        a_title = None
        for a in article.select("h4.ato-title a[href]"):
            cls = (a.get("class") or [])
            if any((c or "").startswith(BADGE_CLASS_PREFIX) for c in cls):
                continue
            a_title = a
            break
        if not a_title:
            continue

        href = a_title.get("href") or ""
        slug = _slug_from_consulta_href(href)
        if not slug:
            continue

        # Fonte oficial no mesmo <article>
        p_src = article.select_one("p.ato-source a[href]")
        source_url = (p_src.get("href").strip() if p_src and p_src.get("href") else "")

        # Badge JSON (opcional — só para checagem visual)
        json_badge = None
        for a in article.select("h4.ato-title a[href]"):
            cls = (a.get("class") or [])
            if "badge-json" in cls:
                json_badge = a
                break
        json_href = json_badge.get("href") if json_badge else ""

        items.append(
            {
                "slug": slug,
                "title": a_title.get_text(strip=True),
                "source_url": source_url,
                "json_href": json_href,
            }
        )
    return items


# --------------------------------------------------------------------------------------
# Execução
# --------------------------------------------------------------------------------------
def build_paths_for_item(item: Dict) -> Tuple[Path, Path]:
    """
    Saídas em ./update/<slug>.html e ./update/<slug>.json (relativo ao CWD).
    """
    slug = item["slug"]
    html_out = CWD / "update" / f"{slug}.html"
    json_out = CWD / "update" / f"{slug}.json"
    html_out.parent.mkdir(parents=True, exist_ok=True)
    return html_out, json_out


def _run_with_timeout(cmd: List[str], timeout: int, label: str) -> int:
    try:
        return subprocess.run(cmd, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        print(f"❌ Tempo esgotado em {label} (timeout={timeout}s). Encerrando processo…")
        return 124
    except KeyboardInterrupt:
        print(f"❌ Execução interrompida por teclado durante {label}.")
        return 130
    except Exception as e:
        print(f"❌ Falha ao executar {label}: {e}")
        return 1


def run_snapshot(snapshot_py: Path, source_url: str, html_out: Path, timeout: int) -> int:
    cmd = [sys.executable, str(snapshot_py), source_url, str(html_out)]
    print(f"▶ snapshot: {' '.join(cmd)}")
    return _run_with_timeout(cmd, timeout, "snapshot")


def run_html2json(html2json_py: Path, html_in: Path, json_out: Path, timeout: int) -> int:
    """
    Executa: html_para_json.py <html_in> <json_out>
    Usado apenas como fallback.
    """
    cmd = [sys.executable, str(html2json_py), str(html_in), str(json_out)]
    print(f"▶ html2json (fallback): {' '.join(cmd)}")
    return _run_with_timeout(cmd, timeout, "html→json")


def _print_plan_line(slug: str, title: str, src: str, html_out: Path, json_out: Path, json_href_in_index: str) -> None:
    domain = urlparse(src).netloc.lower().replace("www.", "") if src else ""
    expected = _expected_domain_for_slug(slug) or "(qualquer)"
    warn_domain = ""
    if expected != "(qualquer)" and domain and expected not in domain:
        warn_domain = f"  ⚠️ domínio inesperado ({expected} ≠ {domain})"
    m = re.search(r"^/consulta/([^/]+)\.json$", json_href_in_index or "")
    slug_from_json = m.group(1) if m else None
    warn_json = ""
    if slug_from_json and slug_from_json != slug:
        warn_json = f"  ⚠️ badge JSON difere do slug ({slug_from_json} ≠ {slug})"

    print(f"- {slug} — {title}")
    print(f"  fonte: {src}  [{domain}]")
    if warn_domain:
        print(warn_domain)
    if warn_json:
        print(warn_json)
    print(f"  html : {html_out}")
    print(f"  json : {json_out}")


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="Atualiza espelhos HTML/JSON a partir do index.html (paths dinâmicos)")
    ap.add_argument("--all", action="store_true", help="Processa todos os itens")
    ap.add_argument("--only", type=str, default="", help="Lista de slugs separados por vírgula (sem extensão)")
    ap.add_argument("--skip", type=str, default="", help="Lista de slugs a ignorar")
    ap.add_argument("--limit", type=int, default=0, help="Limite de itens a processar")

    ap.add_argument("--start-at", type=str, default="", help="Começa a partir deste slug (inclusivo)")
    ap.add_argument("--dry-run", action="store_true", help="Apenas imprime o plano, não executa")
    ap.add_argument("--index", type=str, default="", help="Caminho do index.html (default: autodetect em CWD/…)")
    ap.add_argument("--timeout-snapshot", type=int, default=600, help="Timeout do snapshot (s)")
    ap.add_argument("--timeout-fallback", type=int, default=240, help="Timeout do html→json (s)")
    ap.add_argument("--force-fallback", action="store_true", help="Força rodar html_para_json.py mesmo se o JSON já existir")
    
    # Pós-processamento: comparação e substituição condicional
    ap.add_argument("--no-post-compare", action="store_true", help="Desativa a etapa de comparação pós-processamento")
    ap.add_argument("--threshold-html", type=float, default=0.95, help="Limite para substituição de HTML (default: 0.95)")
    ap.add_argument("--threshold-json", type=float, default=0.98, help="Limite para substituição de JSON (default: 0.98)")
    ap.add_argument("--threshold-txt", type=float, default=0.95, help="Limite para substituição de TXT (default: 0.95)")
    ap.add_argument("--backup", action="store_true", help="Cria .bak antes de substituir no diretório do index")
    args = ap.parse_args()

    index_path = resolve_index_path(args.index)
    snapshot_py = resolve_tool("snapshot.py")
    html2json_py = first_existing(
        SCRIPT_DIR / "html_para_json.py",
        CWD / "html_para_json.py",
        SCRIPT_DIR.parent / "html_para_json.py",
    )
    out_dir = resolve_out_dir()

    items = parse_index(index_path)
    if not items:
        print("Nada para processar (verifique se há <article class='ato-line'> com fonte oficial).")
        sys.exit(0)

    only = set([s.strip() for s in args.only.split(",") if s.strip()]) if args.only else set()
    skip = set([s.strip() for s in args.skip.split(",") if s.strip()]) if args.skip else set()

    # Ordenação previsível por slug
    items.sort(key=lambda it: it["slug"])

    # start-at
    if args.start_at:
        started = False
        filtered: List[Dict] = []
        for it in items:
            if not started and it["slug"] == args.start_at:
                started = True
            if started:
                filtered.append(it)
        items = filtered

    # only/skip
    if only:
        items = [it for it in items if it["slug"] in only]
    if skip:
        items = [it for it in items if it["slug"] not in skip]

    # limit
    if args.limit and args.limit > 0:
        items = items[: args.limit]

    if not items:
        print("Nenhum item após filtros.")
        sys.exit(0)

    print(f"Encontrados {len(items)} item(s) para processar.\n")

    # Plano
    plan: List[Tuple[str, str, str, Path, Path, str]] = []
    for it in items:
        slug = it["slug"]
        src = it["source_url"]
        title = it.get("title") or slug
        html_out, json_out = build_paths_for_item(it)
        plan.append((slug, title, src, html_out, json_out, it["json_href"]))

    for (slug, title, src, html_out, json_out, json_href_in_index) in plan:
        _print_plan_line(slug, title, src, html_out, json_out, json_href_in_index)

    if args.dry_run:
        print("\n(DRY-RUN) Nenhuma execução realizada.")
        sys.exit(0)

    print("\nIniciando execuções...\n")

    processed = 0
    errors = 0

    for (slug, _title, src, html_out, json_out, _json_href_in_index) in plan:
        print("=" * 80)
        print(f"[{slug}] 1/2 snapshot")

        rc1 = run_snapshot(snapshot_py, src, html_out, timeout=args.timeout_snapshot)
        if rc1 != 0:
            errors += 1
            print(f"[{slug}] ERRO no snapshot (rc={rc1}). Pulando conversão JSON.")
            continue

        # Sanidade: HTML gerado?
        if not _file_nonempty(html_out):
            errors += 1
            print(f"[{slug}] ERRO: snapshot terminou mas o HTML '{html_out}' não foi gerado/está vazio.")
            continue

        # Verificação do JSON gerado pelo snapshot (integridade, não só existência)
        ok, reason = _json_valid_and_nonempty(json_out)
        need_fallback = args.force_fallback or (not ok)

        if need_fallback:
            if not args.force_fallback:
                print(f"[{slug}] 2/2 html→json (fallback) — motivo: JSON {reason}.")
            else:
                print(f"[{slug}] 2/2 html→json (fallback) — forçado por argumento.")

            if not html2json_py:
                errors += 1
                print(f"[{slug}] ERRO: html_para_json.py não encontrado (fallback necessário).")
                continue

            rc2 = run_html2json(html2json_py, html_out, json_out, timeout=args.timeout_fallback)
            if rc2 != 0:
                errors += 1
                print(f"[{slug}] ERRO na conversão html→json (rc={rc2}).")
                continue

            ok_after, why_after = _json_valid_and_nonempty(json_out)
            if not ok_after:
                errors += 1
                print(f"[{slug}] ERRO: JSON gerado ainda inválido ({why_after}).")
                continue
        else:
            print(f"[{slug}] 2/2 html→json: pulado (JSON já gerado e válido)")

        processed += 1
        print(f"[{slug}] OK.")

    
    # Etapa 2: pós-processamento (comparação e substituição condicional)
    if not args.no_post_compare:
        try:
            index_dir = index_path.parent
            _post_compare_and_replace(
                update_dir=out_dir,
                index_dir=index_dir,
                thr_html=args.threshold_html,
                thr_json=args.threshold_json,
                thr_txt=args.threshold_txt,
                dry_run=args.dry_run,
                backup=args.backup
            )
        except Exception as _e_post:
            print(f"⚠️ [post-check] erro inesperado na etapa de comparação: {_e_post}")
            
    print("\nResumo:")
    print(f"- Processados com sucesso: {processed}")
    print(f"- Ocorrências com erro    : {errors}")

    sys.exit(0 if errors == 0 else 1)


if __name__ == "__main__":
    main()