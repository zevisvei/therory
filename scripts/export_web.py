"""Export questions.db into static JSON + WebP assets for the GitHub Pages site.

The web app is fully static: there is no server and no database at runtime, so
everything the browser needs has to be baked into web/data/ up front. Re-run
this whenever questions.db changes.

    python scripts/export_web.py
"""

from __future__ import annotations

import io
import json
import sqlite3
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_DB = ROOT / "questions.db"
OUT_DIR = ROOT / "web" / "data"
IMG_DIR = OUT_DIR / "img"

# Short ASCII codes keep the JSON small and let the UI pick its own labels.
CATEGORY_CODES = {
    "חוקי התנועה": "laws",
    "בטיחות": "safety",
    "תמרורים": "signs",
    "הכרת הרכב": "vehicle",
}

# The source data has a Cyrillic Ve (U+0412) where a Latin B belongs.
TYPE_FIXES = {"\u0412": "B"}

MAX_EDGE = 720
WEBP_QUALITY = 82


def normalise_types(raw: str) -> list[str]:
    return [TYPE_FIXES.get(t, t) for t in json.loads(raw)]


def export_image(blob: bytes, dest: Path) -> bool:
    try:
        img = Image.open(io.BytesIO(blob))
        img.load()
    except Exception as exc:  # a corrupt row should not abort the whole export
        print(f"  ! skipping {dest.stem}: {exc}", file=sys.stderr)
        return False

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    if max(img.size) > MAX_EDGE:
        img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    img.save(dest, "WEBP", quality=WEBP_QUALITY, method=6)
    return True


def main() -> int:
    if not SRC_DB.exists():
        print(f"questions.db not found at {SRC_DB}", file=sys.stderr)
        return 1

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    for stale in IMG_DIR.glob("*.webp"):
        stale.unlink()

    conn = sqlite3.connect(SRC_DB)
    conn.row_factory = sqlite3.Row

    images: dict[int, bytes] = {
        row["question_id"]: row["data"] for row in conn.execute("SELECT question_id, data FROM images")
    }

    questions = []
    bytes_in = bytes_out = 0
    for row in conn.execute(
        "SELECT id, text, options_json, correct_answer, category, question_types_json FROM questions ORDER BY id"
    ):
        qid = row["id"]
        has_image = False
        if qid in images:
            blob = images[qid]
            dest = IMG_DIR / f"{qid}.webp"
            if export_image(blob, dest):
                has_image = True
                bytes_in += len(blob)
                bytes_out += dest.stat().st_size

        # correct_answer is stored 1-based in the source DB.
        answer = int(row["correct_answer"]) - 1
        options = json.loads(row["options_json"])
        if not 0 <= answer < len(options):
            print(f"  ! question {qid} has out-of-range answer {row['correct_answer']}", file=sys.stderr)
            continue

        entry = {
            "i": qid,
            "t": row["text"],
            "o": options,
            "a": answer,
            "c": CATEGORY_CODES.get(row["category"], "other"),
            "y": normalise_types(row["question_types_json"]),
        }
        if has_image:
            entry["g"] = 1
        questions.append(entry)

    conn.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    questions_path = OUT_DIR / "questions.json"
    questions_path.write_text(
        json.dumps(questions, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    by_category: dict[str, int] = {}
    with_images: dict[str, int] = {}
    for q in questions:
        by_category[q["c"]] = by_category.get(q["c"], 0) + 1
        if q.get("g"):
            with_images[q["c"]] = with_images.get(q["c"], 0) + 1

    meta = {
        "total": len(questions),
        "byCategory": by_category,
        "withImages": with_images,
        "categoryNames": {code: name for name, code in CATEGORY_CODES.items()},
    }
    (OUT_DIR / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"questions.json : {len(questions)} questions, {questions_path.stat().st_size / 1e6:.2f} MB")
    print(f"images         : {len(list(IMG_DIR.glob('*.webp')))} files, "
          f"{bytes_in / 1e6:.2f} MB jpg -> {bytes_out / 1e6:.2f} MB webp")
    print(f"by category    : {by_category}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
