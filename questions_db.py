from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from question_bank import Question


class QuestionsDatabase:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS questions (
                    id INTEGER PRIMARY KEY,
                    text TEXT NOT NULL,
                    options_json TEXT NOT NULL,
                    correct_answer INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    question_types_json TEXT NOT NULL,
                    image_url TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS images (
                    question_id INTEGER PRIMARY KEY,
                    data BLOB NOT NULL,
                    extension TEXT,
                    FOREIGN KEY(question_id) REFERENCES questions(id)
                )
            """)

    def add_question(self, question: Question, image_data: bytes | None = None, image_ext: str | None = None):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO questions (id, text, options_json, correct_answer, category, question_types_json, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    question.question_id,
                    question.text,
                    json.dumps(question.options),
                    question.correct_answer,
                    question.category,
                    json.dumps(question.question_types),
                    question.image_url
                )
            )
            if image_data:
                conn.execute(
                    "INSERT OR REPLACE INTO images (question_id, data, extension) VALUES (?, ?, ?)",
                    (question.question_id, image_data, image_ext)
                )

    def load_questions(self) -> list[Question]:
        questions = []
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT id, text, options_json, correct_answer, category, question_types_json, image_url FROM questions")
            for row in cursor:
                questions.append(Question(
                    question_id=row[0],
                    text=row[1],
                    options=tuple(json.loads(row[2])),
                    correct_answer=row[3],
                    category=row[4],
                    question_types=tuple(json.loads(row[5])),
                    image_url=row[6]
                ))
        return questions

    def get_image_data(self, question_id: int) -> tuple[bytes | None, str | None]:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT data, extension FROM images WHERE question_id = ?", (question_id,))
            row = cursor.fetchone()
            if row:
                return row[0], row[1]
        return None, None
