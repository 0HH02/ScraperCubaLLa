#!/usr/bin/env python3
"""
Pipeline completo: dependencias → BD → tiendas → productos → GitHub.
Pensado para ejecutarse con doble clic vía Iniciar_Scraper.bat.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import settings
import db
from cuballama_scraper import run_scraper

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
REQUIREMENTS = ROOT / "requirements.txt"
DB_PATH = settings.DEFAULT_DB_PATH
GIT_REMOTE = "origin"
GIT_BRANCH = "main"
TOTAL_STEPS = 5

# ── Colores ANSI ──────────────────────────────────────────────────────────────
R = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
MAGENTA = "\033[95m"
BLUE = "\033[94m"


def _enable_ansi() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        kernel32.GetConsoleMode(handle, ctypes.byref(mode))
        kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def _c(text: str, color: str) -> str:
    return f"{color}{text}{R}"


def _line(char: str = "─", width: int = 62) -> None:
    print(_c(char * width, DIM))


def _banner() -> None:
    os.system("cls" if sys.platform == "win32" else "clear")
    print()
    print(_c("  ╔══════════════════════════════════════════════════════════╗", CYAN))
    print(_c("  ║       SCRAPER CUBALLAMA — PIPELINE AUTOMÁTICO           ║", CYAN + BOLD))
    print(_c("  ╚══════════════════════════════════════════════════════════╝", CYAN))
    print(_c(f"  {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}", DIM))
    print()


def _step_header(num: int, title: str) -> None:
    print()
    _line("═")
    print(
        _c(f"  PASO {num}/{TOTAL_STEPS}  ", MAGENTA + BOLD)
        + _c(title, BOLD)
    )
    _line("═")
    print()


def _info(msg: str) -> None:
    print(_c("  ► ", BLUE) + msg)


def _ok(msg: str) -> None:
    print(_c("  ✔ ", GREEN) + msg)


def _warn(msg: str) -> None:
    print(_c("  ⚠ ", YELLOW) + msg)


def _err(msg: str) -> None:
    print(_c("  ✖ ", RED) + msg)


def _sub(msg: str) -> None:
    print(_c("      ", DIM) + msg)


def _progress_bar(current: int, total: int, label: str = "", width: int = 40) -> None:
    if total <= 0:
        return
    pct = min(1.0, current / total)
    filled = int(width * pct)
    bar = "█" * filled + "░" * (width - filled)
    pct_txt = f"{pct * 100:5.1f}%"
    line = f"  [{bar}] {pct_txt}"
    if label:
        line += f"  {label}"
    print(_c(line, CYAN), end="\r", flush=True)
    if current >= total:
        print()


def _run_stream(cmd: list[str], *, label: str) -> None:
    _info(f"Ejecutando: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        text = line.rstrip()
        if text:
            _sub(text)
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"{label} falló (código {code})")


def _find_python() -> str:
    for candidate in (sys.executable, "py", "python", "python3"):
        if candidate == sys.executable or shutil.which(candidate):
            if candidate == sys.executable:
                return sys.executable
            path = shutil.which(candidate)
            if path:
                return path
    raise RuntimeError("No se encontró Python en el PATH.")


def _python_version_ok(python: str) -> bool:
    result = subprocess.run(
        [python, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if result.returncode != 0:
        return False
    try:
        major, minor = map(int, result.stdout.strip().split("."))
        return (major, minor) >= (3, 11)
    except ValueError:
        return False


def _module_installed(python: str, module: str) -> bool:
    r = subprocess.run(
        [python, "-c", f"import {module}"],
        capture_output=True,
        cwd=ROOT,
    )
    return r.returncode == 0


def _playwright_chromium_ready(python: str) -> bool:
    r = subprocess.run(
        [
            python,
            "-c",
            "from playwright.sync_api import sync_playwright; "
            "p = sync_playwright().start(); "
            "b = p.chromium.launch(headless=True); "
            "b.close(); p.stop()",
        ],
        capture_output=True,
        cwd=ROOT,
        timeout=120,
    )
    return r.returncode == 0


def step_check_and_install_deps(python: str) -> None:
    _step_header(1, "Verificar e instalar dependencias")

    ver_out = subprocess.run(
        [python, "--version"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    version_str = (ver_out.stdout or ver_out.stderr or "").strip()
    _info(f"Python detectado: {version_str}")

    if not _python_version_ok(python):
        raise RuntimeError("Se requiere Python 3.11 o superior.")

    _ok("Versión de Python compatible")

    tasks = [
        ("pip", "Actualizar pip", [python, "-m", "pip", "install", "--upgrade", "pip", "-q"]),
        (
            "requirements",
            "Paquetes de requirements.txt",
            [python, "-m", "pip", "install", "-r", str(REQUIREMENTS)],
        ),
    ]

    for i, (key, desc, cmd) in enumerate(tasks, 1):
        _progress_bar(i - 1, len(tasks) + 1, desc)
        _info(desc + "...")
        _run_stream(cmd, label=desc)
        _ok(desc)
        _progress_bar(i, len(tasks) + 1, desc)

    if _playwright_chromium_ready(python):
        _ok("Playwright Chromium ya está instalado y operativo")
    else:
        _info("Instalando navegador Chromium para Playwright...")
        _run_stream(
            [python, "-m", "playwright", "install", "chromium"],
            label="playwright install chromium",
        )
        _ok("Chromium instalado")

    if not _module_installed(python, "playwright"):
        raise RuntimeError("Playwright no quedó instalado correctamente.")

    _progress_bar(len(tasks) + 1, len(tasks) + 1, "Listo")
    _ok("Todas las dependencias están listas")


def step_choose_execution_mode() -> str:
    """Pregunta si nueva ejecución (borra todo) o continuar la última."""
    print()
    _line("═")
    print(_c("  MODO DE EJECUCIÓN", MAGENTA + BOLD))
    _line("═")
    print()

    with db.get_connection(DB_PATH) as conn:
        n_tiendas = db.contar_tiendas(conn)
        n_productos = db.contar_productos(conn)
        visitadas = db.contar_tiendas_visitadas(conn)
        pendientes = db.get_tiendas_pendientes(conn)
        primera = pendientes[0] if pendientes else None

    print(_c("  [1]  Nueva ejecución", BOLD))
    print(_c("       Borra todas las tiendas y productos y empieza de cero.", DIM))
    print()
    print(_c("  [2]  Continuar última ejecución", BOLD))
    print(_c("       Conserva la BD. Solo scrapea productos de tiendas no visitadas.", DIM))
    if primera:
        print(
            _c(f"       Siguiente tienda pendiente: {primera['Nombre']}", DIM)
        )
    print()

    if n_tiendas > 0:
        print(_c("  Estado actual de la BD:", DIM))
        _sub(f"Tiendas: {n_tiendas}  |  Visitadas: {visitadas}  |  Pendientes: {len(pendientes)}")
        _sub(f"Productos: {n_productos}")
        print()

    while True:
        try:
            choice = input(
                _c("  Elige una opción [1/2]: ", CYAN + BOLD)
            ).strip()
        except EOFError:
            choice = "2" if n_tiendas > 0 else "1"

        if choice == "1":
            if n_tiendas > 0 or n_productos > 0:
                _warn(
                    f"Se eliminarán {n_tiendas} tiendas y {n_productos} productos."
                )
                confirm = input(
                    _c("  ¿Confirmar borrado? (s/N): ", YELLOW)
                ).strip().lower()
                if confirm not in ("s", "si", "sí", "y", "yes"):
                    _info("Cancelado. Vuelve a elegir.")
                    continue
                borradas_t, borrados_p = db.clear_all_data(DB_PATH)
                _ok(
                    f"BD vaciada: {borradas_t} tiendas y {borrados_p} productos eliminados"
                )
            else:
                _ok("BD ya estaba vacía — empezando de cero")
            print()
            _ok("Modo seleccionado: NUEVA ejecución")
            return "fresh"

        if choice == "2":
            if n_tiendas == 0:
                _warn("No hay tiendas en la BD; se usará nueva ejecución.")
                return "fresh"
            print()
            _ok("Modo seleccionado: CONTINUAR ejecución")
            _info(
                f"Se ignoran {visitadas} tienda(s) ya visitadas; "
                f"pendientes: {len(pendientes)}"
            )
            return "continue"

        _err("Opción no válida. Escribe 1 o 2.")


def step_ensure_database() -> None:
    _step_header(2, "Base de datos SQLite")

    existed = DB_PATH.is_file()
    if existed:
        size_kb = DB_PATH.stat().st_size / 1024
        _info(f"BD encontrada: {DB_PATH.name} ({size_kb:.1f} KB)")
    else:
        _warn(f"No existe {DB_PATH.name}; se creará ahora")

    db.init_db(DB_PATH)
    _ok("Esquema de base de datos verificado")

    with db.get_connection(DB_PATH) as conn:
        n_tiendas = db.contar_tiendas(conn)
        n_productos = db.contar_productos(conn)
        pendientes = len(db.get_tiendas_pendientes(conn))

    print()
    print(_c("  ┌─────────────────────────────────────┐", DIM))
    print(_c(f"  │  Tiendas en BD      : {n_tiendas:>6}          │", DIM))
    print(_c(f"  │  Productos en BD    : {n_productos:>6}          │", DIM))
    print(_c(f"  │  Tiendas pendientes : {pendientes:>6}          │", DIM))
    print(_c("  └─────────────────────────────────────┘", DIM))

    if not existed:
        _ok("Base de datos creada correctamente")
    else:
        _ok("Base de datos lista para usar")


def _setup_scraper_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )


def step_scrape_stores(mode: str) -> None:
    if mode == "continue":
        _step_header(3, "Scraping de TIENDAS — omitido (modo continuar)")
        _info("Las tiendas ya guardadas se conservan sin cambios.")
        _info("Puedes añadir tiendas nuevas ejecutando una nueva ejecución [1].")
        return

    _step_header(3, "Scraping de TIENDAS (navegador visible)")
    _info("Modo: nueva ejecución — --solo-tiendas --headed")
    _warn("No cierres la ventana del navegador hasta que termine esta fase")
    print()

    _setup_scraper_logging()
    t0 = time.perf_counter()
    run_scraper(DB_PATH, solo_tiendas=True, solo_productos=False, headless=False)
    elapsed = time.perf_counter() - t0

    with db.get_connection(DB_PATH) as conn:
        total = db.contar_tiendas(conn)

    print()
    _ok(f"Tiendas actualizadas en BD — total: {total} ({elapsed:.0f}s)")


def step_scrape_products(mode: str) -> None:
    _step_header(4, "Scraping de PRODUCTOS (navegador visible)")
    _info("Modo: --solo-productos --headed")

    with db.get_connection(DB_PATH) as conn:
        filas = db.get_tiendas_pendientes(conn)
        pendientes = len(filas)
        visitadas = db.contar_tiendas_visitadas(conn)

    if mode == "continue":
        _info(
            f"Continuar: {visitadas} tienda(s) visitadas se ignoran; "
            f"{pendientes} pendiente(s)"
        )
        if filas:
            _info(f"Empezando por: {filas[0]['Nombre']}")

    if pendientes == 0:
        _warn("No hay tiendas pendientes; se omitirá el scraping de productos.")
        return

    _info(f"Tiendas por procesar: {pendientes}")
    _warn("No cierres la ventana del navegador hasta que termine esta fase")
    print()

    _setup_scraper_logging()
    t0 = time.perf_counter()
    run_scraper(DB_PATH, solo_tiendas=False, solo_productos=True, headless=False)
    elapsed = time.perf_counter() - t0

    with db.get_connection(DB_PATH) as conn:
        total_p = db.contar_productos(conn)
        aún_pend = len(db.get_tiendas_pendientes(conn))

    print()
    _ok(f"Productos en BD: {total_p} | Pendientes restantes: {aún_pend} ({elapsed:.0f}s)")


def step_push_to_github() -> None:
    _step_header(5, "Subir cambios a GitHub (incluye la BD)")

    if not shutil.which("git"):
        raise RuntimeError("Git no está instalado o no está en el PATH.")

    if not (PROJECT_ROOT / ".git").is_dir():
        raise RuntimeError("Este directorio no es un repositorio Git.")

    _info("Añadiendo archivos al staging...")
    subprocess.run(["git", "add", "-A"], cwd=PROJECT_ROOT, check=True)

    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    changes = [ln for ln in status.stdout.splitlines() if ln.strip()]

    if not changes:
        _warn("No hay cambios locales que commitear.")
    else:
        print()
        _info(f"Archivos modificados/nuevos: {len(changes)}")
        for line in changes[:12]:
            _sub(line)
        if len(changes) > 12:
            _sub(f"... y {len(changes) - 12} más")

        msg = f"Actualizar datos scrapeados — {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        _info("Creando commit...")
        subprocess.run(["git", "commit", "-m", msg], cwd=PROJECT_ROOT, check=True)
        _ok(f"Commit creado: {msg}")

    _info(f"Enviando a {GIT_REMOTE}/{GIT_BRANCH}...")
    push = subprocess.run(
        ["git", "push", GIT_REMOTE, GIT_BRANCH],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )
    if push.returncode != 0:
        err = (push.stderr or push.stdout or "").strip()
        raise RuntimeError(f"git push falló:\n{err}")

    _ok("Cambios subidos a GitHub correctamente")
    if DB_PATH.is_file():
        _sub(f"BD incluida: {DB_PATH.name} ({DB_PATH.stat().st_size / 1024:.1f} KB)")


def _finale(success: bool) -> None:
    print()
    _line("═")
    if success:
        print(_c("  ★ PIPELINE COMPLETADO CON ÉXITO ★", GREEN + BOLD))
    else:
        print(_c("  ★ PIPELINE FINALIZADO CON ERRORES ★", RED + BOLD))
    _line("═")
    print()


def main() -> int:
    _enable_ansi()
    _banner()

    python = _find_python()
    _info(f"Ejecutable: {python}")

    try:
        step_check_and_install_deps(python)
        step_ensure_database()
        mode = step_choose_execution_mode()
        step_scrape_stores(mode)
        step_scrape_products(mode)
        step_push_to_github()
        _finale(True)
        return 0
    except KeyboardInterrupt:
        print()
        _warn("Proceso interrumpido por el usuario.")
        _finale(False)
        return 130
    except Exception as exc:
        print()
        _err(str(exc))
        _finale(False)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
