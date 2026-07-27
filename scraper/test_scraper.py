"""Pruebas del almacenamiento del scraper.

Ejecutar desde la carpeta scraper:  python -m unittest
"""
import sqlite3
import tempfile
import unittest
from pathlib import Path

import db
from price_utils import parse_price


class PriceUtilsTest(unittest.TestCase):
    def test_formato_del_api(self):
        self.assertEqual(parse_price("$12.99 USD"), (12.99, "USD"))
        self.assertEqual(parse_price("$7.0 USD"), (7.0, "USD"))

    def test_separador_de_millares(self):
        self.assertEqual(parse_price("$1,299.00"), (1299.0, "USD"))
        self.assertEqual(parse_price("1.299,50 CUP"), (1299.5, "CUP"))
        self.assertEqual(parse_price("$1,250"), (1250.0, "USD"))

    def test_moneda(self):
        self.assertEqual(parse_price("400 CUP")[1], "CUP")
        self.assertEqual(parse_price("25 MLC")[1], "MLC")
        self.assertEqual(parse_price("€10")[1], "EUR")
        self.assertIsNone(parse_price("15")[1])

    def test_sin_importe(self):
        self.assertEqual(parse_price("consultar"), (None, None))
        self.assertEqual(parse_price(None), (None, None))
        self.assertEqual(parse_price(""), (None, None))


class StorageTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "test.db"
        db.init_db(self.path)
        self.conn = db.get_connection(self.path)
        db.upsert_tiendas(self.conn, [("Tienda", "https://ejemplo/tienda")])
        self.id_tienda = self.conn.execute(
            "SELECT ID FROM Tienda WHERE Link = ?", ("https://ejemplo/tienda",)
        ).fetchone()["ID"]

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def _guardar(self, productos):
        return db.upsert_productos(self.conn, self.id_tienda, productos)

    def test_esquema_incluye_columnas_nuevas(self):
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(Producto)")}
        self.assertLessEqual(
            {"Precio_Valor", "Precio_Moneda", "Primera_Vez", "Ultima_Vez", "Activo"},
            cols,
        )

    def test_guarda_importe_y_moneda(self):
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])
        fila = self.conn.execute(
            "SELECT Precio_Valor, Precio_Moneda FROM Producto WHERE Link = ?",
            ("https://ejemplo/p1",),
        ).fetchone()
        self.assertEqual(fila["Precio_Valor"], 2.5)
        self.assertEqual(fila["Precio_Moneda"], "USD")

    def test_segunda_pasada_actualiza_el_precio(self):
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])
        resultado = self._guardar(
            [{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$3.10 USD"}]
        )

        self.assertEqual(resultado["nuevos"], 0)
        self.assertEqual(resultado["actualizados"], 1)
        self.assertEqual(resultado["precios_cambiados"], 1)
        fila = self.conn.execute(
            "SELECT Precio_Valor FROM Producto WHERE Link = ?", ("https://ejemplo/p1",)
        ).fetchone()
        self.assertEqual(fila["Precio_Valor"], 3.10)

    def test_una_lectura_sin_precio_no_borra_el_anterior(self):
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": None}])

        fila = self.conn.execute(
            "SELECT Precio_Valor FROM Producto WHERE Link = ?", ("https://ejemplo/p1",)
        ).fetchone()
        self.assertEqual(fila["Precio_Valor"], 2.5)

    def test_los_anuncios_que_desaparecen_quedan_inactivos(self):
        self._guardar(
            [
                {"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"},
                {"nombre": "Aceite", "link": "https://ejemplo/p2", "precio": "$4.00 USD"},
            ]
        )
        retirados = db.desactivar_no_vistos(self.conn, self.id_tienda, ["https://ejemplo/p1"])

        self.assertEqual(retirados, 1)
        self.assertEqual(db.contar_productos(self.conn), 1)
        self.assertEqual(db.contar_productos(self.conn, solo_activos=False), 2)

    def test_un_anuncio_que_reaparece_vuelve_a_activarse(self):
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])
        db.desactivar_no_vistos(self.conn, self.id_tienda, ["https://ejemplo/otro"])
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])

        fila = self.conn.execute(
            "SELECT Activo FROM Producto WHERE Link = ?", ("https://ejemplo/p1",)
        ).fetchone()
        self.assertEqual(fila["Activo"], 1)

    def test_una_pasada_vacia_no_desactiva_nada(self):
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])
        self.assertEqual(db.desactivar_no_vistos(self.conn, self.id_tienda, []), 0)
        self.assertEqual(db.contar_productos(self.conn), 1)

    def test_marcar_completada_registra_el_conteo(self):
        db.marcar_tienda_completada(self.conn, self.id_tienda, 42)
        fila = self.conn.execute(
            "SELECT scrape_completada, Productos_Ultimo_Scrape, Ultimo_Scrape_At"
            " FROM Tienda WHERE ID = ?",
            (self.id_tienda,),
        ).fetchone()

        self.assertEqual(fila["scrape_completada"], 1)
        self.assertEqual(fila["Productos_Ultimo_Scrape"], 42)
        self.assertIsNotNone(fila["Ultimo_Scrape_At"])

    def test_scrape_fallido_deja_la_tienda_pendiente(self):
        db.registrar_scrape_fallido(self.conn, self.id_tienda)
        self.assertEqual(len(db.get_tiendas_pendientes(self.conn)), 1)

    def test_reabrir_tiendas_conserva_los_productos(self):
        self._guardar([{"nombre": "Arroz", "link": "https://ejemplo/p1", "precio": "$2.50 USD"}])
        db.marcar_tienda_completada(self.conn, self.id_tienda, 1)

        self.assertEqual(db.reabrir_todas_las_tiendas(self.conn), 1)
        self.assertEqual(len(db.get_tiendas_pendientes(self.conn)), 1)
        self.assertEqual(db.contar_productos(self.conn), 1)

    def test_upsert_de_tiendas_no_duplica(self):
        insertadas, ignoradas = db.upsert_tiendas(
            self.conn, [("Tienda Renombrada", "https://ejemplo/tienda")]
        )
        self.assertEqual((insertadas, ignoradas), (0, 1))
        self.assertEqual(db.contar_tiendas(self.conn), 1)
        nombre = self.conn.execute(
            "SELECT Nombre FROM Tienda WHERE ID = ?", (self.id_tienda,)
        ).fetchone()["Nombre"]
        self.assertEqual(nombre, "Tienda Renombrada")


class MigrationTest(unittest.TestCase):
    """La BD ya publicada no tiene las columnas nuevas: debe migrarse sola."""

    def test_migra_una_bd_antigua_y_rellena_los_precios(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "antigua.db"
            conn = sqlite3.connect(path)
            conn.executescript(
                """
                CREATE TABLE Tienda (
                    ID INTEGER PRIMARY KEY AUTOINCREMENT,
                    Nombre TEXT NOT NULL,
                    Link TEXT NOT NULL UNIQUE,
                    scrape_completada INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE Producto (
                    ID INTEGER PRIMARY KEY AUTOINCREMENT,
                    ID_tienda INTEGER NOT NULL,
                    Nombre TEXT NOT NULL,
                    Link TEXT NOT NULL UNIQUE,
                    Descripcion TEXT NOT NULL DEFAULT '',
                    Precio TEXT
                );
                INSERT INTO Tienda (Nombre, Link) VALUES ('T', 'https://ejemplo/t');
                INSERT INTO Producto (ID_tienda, Nombre, Link, Precio)
                VALUES (1, 'Arroz', 'https://ejemplo/p1', '$2.50 USD');
                """
            )
            conn.commit()
            conn.close()

            db.init_db(path)
            # Repetirla no debe fallar.
            db.init_db(path)

            with db.open_db(path) as conn:
                fila = conn.execute(
                    "SELECT Precio_Valor, Precio_Moneda, Activo, Primera_Vez"
                    " FROM Producto WHERE Link = ?",
                    ("https://ejemplo/p1",),
                ).fetchone()

            self.assertEqual(fila["Precio_Valor"], 2.5)
            self.assertEqual(fila["Precio_Moneda"], "USD")
            self.assertEqual(fila["Activo"], 1)
            self.assertIsNotNone(fila["Primera_Vez"])


if __name__ == "__main__":
    unittest.main()
