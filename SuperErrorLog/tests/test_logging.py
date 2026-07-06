from pathlib import Path

from SuperErrorLog.app import create_app
from SuperErrorLog.services.ai_service import AIService


def test_app_writes_request_logs_to_configured_log_file(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_MODE", "mock")
    log_dir = tmp_path / "logs"
    app = create_app(
        {
            "TESTING": True,
            "DATABASE_PATH": str(tmp_path / "logging.db"),
            "UPLOAD_FOLDER": str(tmp_path / "uploads"),
            "LOG_DIR": str(log_dir),
            "LOG_LEVEL": "INFO",
        }
    )

    response = app.test_client().get("/upload")

    assert response.status_code == 200
    log_file = log_dir / "app.log"
    assert log_file.exists()
    body = log_file.read_text()
    assert "request_start" in body
    assert "request_end" in body
    assert "method=GET" in body
    assert "path=/upload" in body
    assert "status=200" in body


def test_ai_service_logs_provider_errors_without_leaking_api_keys(caplog):
    class BrokenProvider:
        def analyze(self, image_path, focus_hint=None):
            raise RuntimeError("401 invalid key sk-secret-value")

    with caplog.at_level("INFO"):
        analysis = AIService(BrokenProvider()).analyze("sample.png")

    log_text = caplog.text
    assert analysis.parse_error
    assert "ai_analysis_start" in log_text
    assert "ai_provider_error" in log_text
    assert "sk-secret-value" not in log_text
    assert "sk-***" in log_text
