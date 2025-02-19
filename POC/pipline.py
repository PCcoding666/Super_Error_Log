# -*- coding: utf-8 -*-
"""
修改后的 pipeline_inference 函数示例：
仅从 Qwen 返回的 `choices[0].message.content` 里提取 JSON 中的 question / student_answer，
再与 DeepSeek 返回的内容合并到同一个字典中。
"""

import sys
import os
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding='utf-8')
import json
import re

# 引入你的 API 客户端
from vlm_api_testing.api_clients.qwen_vl_max_client import QwenVLMaxClient
from Reasoning_Compliance_Assessment.api_clients.deepseek_R1_client import DeepSeekR1Client

def pipeline_inference(image_path: str) -> dict:
    """
    1. 通过 QwenVLMaxClient 获取题目与学生答案（只需提取 JSON 的 question、student_answer）。
    2. 将提取结果传给 DeepSeekR1Client，获取推理解答。
    3. 将二者合并后，返回最终 JSON。
    """

    # 1. 初始化客户端（此处写死 key，仅供示例，实际应从环境变量或安全服务获取）
    try:
        qwen_client = QwenVLMaxClient(api_key="sk-684e72cf6479433cad644344f537ef5f")
        deepseek_client = DeepSeekR1Client(api_key="sk-d4d0ca7b5bc04c5d8b0c3c37e323f005")
    except Exception as e:
        print(f"[调试信息] 初始化客户端时出现异常: {e}")
        raise

    # 2. 调用 Qwen 获取原始响应
    try:
        print(f"[调试信息] 即将调用Qwen接口进行推理，image_path: {image_path}")
        qwen_raw_response = qwen_client.inference(image_path)
        print(f"[调试信息] Qwen原始响应: {qwen_raw_response}")
    except Exception as e:
        print(f"[调试信息] 调用Qwen接口时出现异常，image_path={image_path}，错误：{e}")
        raise

    # Qwen 返回的示例类似：
    # {
    #   "choices": [
    #       {
    #           "message": {
    #               "content": "```json\n{...}\n```"
    #           }
    #       }
    #   ],
    #   ...
    # }

    # 3. 提取 content 中的 JSON（示例中是 ```json ...``` 包裹）
    try:
        qwen_content = qwen_raw_response["choices"][0]["message"]["content"]
        print(f"[调试信息] Qwen返回的content字段: {qwen_content}")
    except (KeyError, IndexError) as e:
        print(f"[调试信息] 无法从Qwen返回的响应中获取content字段，请检查返回数据结构。错误：{e}")
        raise ValueError("Qwen 返回的数据结构不符合预期。")

    if not qwen_content.strip():
        raise ValueError("Qwen 返回的内容为空，请检查 API 响应。")

    match = re.search(r'```json\s*(\{.*?\})\s*```', qwen_content, re.DOTALL)
    if not match:
        print("[调试信息] 无法在content中找到 ```json ...``` 的包裹内容。")
        raise ValueError("Qwen 返回内容中未找到符合 ```json ...``` 的结构，请检查 Qwen 响应。")

    qwen_json_str = match.group(1)  # 提取花括号内完整的 JSON 字符串
    print(f"[调试信息] 提取到的Qwen JSON字符串: {qwen_json_str}")

    try:
        qwen_result_dict = json.loads(qwen_json_str)
        print(f"[调试信息] 解析后的Qwen结果字典: {qwen_result_dict}")
    except json.JSONDecodeError as e:
        print(f"[调试信息] Qwen返回的JSON无法解析。错误：{e}，原始JSON: {qwen_json_str}")
        raise ValueError("无法解析Qwen返回的JSON，请检查格式。")

    # 4. 将 Qwen JSON 转为字符串传给 DeepSeek
    qwen_json_for_deepseek = json.dumps(qwen_result_dict, ensure_ascii=False)
    print(f"[调试信息] 传递给DeepSeek的JSON字符串: {qwen_json_for_deepseek}")

# 5. 调用 DeepSeek 并解析返回（DeepSeek 返回包含 solution、student_error_reason 等）
    try:
        print("[调试信息] 开始调用DeepSeek接口...")
        deepseek_result_str = deepseek_client.inference(qwen_vl_max_result=qwen_json_for_deepseek)
        print(f"[调试信息] DeepSeek原始返回字符串: {deepseek_result_str}")
    except Exception as e:
        print(f"[调试信息] 调用DeepSeek接口时出现异常: {e}")
        raise

    # 如果 deepseek_result_str 已经是字典，则不需要再解析
    if isinstance(deepseek_result_str, dict):
        deepseek_result_dict = deepseek_result_str
    else:
        try:
            deepseek_result_dict = json.loads(deepseek_result_str)
            print(f"[调试信息] 解析后的DeepSeek结果字典: {deepseek_result_dict}")
        except json.JSONDecodeError as e:
            print(f"[调试信息] DeepSeek返回的JSON无法解析。错误：{e}，原始JSON: {deepseek_result_str}")
            raise ValueError("无法解析DeepSeek返回的JSON，请检查格式。")

    # 6. 合并两个结果：Qwen（question/student_answer） + DeepSeek（solution、level_1_title 等）
    combined_result = {**qwen_result_dict, **deepseek_result_dict}
    print(f"[调试信息] 合并后的最终结果: {combined_result}")

    return combined_result

# 简单测试
if __name__ == "__main__":
    # 定义本地测试图片路径
    test_image_path = "/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm_api_testing/temp_file/0436e01b9e083856db051b96d662e63d.JPG"

    try:
        final_result = pipeline_inference(test_image_path)
        print("合并后的最终结果：")
        print(json.dumps(final_result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"执行 pipeline_inference 失败：{e}")