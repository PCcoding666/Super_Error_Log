import sqlite3
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any


ERROR_LOG_COLUMNS = {
    "id",
    "image_path",
    "question",
    "student_answer",
    "solution",
    "error_reason",
    "subject",
    "knowledge_point",
    "confirm_status",
    "mastery_status",
    "raw_ai_response",
    "ai_parse_error",
    "created_at",
    "updated_at",
    "confirmed_at",
    "next_review_at",
    "last_reviewed_at",
    "review_count",
}

REVIEW_RECORD_COLUMNS = {
    "id",
    "error_log_id",
    "reviewed_at",
    "result",
    "next_review_at",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


class ErrorLogDatabase:
    """SQLite persistence for error logs and review records."""

    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.create_tables()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.database_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def create_tables(self) -> None:
        with self._connect() as conn:
            self._rename_legacy_tables(conn)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS error_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    image_path TEXT NOT NULL,
                    question TEXT NOT NULL DEFAULT '',
                    student_answer TEXT NOT NULL DEFAULT '',
                    solution TEXT NOT NULL DEFAULT '',
                    error_reason TEXT NOT NULL DEFAULT '',
                    subject TEXT NOT NULL DEFAULT '',
                    knowledge_point TEXT NOT NULL DEFAULT '',
                    confirm_status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (confirm_status IN ('pending', 'confirmed')),
                    mastery_status TEXT NOT NULL DEFAULT 'new'
                        CHECK (
                            mastery_status IN (
                                'new',
                                'learned',
                                'fuzzy',
                                'wrong_again'
                            )
                        ),
                    raw_ai_response TEXT NOT NULL DEFAULT '',
                    ai_parse_error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    confirmed_at TEXT,
                    next_review_at TEXT,
                    last_reviewed_at TEXT,
                    review_count INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS review_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    error_log_id INTEGER NOT NULL,
                    reviewed_at TEXT NOT NULL,
                    result TEXT NOT NULL CHECK (result IN ('known', 'fuzzy', 'wrong')),
                    next_review_at TEXT NOT NULL,
                    FOREIGN KEY (error_log_id) REFERENCES error_logs(id) ON DELETE CASCADE
                )
                """
            )
            conn.commit()

    def _rename_legacy_tables(self, conn: sqlite3.Connection) -> None:
        existing = self._table_names(conn)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

        if "error_logs" in existing:
            columns = self._table_columns(conn, "error_logs")
            if not ERROR_LOG_COLUMNS.issubset(columns):
                conn.execute(f"ALTER TABLE error_logs RENAME TO error_logs_legacy_{stamp}")

        if "review_records" in existing:
            columns = self._table_columns(conn, "review_records")
            if not REVIEW_RECORD_COLUMNS.issubset(columns):
                conn.execute(
                    f"ALTER TABLE review_records RENAME TO review_records_legacy_{stamp}"
                )

    def _table_names(self, conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        return {row["name"] for row in rows}

    def _table_columns(self, conn: sqlite3.Connection, table_name: str) -> set[str]:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return {row["name"] for row in rows}

    def create_error_log(
        self,
        *,
        image_path: str,
        fields: dict[str, str],
        raw_ai_response: str,
        ai_parse_error: str | None,
        now: datetime | None = None,
    ) -> int:
        current = to_iso(now or utc_now())
        values = self._normalized_fields(fields)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO error_logs (
                    image_path,
                    question,
                    student_answer,
                    solution,
                    error_reason,
                    subject,
                    knowledge_point,
                    confirm_status,
                    mastery_status,
                    raw_ai_response,
                    ai_parse_error,
                    created_at,
                    updated_at,
                    review_count
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'new', ?, ?, ?, ?, 0)
                """,
                (
                    image_path,
                    values["question"],
                    values["student_answer"],
                    values["solution"],
                    values["error_reason"],
                    values["subject"],
                    values["knowledge_point"],
                    raw_ai_response,
                    ai_parse_error,
                    current,
                    current,
                ),
            )
            conn.commit()
            return int(cursor.lastrowid)

    def get_error_log(self, log_id: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM error_logs WHERE id = ?", (log_id,)).fetchone()
        return dict(row) if row else None

    def list_error_logs(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM error_logs ORDER BY created_at DESC, id DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def confirm_error_log(
        self,
        log_id: int,
        *,
        fields: dict[str, str],
        now: datetime | None = None,
    ) -> bool:
        current = to_iso(now or utc_now())
        values = self._normalized_fields(fields)
        existing = self.get_error_log(log_id)
        if existing is None:
            return False
        next_review_at = existing["next_review_at"] or current

        with self._connect() as conn:
            conn.execute(
                """
                UPDATE error_logs
                SET question = ?,
                    student_answer = ?,
                    solution = ?,
                    error_reason = ?,
                    subject = ?,
                    knowledge_point = ?,
                    confirm_status = 'confirmed',
                    confirmed_at = COALESCE(confirmed_at, ?),
                    next_review_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    values["question"],
                    values["student_answer"],
                    values["solution"],
                    values["error_reason"],
                    values["subject"],
                    values["knowledge_point"],
                    current,
                    next_review_at,
                    current,
                    log_id,
                ),
            )
            conn.commit()
        return True

    def list_due_reviews(self, now: datetime | None = None) -> list[dict[str, Any]]:
        current = to_iso(now or utc_now())
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM error_logs
                WHERE confirm_status = 'confirmed'
                  AND next_review_at IS NOT NULL
                  AND next_review_at <= ?
                ORDER BY next_review_at ASC, id ASC
                """,
                (current,),
            ).fetchall()
        return [dict(row) for row in rows]

    def record_review(
        self,
        log_id: int,
        *,
        result: str,
        mastery_status: str,
        next_review_at: datetime,
        reviewed_at: datetime | None = None,
    ) -> bool:
        reviewed_at = reviewed_at or utc_now()
        reviewed_iso = to_iso(reviewed_at)
        next_iso = to_iso(next_review_at)

        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM error_logs WHERE id = ? AND confirm_status = 'confirmed'",
                (log_id,),
            ).fetchone()
            if existing is None:
                return False

            conn.execute(
                """
                INSERT INTO review_records (
                    error_log_id,
                    reviewed_at,
                    result,
                    next_review_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (log_id, reviewed_iso, result, next_iso),
            )
            conn.execute(
                """
                UPDATE error_logs
                SET mastery_status = ?,
                    last_reviewed_at = ?,
                    next_review_at = ?,
                    review_count = review_count + 1,
                    updated_at = ?
                WHERE id = ?
                """,
                (mastery_status, reviewed_iso, next_iso, reviewed_iso, log_id),
            )
            conn.commit()
        return True

    def list_review_records(self, log_id: int) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM review_records
                WHERE error_log_id = ?
                ORDER BY reviewed_at DESC, id DESC
                """,
                (log_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def count_pending(self) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS count FROM error_logs WHERE confirm_status = 'pending'"
            ).fetchone()
        return int(row["count"])

    def count_due_by_end_of_day(self, now: datetime | None = None) -> int:
        current = now or utc_now()
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        end_of_day = datetime.combine(current.date(), time.max, tzinfo=timezone.utc)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM error_logs
                WHERE confirm_status = 'confirmed'
                  AND next_review_at IS NOT NULL
                  AND next_review_at <= ?
                """,
                (to_iso(end_of_day),),
            ).fetchone()
        return int(row["count"])

    def top_knowledge_points(self, limit: int = 5) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT knowledge_point, COUNT(*) AS count
                FROM error_logs
                WHERE confirm_status = 'confirmed'
                  AND TRIM(knowledge_point) != ''
                GROUP BY knowledge_point
                ORDER BY count DESC, knowledge_point ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def repeated_error_reasons(self, limit: int = 5) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT error_reason, COUNT(*) AS count
                FROM error_logs
                WHERE confirm_status = 'confirmed'
                  AND TRIM(error_reason) != ''
                GROUP BY error_reason
                HAVING COUNT(*) >= 2
                ORDER BY count DESC, error_reason ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def recent_review_records(self, limit: int = 5) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    review_records.id,
                    review_records.error_log_id,
                    review_records.reviewed_at,
                    review_records.result,
                    review_records.next_review_at,
                    error_logs.question,
                    error_logs.subject,
                    error_logs.knowledge_point
                FROM review_records
                JOIN error_logs ON error_logs.id = review_records.error_log_id
                ORDER BY review_records.reviewed_at DESC, review_records.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _normalized_fields(self, fields: dict[str, str]) -> dict[str, str]:
        return {
            "question": (fields.get("question") or "").strip(),
            "student_answer": (fields.get("student_answer") or "").strip(),
            "solution": (fields.get("solution") or "").strip(),
            "error_reason": (fields.get("error_reason") or "").strip(),
            "subject": (fields.get("subject") or "").strip(),
            "knowledge_point": (fields.get("knowledge_point") or "").strip(),
        }

    # Backwards-compatible aliases for older templates or scripts.
    def get_error_log_by_id(self, log_id: int) -> dict[str, Any] | None:
        return self.get_error_log(log_id)

    def get_all_error_logs(self) -> list[dict[str, Any]]:
        return self.list_error_logs()

    def close(self) -> None:
        return None
