#!/bin/bash
# Lanzador macOS: doble clic abre Terminal y ejecuta run_pipeline.py
# (mismo flujo que Iniciar_Scraper.bat: menú nueva/continuar, scrape, GitHub).
set -o pipefail

cd "$(dirname "$0")" || exit 1

export LANG="${LANG:-es_ES.UTF-8}"
export LC_ALL="${LC_ALL:-es_ES.UTF-8}"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Scraper Cuballama — Pipeline (macOS)"
echo "══════════════════════════════════════════════════════════════"
echo ""

PYTHON=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON="python"
fi

if [ -z "$PYTHON" ]; then
    echo "[ERROR] No se encontró Python 3.11+."
    echo "Instálalo con Homebrew: brew install python@3.12"
    echo "O desde: https://www.python.org/downloads/macos/"
    read -r -p "Pulsa Enter para cerrar..."
    exit 1
fi

"$PYTHON" run_pipeline.py
EXIT_CODE=$?

echo ""
if [ "$EXIT_CODE" -ne 0 ]; then
    echo "El proceso terminó con errores (código $EXIT_CODE)."
else
    echo "Proceso completado."
fi
read -r -p "Pulsa Enter para cerrar..."
exit "$EXIT_CODE"
