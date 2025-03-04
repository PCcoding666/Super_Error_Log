import os

# API密钥配置
QWEN_API_KEY = os.getenv("QWEN_API_KEY", "sk-684e72cf6479433cad644344f537ef5f")  # 默认使用环境变量，如果没有则使用默认值
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "sk-d4d0ca7b5bc04c5d8b0c3c37e323f005")  # 默认使用环境变量，如果没有则使用默认值

# 应用配置
APP_NAME = "超级错题本"
APP_VERSION = "1.0.0"

# 服务器配置
HOST = "0.0.0.0"
PORT = 8080

# 静态文件配置
STATIC_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TEMPLATES_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")

# 数据库配置
DATABASE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "error_log.db")

# 上传文件配置
UPLOAD_FOLDER = os.path.join(STATIC_FOLDER, "uploads")
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp'} 