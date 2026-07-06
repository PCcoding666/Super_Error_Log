import openai
import os
import json

class DeepSeekR1Client:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.client = openai.OpenAI(
            api_key=self.api_key,
            base_url="https://api.deepseek.com/v1"
        )
    
    def inference(self, qwen_vl_max_result: str) -> dict:
        """
        发送qwen-vl-max的返回结果给 DeepSeek V3进行推理
        :param qwen_vl_max_result: qwen-vl-max的返回结果
        :return: DeepSeek R1的返回结果
        """
        prompt = "你是一位高阶推理与讲解模型。下面提供给你的输入是一段来自 qwen-vl-max 模型的 JSON 输出，其中包含题目信息和学生的答案。请阅读并解析该 JSON 内容，尤其是其中的题目部分（通常位于 message.content 的 JSON 字段中）。在理解题目后，请根据要求，仅输出一个 JSON 格式的对象，并且保证包含以下五个键，且不得包含任何多余信息：1. “solution”：题目的正确解法，请用 Markdown 格式描述，包括必要的公式、步骤和推理过程。2. “student_error_reason”：简要说明学生出现错误或失分的主要原因。3. “level_1_title”：该题目所属的一级标题（如学科类型，例：“数学”）。4. “level_2_title”：该题目所属的二级标题（如具体知识模块，例：“圆锥曲线”）。5. “level_3_title”：该题目所属的三级标题（对知识点的高度概括，例：“圆锥曲线的定义”）。注意：• 输出的内容必须且只包含这五个键值对。• 你的回答应当完全遵循 JSON 对象 的格式，不要包含额外的说明、前后缀或文本。• 在 \"solution\" 字段中，使用 Markdown 展示你的解题思路，允许使用如代码块、公式等标记，但仍需符合 JSON 字符串规范（可用反引号 ` 来表示代码块内容）。以下为示例的输出格式（务必符合 JSON 语法）：{\"solution\": \"...\",\"student_error_reason\": \"...\",\"level_1_title\": \"...\",\"level_2_title\": \"...\",\"level_3_title\": \"...\"}"
        try:
            print("[调试信息] 发送请求到 DeepSeek API...")
            response = self.client.chat.completions.create(
                model="deepseek-chat",
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": qwen_vl_max_result},
                ],
                response_format={"type": "json_object"}
            )
            print("[调试信息] DeepSeek API 请求成功，正在处理响应...")

            response_content = response.choices[0].message.content
            print(f"[调试信息] DeepSeek 返回的原始内容: {response_content}")

            if not response_content.strip():
                raise ValueError("DeepSeek 返回的内容为空，请检查 API 响应。")

            # 尝试解析 JSON
            try:
                response_json = json.loads(response_content)
                print("[调试信息] DeepSeek 返回的内容已成功解析为 JSON。")
                return response_json
            except json.JSONDecodeError as e:
                print(f"[调试信息] DeepSeek 返回的内容不是有效的 JSON 格式: {e}")
                raise ValueError("DeepSeek 返回的内容不是有效的 JSON 格式。")

        except Exception as e:
            print(f"异常信息: {e}")
            raise

if __name__ == "__main__":
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise ValueError("DEEPSEEK_API_KEY must be set")
    client = DeepSeekR1Client(api_key=api_key)
    qwen_vl_max_result='{"question": "如图1，在平行四边形ABCD中，AB=2BC=4，∠ABC=60°，E为CD的中点。将△ADE沿AE折起，连接BD与CE，如图2。\n(1) 当BD为何值时，平面ADE⊥平面ABCE？\n(2) 设BF=λBD(0≤λ≤1)，当BE⊥DE时，是否存在实数λ，使得直线AF与平面ABCE所成角的正弦值为√3/2？若存在，求出λ的值；若不存在，请说明理由。\n(3) 当三棱锥B-CDE的体积最大时，求三棱锥D-ABE的内切球的半径。",  "student_answer": "AP=DE=2，∠ADE\n△ADE≌△DAE，AE=AD=2\nCBE=120\nBE²=12\nBE=2√3 BE=2 AB=4\n则AE²+BE²=AB²\n故BE⊥AE\n若平面ADE⊥平面ABCE\n由平面ADE⊥平面ABCE→AE\nBEC平面ABCE，BE⊥AE BD=4\n∴BE=2√3 DE=2 BD=4\n则BE²+DE²=BD²\n∴BE⊥DE且BE⊥AE，AE∩DE=E，DE⊂平面ADE\n∴BE⊥平面ADE\n又BE⊂平面ABCE ∴平面ADE⊥平面ABCE\n∴EG⊥AE EG⊂平面ABCE\n∴EG⊥平面ABCE BE⊂平面ADE 则EG⊥BE"}'
    try:
        result = client.inference(qwen_vl_max_result=qwen_vl_max_result)
        print("推理结果:", result)
    except Exception as e:
        print(f"执行失败: {e}")
