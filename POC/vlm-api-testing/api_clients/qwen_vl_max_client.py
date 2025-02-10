from dotenv import load_dotenv
import os
import requests
from api_clients.base_client import BaseVLMClient

class QwenVLMaxClient(BaseVLMClient):
    """
    Qwen-VL-Max API 客户端实现
    """

    def __init__(self):
        """
        初始化客户端
        """
        load_dotenv()
        self.api_key = os.getenv("qwen_api_key")
        self.base_url = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"

    def analyze_image(self, image_path: str) -> dict:
        """
        调用 Qwen-VL-Max API 分析图片的逻辑
        :param image_path: 图片文件路径
        :return: {'question': '题目内容', 'student_answer': '答题过程'}
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        data = {
            "model": "qwen-vl-plus",
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": image_path}}
                ]}
            ]
        }
        response = requests.post(self.base_url, headers=headers, json=data)
        if response.status_code == 200:
            result = response.json()
            question = result.get("output", {}).get("choices", [{}])[0].get("message", {}).get("content", "未识别到题目")
            student_answer = "未识别到答题过程"  # Assuming the API provides this in a different way
            return {
                "question": question,
                "student_answer": student_answer
            }
        else:
            raise Exception(f"API request failed with status code {response.status_code}: {response.text}")
