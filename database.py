from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class User:
    id: int
    name: str
    created_at: datetime


@dataclass(frozen=True)
class SessionRecord:
    id: int
    started_at: datetime
    completed_at: datetime
    total_questions: int
    correct_answers: int
    config: dict[str, object]
    category_breakdown: dict[str, dict[str, int]]
    type_breakdown: dict[str, dict[str, int]]


class Database:
    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._connection = sqlite3.connect(self._db_path)
        self._connection.row_factory = sqlite3.Row
        self._ensure_schema()

    def close(self) -> None:
        self._connection.close()

    def _ensure_schema(self) -> None:
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS quiz_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    started_at TEXT NOT NULL,
                    completed_at TEXT NOT NULL,
                    total_questions INTEGER NOT NULL,
                    correct_answers INTEGER NOT NULL,
                    config TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users (id)
                );

                CREATE TABLE IF NOT EXISTS quiz_session_questions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    question_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    question_types TEXT NOT NULL,
                    selected_answer INTEGER,
                    correct_answer INTEGER NOT NULL,
                    is_correct INTEGER NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES quiz_sessions (id)
                );
                """
            )

    def list_users(self) -> list[User]:
        rows = self._connection.execute(
            "SELECT id, name, created_at FROM users ORDER BY LOWER(name)"
        ).fetchall()
        return [
            User(
                id=row["id"],
                name=row["name"],
                created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in rows
        ]

    def get_or_create_user(self, name: str) -> User:
        name = name.strip()
        if not name:
            raise ValueError("User name must not be empty")
        existing = self._connection.execute(
            "SELECT id, name, created_at FROM users WHERE LOWER(name) = LOWER(?)",
            (name,),
        ).fetchone()
        if existing:
            return User(
                id=existing["id"],
                name=existing["name"],
                created_at=datetime.fromisoformat(existing["created_at"]),
            )
        created_at = datetime.utcnow().isoformat()
        with self._connection:
            cursor = self._connection.execute(
                "INSERT INTO users (name, created_at) VALUES (?, ?)",
                (name, created_at),
            )
        return User(id=cursor.lastrowid, name=name, created_at=datetime.fromisoformat(created_at))

    def save_session(
        self,
        user_id: int,
        started_at: datetime,
        completed_at: datetime,
        total_questions: int,
        correct_answers: int,
        config: dict[str, object],
        question_rows: Iterable[dict[str, object]],
    ) -> int:
        config_json = json.dumps(config, ensure_ascii=False)
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO quiz_sessions (
                    user_id, started_at, completed_at,
                    total_questions, correct_answers, config
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    started_at.isoformat(),
                    completed_at.isoformat(),
                    total_questions,
                    correct_answers,
                    config_json,
                ),
            )
            session_id = cursor.lastrowid
            self._connection.executemany(
                """
                INSERT INTO quiz_session_questions (
                    session_id, question_id, category, question_types,
                    selected_answer, correct_answer, is_correct
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        session_id,
                        row["question_id"],
                        row["category"],
                        row["question_types"],
                        row.get("selected_answer"),
                        row["correct_answer"],
                        1 if row["is_correct"] else 0,
                    )
                    for row in question_rows
                ],
            )
        return session_id

    def get_session_history(self, user_id: int) -> list[SessionRecord]:
        sessions = self._connection.execute(
            """
            SELECT id, started_at, completed_at,
                   total_questions, correct_answers, config
            FROM quiz_sessions
            WHERE user_id = ?
            ORDER BY completed_at DESC
            """,
            (user_id,),
        ).fetchall()
        results: list[SessionRecord] = []
        for session in sessions:
            per_question = self._connection.execute(
                """
                SELECT question_id, category, question_types,
                       selected_answer, correct_answer, is_correct
                FROM quiz_session_questions
                WHERE session_id = ?
                """,
                (session["id"],),
            ).fetchall()
            category_breakdown: dict[str, dict[str, int]] = {}
            type_breakdown: dict[str, dict[str, int]] = {}
            for row in per_question:
                category = row["category"]
                is_correct = bool(row["is_correct"])
                stats = category_breakdown.setdefault(category, {"correct": 0, "total": 0})
                stats["total"] += 1
                if is_correct:
                    stats["correct"] += 1

                type_entries = [
                    part.strip()
                    for part in row["question_types"].split(",")
                    if part.strip()
                ]
                for entry in type_entries:
                    t_stats = type_breakdown.setdefault(entry, {"correct": 0, "total": 0})
                    t_stats["total"] += 1
                    if is_correct:
                        t_stats["correct"] += 1
            results.append(
                SessionRecord(
                    id=session["id"],
                    started_at=datetime.fromisoformat(session["started_at"]),
                    completed_at=datetime.fromisoformat(session["completed_at"]),
                    total_questions=session["total_questions"],
                    correct_answers=session["correct_answers"],
                    config=json.loads(session["config"]),
                    category_breakdown=category_breakdown,
                    type_breakdown=type_breakdown,
                )
            )
        return results

    def get_session_questions(self, session_id: int) -> list[dict]:
        rows = self._connection.execute(
            """
            SELECT question_id, selected_answer
            FROM quiz_session_questions
            WHERE session_id = ?
            ORDER BY id
            """,
            (session_id,),
        ).fetchall()
        return [{"question_id": r["question_id"], "selected_answer": r["selected_answer"]} for r in rows]

    def delete_session(self, session_id: int) -> None:
        with self._connection:
            self._connection.execute(
                "DELETE FROM quiz_session_questions WHERE session_id = ?", (session_id,)
            )
            self._connection.execute(
                "DELETE FROM quiz_sessions WHERE id = ?", (session_id,)
            )

    def delete_user(self, user_id: int) -> None:
        # First confirm the user exists
        user_check = self._connection.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user_check:
            return

        with self._connection:
            # Get all session IDs for this user
            sessions = self._connection.execute(
                "SELECT id FROM quiz_sessions WHERE user_id = ?", (user_id,)
            ).fetchall()

            for session in sessions:
                self.delete_session(session["id"])

            self._connection.execute("DELETE FROM users WHERE id = ?", (user_id,))

    def delete(self) -> None:
        self.close()
        if self._db_path.exists():
            self._db_path.unlink()


def _format_breakdown(data: dict[str, dict[str, int]]) -> list[str]:
    formatted: list[str] = []
    for key, stats in data.items():
        formatted.append(f"{key}: {stats['correct']}/{stats['total']}")
    return formatted


def format_history_entry(record: SessionRecord) -> dict[str, object]:
    return {
        "session_id": record.id,
        "completed_at": record.completed_at,
        "score": f"{record.correct_answers}/{record.total_questions}",
        "categories": ", ".join(_format_breakdown(record.category_breakdown)),
        "question_types": ", ".join(_format_breakdown(record.type_breakdown)),
        "config": record.config,
    }
