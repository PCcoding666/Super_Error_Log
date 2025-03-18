# main.py
from Gradio_frontend import GradioApp
from config.config_manager import ConfigManager

if __name__ == "__main__":
    # 初始化配置
    config = ConfigManager()
    
    # 创建并启动 Gradio 应用
    app = GradioApp()
    app.launch(
        server_name=config.get('server_host'),
        server_port=config.get('server_port'),
        share=config.get('share'),
        show_error=True
    )