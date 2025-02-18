import gradio as gr
from api_clients.qwen_vl_max_client import QwenVLMaxClient
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv('/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm-api-testing/.env')

# Get the API key from the environment variable
api_key = os.getenv("qwen_api_key")
client = QwenVLMaxClient(api_key=api_key)

def process_image(image=None):
    if image:
        try:
            result = client.inference(image)
            print("识别结果:", result)
            return result
        except Exception as e:
            print(f"处理失败: {str(e)}")
            return {"error": str(e)}
    else:
        return "请上传图片"

with gr.Blocks() as demo:
    gr.Markdown("## 题目解析")
    gr.Markdown("上传一张包含题目和学生解答的图片，系统将自动提取题目内容和学生答案。")
    gr.Markdown("支持的图片格式：JPG、JPEG、PNG、WEBP")

    with gr.Row():
        img_input = gr.Image(
            type="filepath",
            label="上传图片"
        )

    output_text = gr.JSON(label="解析结果")
    submit_button = gr.Button("提交解析")

    # 添加示例图片
    gr.Examples(
        examples=[
            "/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm-api-testing/temp_file/测试示例.png"
        ],
        inputs=img_input,
        outputs=output_text,
        fn=process_image,
        cache_examples=True
    )

    submit_button.click(fn=process_image, inputs=[img_input], outputs=[output_text])
