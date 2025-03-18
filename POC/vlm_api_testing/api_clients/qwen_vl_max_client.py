# -*- coding: utf-8 -*-
import io
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding='utf-8')
import openai
import requests
from typing import Dict, Any, Optional

# 修正导入路径
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(project_root)

from utils.Image_utils import upload_image_to_gcs

# 引入基类
from .base_client import VLMClient
from ..config.config_manager import ConfigManager
from ..services.storage_service import create_storage_service

class QwenVLMaxClient(VLMClient):
    """
    通义千问视觉语言模型客户端
    """
    
    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        """
        初始化通义千问VLM客户端
        
        Args:
            api_key: API密钥，如果为None则从配置中读取
            model: 模型名称，如果为None则从配置中读取
        """
        # 使用配置管理器获取配置
        self.config = ConfigManager()
        
        # 获取API密钥和模型名称
        self.api_key = api_key if api_key else self.config.get('qwen_api_key')
        if not self.api_key:
            raise ValueError("API密钥未提供，请在参数中提供或在配置文件中设置")
            
        self.model = model if model else self.config.get('qwen_model')
        
        # 初始化存储服务
        self.storage_service = create_storage_service()
        
        # 初始化API客户端
        self.client = openai.OpenAI(
            api_key=self.api_key,
            base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        )
        
    def inference(self, image_input: str) -> Dict[str, Any]:
        """
        使用通义千问VLM进行图像分析
        
        Args:
            image_input: 图像的本地路径
            
        Returns:
            包含分析结果的字典
            
        Raises:
            Exception: 当处理过程中发生错误时
        """
        try:
            # 验证图像
            self.validate_image(image_input)
            
            # 上传图像并获取URL
            image_url = self.storage_service.upload_file(image_input)
            
            # 验证URL可访问性
            self._verify_url_accessibility(image_url)
            
            # 构造请求消息
            messages = self._construct_prompt_messages(image_url)
            
            # 发送请求
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=messages
            )
            
            # 返回结果
            return completion.model_dump()
            
        except Exception as e:
            raise Exception(f"通义千问VLM分析失败: {str(e)}")
    
    def _verify_url_accessibility(self, url: str) -> None:
        """
        验证URL的可访问性
        
        Args:
            url: 需要验证的URL
            
        Raises:
            Exception: 当URL不可访问时
        """
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise Exception(f"无法访问图片URL: {str(e)}")
    
    def _construct_prompt_messages(self, image_url: str) -> list:
        """
        构造通义千问VLM的提示消息
        
        Args:
            image_url: 图像URL
            
        Returns:
            消息列表
        """
        return [
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