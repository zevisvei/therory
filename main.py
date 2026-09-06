from __future__ import annotations

import base64
import os
import random
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import flet as ft
from database import Database, SessionRecord, User, format_history_entry
from question_bank import Question, list_categories, list_question_types
from questions_db import QuestionsDatabase

TZ = ZoneInfo("Asia/Jerusalem")

FROZEN = getattr(sys, "frozen", False)


def resource_dir() -> Path:
    """Directory holding read-only bundled files (questions.db, scripts)."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).parent


def user_data_dir() -> Path:
    """Writable directory for the user's own data.

    When frozen, _MEIPASS is a temp dir that PyInstaller wipes on exit, so the
    quiz history has to live somewhere that survives the run.
    """
    if not FROZEN:
        return Path(__file__).parent
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    target = (Path(base) if base else Path.home() / ".local" / "share") / "TheoryQuiz"
    target.mkdir(parents=True, exist_ok=True)
    return target


class TheoryQuizApp:
    def __init__(self, page: ft.Page, questions: list[Question], database: Database, questions_db: QuestionsDatabase) -> None:
        self.page = page
        self.questions = questions
        self.database = database
        self.questions_db = questions_db

        self.categories = list_categories(self.questions)
        self.question_types = list_question_types(self.questions)

        self.active_user: User | None = None
        self.filtered_questions: list[Question] = []
        self.answers: list[int | None] = []
        self.current_index = 0
        self.quiz_started_at: datetime | None = None
        self.active_config: dict[str, object] = {}

        self.category_checkboxes: list[ft.Checkbox] = []
        self.type_checkboxes: list[ft.Checkbox] = []

        self.history_records: list[SessionRecord] = []

        self.option_controls: dict[int, ft.Container] = {}

        self._build_ui()
        self.page.on_keyboard_event = self._handle_keyboard
        self.prompt_for_user(initial=True)

    # UI construction -----------------------------------------------------

    def _build_ui(self) -> None:
        self.page.title = "מבחן תיאוריה"
        self.page.padding = 20
        self.page.theme = ft.Theme(font_family="Rubik", color_scheme_seed=ft.Colors.INDIGO)
        self.page.rtl = True
        self.page.window_width = 1200
        self.page.window_height = 800
        self.page.window_resizable = False

        self.user_label = ft.Text(value="", size=16, weight=ft.FontWeight.BOLD)

        # Header actions
        actions = [
            ft.IconButton(ft.Icons.QUESTION_MARK, tooltip="עזרה", on_click=self._show_help_dialog),
            ft.IconButton(ft.Icons.HISTORY, tooltip="היסטוריה", on_click=self._show_history_view),
            ft.IconButton(ft.Icons.PLAY_CIRCLE_OUTLINE, tooltip="התחל משחק חדש", on_click=self._show_config_view),
            ft.IconButton(ft.Icons.PERSON, tooltip="החלף משתמש", on_click=lambda e: self.prompt_for_user(initial=False)),
        ]

        header = ft.Container(
            content=ft.Row(
                controls=[
                    ft.Text("מבחן תיאוריה", size=24, weight=ft.FontWeight.BOLD, color=ft.Colors.PRIMARY),
                    ft.Row(controls=actions, spacing=0),
                    self.user_label,
                ],
                alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
            ),
            padding=ft.Padding.symmetric(vertical=10),
            border=ft.Border.only(bottom=ft.BorderSide(1, ft.Colors.OUTLINE_VARIANT)),
        )

        self.content_container = ft.Container(expand=True, padding=ft.Padding.only(top=20))
        self.page.add(header, self.content_container)

        self.config_view = self._build_config_view()
        self.quiz_view = self._build_quiz_view()
        self.history_view = self._build_history_view()

        self.login_dialog = self._build_login_dialog()

    def _build_config_view(self) -> ft.Column:
        self.random_checkbox = ft.Switch(label="שאלות רנדומליות", value=True)
        self.random_checkbox.label_style = ft.TextStyle(size=16)

        self.question_count_field = ft.TextField(
            label="מספר שאלות",
            value="30",
            width=120,
            text_align=ft.TextAlign.RIGHT,
            keyboard_type=ft.KeyboardType.NUMBER,
        )

        self.category_checkboxes = [
            ft.Checkbox(label=category, value=True, label_position=ft.LabelPosition.RIGHT)
            for category in self.categories
        ]
        self.type_checkboxes = [
            ft.Checkbox(label=q_type, value=True, label_position=ft.LabelPosition.RIGHT)
            for q_type in self.question_types
        ]

        def _make_grid(controls: list[ft.Control]) -> ft.Column:
            rows = []
            for i in range(0, len(controls), 2):
                row_children = [ft.Container(content=controls[i], width=280)]
                if i + 1 < len(controls):
                    row_children.append(ft.Container(content=controls[i + 1], width=280))
                else:
                    row_children.append(ft.Container(width=280))
                rows.append(ft.Row(controls=row_children, spacing=20, rtl=True))
            return ft.Column(controls=rows, spacing=8, scroll=ft.ScrollMode.AUTO, expand=True)

        category_grid = _make_grid(self.category_checkboxes)
        type_grid = _make_grid(self.type_checkboxes)

        select_categories_row = ft.Row(
            controls=[
                ft.TextButton("בחר הכל", on_click=lambda e: self._set_checkbox_group(self.category_checkboxes, True)),
                ft.TextButton("נקה בחירה", on_click=lambda e: self._set_checkbox_group(self.category_checkboxes, False)),
            ],
            rtl=True,
            alignment=ft.MainAxisAlignment.START,
        )

        select_types_row = ft.Row(
            controls=[
                ft.TextButton("בחר הכל", on_click=lambda e: self._set_checkbox_group(self.type_checkboxes, True)),
                ft.TextButton("נקה בחירה", on_click=lambda e: self._set_checkbox_group(self.type_checkboxes, False)),
            ],
            rtl=True,
            alignment=ft.MainAxisAlignment.START,
        )

        category_box = ft.Container(
            content=ft.Column(
                controls=[
                    ft.Text("קטגוריות", size=18, weight=ft.FontWeight.W_600),
                    select_categories_row,
                    category_grid
                ],
            ),
            border=ft.Border.all(1, ft.Colors.OUTLINE_VARIANT),
            border_radius=8,
            padding=10,
            expand=True
        )

        type_box = ft.Container(
            content=ft.Column(
                controls=[
                    ft.Text("סוגי שאלות", size=18, weight=ft.FontWeight.W_600),
                    select_types_row,
                    type_grid
                ],
            ),
            border=ft.Border.all(1, ft.Colors.OUTLINE_VARIANT),
            border_radius=8,
            padding=10,
            expand=True
        )

        settings_grid = ft.Row(
            controls=[category_box, type_box],
            expand=True,
            spacing=20
        )

        start_button = ft.FilledButton("התחל מבחן", on_click=self._start_quiz, height=50, width=200)

        layout = ft.Column(
            controls=[
                ft.Row(
                    controls=[
                        ft.Text("הגדרות מבחן", size=24, weight=ft.FontWeight.BOLD),
                        ft.Container(expand=True),
                        self.random_checkbox,
                        self.question_count_field
                    ],
                    alignment=ft.MainAxisAlignment.SPACE_BETWEEN
                ),
                settings_grid,
                ft.Container(content=start_button, alignment=ft.Alignment(0, 0), padding=20),
            ],
            spacing=16,
            expand=True,
        )
        return layout

    def _build_quiz_view(self) -> ft.Column:
        self.question_title = ft.Text(
            value="",
            size=16,
            weight=ft.FontWeight.W_500,
            color=ft.Colors.PRIMARY,
            text_align=ft.TextAlign.RIGHT,
        )
        self.question_text = ft.Text(
            value="",
            size=22,
            weight=ft.FontWeight.BOLD,
            text_align=ft.TextAlign.RIGHT,
        )

        # Fixed height container for question text to maintain consistent layout
        self.question_container = ft.Container(
            content=ft.Column(
                controls=[
                    self.question_title,
                    self.question_text,
                ],
                spacing=5,
            ),
            height=120,  # Fixed height
            alignment=ft.Alignment(1, -1),  # Align to top-right
        )

        self.image_control = ft.Image(
            src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            visible=False,
            fit="contain",
        )

        # Image container - always visible to maintain layout, shows/hides image content
        self.image_container = ft.Container(
            content=self.image_control,
            width=280,
            alignment=ft.Alignment(0, -1),
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            border_radius=8,
            visible=True,  # Always visible to maintain spacing
        )

        self.option_list = ft.Column(spacing=12, scroll=ft.ScrollMode.AUTO, expand=True)

        # Row for options and image side by side
        self.options_and_image_row = ft.Row(
            controls=[
                ft.Container(content=self.option_list, expand=3),  # 3/4 of width
                ft.Container(content=self.image_container, expand=1),  # 1/4 of width
            ],
            spacing=20,
            alignment=ft.MainAxisAlignment.START,
            vertical_alignment=ft.CrossAxisAlignment.START,
            expand=True,
        )

        self.prev_button = ft.OutlinedButton(
            "הקודם",
            on_click=self._go_previous,
            icon=ft.Icons.ARROW_FORWARD
        )
        self.next_button = ft.FilledTonalButton(
            "הבא",
            on_click=self._go_next,
            icon=ft.Icons.ARROW_BACK
        )
        self.submit_button = ft.FilledButton(
            "סיום מבחן",
            on_click=self._submit_quiz,
            icon=ft.Icons.CHECK
        )

        self.exit_history_button = ft.FilledButton(
            "חזרה להיסטוריה",
            on_click=self._exit_history_review,
            icon=ft.Icons.EXIT_TO_APP,
            visible=False
        )

        self.review_nav_button = ft.OutlinedButton(
            "רשימת שאלות",
            icon=ft.Icons.LIST,
            on_click=lambda e: self._open_review_navigation_dialog(),
            visible=False
        )

        actions_bar = ft.Container(
            content=ft.Row(
                controls=[
                    self.prev_button,
                    self.review_nav_button,
                    ft.Container(expand=True),
                    self.next_button,
                    self.submit_button,
                    self.exit_history_button,
                ],
            ),
            padding=ft.Padding.only(top=10, bottom=10),
        )

        # Scrollable content area
        content_area = ft.Column(
            controls=[
                self.question_container,
                ft.Divider(height=1, color=ft.Colors.OUTLINE_VARIANT),
                self.options_and_image_row,
            ],
            spacing=10,
            scroll=ft.ScrollMode.AUTO,
            expand=True,
        )

        # Layout: Content (Expanded) + Divider + Actions (Fixed)
        return ft.Container(
            content=ft.Column(
                controls=[
                    content_area,
                    ft.Divider(height=1),
                    actions_bar
                ],
                spacing=0,
                expand=True
            ),
            padding=20,
            expand=True
        )

    def _build_history_view(self) -> ft.Column:
        self.history_table = ft.DataTable(
            columns=[
                ft.DataColumn(ft.Text("תאריך")),
                ft.DataColumn(ft.Text("ציון"), numeric=True),
            ],
            rows=[],
            width=600,
        )

        # Header row (fixed)
        table_header = ft.Container(
            content=ft.Row(
                controls=[
                    ft.Container(
                        content=ft.Text("תאריך", weight=ft.FontWeight.BOLD, size=14),
                        width=400,
                        alignment=ft.Alignment(1, 0),
                    ),
                    ft.Container(
                        content=ft.Text("ציון", weight=ft.FontWeight.BOLD, size=14),
                        width=200,
                        alignment=ft.Alignment(0, 0),
                    ),
                ],
                rtl=True,
            ),
            padding=ft.Padding(12, 12, 12, 12),
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            border=ft.Border.only(bottom=ft.BorderSide(2, ft.Colors.OUTLINE_VARIANT)),
        )

        # Table rows container (scrollable)
        self.history_rows_container = ft.Column(spacing=0)

        self.history_details = ft.Container(
            padding=20,
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            border_radius=10,
            visible=False,
            expand=True,
            alignment=ft.Alignment(1, -1)
        )

        layout = ft.Column(
            controls=[
                ft.Text("היסטוריית מבחנים", size=24, weight=ft.FontWeight.BOLD),
                ft.Container(
                    content=ft.Row(
                        controls=[
                            ft.Container(
                                content=ft.Column(
                                    controls=[
                                        table_header,
                                        ft.Container(
                                            content=ft.Column(
                                                controls=[self.history_rows_container],
                                                scroll=ft.ScrollMode.AUTO,
                                            ),
                                            expand=True,
                                        ),
                                    ],
                                    spacing=0,
                                ),
                                border=ft.Border.all(1, ft.Colors.OUTLINE_VARIANT),
                                border_radius=10,
                                alignment=ft.Alignment(0, -1),
                                height=600,
                                width=620,
                            ),
                            self.history_details,
                        ],
                        vertical_alignment=ft.CrossAxisAlignment.START,
                        spacing=20,
                    ),
                    expand=True,
                )
            ],
            spacing=20,
            expand=True,
        )
        return layout

    def _refresh_history(self) -> None:
        if not self.active_user:
            return
        self.history_records = self.database.get_session_history(self.active_user.id)
        self.history_rows_container.controls = []

        for record in self.history_records:
            formatted = format_history_entry(record)
            date_str = record.completed_at.strftime("%d/%m/%Y %H:%M")

            row_container = ft.Container(
                content=ft.Row(
                    controls=[
                        ft.Container(
                            content=ft.Text(date_str, size=14),
                            width=400,
                            alignment=ft.Alignment(1, 0),
                        ),
                        ft.Container(
                            content=ft.Text(formatted["score"], size=14),
                            width=200,
                            alignment=ft.Alignment(0, 0),
                        ),
                    ],
                    rtl=True,
                ),
                padding=ft.Padding(12, 12, 12, 12),
                border=ft.Border.only(bottom=ft.BorderSide(1, ft.Colors.OUTLINE_VARIANT)),
                on_click=lambda e, r=record: self._show_history_details(r),
                ink=True,
            )
            self.history_rows_container.controls.append(row_container)

        if not self.history_records:
            self.history_details.visible = False

        self.page.update()

    def _show_history_details(self, record: SessionRecord) -> None:
        lines = [
            ft.Text(f"ציון סופי: {record.correct_answers} מתוך {record.total_questions}", size=18, weight=ft.FontWeight.BOLD),
            ft.Divider(),
        ]

        if record.category_breakdown:
            lines.append(ft.Text("לפי קטגוריות:", weight=ft.FontWeight.BOLD))
            for key, stats in record.category_breakdown.items():
                pct = int((stats['correct'] / stats['total']) * 100) if stats['total'] > 0 else 0
                lines.append(ft.Text(f"{key}: {stats['correct']}/{stats['total']} ({pct}%)"))

        if record.type_breakdown:
            lines.append(ft.Container(height=10))
            lines.append(ft.Text("לפי סוג שאלה:", weight=ft.FontWeight.BOLD))
            for key, stats in record.type_breakdown.items():
                pct = int((stats['correct'] / stats['total']) * 100) if stats['total'] > 0 else 0
                lines.append(ft.Text(f"{key}: {stats['correct']}/{stats['total']} ({pct}%)"))

        lines.append(ft.Container(height=20))

        button_row = ft.Row(
            controls=[
                ft.FilledButton(
                    "צפה בשאלות ותשובות",
                    on_click=lambda e: self._load_history_session(record.id),
                    icon=ft.Icons.VISIBILITY,
                    expand=True
                ),
                ft.OutlinedButton(
                    "מחק",
                    on_click=lambda e: self._delete_history_record(record.id),
                    icon=ft.Icons.DELETE_OUTLINE,
                    style=ft.ButtonStyle(color=ft.Colors.RED, icon_color=ft.Colors.RED),
                ),
            ],
            spacing=10,
        )
        lines.append(button_row)

        self.history_details.content = ft.Column(controls=lines)
        self.history_details.visible = True
        self.page.update()

    def _delete_history_record(self, session_id: int) -> None:
        def _confirm_delete(e: ft.ControlEvent) -> None:
            self.database.delete_session(session_id)
            dialog.open = False
            self.page.update()

            # Refresh history view
            self._refresh_history()

            self.page.snack_bar = ft.SnackBar(ft.Text("הרשומה נמחקה בהצלחה"))
            self.page.snack_bar.open = True
            self.page.update()

        dialog = ft.AlertDialog(
            title=ft.Text("מחיקת היסטוריה", text_align=ft.TextAlign.RIGHT, rtl=True),
            content=ft.Text("האם למחוק את הרשומה מההיסטוריה?", text_align=ft.TextAlign.RIGHT, rtl=True),
            actions=[
                ft.TextButton("ביטול", on_click=lambda e: self._close_dialog(e, dialog)),
                ft.FilledButton("מחק", on_click=_confirm_delete, style=ft.ButtonStyle(bgcolor=ft.Colors.RED)),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.dialog = dialog
        if dialog not in self.page.overlay:
            self.page.overlay.append(dialog)
        dialog.open = True
        self.page.update()

    def _load_history_session(self, session_id: int) -> None:
        session_data = self.database.get_session_questions(session_id)
        if not session_data:
            return

        self.filtered_questions = []
        self.answers = []
        q_map = {q.question_id: q for q in self.questions}

        for item in session_data:
            q_id = item["question_id"]
            if q_id in q_map:
                self.filtered_questions.append(q_map[q_id])
                self.answers.append(item["selected_answer"])

        if not self.filtered_questions:
            return

        self.current_index = 0
        self.quiz_submitted = True

        self._show_question()
        self._show_quiz_view()

    def _open_review_navigation_dialog(self) -> None:
        if not self.filtered_questions:
            return

        # Initialize filter if not exists (default: status='all')
        if not hasattr(self, 'review_filter'):
            self.review_filter = "all"

        def _get_status_icon(index: int, question: Question) -> ft.Icon:
            answer = self.answers[index]
            if answer is None:
                return ft.Icon(ft.Icons.QUESTION_MARK, color=ft.Colors.GREY)
            if answer == question.correct_answer:
                return ft.Icon(ft.Icons.CHECK_CIRCLE, color=ft.Colors.GREEN)
            return ft.Icon(ft.Icons.CANCEL, color=ft.Colors.RED)

        def _get_counts() -> dict[str, int]:
            counts = {"all": 0, "correct": 0, "wrong": 0, "unanswered": 0}
            for i, q in enumerate(self.filtered_questions):
                counts["all"] += 1
                answer = self.answers[i]
                if answer is None:
                    counts["unanswered"] += 1
                elif answer == q.correct_answer:
                    counts["correct"] += 1
                else:
                    counts["wrong"] += 1
            return counts

        def _get_filtered_indices() -> list[int]:
            indices = []
            for i, q in enumerate(self.filtered_questions):
                answer = self.answers[i]
                is_correct = (answer == q.correct_answer)
                is_answered = (answer is not None)

                if self.review_filter == "correct" and is_correct:
                    indices.append(i)
                elif self.review_filter == "wrong" and is_answered and not is_correct:
                    indices.append(i)
                elif self.review_filter == "unanswered" and not is_answered:
                    indices.append(i)
                elif self.review_filter == "all":
                    indices.append(i)
            return indices

        self.review_list_container = ft.Column(scroll=ft.ScrollMode.AUTO, expand=True)

        def _update_list() -> None:
            items = []
            indices = _get_filtered_indices()
            for i in indices:
                q = self.filtered_questions[i]
                items.append(
                    ft.Container(
                        content=ft.Row(
                            controls=[
                                ft.Text(str(i + 1), width=30, weight=ft.FontWeight.BOLD),
                                _get_status_icon(i, q),
                                ft.Text(q.text, expand=True, no_wrap=True, max_lines=1, overflow=ft.TextOverflow.ELLIPSIS),
                            ],
                            alignment=ft.MainAxisAlignment.START,
                            rtl=True,
                        ),
                        padding=10,
                        border=ft.Border.only(bottom=ft.BorderSide(1, ft.Colors.OUTLINE_VARIANT)),
                        on_click=lambda e, idx=i: _on_row_select(idx),
                        ink=True,
                    )
                )
            self.review_list_container.controls = items
            try:
                self.review_list_container.update()
            except:
                pass

        def _on_row_select(index: int) -> None:
            self.current_index = index
            self.dialog.open = False
            self.page.update()
            self._show_question()

        # Custom Tabs Implementation to avoid version compatibility issues
        self.review_tabs_row = ft.Row(scroll=ft.ScrollMode.AUTO, spacing=10, rtl=True)

        def _set_filter(filter_name: str) -> None:
            self.review_filter = filter_name
            _update_tabs_ui()
            _update_list()

        def _update_tabs_ui() -> None:
            counts = _get_counts()
            tabs_data = [
                ("all", f"הכל ({counts['all']})", ft.Icons.LIST, None),
                ("correct", f"נכון ({counts['correct']})", ft.Icons.CHECK_CIRCLE, ft.Colors.GREEN),
                ("wrong", f"שגוי ({counts['wrong']})", ft.Icons.CANCEL, ft.Colors.RED),
                ("unanswered", f"לא נענה ({counts['unanswered']})", ft.Icons.QUESTION_MARK, ft.Colors.GREY),
            ]

            controls = []
            for key, text, icon, color in tabs_data:
                is_selected = self.review_filter == key
                controls.append(
                    ft.Container(
                        content=ft.Row(
                            controls=[
                                ft.Icon(icon, color=color if color else ft.Colors.ON_SURFACE, size=16),
                                ft.Text(text, weight=ft.FontWeight.BOLD if is_selected else ft.FontWeight.NORMAL),
                            ],
                            spacing=5,
                            rtl=True,
                            alignment=ft.MainAxisAlignment.CENTER,
                        ),
                        padding=ft.Padding(12, 8, 12, 8),
                        bgcolor=ft.Colors.SECONDARY_CONTAINER if is_selected else ft.Colors.SURFACE_CONTAINER_HIGHEST,
                        border_radius=20,
                        on_click=lambda e, k=key: _set_filter(k),
                        animate=200,
                        ink=True,
                    )
                )
            self.review_tabs_row.controls = controls
            try:
                self.review_tabs_row.update()
            except:
                pass

        # Initial populate
        _update_tabs_ui()

        filter_tabs = self.review_tabs_row

        self.dialog = ft.AlertDialog(
            title=ft.Text("רשימת שאלות", text_align=ft.TextAlign.RIGHT, rtl=True),
            content=ft.Container(
                content=ft.Column(
                    controls=[
                        filter_tabs,
                        ft.Container(
                            content=self.review_list_container,
                            height=400,
                            padding=ft.Padding(0, 10, 0, 0)
                        )
                    ],
                    tight=True
                ),
                width=600
            ),
            actions=[
                ft.TextButton("סגור", on_click=lambda e: self._close_dialog(e, self.dialog)),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )

        # Initial populate
        _update_list()

        self.page.dialog = self.dialog
        if self.dialog not in self.page.overlay:
            self.page.overlay.append(self.dialog)
        self.dialog.open = True
        self.page.update()

    def _exit_history_review(self, e: ft.ControlEvent = None) -> None:
        self._show_history_view()

    def _show_help_dialog(self, e: ft.ControlEvent | None = None) -> None:
        shortcuts = [
            ("←", "מעבר לשאלה הבאה"),
            ("→", "מעבר לשאלה הקודמת"),
            ("1-4", "בחירת תשובה"),
            ("Enter", "סיום מבחן"),
            ("PageDown", "מעבר לשאלה הבאה"),
            ("PageUp", "מעבר לשאלה הקודמת"),
        ]

        content = ft.Column(
            controls=[
                ft.Container(
                    content=ft.Row(
                        controls=[
                            ft.Icon(ft.Icons.KEYBOARD, size=30, color=ft.Colors.PRIMARY),
                            ft.Text("קיצורי מקשים", size=20, weight=ft.FontWeight.BOLD),
                        ],
                        rtl=True,
                        alignment=ft.MainAxisAlignment.START,
                    ),
                    padding=ft.Padding(bottom=15, top=5, left=0, right=0),
                ),
                ft.Divider(height=1, color=ft.Colors.OUTLINE_VARIANT),
                ft.Container(height=10),
            ] + [
                ft.Container(
                    content=ft.Row(
                        controls=[
                            ft.Container(
                                content=ft.Text(key, weight=ft.FontWeight.BOLD, size=14),
                                padding=ft.Padding(8, 4, 8, 4),
                                bgcolor=ft.Colors.SECONDARY_CONTAINER,
                                border_radius=6,
                            ),
                            ft.Text(":", size=14),
                            ft.Text(desc, size=14),
                        ],
                        rtl=True,
                        alignment=ft.MainAxisAlignment.START,
                        spacing=10,
                    ),
                    padding=ft.Padding(0, 4, 0, 4),
                )
                for key, desc in shortcuts
            ],
            tight=True,
            spacing=0,
            rtl=True,
        )

        dialog = ft.AlertDialog(
            title=ft.Text("עזרה", text_align=ft.TextAlign.RIGHT, rtl=True),
            content=content,
            actions=[ft.FilledButton("סגור", on_click=lambda e: self._close_dialog(e, dialog))],
            actions_alignment=ft.MainAxisAlignment.END,
            content_padding=ft.Padding(20, 20, 20, 10),
            shape=ft.RoundedRectangleBorder(radius=12),
        )
        self.page.dialog = dialog
        if dialog not in self.page.overlay:
            self.page.overlay.append(dialog)
        dialog.open = True
        self.page.update()

    def _build_login_dialog(self) -> ft.AlertDialog:
        self.user_dropdown = ft.Dropdown(
            label="בחר משתמש",
            text_align=ft.TextAlign.RIGHT,
            rtl=True,
            expand=True
        )
        self.new_user_field = ft.TextField(label="או הזן משתמש חדש", text_align=ft.TextAlign.RIGHT, rtl=True)

        delete_user_btn = ft.IconButton(
            ft.Icons.DELETE_OUTLINE,
            tooltip="מחק משתמש נבחר",
            on_click=self._delete_selected_user,
            icon_color=ft.Colors.RED
        )

        dialog = ft.AlertDialog(
            modal=True,
            title=ft.Text("ניהול משתמשים", text_align=ft.TextAlign.RIGHT, rtl=True),
            content=ft.Column(
                controls=[
                    ft.Row(
                        controls=[
                            delete_user_btn,
                            self.user_dropdown,
                        ],
                        rtl=True,
                    ),
                    self.new_user_field
                ],
                tight=True,
                spacing=10,
                rtl=True,
            ),
            actions_alignment=ft.MainAxisAlignment.END,
            actions=[
                ft.TextButton("ביטול", on_click=lambda e: self._close_login_dialog(cancelled=True)),
                ft.FilledButton("אישור", on_click=self._confirm_user_selection),
            ],
            content_padding=ft.Padding(20, 20, 20, 10),
            shape=ft.RoundedRectangleBorder(radius=12),
        )
        return dialog

    def _delete_selected_user(self, e: ft.ControlEvent) -> None:
        selected_name = self.user_dropdown.value
        if not selected_name:
            self.page.snack_bar = ft.SnackBar(ft.Text("בחר משתמש למחיקה"), bgcolor=ft.Colors.ERROR)
            self.page.snack_bar.open = True
            self.page.update()
            return

        def _confirm_delete(e: ft.ControlEvent) -> None:
            user = self._get_user_by_name(selected_name)
            if user:
                # If deleting active user, clear active user
                if self.active_user and self.active_user.id == user.id:
                    self.active_user = None
                    self.user_label.value = ""

                self.database.delete_user(user.id)

                # Refresh list
                users = self.database.list_users()
                self.user_dropdown.options = [ft.dropdown.Option(u.name) for u in users]
                self.user_dropdown.value = users[0].name if users else None
                self.page.update()

                confirm_dialog.open = False
                self.page.update()

                self.page.snack_bar = ft.SnackBar(ft.Text(f"משתמש {selected_name} נמחק"))
                self.page.snack_bar.open = True
                self.page.update()

        confirm_dialog = ft.AlertDialog(
            title=ft.Text("מחיקת משתמש", text_align=ft.TextAlign.RIGHT, rtl=True),
            content=ft.Text(f"האם אתה בטוח שברצונך למחוק את {selected_name} ואת כל ההיסטוריה שלו?", text_align=ft.TextAlign.RIGHT, rtl=True),
            actions=[
                ft.TextButton("ביטול", on_click=lambda e: self._close_dialog(e, confirm_dialog)),
                ft.FilledButton("מחק", on_click=_confirm_delete, style=ft.ButtonStyle(bgcolor=ft.Colors.RED)),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
        )
        self.page.dialog = confirm_dialog
        if confirm_dialog not in self.page.overlay:
            self.page.overlay.append(confirm_dialog)
        confirm_dialog.open = True
        self.page.update()

    # View switching ------------------------------------------------------

    def _show_config_view(self, e: ft.ControlEvent | None = None) -> None:
        self.content_container.content = self.config_view
        self.page.update()

    def _show_quiz_view(self) -> None:
        self.content_container.content = self.quiz_view
        self.page.update()

    def _show_history_view(self, e: ft.ControlEvent | None = None) -> None:
        if not self.active_user:
            self.page.snack_bar = ft.SnackBar(ft.Text("בחר משתמש קודם"))
            self.page.snack_bar.open = True
            self.page.update()
            return
        self._refresh_history()
        self.content_container.content = self.history_view
        self.page.update()

    # Login ---------------------------------------------------------------

    def prompt_for_user(self, initial: bool) -> None:
        users = self.database.list_users()
        self.user_dropdown.options = [ft.dropdown.Option(user.name) for user in users]
        self.user_dropdown.value = users[0].name if users else None
        self.new_user_field.value = ""
        self.login_dialog.open = True
        self.page.dialog = self.login_dialog
        if self.login_dialog not in self.page.overlay:
            self.page.overlay.append(self.login_dialog)
        self.page.update()
        if initial and not users:
            self.page.snack_bar = ft.SnackBar(ft.Text("צור משתמש חדש כדי להתחיל"))
            self.page.snack_bar.open = True
            self.page.update()

    def _confirm_user_selection(self, e: ft.ControlEvent) -> None:
        name = self.new_user_field.value.strip()
        if name:
            try:
                user = self.database.get_or_create_user(name)
            except ValueError:
                self.page.snack_bar = ft.SnackBar(ft.Text("שם משתמש לא תקין"), bgcolor=ft.Colors.ERROR)
                self.page.snack_bar.open = True
                self.page.update()
                return
        else:
            selected = self.user_dropdown.value
            if not selected:
                self.page.snack_bar = ft.SnackBar(ft.Text("בחר או צור משתמש"), bgcolor=ft.Colors.ERROR)
                self.page.snack_bar.open = True
                self.page.update()
                return
            user = self._get_user_by_name(selected)
            if user is None:
                self.page.snack_bar = ft.SnackBar(ft.Text("משתמש לא נמצא"), bgcolor=ft.Colors.ERROR)
                self.page.snack_bar.open = True
                self.page.update()
                return
        self.active_user = user
        self.user_label.value = f"משתמש פעיל: {self.active_user.name}"
        self._load_last_settings(user.id)
        self._close_login_dialog(cancelled=False)
        self._show_config_view()

    def _load_last_settings(self, user_id: int) -> None:
        try:
            history = self.database.get_session_history(user_id)
            if history:
                last = history[0]
                config = last.config
                if "question_count" in config:
                    self.question_count_field.value = str(config["question_count"])
                if "randomize" in config:
                    self.random_checkbox.value = bool(config["randomize"])

                last_cats = config.get("categories", [])
                for box in self.category_checkboxes:
                    box.value = box.label in last_cats

                last_types = config.get("question_types", [])
                for box in self.type_checkboxes:
                    box.value = box.label in last_types

                self.page.update()
        except:
            pass  # Ignore errors loading history

    def _close_login_dialog(self, cancelled: bool) -> None:
        self.login_dialog.open = False
        self.page.update()
        if cancelled and not self.active_user:
            self.page.window_close()

    def _get_user_by_name(self, name: str) -> User | None:
        for user in self.database.list_users():
            if user.name == name:
                return user
        return None

    # Config helpers ------------------------------------------------------

    def _set_checkbox_group(self, boxes: list[ft.Checkbox], value: bool) -> None:
        for box in boxes:
            box.value = value
        self.page.update()

    def _start_quiz(self, e: ft.ControlEvent) -> None:
        if not self.active_user:
            self.page.snack_bar = ft.SnackBar(ft.Text("יש לבחור משתמש לפני התחלת מבחן"), bgcolor=ft.Colors.ERROR)
            self.page.snack_bar.open = True
            self.page.update()
            return

        try:
            requested_count = int(self.question_count_field.value)
        except ValueError:
            requested_count = 30
            self.question_count_field.value = "30"

        # Gather selections directly from UI controls to ensure freshness
        selected_categories = [box.label for box in self.category_checkboxes if box.value]
        selected_types = [box.label for box in self.type_checkboxes if box.value]

        if not selected_categories:
            self.page.snack_bar = ft.SnackBar(ft.Text("יש לבחור לפחות קטגוריה אחת"), bgcolor=ft.Colors.ERROR)
            self.page.snack_bar.open = True
            self.page.update()
            return

        if not selected_types:
            self.page.snack_bar = ft.SnackBar(ft.Text("יש לבחור לפחות סוג שאלה אחד"), bgcolor=ft.Colors.ERROR)
            self.page.snack_bar.open = True
            self.page.update()
            return

        # Explicit filtering logic
        filtered = []
        for q in self.questions:
            # Check Category
            if q.category not in selected_categories:
                continue

            # Check Types (match at least one)
            type_match = False
            for t in q.question_types:
                if t in selected_types:
                    type_match = True
                    break

            if type_match:
                filtered.append(q)

        if not filtered:
            self.page.snack_bar = ft.SnackBar(ft.Text("לא נמצאו שאלות עבור ההגדרות שנבחרו"), bgcolor=ft.Colors.ERROR)
            self.page.snack_bar.open = True
            self.page.update()
            return

        if self.random_checkbox.value:
            random.shuffle(filtered)
        else:
            filtered.sort(key=lambda q: q.question_id)

        if requested_count < 1:
            requested_count = 1

        warning_msg = None
        # Logic: If we found FEWER questions than requested, use what we found and warn the user.
        if len(filtered) < requested_count:
            warning_msg = f"נמצאו רק {len(filtered)} שאלות תואמות (ביקשת {requested_count})"
            requested_count = len(filtered)

        self.filtered_questions = filtered[:requested_count]
        self.answers = [None] * len(self.filtered_questions)
        self.current_index = 0
        self.quiz_started_at = datetime.now(tz=TZ)
        self.quiz_submitted = False  # Track if quiz was submitted
        self.active_config = {
            "randomize": self.random_checkbox.value,
            "question_count": requested_count,
            "categories": selected_categories,
            "question_types": selected_types,
        }

        # Update submit button state based on mode
        self.submit_button.text = "סיום מבחן"
        self.submit_button.icon = ft.Icons.CHECK
        self.submit_button.on_click = self._submit_quiz

        self._show_question()
        self._show_quiz_view()

        if warning_msg:
            def close_warning(e):
                warning_dialog.open = False
                self.page.update()

            warning_dialog = ft.AlertDialog(
                title=ft.Row([ft.Text("שים לב", weight=ft.FontWeight.BOLD)], rtl=True),
                content=ft.Row([ft.Text(warning_msg)], rtl=True),
                actions=[
                    ft.FilledButton("הבנתי", on_click=close_warning)
                ],
                actions_alignment=ft.MainAxisAlignment.END,
                shape=ft.RoundedRectangleBorder(radius=8),
            )
            self.page.dialog = warning_dialog
            self.page.overlay.append(warning_dialog)
            warning_dialog.open = True
            self.page.update()

    # Quiz functionality --------------------------------------------------

    def _show_question(self) -> None:
        if not self.filtered_questions:
            return
        question = self.filtered_questions[self.current_index]

        # Build question header with indicators
        header = f"שאלה {self.current_index + 1}/{len(self.filtered_questions)}"
        current_answer = self.answers[self.current_index]

        # Determine mode
        is_review_mode = hasattr(self, 'quiz_submitted') and self.quiz_submitted

        # Toggle button visibility based on mode
        self.submit_button.visible = not is_review_mode
        self.exit_history_button.visible = is_review_mode

        # Add indicator if quiz was submitted
        if hasattr(self, 'quiz_submitted') and self.quiz_submitted:
            if current_answer is None:
                header += " ❌ לא נענתה"  # Red X
            elif current_answer != question.correct_answer:
                header += " ❌ תשובה שגויה"  # Red X
            else:
                header += " ✔ נכון"  # Green check

        self.question_title.value = header
        self.question_text.value = question.text

        # Image handling - container always visible, only image visibility changes
        self.image_control.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        self.image_control.src_base64 = None
        self.image_control.visible = False

        has_image = False

        # Try loading from DB
        img_data, img_ext = self.questions_db.get_image_data(question.question_id)
        if img_data:
            encoded = base64.b64encode(img_data).decode("utf-8")
            if not img_ext:
                img_ext = "jpeg"  # Default fallback
            elif img_ext == "jpg":
                img_ext = "jpeg"
            self.image_control.src = f"data:image/{img_ext};base64,{encoded}"
            has_image = True
        elif question.image_url:
            self.image_control.src = question.image_url
            has_image = True

        if has_image:
            self.image_control.visible = True

        # Options
        option_controls: list[ft.Control] = []
        self.option_controls.clear()

        current_answer = self.answers[self.current_index]
        is_review_mode = hasattr(self, 'quiz_submitted') and self.quiz_submitted
        correct_answer_idx = question.correct_answer if is_review_mode else -1

        self.review_nav_button.visible = is_review_mode

        for index, option_text in enumerate(question.options, start=1):
            is_selected = (current_answer == index)

            # Default styles
            bg_color = None
            border_color = ft.Colors.OUTLINE_VARIANT
            icon_name = ft.Icons.RADIO_BUTTON_UNCHECKED
            icon_color = ft.Colors.OUTLINE

            if is_review_mode:
                if index == correct_answer_idx:
                    bg_color = ft.Colors.GREEN_50
                    border_color = ft.Colors.GREEN
                    icon_name = ft.Icons.CHECK_CIRCLE
                    icon_color = ft.Colors.GREEN
                elif is_selected:  # Selected but not correct (since correct check is first)
                    bg_color = ft.Colors.RED_50
                    border_color = ft.Colors.RED
                    icon_name = ft.Icons.CANCEL
                    icon_color = ft.Colors.RED
            else:
                if is_selected:
                    bg_color = ft.Colors.SECONDARY_CONTAINER
                    border_color = ft.Colors.PRIMARY
                    icon_name = ft.Icons.RADIO_BUTTON_CHECKED
                    icon_color = ft.Colors.PRIMARY

            icon = ft.Icon(icon_name, color=icon_color, size=20)

            row = ft.Row(
                controls=[
                    ft.Text(f"{index}. {option_text}", size=18, expand=True, text_align=ft.TextAlign.RIGHT),
                    icon,
                ],
                rtl=True,
                alignment=ft.MainAxisAlignment.START,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            )

            # Using GestureDetector to avoid focus-traversal issues with Arrow keys
            container = ft.Container(
                content=row,
                padding=12,
                border_radius=8,
                bgcolor=bg_color,
                border=ft.Border.all(1, border_color),
                height=60,  # Fixed height for each answer option
            )

            gesture = ft.GestureDetector(
                mouse_cursor=ft.MouseCursor.CLICK if not is_review_mode else ft.MouseCursor.BASIC,
                on_tap=lambda e, idx=index: self._select_option(idx),
                content=container
            )

            option_controls.append(gesture)
            self.option_controls[index] = gesture

        self.option_list.controls = option_controls

        self.prev_button.disabled = self.current_index == 0
        self.next_button.disabled = self.current_index >= len(self.filtered_questions) - 1

        self.page.update()

    def _select_option(self, index: int) -> None:
        if hasattr(self, 'quiz_submitted') and self.quiz_submitted:
            return
        self.answers[self.current_index] = index
        # Update only the options, not the entire question (to prevent image flickering)
        self._update_options_only()

    def _update_options_only(self) -> None:
        """Update only the option controls without refreshing question text or image"""
        if not self.filtered_questions:
            return

        question = self.filtered_questions[self.current_index]
        current_answer = self.answers[self.current_index]

        option_controls: list[ft.Control] = []
        self.option_controls.clear()

        for index, option_text in enumerate(question.options, start=1):
            is_selected = (current_answer == index)

            icon = ft.Icon(
                ft.Icons.RADIO_BUTTON_CHECKED if is_selected else ft.Icons.RADIO_BUTTON_UNCHECKED,
                color=ft.Colors.PRIMARY if is_selected else ft.Colors.OUTLINE,
                size=20
            )

            row = ft.Row(
                controls=[
                    ft.Text(f"{index}. {option_text}", size=18, expand=True, text_align=ft.TextAlign.RIGHT),
                    icon,
                ],
                rtl=True,
                alignment=ft.MainAxisAlignment.START,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            )

            container = ft.Container(
                content=row,
                padding=12,
                border_radius=8,
                bgcolor=ft.Colors.SECONDARY_CONTAINER if is_selected else None,
                border=ft.Border.all(1, ft.Colors.OUTLINE_VARIANT if not is_selected else ft.Colors.PRIMARY),
                height=60,
            )

            gesture = ft.GestureDetector(
                mouse_cursor=ft.MouseCursor.CLICK,
                on_tap=lambda e, idx=index: self._select_option(idx),
                content=container
            )

            option_controls.append(gesture)
            self.option_controls[index] = gesture

        self.option_list.controls = option_controls
        self.page.update()

    def _on_option_change_unused(self, e: ft.ControlEvent) -> None:
        pass

    def _go_previous(self, e: ft.ControlEvent | None = None) -> None:
        if self.current_index > 0:
            self.current_index -= 1
            self._show_question()

    def _go_next(self, e: ft.ControlEvent | None = None) -> None:
        if self.current_index < len(self.filtered_questions) - 1:
            self.current_index += 1
            self._show_question()

    def _submit_quiz(self, e: ft.ControlEvent | None = None) -> None:
        if not self.filtered_questions:
            return

        # Prevent double dialog
        if self.page.dialog and self.page.dialog.open:
            return

        missing = sum(1 for answer in self.answers if answer is None)
        if missing:
            dialog = ft.AlertDialog(
                title=ft.Text("אישור סיום", text_align=ft.TextAlign.RIGHT, rtl=True),
                content=ft.Column(
                    controls=[
                        ft.Row(
                            controls=[
                                ft.Icon(ft.Icons.WARNING_AMBER_ROUNDED, size=30, color=ft.Colors.AMBER),
                                ft.Text(f"ישנן {missing} שאלות ללא תשובה.", size=16),
                            ],
                            rtl=True,
                            alignment=ft.MainAxisAlignment.START,
                        ),
                        ft.Container(height=5),
                        ft.Text("האם ברצונך לסיים את המבחן?", size=14, text_align=ft.TextAlign.RIGHT),
                    ],
                    tight=True,
                    rtl=True,
                ),
                actions=[
                    ft.TextButton("חזרה למבחן", on_click=lambda ev: self._close_dialog(ev, dialog)),
                    ft.FilledButton("סיום מבחן", on_click=lambda ev: self._finalize_quiz(dialog)),
                ],
                actions_alignment=ft.MainAxisAlignment.END,
                content_padding=ft.Padding(20, 20, 20, 10),
                shape=ft.RoundedRectangleBorder(radius=12),
            )
            self.page.dialog = dialog
            if dialog not in self.page.overlay:
                self.page.overlay.append(dialog)
            dialog.open = True
            self.page.update()
        else:
            self._finalize_quiz(None)

    def _close_dialog(self, e: ft.ControlEvent, dialog: ft.AlertDialog) -> None:
        dialog.open = False
        if self.page.dialog is dialog:
            self.page.dialog = None
        self.page.update()

    def _finalize_quiz(self, dialog: ft.AlertDialog | None) -> None:
        if dialog:
            dialog.open = False
            if self.page.dialog is dialog:
                self.page.dialog = None
        completed_at = datetime.now(tz=TZ)
        correct_answers = 0
        question_rows: list[dict[str, object]] = []
        category_stats: dict[str, dict[str, int]] = {}
        type_stats: dict[str, dict[str, int]] = {}

        for question, selected in zip(self.filtered_questions, self.answers):
            is_correct = selected == question.correct_answer
            if is_correct:
                correct_answers += 1
            question_rows.append(
                {
                    "question_id": question.question_id,
                    "category": question.category,
                    "question_types": ", ".join(question.question_types),
                    "selected_answer": selected,
                    "correct_answer": question.correct_answer,
                    "is_correct": is_correct,
                }
            )
            category_entry = category_stats.setdefault(question.category, {"correct": 0, "total": 0})
            category_entry["total"] += 1
            if is_correct:
                category_entry["correct"] += 1
            for q_type in question.question_types:
                type_entry = type_stats.setdefault(q_type, {"correct": 0, "total": 0})
                type_entry["total"] += 1
                if is_correct:
                    type_entry["correct"] += 1

        if self.active_user and self.quiz_started_at:
            self.database.save_session(
                user_id=self.active_user.id,
                started_at=self.quiz_started_at,
                completed_at=completed_at,
                total_questions=len(self.filtered_questions),
                correct_answers=correct_answers,
                config=self.active_config,
                question_rows=question_rows,
            )

        lines = [f"תוצאה: {correct_answers}/{len(self.filtered_questions)}"]
        if category_stats:
            lines.append("\nקטגוריות:")
            for key, stats in category_stats.items():
                lines.append(f"  {key}: {stats['correct']}/{stats['total']}")
        if type_stats:
            lines.append("\nסוגי שאלות:")
            for key, stats in type_stats.items():
                lines.append(f"  {key}: {stats['correct']}/{stats['total']}")

        score_percentage = int((correct_answers / len(self.filtered_questions)) * 100)
        is_passing = score_percentage >= 70

        result_dialog = ft.AlertDialog(
            title=ft.Row(
                controls=[
                    ft.Icon(
                        ft.Icons.CHECK_CIRCLE if is_passing else ft.Icons.CANCEL,
                        size=30,
                        color=ft.Colors.GREEN if is_passing else ft.Colors.RED
                    ),
                    ft.Text("תוצאות המבחן", size=20, weight=ft.FontWeight.BOLD),
                ],
                rtl=True,
                alignment=ft.MainAxisAlignment.START,
            ),
            content=ft.Column(
                controls=[
                    ft.Container(
                        content=ft.Row(
                            controls=[
                                ft.Text(
                                    f"{score_percentage}%",
                                    size=40,
                                    weight=ft.FontWeight.BOLD,
                                    color=ft.Colors.GREEN if is_passing else ft.Colors.RED,
                                ),
                                ft.Text(
                                    f"{correct_answers}/{len(self.filtered_questions)}",
                                    size=18,
                                    color=ft.Colors.ON_SURFACE_VARIANT,
                                ),
                            ],
                            rtl=True,
                            alignment=ft.MainAxisAlignment.CENTER,
                            spacing=15,
                        ),
                        padding=ft.Padding(0, 10, 0, 15),
                        alignment=ft.Alignment(0, 0),
                    ),
                    ft.Divider(height=1, color=ft.Colors.OUTLINE_VARIANT),
                    ft.Container(height=10),
                ] + ([
                    ft.Text("פירוט לפי קטגוריות:", weight=ft.FontWeight.BOLD, size=14, text_align=ft.TextAlign.RIGHT),
                    ft.Container(height=5),
                ] + [
                    ft.Row(
                        controls=[
                            ft.Text(f"{stats['correct']}/{stats['total']}", size=13, weight=ft.FontWeight.BOLD),
                            ft.Text(":", size=13),
                            ft.Text(key, size=13),
                        ],
                        rtl=True,
                        alignment=ft.MainAxisAlignment.START,
                    )
                    for key, stats in category_stats.items()
                ] if category_stats else []) + ([
                    ft.Container(height=10),
                    ft.Text("פירוט לפי סוג שאלה:", weight=ft.FontWeight.BOLD, size=14, text_align=ft.TextAlign.RIGHT),
                    ft.Container(height=5),
                ] + [
                    ft.Row(
                        controls=[
                            ft.Text(f"{stats['correct']}/{stats['total']}", size=13, weight=ft.FontWeight.BOLD),
                            ft.Text(":", size=13),
                            ft.Text(key, size=13),
                        ],
                        rtl=True,
                        alignment=ft.MainAxisAlignment.START,
                    )
                    for key, stats in type_stats.items()
                ] if type_stats else []),
                tight=True,
                rtl=True,
                scroll=ft.ScrollMode.AUTO,
            ),
            actions=[
                ft.FilledButton("סגור", on_click=lambda e: self._close_result_dialog(e, result_dialog)),
                ft.OutlinedButton("סקור תשובות", on_click=lambda e: self._review_answers(result_dialog)),
            ],
            actions_alignment=ft.MainAxisAlignment.END,
            content_padding=ft.Padding(20, 20, 20, 10),
            shape=ft.RoundedRectangleBorder(radius=12),
        )
        self.page.dialog = result_dialog
        if result_dialog not in self.page.overlay:
            self.page.overlay.append(result_dialog)
        result_dialog.open = True
        self.page.update()

    def _close_result_dialog(self, e: ft.ControlEvent, dialog: ft.AlertDialog) -> None:
        dialog.open = False
        self.page.update()
        self._show_history_view()

    def _review_answers(self, dialog: ft.AlertDialog) -> None:
        """Allow user to review their answers after quiz completion"""
        dialog.open = False
        self.page.update()
        self.quiz_submitted = True  # Mark quiz as submitted for indicators
        self.current_index = 0

        self._show_question()
        self._show_quiz_view()

    # Keyboard handling ---------------------------------------------------

    def _handle_keyboard(self, e: ft.KeyboardEvent) -> None:
        # Handle keyboard shortcuts in dialogs
        if self.page.dialog and self.page.dialog.open:
            if e.key == "Escape":
                self.page.dialog.open = False
                self.page.update()
            return

        if e.key == "F1" or e.key == "?":
            self._show_help_dialog()
            return

        if self.content_container.content is not self.quiz_view:
            return

        key = e.key
        # Navigation keys for next question (Left arrow = next in RTL)
        if key in {"ArrowLeft", "Arrow Left", "PageDown", "Page Down"}:
            self._go_next()
        # Navigation keys for previous question (Right arrow = previous in RTL)
        elif key in {"ArrowRight", "Arrow Right", "PageUp", "Page Up"}:
            self._go_previous()
        # Submit quiz
        elif key == "Enter":
            self._submit_quiz()
        # Number keys for selecting options
        elif key and len(key) == 1 and key.isdigit():
            index = int(key)
            if index in self.option_controls:
                self._select_option(index)
        elif key.startswith("Digit") and len(key) > 5:
            try:
                index = int(key[5:])
                if index in self.option_controls:
                    self._select_option(index)
            except:
                pass
        elif key.startswith("Numpad") and len(key) > 6:
            try:
                index = int(key[6:])
                if index in self.option_controls:
                    self._select_option(index)
            except:
                pass


def main(page: ft.Page) -> None:
    db_path = user_data_dir() / "theory_quiz.db"
    questions_db_path = resource_dir() / "questions.db"

    # Initialize Questions DB
    questions_db = QuestionsDatabase(questions_db_path)
    questions = questions_db.load_questions()

    if not questions:
        # Fallback to CSV if DB is empty or not populated?
        # User wants to transfer, so I assume they used migrate.py or expect it to work.
        # But for safety, I can keep CSV fallback if I wanted, but the signature of App changed to expect db.
        # Use simple fallback if questions empty?
        page.snack_bar = ft.SnackBar(ft.Text("לא נמצאו שאלות במסד הנתונים"), bgcolor=ft.Colors.ERROR)
        page.snack_bar.open = True
        page.update()
        return

    database = Database(db_path)

    def _on_close(e: ft.ControlEvent) -> None:
        database.close()

    page.on_close = _on_close
    TheoryQuizApp(page, questions, database, questions_db)


if __name__ == "__main__":
    ft.run(main)
