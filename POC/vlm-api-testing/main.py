import os
import tempfile
import random
import gradio as gr
import numpy as np
from PIL import Image

# 导入 API 客户端和 Markdown 格式化工具
from api_clients.qwen_vl_max_client import QwenVLMaxClient
from utils.markdown_utils import format_markdown_output

# 初始化 Qwen-VL-Max 客户端（api_key请替换为实际的密钥或配置）
client = QwenVLMaxClient(api_key="YOUR_API_KEY")

def process_image(image):
    """
    处理上传的图片，调用 API 客户端进行分析，并返回 Markdown 格式的结果。
    :param image: Gradio 上传的图片，格式为 numpy 数组
    :return: Markdown 格式的字符串，包含题目和学生答题过程
    """
    # 如果 image 为 numpy 数组，则转换为 PIL Image
    if isinstance(image, np.ndarray):
        image = Image.fromarray(image)
    
    # 保存图片到临时文件
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp_file:
        image.save(tmp_file.name)
        tmp_path = tmp_file.name
    
    # 调用 API 客户端，获取分析结果（包含 'question' 与 'student_answer'）
    result = client.analyze_image(tmp_path)
    
    # 删除临时文件
    os.remove(tmp_path)
    
    # 格式化输出为 Markdown 字符串
    markdown_output = format_markdown_output(result)
    return markdown_output

def main():
    """
    主函数，构建 Gradio 界面并启动服务
    """
    title = "视觉大模型 API 测试界面"
    description = "上传图片以识别题目和学生答题过程（数学公式将正确渲染）"
    
    with gr.Blocks() as demo:
        gr.Markdown(f"# {title}")
        gr.Markdown(description)
        with gr.Row():
            image_input = gr.Image(type="numpy", label="上传图片", tool="editor")
        output_text = gr.Markdown(label="识别结果")
        submit_btn = gr.Button("开始识别")
        
        # 点击按钮时调用 process_image 函数
        submit_btn.click(fn=process_image, inputs=image_input, outputs=output_text)
    
    demo.launch()

if __name__ == "__main__":
    main()
