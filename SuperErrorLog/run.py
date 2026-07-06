#!/usr/bin/env python
import sys
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

load_dotenv()

from SuperErrorLog import config
from SuperErrorLog.app import create_app

app = create_app()


if __name__ == "__main__":
    print("启动超级错题本应用...")
    print(f"服务器地址: http://{config.HOST}:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
