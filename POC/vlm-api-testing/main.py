# main.py
from Gradio_frontend import demo

if __name__ == "__main__":
    # 启动 Gradio Web 界面
    demo.launch(server_name="0.0.0.0", server_port=7860)
