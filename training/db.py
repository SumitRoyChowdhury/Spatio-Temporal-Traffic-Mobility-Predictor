"""PostgreSQL connection for the training and prediction scripts."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import psycopg
from dotenv import load_dotenv

load_dotenv()


def connect() -> psycopg.Connection[tuple[Any, ...]]:
    """Connect using ``DATABASE_URL`` or the standard ``PG*`` variables.

    The session timezone is UTC so timestamp arithmetic matches ingestion.
    """
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        parsed_url = urlsplit(database_url)
        query = parse_qs(parsed_url.query)
        options: dict[str, Any] = {
            "host": query.get("host", [parsed_url.hostname])[0],
            "port": parsed_url.port or int(os.environ.get("PGPORT", "5432")),
            "dbname": unquote(parsed_url.path.lstrip("/")),
            "user": unquote(parsed_url.username)
            if parsed_url.username
            else os.environ.get("PGUSER", "sumitroychowdhury"),
            "password": unquote(parsed_url.password)
            if parsed_url.password
            else os.environ.get("PGPASSWORD") or None,
            "options": "-c timezone=UTC",
        }
        sslmode = query.get("sslmode")
        if sslmode:
            options["sslmode"] = sslmode[0]
        return psycopg.connect(**options)

    return psycopg.connect(
        host=os.environ.get("PGHOST", "/tmp"),
        port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "gridlock_train_data"),
        user=os.environ.get("PGUSER", "sumitroychowdhury"),
        password=os.environ.get("PGPASSWORD") or None,
        options="-c timezone=UTC",
    )
