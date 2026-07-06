import json

from openai import OpenAI


class DeepSeekClient:
    """Legacy client kept importable for old scripts."""

    def __init__(self, api_key: str, base_url: str = "https://api.deepseek.com/v1"):
        self.client = OpenAI(api_key=api_key, base_url=base_url)

    def inference(self, qwen_vl_max_result: str) -> dict:
        prompt = (
            "你是一位错题讲解模型。读取输入中的题目和学生答案后，只输出 JSON 对象，"
            "包含 solution, student_error_reason, level_1_title, level_2_title, "
            "level_3_title 五个字符串字段，不要输出额外说明。"
        )
        response = self.client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": qwen_vl_max_result},
            ],
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        if not content or not content.strip():
            raise ValueError("DeepSeek returned an empty response")
        return json.loads(content)
