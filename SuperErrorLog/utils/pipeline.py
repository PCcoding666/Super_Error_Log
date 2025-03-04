import os
import json
import re
from typing import Dict, Any

from SuperErrorLog.api_clients.qwen_client import QwenVLMaxClient
from SuperErrorLog.api_clients.deepseek_client import DeepSeekClient

def pipeline_inference(image_path: str, qwen_api_key: str, deepseek_api_key: str) -> Dict[str, Any]:
    """
    处理流程管道：
    1. 通过 QwenVLMaxClient 获取题目与学生答案
    2. 将提取结果传给 DeepSeekClient，获取推理解答
    3. 将二者合并后，返回最终结果
    
    Args:
        image_path: 图片路径
        qwen_api_key: 通义千问API密钥
        deepseek_api_key: DeepSeek API密钥
        
    Returns:
        合并后的结果字典
    """
    # 1. 初始化客户端
    try:
        qwen_client = QwenVLMaxClient(api_key=qwen_api_key)
        deepseek_client = DeepSeekClient(api_key=deepseek_api_key)
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

    # 3. 提取 content 中的 JSON
    try:
        qwen_content = qwen_raw_response["choices"][0]["message"]["content"]
        print(f"[调试信息] Qwen返回的content字段: {qwen_content}")
    except (KeyError, IndexError) as e:
        print(f"[调试信息] 无法从Qwen返回的响应中获取content字段，请检查返回数据结构。错误：{e}")
        raise ValueError("Qwen 返回的数据结构不符合预期。")

    if not qwen_content.strip():
        raise ValueError("Qwen 返回的内容为空，请检查 API 响应。")

    # 尝试从内容中提取JSON
    match = re.search(r'```json\s*(\{.*?\})\s*```', qwen_content, re.DOTALL)
    if not match:
        # 如果没有找到```json包裹的内容，尝试直接解析整个内容
        try:
            qwen_result_dict = json.loads(qwen_content)
        except json.JSONDecodeError:
            # 如果直接解析失败，尝试查找任何花括号包裹的内容
            match = re.search(r'(\{.*\})', qwen_content, re.DOTALL)
            if not match:
                raise ValueError("Qwen 返回内容中未找到有效的JSON结构，请检查 Qwen 响应。")
            qwen_json_str = match.group(1)
            qwen_result_dict = json.loads(qwen_json_str)
    else:
        qwen_json_str = match.group(1)
        qwen_result_dict = json.loads(qwen_json_str)

    print(f"[调试信息] 解析后的Qwen结果字典: {qwen_result_dict}")

    # 4. 将 Qwen JSON 转为字符串传给 DeepSeek
    qwen_json_for_deepseek = json.dumps(qwen_result_dict, ensure_ascii=False)
    print(f"[调试信息] 传递给DeepSeek的JSON字符串: {qwen_json_for_deepseek}")

    # 5. 调用 DeepSeek 并解析返回
    try:
        print("[调试信息] 开始调用DeepSeek接口...")
        deepseek_result = deepseek_client.inference(qwen_vl_max_result=qwen_json_for_deepseek)
        print(f"[调试信息] DeepSeek返回结果: {deepseek_result}")
    except Exception as e:
        print(f"[调试信息] 调用DeepSeek接口时出现异常: {e}")
        raise

    # 6. 合并两个结果
    combined_result = {**qwen_result_dict, **deepseek_result}
    print(f"[调试信息] 合并后的最终结果: {combined_result}")

    return combined_result 