import os
import sys
import openai
import requests
import base64

class QwenVLMaxClient:
    def __init__(self, api_key: str):
        """
        初始化客户端。
        :param api_key: DashScope API 密钥
        """
        self.api_key = api_key
        # 使用 OpenAI 兼容客户端初始化，指定基础地址为 DashScope 接口地址
        self.client = openai.OpenAI(
            api_key=self.api_key,
            base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        )
        # 设置使用的模型名称
        self.model = "qwen-vl-max"

    def inference(self, image_path: str) -> dict:
        """
        发送图片给 Qwen 进行 OCR 解析。
        :param image_path: 本地图片路径
        :return: Qwen 返回的 JSON 结果
        """
        try:
            print(f"开始处理图片: {image_path}")
            
            # 检查输入文件是否存在
            if not os.path.exists(image_path):
                raise Exception(f"输入文件不存在: {image_path}")
            
            # 检查文件格式和大小
            file_extension = os.path.splitext(image_path)[1].lower()
            supported_formats = ['.jpg', '.jpeg', '.png', '.webp']
            if file_extension not in supported_formats:
                raise Exception(f"不支持的文件格式 {file_extension}，支持的格式包括: {supported_formats}")
            
            file_size = os.path.getsize(image_path) / (1024 * 1024)  # 转换为 MB
            print(f"文件大小: {file_size:.2f} MB")
            
            if file_size > 10:
                raise Exception(f"文件太大 ({file_size:.2f} MB)，请确保小于 10MB")
            
            # 直接使用本地文件路径
            with open(image_path, "rb") as image_file:
                image_data = image_file.read()
                
            # 构造请求
            messages = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "我上传的是一张学生的题目图片，其中一定包含题目本身，并且可能包含学生的解题过程。\n"
                                "请输出 JSON 格式：\n\n"
                                "{\n  \"question\": \"图片中题目的完整内容（Markdown格式）\",\n"
                                "  \"student_answer\": \"图片中学生的实际作答过程（Markdown格式），如果没有则返回空字符串\"\n"
                                "}\n"
                                "严格按照图片内容逐字逐句提取，不得遗漏任何信息。\n"
                                "如果学生解题过程不完整，也必须提取已有部分，不可忽略。\n"
                                "不要推测或补充答案，不要输出额外说明！"
                            )
                        },
                        {
                            "type": "image",
                            "image_url": {"url": f"data:image/{file_extension[1:]};base64,{base64.b64encode(image_data).decode('utf-8')}"}
                        }
                    ]
                }
            ]

            print("正在发送请求到 Qwen API...")
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=messages
            )
            print("API 响应成功")
            return completion.model_dump()

        except Exception as e:
            print(f"处理失败: {str(e)}")
            raise 