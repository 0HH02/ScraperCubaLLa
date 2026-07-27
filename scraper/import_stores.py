#!/usr/bin/env python3
"""Crea la BD SQLite e importa tiendas desde discovered_stores.json."""
import argparse
import json
import sys
from pathlib import Path

import settings
import db


def load_negocios(path: Path) -> list[tuple[str, str]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    tiendas: list[tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        link, nombre = item[0], item[1]
        if link and nombre:
            tiendas.append((str(nombre).strip(), str(link).strip()))
    return tiendas


def main() -> int:
    parser = argparse.ArgumentParser(description="Importar negocios a SQLite")
    parser.add_argument(
        "--json",
        type=Path,
        default=Path(__file__).parent / "discovered_stores.json",
        help="Archivo JSON con pares [url, nombre]",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=settings.DEFAULT_DB_PATH,
        help="Ruta del archivo SQLite",
    )
    args = parser.parse_args()

    if not args.json.is_file():
        print(f"No existe el archivo: {args.json}", file=sys.stderr)
        return 1

    tiendas = load_negocios(args.json)
    if not tiendas:
        print("No hay negocios para importar.", file=sys.stderr)
        return 1

    db.init_db(args.db)
    with db.open_db(args.db) as conn:
        insertadas, ignoradas = db.upsert_tiendas(conn, tiendas)
        total = db.contar_tiendas(conn)

    print(f"BD: {args.db.resolve()}")
    print(f"Leídos del JSON: {len(tiendas)}")
    print(f"Insertados: {insertadas} | Ya existían: {ignoradas}")
    print(f"Total en Tienda: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
