#!/usr/bin/env python3
import argparse
import logging
import sys
from pathlib import Path

import settings
from cuballama_scraper import run_scraper


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scraper Cuballama Mercado (Playwright + SQLite)"
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=settings.DEFAULT_DB_PATH,
        help="Ruta del archivo SQLite",
    )
    parser.add_argument(
        "--solo-tiendas",
        action="store_true",
        help="Solo extraer tiendas de la sección Todos los Negocios",
    )
    parser.add_argument(
        "--solo-productos",
        action="store_true",
        help="Solo scrapear productos (tiendas ya en la BD)",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Mostrar navegador (útil para depurar selectores)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Logging detallado",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.solo_tiendas and args.solo_productos:
        print("No puedes usar --solo-tiendas y --solo-productos a la vez.", file=sys.stderr)
        return 1

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        run_scraper(
            args.db,
            solo_tiendas=args.solo_tiendas,
            solo_productos=args.solo_productos,
            headless=not args.headed,
        )
    except KeyboardInterrupt:
        print("\nInterrumpido. Puedes reanudar ejecutando de nuevo el mismo comando.")
        return 130
    except Exception as exc:
        logging.exception("Error fatal: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
