from pathlib import Path

from question_bank import load_questions
from questions_db import QuestionsDatabase


def migrate():
    base_dir = Path(__file__).parent
    csv_path = base_dir / "theory.csv"
    images_dir = base_dir / "images"
    db_path = base_dir / "questions.db"

    print(f"Loading questions from {csv_path}...")
    questions = load_questions(csv_path)

    print(f"Migrating {len(questions)} questions to {db_path}...")

    # Reset DB
    if db_path.exists():
        db_path.unlink()

    db = QuestionsDatabase(db_path)

    count_images = 0
    for q in questions:
        # Check for local image
        image_data = None
        image_ext = None
        local_path = q.local_image_path(images_dir)
        if local_path and local_path.exists():
            try:
                image_data = local_path.read_bytes()
                image_ext = local_path.suffix.lstrip(".").lower()
                count_images += 1
            except Exception as e:
                print(f"Error reading image for question {q.question_id}: {e}")

        db.add_question(q, image_data, image_ext)

    print(f"Migration complete. {len(questions)} questions migrated.")
    print(f"Migrated {count_images} images.")


if __name__ == "__main__":
    migrate()
