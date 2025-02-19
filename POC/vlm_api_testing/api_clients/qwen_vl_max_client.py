# -*- coding: utf-8 -*-
import io
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding='utf-8')
import openai
import requests

# 修正导入路径
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(project_root)

from utils.Image_utils import upload_image_to_gcs

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
        # 设置使用的模型名称（根据实际情况选择 qwen-vl-max 或 qwen-vl-plus）
        self.model = "qwen-vl-max"

    def inference(self, image_input: str) -> dict:
        """
        发送图片给 Qwen 进行 OCR 解析。
        :param image_input: 本地图片路径
        :return: Qwen 返回的 JSON 结果
        """
        try:
            print(f"开始处理图片: {image_input}")
            
            # 检查输入文件是否存在
            if not os.path.exists(image_input):
                raise Exception(f"输入文件不存在: {image_input}")
            
            # 检查文件格式和大小
            file_extension = os.path.splitext(image_input)[1].lower()
            supported_formats = ['.jpg', '.jpeg', '.png', '.webp']
            if file_extension not in supported_formats:
                raise Exception(f"不支持的文件格式 {file_extension}，支持的格式包括: {supported_formats}")
            
            file_size = os.path.getsize(image_input) / (1024 * 1024)  # 转换为 MB
            print(f"文件大小: {file_size:.2f} MB")
            
            if file_size > 10:
                raise Exception(f"文件太大 ({file_size:.2f} MB)，请确保小于 10MB")
            
            # 上传图片到 GCS 并获取 URL
            image_url = upload_image_to_gcs(
                image_input,
                f"uploads/{os.path.basename(image_input)}"
            )
            print(f"图片已上传到 GCS，URL: {image_url}")

            # 验证 URL 可访问性
            try:
                access_resp = requests.get(image_url, timeout=10)
                access_resp.raise_for_status()
                print(f"URL 可以正常访问，响应状态码: {access_resp.status_code}")
            except requests.exceptions.RequestException as e:
                raise Exception(f"无法访问图片 URL: {str(e)}")

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
                            "type": "image_url",
                            "image_url": {"url": image_url}
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

# 测试代码
if __name__ == "__main__":
    # 请确保环境变量 DASHSCOPE_API_KEY 已经配置正确
    api_key = os.getenv("qwen_api_key", "sk-684e72cf6479433cad644344f537ef5f")
    client = QwenVLMaxClient(api_key=api_key)

    test_image = "/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm_api_testing/temp_file/测试示例.png"
    try:
        result = client.inference(test_image)
        print("识别结果:", result)
    except Exception as e:
        print(f"测试失败: {str(e)}")