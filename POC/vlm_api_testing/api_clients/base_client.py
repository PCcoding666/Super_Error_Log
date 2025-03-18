from abc import ABC, abstractmethod
from typing import Dict, Any, Optional


class VLMClient(ABC):
    """
    视觉语言模型客户端的抽象基类
    所有特定供应商的VLM客户端都应该继承这个基类
    """
    
    @abstractmethod
    def __init__(self, api_key: str, **kwargs):
        """
        初始化客户端
        
        Args:
            api_key: API密钥
            **kwargs: 其他初始化参数
        """
        pass
        
    @abstractmethod
    def inference(self, image_input: str) -> Dict[str, Any]:
        """
        使用图像进行推理
        
        Args:
            image_input: 图像的本地路径
            
        Returns:
            包含推理结果的字典
            
        Raises:
            Exception: 当推理过程中发生错误时
        """
        pass
    
    def validate_image(self, image_path: str, 
                       supported_formats: Optional[list] = None, 
                       max_size_mb: float = 10) -> None:
        """
        验证图像文件格式和大小
        
        Args:
            image_path: 图像的本地路径
            supported_formats: 支持的文件格式列表，默认为['.jpg', '.jpeg', '.png', '.webp']
            max_size_mb: 最大文件大小（MB），默认为10MB
            
        Raises:
            FileNotFoundError: 当文件不存在时
            ValueError: 当文件格式不支持或大小超限时
        """
        import os
        
        # 检查文件是否存在
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"输入文件不存在: {image_path}")
        
        # 默认支持的格式
        if supported_formats is None:
            supported_formats = ['.jpg', '.jpeg', '.png', '.webp']
            
        # 检查文件格式
        file_extension = os.path.splitext(image_path)[1].lower()
        if file_extension not in supported_formats:
            raise ValueError(f"不支持的文件格式 {file_extension}，支持的格式包括: {supported_formats}")
        
        # 检查文件大小
        file_size = os.path.getsize(image_path) / (1024 * 1024)  # 转换为 MB
        if file_size > max_size_mb:
            raise ValueError(f"文件太大 ({file_size:.2f} MB)，请确保小于 {max_size_mb}MB")
        
        return None 