import uuid
import os
import logging
import time
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    abort,
    flash,
    redirect,
    render_template,
    request,
    g,
    send_from_directory,
    url_for,
)
from werkzeug.datastructures import FileStorage
from PIL import Image

from SuperErrorLog import config as default_config
from SuperErrorLog.database.models import ErrorLogDatabase
from SuperErrorLog.services.ai_service import AIService
from SuperErrorLog.services.review_scheduler import schedule_next_review
from SuperErrorLog.services.stats_service import StatsService


STATUS_LABELS = {
    "pending": "待确认",
    "confirmed": "已确认",
    "new": "新错题",
    "learned": "会了",
    "fuzzy": "模糊",
    "wrong_again": "又错了",
}

REVIEW_LABELS = {
    "known": "会了",
    "fuzzy": "模糊",
    "wrong": "又错了",
}

FOCUS_REGION_HINTS = {
    "full": None,
    "left": "只识别图片左半部分，忽略右半部分题目",
    "right": "只识别图片右半部分，忽略左半部分题目",
    "upper_left": "只识别图片左上区域，忽略其他题目",
    "upper_right": "只识别图片右上区域，忽略其他题目",
    "lower_left": "只识别图片左下区域，忽略其他题目",
    "lower_right": "只识别图片右下区域，忽略其他题目",
}


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    app = Flask(
        __name__,
        static_folder=str(default_config.STATIC_FOLDER),
        template_folder=str(default_config.TEMPLATES_FOLDER),
    )
    _load_config(app, test_config)
    _ensure_runtime_dirs(app)

    app.db = ErrorLogDatabase(app.config["DATABASE_PATH"])
    app.ai_service = AIService.from_config(app.config)
    app.stats_service = StatsService(app.db)

    configure_logging(app)
    register_template_helpers(app)
    register_routes(app)
    return app


def _load_config(app: Flask, test_config: dict[str, Any] | None) -> None:
    app.config.update(
        APP_NAME=default_config.APP_NAME,
        APP_VERSION=default_config.APP_VERSION,
        SECRET_KEY=os.getenv("SECRET_KEY", default_config.SECRET_KEY),
        DATABASE_PATH=os.getenv("DATABASE_PATH", str(default_config.DATABASE_PATH)),
        UPLOAD_FOLDER=os.getenv("UPLOAD_FOLDER", str(default_config.UPLOAD_FOLDER)),
        ALLOWED_EXTENSIONS=default_config.ALLOWED_EXTENSIONS,
        MAX_CONTENT_LENGTH=int(
            os.getenv("MAX_CONTENT_LENGTH", str(default_config.MAX_CONTENT_LENGTH))
        ),
        AI_MODE=os.getenv("AI_MODE", default_config.AI_MODE).lower(),
        DASHSCOPE_API_KEY=os.getenv("DASHSCOPE_API_KEY", default_config.DASHSCOPE_API_KEY),
        DASHSCOPE_BASE_URL=os.getenv(
            "DASHSCOPE_BASE_URL",
            default_config.DASHSCOPE_BASE_URL,
        ),
        DASHSCOPE_MODEL=os.getenv("DASHSCOPE_MODEL", default_config.DASHSCOPE_MODEL),
        LOG_DIR=os.getenv("LOG_DIR", str(default_config.LOG_DIR)),
        LOG_LEVEL=os.getenv("LOG_LEVEL", default_config.LOG_LEVEL),
    )
    if test_config:
        app.config.update(test_config)

    app.config["DATABASE_PATH"] = str(Path(app.config["DATABASE_PATH"]))
    app.config["UPLOAD_FOLDER_PATH"] = Path(app.config["UPLOAD_FOLDER"])
    app.config["LOG_DIR_PATH"] = Path(app.config["LOG_DIR"])


def _ensure_runtime_dirs(app: Flask) -> None:
    Path(app.config["DATABASE_PATH"]).parent.mkdir(parents=True, exist_ok=True)
    app.config["UPLOAD_FOLDER_PATH"].mkdir(parents=True, exist_ok=True)
    app.config["LOG_DIR_PATH"].mkdir(parents=True, exist_ok=True)


def configure_logging(app: Flask) -> None:
    log_level = getattr(logging, str(app.config["LOG_LEVEL"]).upper(), logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    log_file = app.config["LOG_DIR_PATH"] / "app.log"

    app.logger.handlers.clear()
    app.logger.setLevel(log_level)
    app.logger.propagate = False

    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setLevel(log_level)
    file_handler.setFormatter(formatter)
    app.logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(log_level)
    console_handler.setFormatter(formatter)
    app.logger.addHandler(console_handler)

    ai_logger = logging.getLogger("SuperErrorLog.services.ai_service")
    ai_logger.setLevel(log_level)
    ai_logger.handlers.clear()
    ai_logger.addHandler(file_handler)
    ai_logger.addHandler(console_handler)
    ai_logger.propagate = True

    app.logger.info(
        "app_start ai_mode=%s database=%s upload_folder=%s log_file=%s",
        app.config["AI_MODE"],
        app.config["DATABASE_PATH"],
        app.config["UPLOAD_FOLDER"],
        log_file,
    )


def register_routes(app: Flask) -> None:
    @app.before_request
    def log_request_start():
        g.request_started_at = time.perf_counter()
        g.request_id = uuid.uuid4().hex[:12]
        app.logger.info(
            "request_start request_id=%s method=%s path=%s remote_addr=%s",
            g.request_id,
            request.method,
            request.path,
            request.remote_addr,
        )

    @app.after_request
    def log_request_end(response):
        elapsed_ms = int((time.perf_counter() - g.request_started_at) * 1000)
        app.logger.info(
            "request_end request_id=%s method=%s path=%s status=%s elapsed_ms=%s",
            g.request_id,
            request.method,
            request.path,
            response.status_code,
            elapsed_ms,
        )
        return response

    @app.route("/")
    def index():
        return redirect(url_for("upload"))

    @app.route("/upload", methods=["GET", "POST"])
    def upload():
        if request.method == "GET":
            return render_template("upload.html")

        file = request.files.get("file")
        if not file or not file.filename:
            app.logger.warning("upload_rejected reason=missing_file")
            flash("请选择一张错题图片。", "warning")
            return redirect(url_for("upload"))

        try:
            image_path = save_uploaded_image(file, app.config["UPLOAD_FOLDER_PATH"])
        except ValueError as exc:
            app.logger.warning("upload_rejected reason=%s", exc)
            flash(str(exc), "warning")
            return redirect(url_for("upload"))

        absolute_image_path = app.config["UPLOAD_FOLDER_PATH"] / image_path
        focus_region = request.form.get("focus_region", "full")
        analysis_image_path = prepare_analysis_image(absolute_image_path, focus_region)
        app.logger.info(
            "upload_saved image_path=%s analysis_image=%s focus_region=%s",
            image_path,
            analysis_image_path,
            focus_region,
        )
        analysis = app.ai_service.analyze(
            str(analysis_image_path),
            focus_hint=FOCUS_REGION_HINTS.get(focus_region),
        )
        log_id = app.db.create_error_log(
            image_path=image_path,
            fields=analysis.fields,
            raw_ai_response=analysis.raw_response,
            ai_parse_error=analysis.parse_error,
        )
        app.logger.info(
            "error_log_created log_id=%s image_path=%s confirm_status=pending ai_ok=%s raw_len=%s parse_error=%s",
            log_id,
            image_path,
            analysis.parse_error is None,
            len(analysis.raw_response or ""),
            bool(analysis.parse_error),
        )

        if analysis.parse_error:
            flash("原图已保存，AI 解析失败，请在详情页手动校对。", "warning")
        else:
            flash("原图已保存，AI 已生成待确认信息。", "success")
        return redirect(url_for("view_log", log_id=log_id))

    @app.route("/logs")
    def logs():
        return render_template("logs.html", error_logs=app.db.list_error_logs())

    @app.route("/logs/<int:log_id>")
    def view_log(log_id: int):
        log = app.db.get_error_log(log_id)
        if log is None:
            flash("错题记录不存在。", "warning")
            return redirect(url_for("logs"))
        return render_template(
            "detail.html",
            log=log,
            review_records=app.db.list_review_records(log_id),
        )

    @app.route("/logs/<int:log_id>/confirm", methods=["POST"])
    def confirm_log(log_id: int):
        ok = app.db.confirm_error_log(
            log_id,
            fields={
                "question": request.form.get("question", ""),
                "student_answer": request.form.get("student_answer", ""),
                "solution": request.form.get("solution", ""),
                "error_reason": request.form.get("error_reason", ""),
                "subject": request.form.get("subject", ""),
                "knowledge_point": request.form.get("knowledge_point", ""),
            },
        )
        if not ok:
            app.logger.warning("confirm_failed log_id=%s", log_id)
            abort(404)
        app.logger.info("error_log_confirmed log_id=%s", log_id)
        flash("错题已确认，并已进入复习队列。", "success")
        return redirect(url_for("view_log", log_id=log_id))

    @app.route("/review")
    def review_queue():
        return render_template("review_queue.html", error_logs=app.db.list_due_reviews())

    @app.route("/review/<int:log_id>", methods=["POST"])
    def submit_review(log_id: int):
        result = request.form.get("result", "")
        schedule = schedule_next_review(result)
        ok = app.db.record_review(
            log_id,
            result=schedule.result,
            mastery_status=schedule.mastery_status,
            next_review_at=schedule.next_review_at,
        )
        if not ok:
            app.logger.warning("review_submit_failed log_id=%s result=%s", log_id, result)
            abort(404)
        app.logger.info(
            "review_submitted log_id=%s result=%s next_review_at=%s",
            log_id,
            schedule.result,
            schedule.next_review_at.isoformat(),
        )
        flash("复习反馈已记录，下一次复习时间已更新。", "success")
        return redirect(url_for("review_queue"))

    @app.route("/stats")
    def stats():
        return render_template("stats.html", stats=app.stats_service.get_summary())

    @app.route("/uploads/<path:filename>")
    def uploaded_file(filename: str):
        return send_from_directory(app.config["UPLOAD_FOLDER_PATH"], filename)

    @app.route("/features")
    def features():
        return redirect(url_for("stats"))

    @app.route("/pricing")
    def pricing():
        return redirect(url_for("stats"))

    @app.route("/search")
    def search():
        return redirect(url_for("logs"))

    @app.errorhandler(404)
    def page_not_found(error):
        return render_template("404.html"), 404

    @app.errorhandler(500)
    def server_error(error):
        return render_template("500.html"), 500


def save_uploaded_image(file: FileStorage, upload_root: Path) -> str:
    original_name = file.filename or ""
    extension = Path(original_name).suffix.lower().lstrip(".")
    if not extension:
        raise ValueError("请上传 PNG、JPG、JPEG 或 WEBP 格式的图片。")

    if extension not in default_config.ALLOWED_EXTENSIONS:
        raise ValueError("不支持的文件类型，请上传 PNG、JPG、JPEG 或 WEBP 格式的图片。")

    today_dir = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    target_dir = upload_root / today_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.{extension}"
    target_path = target_dir / filename
    file.save(target_path)
    return f"{today_dir}/{filename}"


def prepare_analysis_image(image_path: Path, focus_region: str) -> Path:
    if focus_region not in FOCUS_REGION_HINTS or focus_region == "full":
        return image_path

    with Image.open(image_path) as image:
        width, height = image.size
        boxes = {
            "left": (0, 0, width // 2, height),
            "right": (width // 2, 0, width, height),
            "upper_left": (0, 0, width // 2, height // 2),
            "upper_right": (width // 2, 0, width, height // 2),
            "lower_left": (0, height // 2, width // 2, height),
            "lower_right": (width // 2, height // 2, width, height),
        }
        cropped = image.crop(boxes[focus_region])
        analysis_dir = image_path.parent / "_analysis"
        analysis_dir.mkdir(parents=True, exist_ok=True)
        analysis_path = analysis_dir / f"{image_path.stem}_{focus_region}{image_path.suffix}"
        cropped.save(analysis_path)
    return analysis_path


def register_template_helpers(app: Flask) -> None:
    @app.context_processor
    def inject_labels():
        return {
            "status_labels": STATUS_LABELS,
            "review_labels": REVIEW_LABELS,
            "app_name": app.config["APP_NAME"],
            "app_version": app.config["APP_VERSION"],
        }

    @app.template_filter("format_date")
    def format_date(value):
        if not value:
            return ""
        if isinstance(value, str):
            try:
                value = datetime.fromisoformat(value)
            except ValueError:
                return value
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone().strftime("%Y-%m-%d %H:%M")


if __name__ == "__main__":
    app = create_app()
    app.run(host=default_config.HOST, port=default_config.PORT, debug=default_config.DEBUG)
