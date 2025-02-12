from dotenv import load_dotenv
import os
import requests
import base64

# Load environment variables from .env file
load_dotenv()

class QwenVLMaxClient:
    def __init__(self, api_key=None, base_url=None):
        self.api_key = api_key or os.getenv("qwen_api_key")
        self.base_url = base_url or "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        # Debug: Print the API key to verify it's loaded correctly
        # print(f"Loaded API Key: {self.api_key}")

    def analyze_image(self, image_path):
        # Read the image file and encode it to base64
        with open(image_path, "rb") as image_file:
            base64_encoded_image = base64.b64encode(image_file.read()).decode('utf-8')

        # Prepare the request payload
        text_content = (
            "我上传的是一张学生的题目图片，其中一定包含题目本身，并且可能包含学生的解题过程。"
            "我希望模型输出一个 JSON 格式的文件，其中包含两个键：\"question\" 和 \"student_answer\"。\n\n"
            "\"question\" 键的值应为图片中题目的完整内容，使用 Markdown 格式。\n"
            "\"student_answer\" 键的值应为图片中学生的实际作答过程（如果存在），使用 Markdown 格式；"
            "如果图片中未包含学生作答过程，则输出 \"\"（空字符串）。\n"
            "请严格按照图片内容提取，不要自行推理或补充额外信息。请直接输出 JSON，不要添加额外的说明文字。"
        )

        payload = {
            "model": "qwen-vl-plus",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text_content},
                        {"type": "image_base64", "image_base64": {"data": base64_encoded_image}}
                    ]
                }
            ]
        }

        # Send the request to the API
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        response = requests.post(
            f"{self.base_url}/chat/completions",
            json=payload,
            headers=headers
        )

        # Check for errors in the response
        if response.status_code != 200:
            raise Exception(f"API request failed with status code {response.status_code}: {response.text}")

        # Parse the response
        result = response.json()
        return {
            "question": result.get("question", "未识别到题目"),
            "student_answer": result.get("student_answer", "未识别到答题过程")
        }
    

def test_qwen_vl_max_client():
    # Initialize the client with a dummy API key
    client = QwenVLMaxClient()

    # Define a dummy image path (this should be a valid image file path for a real test)
    dummy_image_path = "/home/pcuser/Myproject/Super_Error_Log/POC/vlm-api-testing/temp_file/测试示例.png"

    try:
        # Call the analyze_image method
        result = client.analyze_image(dummy_image_path)

        # Print the result for inspection
        print("Test Result:", result)

        # Check if the result contains expected keys
        assert "question" in result, "Result should contain 'question'"
        assert "student_answer" in result, "Result should contain 'student_answer'"

        print("Test passed.")
    except Exception as e:
        print("Test failed:", str(e))

# Run the test case
test_qwen_vl_max_client()
