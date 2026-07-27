import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from price_utils import parse_price


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_connection(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def open_db(db_path: Path) -> Iterator[sqlite3.Connection]:
    """Abre la BD y la cierra al salir.

    El context manager de sqlite3 confirma la transacción pero deja el archivo
    abierto, lo que en Windows impide moverlo o borrarlo.
    """
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with open_db(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS Tienda (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                Nombre TEXT NOT NULL,
                Link TEXT NOT NULL UNIQUE,
                scrape_completada INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS Producto (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                ID_tienda INTEGER NOT NULL,
                Nombre TEXT NOT NULL,
                Link TEXT NOT NULL UNIQUE,
                Descripcion TEXT NOT NULL DEFAULT '',
                Precio TEXT,
                Precio_por_Magnitud TEXT,
                FOREIGN KEY (ID_tienda) REFERENCES Tienda(ID)
            );

            CREATE INDEX IF NOT EXISTS idx_tienda_scrape
                ON Tienda(scrape_completada);
            CREATE INDEX IF NOT EXISTS idx_producto_tienda
                ON Producto(ID_tienda);
            """
        )
        _migrate_db(conn)
        conn.commit()


def _add_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> bool:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column in cols:
        return False
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
    return True


def _migrate_db(conn: sqlite3.Connection) -> None:
    _add_column(conn, "Producto", "Precio_por_Magnitud", "Precio_por_Magnitud TEXT")

    # Importe y moneda ya interpretados, para que la web no tenga que adivinar.
    added_valor = _add_column(conn, "Producto", "Precio_Valor", "Precio_Valor REAL")
    _add_column(conn, "Producto", "Precio_Moneda", "Precio_Moneda TEXT")

    # Trazabilidad: permite detectar anuncios retirados y datos obsoletos.
    _add_column(conn, "Producto", "Primera_Vez", "Primera_Vez TEXT")
    _add_column(conn, "Producto", "Ultima_Vez", "Ultima_Vez TEXT")
    _add_column(conn, "Producto", "Activo", "Activo INTEGER NOT NULL DEFAULT 1")

    _add_column(conn, "Tienda", "Ultimo_Scrape_At", "Ultimo_Scrape_At TEXT")
    _add_column(
        conn,
        "Tienda",
        "Productos_Ultimo_Scrape",
        "Productos_Ultimo_Scrape INTEGER NOT NULL DEFAULT 0",
    )

    conn.execute("CREATE INDEX IF NOT EXISTS idx_producto_activo ON Producto(Activo)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_producto_link ON Producto(Link)")

    if added_valor:
        _backfill_precios(conn)

    conn.execute(
        "UPDATE Producto SET Primera_Vez = COALESCE(Primera_Vez, ?) WHERE Primera_Vez IS NULL",
        (_now(),),
    )


def _backfill_precios(conn: sqlite3.Connection) -> None:
    """Rellena importe/moneda de los productos ya guardados como texto."""
    filas = conn.execute(
        "SELECT ID, Precio FROM Producto WHERE Precio IS NOT NULL AND TRIM(Precio) != ''"
    ).fetchall()
    for fila in filas:
        valor, moneda = parse_price(fila["Precio"])
        if valor is None and moneda is None:
            continue
        conn.execute(
            "UPDATE Producto SET Precio_Valor = ?, Precio_Moneda = ? WHERE ID = ?",
            (valor, moneda, fila["ID"]),
        )


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def reset_productos_y_tiendas(conn: sqlite3.Connection) -> None:
    """Borra todos los productos y marca todas las tiendas como no visitadas."""
    conn.execute("DELETE FROM Producto")
    conn.execute(
        "UPDATE Tienda SET scrape_completada = 0, Ultimo_Scrape_At = NULL,"
        " Productos_Ultimo_Scrape = 0"
    )
    conn.commit()


def reabrir_todas_las_tiendas(conn: sqlite3.Connection) -> int:
    """Deja todas las tiendas pendientes sin borrar productos.

    Es la base del modo "actualizar precios": el upsert refrescará importes y
    marcará como inactivos los anuncios que ya no existan.
    """
    cur = conn.execute("UPDATE Tienda SET scrape_completada = 0")
    conn.commit()
    return cur.rowcount or 0


def clear_all_data(db_path: Path) -> tuple[int, int]:
    """Borra todas las tiendas y productos. Retorna (tiendas_borradas, productos_borrados)."""
    with open_db(db_path) as conn:
        n_tiendas = contar_tiendas(conn)
        n_productos = contar_productos(conn, solo_activos=False)
        conn.execute("DELETE FROM Producto")
        conn.execute("DELETE FROM Tienda")
        conn.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('Tienda', 'Producto')"
        )
        conn.commit()
    return n_tiendas, n_productos


def contar_tiendas_visitadas(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM Tienda WHERE scrape_completada = 1"
    ).fetchone()[0]


def upsert_tiendas(
    conn: sqlite3.Connection, tiendas: list[tuple[str, str]]
) -> tuple[int, int]:
    """Inserta tiendas nuevas y refresca el nombre de las existentes."""
    insertadas = 0
    ignoradas = 0
    for nombre, link in tiendas:
        nombre = nombre.strip()
        link = link.strip()
        if not link:
            continue

        existe = conn.execute(
            "SELECT ID FROM Tienda WHERE Link = ?", (link,)
        ).fetchone()

        if existe is None:
            conn.execute(
                "INSERT INTO Tienda (Nombre, Link) VALUES (?, ?)", (nombre, link)
            )
            insertadas += 1
        else:
            if nombre:
                conn.execute(
                    "UPDATE Tienda SET Nombre = ? WHERE ID = ?", (nombre, existe["ID"])
                )
            ignoradas += 1
    conn.commit()
    return insertadas, ignoradas


def upsert_productos(
    conn: sqlite3.Connection,
    id_tienda: int,
    productos: list[dict[str, Any]],
) -> dict[str, int]:
    """Inserta o actualiza productos. Retorna conteos por tipo de cambio.

    Antes se usaba INSERT OR IGNORE, así que el primer precio capturado quedaba
    congelado para siempre. Ahora cada pasada refresca precio, nombre y fecha de
    última vez visto.
    """
    ahora = _now()
    nuevos = 0
    actualizados = 0
    precios_cambiados = 0

    for p in productos:
        link = str(p.get("link") or "").strip()
        nombre = str(p.get("nombre") or "").strip()
        if not link or not nombre:
            continue

        precio_texto = _optional_text(p.get("precio"))
        valor, moneda = parse_price(precio_texto)
        descripcion = (p.get("descripcion") or "").strip()
        por_magnitud = _optional_text(p.get("precio_por_magnitud"))

        previo = conn.execute(
            "SELECT ID, Precio_Valor, Precio_Moneda FROM Producto WHERE Link = ?",
            (link,),
        ).fetchone()

        if previo is None:
            conn.execute(
                """
                INSERT INTO Producto
                    (ID_tienda, Nombre, Link, Descripcion, Precio, Precio_por_Magnitud,
                     Precio_Valor, Precio_Moneda, Primera_Vez, Ultima_Vez, Activo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    id_tienda,
                    nombre,
                    link,
                    descripcion,
                    precio_texto,
                    por_magnitud,
                    valor,
                    moneda,
                    ahora,
                    ahora,
                ),
            )
            nuevos += 1
            continue

        if valor is not None and previo["Precio_Valor"] != valor:
            precios_cambiados += 1

        # Solo se pisan los campos con dato nuevo: una lectura parcial del DOM
        # no debe borrar información buena capturada antes.
        conn.execute(
            """
            UPDATE Producto SET
                ID_tienda = ?,
                Nombre = ?,
                Descripcion = CASE WHEN ? != '' THEN ? ELSE Descripcion END,
                Precio = COALESCE(?, Precio),
                Precio_por_Magnitud = COALESCE(?, Precio_por_Magnitud),
                Precio_Valor = COALESCE(?, Precio_Valor),
                Precio_Moneda = COALESCE(?, Precio_Moneda),
                Ultima_Vez = ?,
                Activo = 1
            WHERE ID = ?
            """,
            (
                id_tienda,
                nombre,
                descripcion,
                descripcion,
                precio_texto,
                por_magnitud,
                valor,
                moneda,
                ahora,
                previo["ID"],
            ),
        )
        actualizados += 1

    conn.commit()
    return {
        "nuevos": nuevos,
        "actualizados": actualizados,
        "precios_cambiados": precios_cambiados,
    }


def desactivar_no_vistos(
    conn: sqlite3.Connection, id_tienda: int, links_vistos: Iterable[str]
) -> int:
    """Marca como inactivos los productos de la tienda que ya no aparecen.

    No se borran para conservar el histórico, pero la web deja de compararlos.
    """
    vistos = [str(link).strip() for link in links_vistos if str(link).strip()]
    if not vistos:
        return 0

    marcadores = ",".join("?" for _ in vistos)
    cur = conn.execute(
        f"""
        UPDATE Producto SET Activo = 0
        WHERE ID_tienda = ? AND Activo = 1 AND Link NOT IN ({marcadores})
        """,
        (id_tienda, *vistos),
    )
    conn.commit()
    return cur.rowcount or 0


# Compatibilidad con llamadas antiguas.
def insert_productos(
    conn: sqlite3.Connection,
    id_tienda: int,
    productos: list[dict[str, Any]],
) -> int:
    resultado = upsert_productos(conn, id_tienda, productos)
    return resultado["nuevos"]


def get_tiendas_pendientes(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT ID, Nombre, Link
        FROM Tienda
        WHERE scrape_completada = 0
        ORDER BY ID
        """
    ).fetchall()


def marcar_tienda_completada(
    conn: sqlite3.Connection, id_tienda: int, productos_encontrados: int = 0
) -> None:
    conn.execute(
        """
        UPDATE Tienda
        SET scrape_completada = 1,
            Ultimo_Scrape_At = ?,
            Productos_Ultimo_Scrape = ?
        WHERE ID = ?
        """,
        (_now(), int(productos_encontrados), id_tienda),
    )
    conn.commit()


def registrar_scrape_fallido(conn: sqlite3.Connection, id_tienda: int) -> None:
    """Deja constancia del intento sin marcar la tienda como completada."""
    conn.execute(
        "UPDATE Tienda SET Ultimo_Scrape_At = ?, Productos_Ultimo_Scrape = 0 WHERE ID = ?",
        (_now(), id_tienda),
    )
    conn.commit()


def compactar(db_path: Path) -> tuple[int, int]:
    """Compacta la BD antes de versionarla. Retorna (bytes_antes, bytes_después)."""
    antes = db_path.stat().st_size if db_path.is_file() else 0
    conn = get_connection(db_path)
    try:
        conn.execute("ANALYZE")
        conn.commit()
        # VACUUM necesita ejecutarse fuera de una transacción.
        conn.isolation_level = None
        conn.execute("VACUUM")
    finally:
        conn.close()
    despues = db_path.stat().st_size if db_path.is_file() else 0
    return antes, despues


def contar_tiendas(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM Tienda").fetchone()[0]


def contar_productos(conn: sqlite3.Connection, *, solo_activos: bool = True) -> int:
    sql = "SELECT COUNT(*) FROM Producto"
    if solo_activos:
        sql += " WHERE Activo = 1"
    return conn.execute(sql).fetchone()[0]
