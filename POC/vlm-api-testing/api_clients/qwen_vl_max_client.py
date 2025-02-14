import os
import requests
from utils.Image_utils import encode_image_to_base64

class QwenVLMaxClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.endpoint_url = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"

    def inference(self, image_input: str, is_base64: bool = False) -> dict:
        """
        发送图片（公网 URL 或 Base64 编码）给 Qwen 进行 OCR 解析，并严格按照 JSON 格式返回结果。
        :param image_input: 可以是公网 URL 或本地图片路径（如果 is_base64 为 True）
        :param is_base64: 是否使用 Base64 方式上传
        :return: Qwen 返回的 JSON 结果
        """
        # 处理图片输入
        if is_base64:
            try:
                image_url = encode_image_to_base64(image_input, "png")  # 读取本地图片
            except Exception as e:
                raise Exception(f"Base64 编码失败: {str(e)}")
        else:
            image_url = image_input  # 直接使用公网 URL

        text_content = (
            "我上传的是一张学生的题目图片，其中一定包含题目本身，并且可能包含学生的解题过程。\n"
            "请输出 JSON 格式：\n\n"
            "{\n  \"question\": \"图片中题目的完整内容（Markdown格式）\",\n"
            "  \"student_answer\": \"图片中学生的实际作答过程（Markdown格式），如果没有则返回空字符串\" \n}"
            "\n严格按照图片内容逐字逐句提取，不得遗漏任何信息。\n"
            "如果学生解题过程不完整，也必须提取已有部分，不可忽略。\n"
            "不要推测或补充答案，不要输出额外说明！"
        )

        payload = {
            "model": "qwen-vl-max",
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
            "response_format": {"type": "json_object"}  # 强制返回 JSON
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable"
        }

        try:
            response = requests.post(self.endpoint_url, json=payload, headers=headers)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise Exception(f"API 请求失败: {str(e)}")

        try:
            return response.json()
        except ValueError as e:
            raise Exception(f"解析 JSON 失败: {str(e)}")

# --------------------------
# 测试代码
# --------------------------
if __name__ == "__main__":
    api_key = os.getenv("DASHSCOPE_API_KEY", "sk-684e72cf6479433cad644344f537ef5f")
    client = QwenVLMaxClient(api_key=api_key)

    # # 测试公网 URL
    # test_url = "http://www.baidu.com/img/bdlogo.png"
    # print("公网 URL 结果:", client.inference(test_url, is_base64=False))

    # 测试本地 Base64
    test_local_path = "/home/pcuser/Myproject/Super_Error_Log/POC/vlm-api-testing/temp_file/测试示例.png"
    try:
        print("Base64 结果:", client.inference(test_local_path, is_base64=True))
    except Exception as e:
        print(f"测试失败: {str(e)}")
