#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
超级错题本启动脚本
"""

import os
import sys
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 添加项目根目录到Python路径
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(project_root)

# 导入应用
from SuperErrorLog.app import app

if __name__ == '__main__':
    # 获取配置
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', 8080))
    debug = os.getenv('DEBUG', 'False').lower() in ('true', '1', 't')
    
    # 打印启动信息
    print(f"启动超级错题本应用...")
    print(f"服务器地址: http://{host}:{port}")
    if debug:
        print("调试模式: 开启")
    
    # 启动应用
    app.run(host=host, port=port, debug=debug) 