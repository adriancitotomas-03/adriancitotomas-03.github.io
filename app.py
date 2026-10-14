import sqlite3
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = BASE_DIR / "database.db"
VALID_STATUSES = {"preparacion", "en-transito", "en-reparto", "entregado", "incidencia"}
SHIPMENT_FIELDS = {
    "trackingCode": "tracking_code",
    "recipient": "recipient",
    "address": "address",
    "status": "status",
    "packageType": "package_type",
    "pin": "pin",
    "lat": "lat",
    "lon": "lon",
    "origin": "origin",
    "estimatedDelivery": "estimated_delivery",
}

app = Flask(__name__, static_folder=None)


def get_db_connection():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def shipment_to_json(row):
    return {
        "id": row["id"],
        "trackingCode": row["tracking_code"],
        "recipient": row["recipient"],
        "address": row["address"],
        "status": row["status"],
        "packageType": row["package_type"],
        "pin": row["pin"],
        "lat": row["lat"],
        "lon": row["lon"],
        "origin": row["origin"],
        "estimatedDelivery": row["estimated_delivery"],
    }


def validate_shipment_payload(payload, partial=False):
    if not isinstance(payload, dict):
        return None, "El cuerpo de la solicitud debe ser un objeto JSON."

    values = {field: payload[field] for field in SHIPMENT_FIELDS if field in payload}
    required = {"trackingCode", "recipient", "address", "status", "packageType", "pin", "lat", "lon"}
    if not partial:
        missing = sorted(required - values.keys())
        if missing:
            return None, f"Faltan campos obligatorios: {', '.join(missing)}."

    for field in ("trackingCode", "recipient", "address", "status", "packageType", "pin", "origin", "estimatedDelivery"):
        if field in values:
            values[field] = str(values[field]).strip()
            if field in required and not values[field]:
                return None, f"El campo {field} no puede estar vacío."

    if "status" in values and values["status"] not in VALID_STATUSES:
        return None, "El estado del envío no es válido."
    if "pin" in values and (len(values["pin"]) != 4 or not values["pin"].isdigit()):
        return None, "El PIN debe contener exactamente 4 dígitos."

    for field, minimum, maximum in (("lat", -90, 90), ("lon", -180, 180)):
        if field in values:
            try:
                values[field] = float(values[field])
            except (TypeError, ValueError):
                return None, f"El campo {field} debe ser numérico."
            if not minimum <= values[field] <= maximum:
                return None, f"El campo {field} está fuera de rango."

    return values, None


def init_db():
    seeds = [
        ("shipment-2048-7391", "LTX-2048-7391", "Mariana López", "Recoleta, Buenos Aires", "en-transito", "Express Saver", "4821", -34.5889, -58.3974, "Tapiales", ""),
        ("shipment-2048-7392", "LTX-2048-7392", "Carlos Méndez", "San Telmo, Buenos Aires", "entregado", "Domestic Ground", "7350", -34.6218, -58.3731, "Tapiales", ""),
        ("shipment-2048-7393", "LTX-2048-7393", "Ana Ruiz", "Palermo, Buenos Aires", "incidencia", "Domestic Ground", "1964", -34.5882, -58.4306, "Tapiales", ""),
    ]
    with get_db_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS envios (
                id TEXT PRIMARY KEY,
                tracking_code TEXT NOT NULL UNIQUE,
                recipient TEXT NOT NULL,
                address TEXT NOT NULL,
                status TEXT NOT NULL,
                package_type TEXT NOT NULL,
                pin TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                origin TEXT NOT NULL DEFAULT 'Tapiales',
                estimated_delivery TEXT NOT NULL DEFAULT ''
            )
            """
        )
        count = connection.execute("SELECT COUNT(*) FROM envios").fetchone()[0]
        if count == 0:
            connection.executemany(
                """
                INSERT INTO envios (
                    id, tracking_code, recipient, address, status, package_type,
                    pin, lat, lon, origin, estimated_delivery
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                seeds,
            )


@app.get("/")
def serve_index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/styles.css")
def serve_styles():
    return send_from_directory(BASE_DIR, "styles.css")


@app.get("/app.js")
def serve_script():
    return send_from_directory(BASE_DIR, "app.js")


@app.get("/api/envios")
def get_shipments():
    with get_db_connection() as connection:
        rows = connection.execute("SELECT * FROM envios ORDER BY rowid").fetchall()
    return jsonify([shipment_to_json(row) for row in rows])


@app.get("/api/envios/<string:tracking_code>")
def get_shipment_by_tracking_code(tracking_code):
    with get_db_connection() as connection:
        row = connection.execute(
            "SELECT * FROM envios WHERE tracking_code = ? COLLATE NOCASE",
            (tracking_code,),
        ).fetchone()
    if row is None:
        return jsonify({"error": "No se encontró el envío."}), 404
    return jsonify(shipment_to_json(row))


@app.post("/api/envios")
def create_shipment():
    values, error = validate_shipment_payload(request.get_json(silent=True))
    if error:
        return jsonify({"error": error}), 400

    shipment_id = str(request.get_json().get("id") or uuid.uuid4())
    values.setdefault("origin", "Tapiales")
    values.setdefault("estimatedDelivery", "")
    columns = ["id", *values.keys()]
    database_columns = ["id", *(SHIPMENT_FIELDS[field] for field in values)]
    parameters = [shipment_id, *values.values()]
    placeholders = ", ".join("?" for _ in columns)
    column_list = ", ".join(database_columns)

    try:
        with get_db_connection() as connection:
            connection.execute(
                f"INSERT INTO envios ({column_list}) VALUES ({placeholders})",
                parameters,
            )
            row = connection.execute("SELECT * FROM envios WHERE id = ?", (shipment_id,)).fetchone()
    except sqlite3.IntegrityError:
        return jsonify({"error": "El identificador o número de guía ya existe."}), 409
    return jsonify(shipment_to_json(row)), 201


@app.put("/api/envios/<string:shipment_id>")
def update_shipment(shipment_id):
    values, error = validate_shipment_payload(request.get_json(silent=True), partial=True)
    if error:
        return jsonify({"error": error}), 400
    if not values:
        return jsonify({"error": "No se recibieron campos para actualizar."}), 400

    updates = ", ".join(f"{SHIPMENT_FIELDS[field]} = ?" for field in values)
    try:
        with get_db_connection() as connection:
            cursor = connection.execute(
                f"UPDATE envios SET {updates} WHERE id = ?",
                [*values.values(), shipment_id],
            )
            if cursor.rowcount == 0:
                return jsonify({"error": "No se encontró el envío."}), 404
            row = connection.execute("SELECT * FROM envios WHERE id = ?", (shipment_id,)).fetchone()
    except sqlite3.IntegrityError:
        return jsonify({"error": "El número de guía ya existe."}), 409
    return jsonify(shipment_to_json(row))


@app.delete("/api/envios/<string:shipment_id>")
def delete_shipment(shipment_id):
    with get_db_connection() as connection:
        cursor = connection.execute("DELETE FROM envios WHERE id = ?", (shipment_id,))
    if cursor.rowcount == 0:
        return jsonify({"error": "No se encontró el envío."}), 404
    return jsonify({"deleted": True, "id": shipment_id})


init_db()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)