# main.py
from Gradio_frontend import demo

if __name__ == "__main__":
    # 启动 Gradio Web 界面
    demo.launch(
        server_name="0.0.0.0", 
        server_port=7860, 
        share=True,  # 这将创建一个公共链接
        show_error=True  # 显示任何可能的错误
    )