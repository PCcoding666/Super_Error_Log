from dotenv import load_dotenv
import os
import requests
from api_clients.base_client import BaseVLMClient

class QwenVLMaxClient(BaseVLMClient):
    # ... existing code ...

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
        # 添加 prompt 描述使用场景
        prompt = "我上传的是一张学生的题目，其中一定包含了题目的本身，有可能包含了学生的解题过程。我希望模型输出一个JSON格式的文件，其中包含两个键："
        data = {
            "model": "qwen-vl-plus",
            "messages": [
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": image_path}},
                    {"type": "text", "text": prompt}
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
