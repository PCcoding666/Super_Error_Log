import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent

APP_NAME = "超级错题本"
APP_VERSION = "0.2.0"

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8080"))
DEBUG = os.getenv("DEBUG", "False").lower() in {"1", "true", "t", "yes"}
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")

STATIC_FOLDER = BASE_DIR / "static"
TEMPLATES_FOLDER = BASE_DIR / "templates"
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", str(BASE_DIR / "data" / "error_log.db")))
UPLOAD_FOLDER = Path(os.getenv("UPLOAD_FOLDER", str(STATIC_FOLDER / "uploads")))
MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(10 * 1024 * 1024)))
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}

AI_MODE = os.getenv("AI_MODE", "mock").lower()
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")
DASHSCOPE_BASE_URL = os.getenv(
    "DASHSCOPE_BASE_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
)
DASHSCOPE_MODEL = os.getenv("DASHSCOPE_MODEL", "qwen3.7-plus")

LOG_DIR = Path(os.getenv("LOG_DIR", str(BASE_DIR / "logs")))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
