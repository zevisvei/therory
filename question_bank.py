from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Question:
    question_id: int
    text: str
    options: Sequence[str]
    correct_answer: int
    category: str
    question_types: Sequence[str]
    image_url: str

    def has_type(self, type_name: str) -> bool:
        return type_name in self.question_types

    def local_image_path(self, images_dir: Path) -> Path | None:
        for extension in (".jpg", ".jpeg", ".png", ".gif"):
            candidate = images_dir / f"{self.question_id}{extension}"
            if candidate.exists():
                return candidate
        return None


def _parse_question_types(raw_value: str) -> list[str]:
    parts = [part.strip() for part in raw_value.split(",")]
    return [part for part in parts if part]


def load_questions(csv_path: Path) -> list[Question]:
    questions: list[Question] = []
    with csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            options = [
                row.get("option 1", "").strip(),
                row.get("option 2", "").strip(),
                row.get("option 3", "").strip(),
                row.get("option 4", "").strip(),
            ]
            questions.append(
                Question(
                    question_id=int(row["question_id"]),
                    text=row["question_text"].strip(),
                    options=tuple(option for option in options if option),
                    correct_answer=int(row["correct_answer"]),
                    category=row["category"].strip(),
                    question_types=tuple(_parse_question_types(row["question_type"])),
                    image_url=row.get("image_url", "").strip(),
                )
            )
    return questions


def list_categories(questions: Iterable[Question]) -> list[str]:
    categories: set[str] = {question.category for question in questions}
    return sorted(categories)


def list_question_types(questions: Iterable[Question]) -> list[str]:
    types: set[str] = set()
    for question in questions:
        types.update(question.question_types)
    return sorted(types)
