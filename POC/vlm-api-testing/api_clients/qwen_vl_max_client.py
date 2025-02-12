# api_clients/qwen_vl_max_client.py


import os
import requests

class QwenVLMaxClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.endpoint_url = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"

    def inference(self, image_url: str) -> dict:
        """
        发送图片 URL 给 Qwen 进行 OCR 解析，并严格按照 JSON 格式返回结果
        """
        text_content = (
            "我上传的是一张学生的题目图片，其中一定包含题目本身，并且可能包含学生的解题过程。\n"
            "我希望模型输出一个 JSON 格式的文件，其中包含两个键：\"question\" 和 \"student_answer\"。\n\n"
            "\"question\" 键的值应为图片中题目的完整内容，使用 Markdown 格式。\n"
            "\"student_answer\" 键的值应为图片中学生的实际作答过程（如果存在），使用 Markdown 格式；"
            "如果图片中未包含学生作答过程，则输出 \"\"（空字符串）。\n"
            "请严格按照图片内容提取，不要自行推理或补充额外信息。\n"
            "请直接输出 JSON，不要添加额外的说明文字。"
        )

        payload = {
            "model": "qwen-vl-plus",
            "messages": [
                {"role": "system", "content": "你是一个精准的 OCR 解析助手，严格按照图片内容提取信息，不进行推理。"},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text_content},
                        {"type": "image_url", "image_url": {"url": image_url}}
                    ]
                }
            ],
            "response_format": {"type": "json_object"}  # 确保返回 JSON 格式
        }
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable"
        }

        response = requests.post(self.endpoint_url, json=payload, headers=headers)

        if response.status_code != 200:
            raise Exception(f"API 请求失败: {response.status_code}, {response.text}")

        return response.json()

# --------------------------
# 测试代码
# --------------------------
if __name__ == "__main__":
    fake_api_key = os.getenv("qwen_api_key", "sk-684e72cf6479433cad644344f537ef5f")
    print(fake_api_key)
    client = QwenVLMaxClient(api_key=fake_api_key)
    test_image_url = "https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg"  # 这里需要一个有效的公网可访问 URL

    try:
        result = client.inference(test_image_url)
        print("Qwen 推断结果:", result)
    except Exception as e:
        print("测试出现错误:", e)
