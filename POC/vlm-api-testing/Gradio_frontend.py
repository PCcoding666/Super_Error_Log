import gradio as gr
from api_clients.qwen_vl_max_client import QwenVLMaxClient

api_key = "your_actual_api_key_here"
client = QwenVLMaxClient(api_key=api_key)

def process_image(image=None, url=None):
    if image:
        return client.inference(image, is_base64=True)
    elif url:
        return client.inference(url, is_base64=False)
    else:
        return "请上传图片或输入 URL"

with gr.Blocks() as demo:
    gr.Markdown("## 题目 OCR 解析")

    with gr.Row():
        img_input = gr.Image(type="filepath", label="上传图片")
        url_input = gr.Textbox(label="或输入公网 URL")

    output_text = gr.JSON(label="解析结果")
    submit_button = gr.Button("提交")

    submit_button.click(fn=process_image, inputs=[img_input, url_input], outputs=[output_text])

demo.launch(server_name="0.0.0.0", server_port=7860)