import io
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from PIL import Image

from SuperErrorLog.app import create_app, prepare_analysis_image
from SuperErrorLog.services.ai_service import (
    AIService,
    DashScopeAIProvider,
    REAL_AI_SYSTEM_PROMPT,
    REAL_AI_USER_PROMPT,
)


PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00"
    b"\x00\x00\nIDATx\x9cc\xf8\x0f\x00\x01\x01\x01\x00"
    b"\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_MODE", "mock")
    app = create_app(
        {
            "TESTING": True,
            "DATABASE_PATH": str(tmp_path / "error_log_test.db"),
            "UPLOAD_FOLDER": str(tmp_path / "uploads"),
            "LOG_DIR": str(tmp_path / "logs"),
            "AI_MODE": "mock",
            "WTF_CSRF_ENABLED": False,
        }
    )
    return app


@pytest.fixture()
def client(app):
    return app.test_client()


def upload_sample(client):
    return client.post(
        "/upload",
        data={"file": (io.BytesIO(PNG_BYTES), "mistake.png")},
        content_type="multipart/form-data",
        follow_redirects=False,
    )


def upload_sample_with_filename(client, filename):
    return client.post(
        "/upload",
        data={"file": (io.BytesIO(PNG_BYTES), filename)},
        content_type="multipart/form-data",
        follow_redirects=False,
    )


def upload_sample_with_focus_region(client, focus_region):
    image_bytes = io.BytesIO()
    Image.new("RGB", (100, 80), "white").save(image_bytes, format="PNG")
    image_bytes.seek(0)
    return client.post(
        "/upload",
        data={
            "file": (image_bytes, "mistake.png"),
            "focus_region": focus_region,
        },
        content_type="multipart/form-data",
        follow_redirects=False,
    )


def confirm_log(client, log_id, **overrides):
    form = {
        "question": "3 + 5 = ?",
        "student_answer": "6",
        "solution": "3 + 5 = 8",
        "error_reason": "加法进位意识薄弱",
        "subject": "数学",
        "knowledge_point": "整数加法",
    }
    form.update(overrides)
    return client.post(f"/logs/{log_id}/confirm", data=form, follow_redirects=False)


def test_app_can_be_created(app):
    assert app.testing is True
    assert app.config["AI_MODE"] == "mock"


def test_real_ai_provider_configuration_is_read_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_MODE", "real")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-env-key")
    monkeypatch.setenv(
        "DASHSCOPE_BASE_URL",
        "https://example.test/compatible-mode/v1",
    )
    monkeypatch.setenv("DASHSCOPE_MODEL", "qwen3.7-plus")
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "env_config.db"))
    monkeypatch.setenv("UPLOAD_FOLDER", str(tmp_path / "env_uploads"))
    monkeypatch.setenv("LOG_DIR", str(tmp_path / "env_logs"))

    env_app = create_app({"TESTING": True})

    assert env_app.config["AI_MODE"] == "real"
    assert isinstance(env_app.ai_service.provider, DashScopeAIProvider)
    assert env_app.ai_service.provider.api_key == "test-env-key"
    assert env_app.ai_service.provider.base_url == "https://example.test/compatible-mode/v1"
    assert env_app.ai_service.provider.model == "qwen3.7-plus"


def test_real_ai_prompt_forbids_mock_or_placeholder_content():
    combined_prompt = f"{REAL_AI_SYSTEM_PROMPT}\n{REAL_AI_USER_PROMPT}"

    assert "面向初中学生" in combined_prompt
    assert "原图是唯一事实来源" in combined_prompt
    assert "不允许输出 “Mock AI”" in combined_prompt
    assert "json.loads" in combined_prompt
    assert "请根据原图校对" in combined_prompt
    assert "Mock AI 识别题目" not in combined_prompt


def test_database_tables_are_created(app):
    with sqlite3.connect(app.config["DATABASE_PATH"]) as conn:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }

    assert "error_logs" in names
    assert "review_records" in names


def test_mock_ai_returns_structured_fields(app):
    service = AIService.from_config(app.config)

    analysis = service.analyze("sample.png")

    assert analysis.raw_response
    assert analysis.parse_error is None
    assert set(analysis.fields) == {
        "question",
        "student_answer",
        "solution",
        "error_reason",
        "subject",
        "knowledge_point",
    }
    assert analysis.fields["knowledge_point"]


def test_ai_service_forwards_student_focus_hint():
    class RecordingProvider:
        def __init__(self):
            self.image_path = None
            self.focus_hint = None

        def analyze(self, image_path, focus_hint=None):
            self.image_path = image_path
            self.focus_hint = focus_hint
            return "{}"

    provider = RecordingProvider()
    service = AIService(provider)

    analysis = service.analyze("sample.png", focus_hint="只识别左下区域")

    assert provider.image_path == "sample.png"
    assert provider.focus_hint == "只识别左下区域"
    assert analysis.parse_error is not None


def test_prepare_analysis_image_crops_lower_left_region(tmp_path):
    source = tmp_path / "source.png"
    Image.new("RGB", (100, 80), "white").save(source)

    analysis_path = prepare_analysis_image(source, "lower_left")

    assert analysis_path != source
    with Image.open(analysis_path) as cropped:
        assert cropped.size == (50, 40)


def test_upload_saves_image_and_creates_pending_log(client, app):
    response = upload_sample(client)

    assert response.status_code == 302
    log = app.db.get_error_log(1)
    assert log is not None
    assert log["confirm_status"] == "pending"
    assert log["raw_ai_response"]
    assert log["ai_parse_error"] is None
    assert (app.config["UPLOAD_FOLDER_PATH"] / log["image_path"]).exists()


def test_upload_passes_focus_region_to_ai_without_replacing_source_image(client, app):
    class RecordingProvider:
        def __init__(self):
            self.image_path = None
            self.focus_hint = None

        def analyze(self, image_path, focus_hint=None):
            self.image_path = image_path
            self.focus_hint = focus_hint
            return "{}"

    provider = RecordingProvider()
    app.ai_service = AIService(provider)

    response = upload_sample_with_focus_region(client, "lower_left")

    assert response.status_code == 302
    log = app.db.get_error_log(1)
    assert log["confirm_status"] == "pending"
    assert (app.config["UPLOAD_FOLDER_PATH"] / log["image_path"]).exists()
    assert provider.focus_hint == "只识别图片左下区域，忽略其他题目"
    assert provider.image_path != str(app.config["UPLOAD_FOLDER_PATH"] / log["image_path"])


def test_upload_accepts_chinese_image_filename(client, app):
    response = upload_sample_with_filename(client, "测试示例.png")

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/logs/1")
    log = app.db.get_error_log(1)
    assert log["confirm_status"] == "pending"
    assert (app.config["UPLOAD_FOLDER_PATH"] / log["image_path"]).exists()


def test_ai_parse_failure_keeps_image_and_pending_log(client, app):
    class InvalidJSONProvider:
        def analyze(self, image_path, focus_hint=None):
            return "not-json"

    app.ai_service = AIService(InvalidJSONProvider())

    response = upload_sample(client)

    assert response.status_code == 302
    log = app.db.get_error_log(1)
    assert log["confirm_status"] == "pending"
    assert log["raw_ai_response"] == "not-json"
    assert log["ai_parse_error"].startswith("AI parse error:")
    assert (app.config["UPLOAD_FOLDER_PATH"] / log["image_path"]).exists()


def test_provider_error_keeps_error_summary_as_raw_response():
    class BrokenProvider:
        def analyze(self, image_path, focus_hint=None):
            raise RuntimeError("network unavailable")

    analysis = AIService(BrokenProvider()).analyze("sample.png")

    assert analysis.fields == {
        "question": "",
        "student_answer": "",
        "solution": "",
        "error_reason": "",
        "subject": "",
        "knowledge_point": "",
    }
    assert "AI provider error:" in analysis.raw_response
    assert "network unavailable" in analysis.raw_response
    assert analysis.parse_error == analysis.raw_response


def test_detail_page_displays_error_log(client, app):
    upload_sample(client)

    response = client.get("/logs/1")

    assert response.status_code == 200
    assert "待确认" in response.get_data(as_text=True)
    assert "Mock AI" in response.get_data(as_text=True)


def test_upload_page_is_student_first_and_does_not_promote_mock_mode(client):
    response = client.get("/upload")
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "今天先做哪一步" in body
    assert "学生" in body
    assert "识别范围" in body
    assert "左下区域" in body
    assert "AI_MODE=mock" not in body
    assert "默认模式" not in body


def test_confirm_updates_fields_status_and_review_due_time(client, app):
    upload_sample(client)

    response = confirm_log(client, 1)

    assert response.status_code == 302
    log = app.db.get_error_log(1)
    assert log["question"] == "3 + 5 = ?"
    assert log["student_answer"] == "6"
    assert log["solution"] == "3 + 5 = 8"
    assert log["error_reason"] == "加法进位意识薄弱"
    assert log["subject"] == "数学"
    assert log["knowledge_point"] == "整数加法"
    assert log["confirm_status"] == "confirmed"
    assert log["confirmed_at"] is not None
    assert log["next_review_at"] is not None


def test_confirmed_due_log_appears_in_review_queue(client, app):
    upload_sample(client)
    confirm_log(client, 1)

    response = client.get("/review")

    assert response.status_code == 200
    assert "整数加法" in response.get_data(as_text=True)


def test_pending_log_does_not_appear_in_review_queue(client):
    upload_sample(client)

    response = client.get("/review")

    assert response.status_code == 200
    assert "暂无到期复习" in response.get_data(as_text=True)


def test_known_feedback_creates_review_and_schedules_seven_days(client, app):
    upload_sample(client)
    confirm_log(client, 1)
    before = datetime.now(timezone.utc)

    response = client.post("/review/1", data={"result": "known"}, follow_redirects=False)

    assert response.status_code == 302
    records = app.db.list_review_records(1)
    log = app.db.get_error_log(1)
    next_review = datetime.fromisoformat(log["next_review_at"])
    assert len(records) == 1
    assert records[0]["result"] == "known"
    assert log["review_count"] == 1
    assert log["mastery_status"] == "learned"
    assert before + timedelta(days=7) <= next_review <= before + timedelta(days=7, seconds=5)


def test_fuzzy_feedback_schedules_three_days(client, app):
    upload_sample(client)
    confirm_log(client, 1)
    before = datetime.now(timezone.utc)

    response = client.post("/review/1", data={"result": "fuzzy"}, follow_redirects=False)

    assert response.status_code == 302
    log = app.db.get_error_log(1)
    next_review = datetime.fromisoformat(log["next_review_at"])
    assert log["mastery_status"] == "fuzzy"
    assert before + timedelta(days=3) <= next_review <= before + timedelta(days=3, seconds=5)


def test_wrong_feedback_schedules_one_day(client, app):
    upload_sample(client)
    confirm_log(client, 1)
    before = datetime.now(timezone.utc)

    response = client.post("/review/1", data={"result": "wrong"}, follow_redirects=False)

    assert response.status_code == 302
    log = app.db.get_error_log(1)
    next_review = datetime.fromisoformat(log["next_review_at"])
    assert log["mastery_status"] == "wrong_again"
    assert before + timedelta(days=1) <= next_review <= before + timedelta(days=1, seconds=5)


def test_stats_include_pending_due_knowledge_points_and_error_reasons(client, app):
    upload_sample(client)
    upload_sample(client)
    confirm_log(client, 1, knowledge_point="整数加法", error_reason="审题不清")
    confirm_log(client, 2, knowledge_point="整数加法", error_reason="审题不清")
    upload_sample(client)

    stats = app.stats_service.get_summary()
    response = client.get("/stats")

    assert stats["pending_count"] == 1
    assert stats["today_due_count"] == 2
    assert stats["top_knowledge_points"][0]["knowledge_point"] == "整数加法"
    assert stats["top_knowledge_points"][0]["count"] == 2
    assert stats["repeated_error_reasons"][0]["error_reason"] == "审题不清"
    assert response.status_code == 200
    assert "待确认" in response.get_data(as_text=True)
    assert "整数加法" in response.get_data(as_text=True)


def test_stats_include_recent_review_completion(client, app):
    upload_sample(client)
    confirm_log(client, 1, knowledge_point="整数加法", error_reason="审题不清")

    client.post("/review/1", data={"result": "known"}, follow_redirects=False)

    stats = app.stats_service.get_summary()
    response = client.get("/stats")
    body = response.get_data(as_text=True)

    assert stats["recent_reviews"][0]["result"] == "known"
    assert stats["recent_reviews"][0]["question"] == "3 + 5 = ?"
    assert response.status_code == 200
    assert "最近复习完成情况" in body
    assert "会了" in body
