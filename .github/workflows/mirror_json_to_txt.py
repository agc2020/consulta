#!/usr/bin/env python3
import os
import sys

# Raiz a partir da qual o Pages serve os arquivos (aqui, o próprio gh-pages)
ROOT = "."

def iter_json_files(root):
    for base, _dirs, files in os.walk(root):
        for f in files:
            if f.lower().endswith(".json"):
                yield os.path.join(base, f)

def ensure_txt_pair(json_path):
    txt_path = json_path[:-5] + ".txt"  # troca .json -> .txt
    # Se o txt já existe e está atualizado com o mesmo conteúdo, não reescreve
    try:
        with open(json_path, "r", encoding="utf-8") as jf:
            json_content = jf.read()
    except Exception as e:
        print(f"[WARN] Falha lendo {json_path}: {e}", file=sys.stderr)
        return False

    need_write = True
    if os.path.exists(txt_path):
        try:
            with open(txt_path, "r", encoding="utf-8") as tf:
                if tf.read() == json_content:
                    need_write = False
        except Exception as e:
            print(f"[WARN] Falha lendo {txt_path}: {e}", file=sys.stderr)

    if need_write:
        # Escreve como texto puro, idêntico ao JSON – sem parse.
        with open(txt_path, "w", encoding="utf-8", newline="\n") as tf:
            tf.write(json_content)
        print(f"[OK] Atualizado: {txt_path}")
        return True

    print(f"[SKIP] Sem mudanças: {txt_path}")
    return False

def main():
    changed = 0
    for jp in iter_json_files(ROOT):
        if ensure_txt_pair(jp):
            changed += 1
    print(f"[DONE] Arquivos .txt atualizados: {changed}")

if __name__ == "__main__":
    main()
