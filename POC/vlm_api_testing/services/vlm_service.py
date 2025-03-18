from typing import Dict, Any, Optional

from ..api_clients.base_client import VLMClient
from ..api_clients.qwen_vl_max_client import QwenVLMaxClient
from ..config.config_manager import ConfigManager


class VLMFactory:
    """
    视觉语言模型客户端工厂类
    """
    
    @staticmethod
    def create_client(provider: str = None, **kwargs) -> VLMClient:
        """
        创建VLM客户端
        
        Args:
            provider: 提供商名称，默认从配置中读取
            **kwargs: 传递给客户端构造函数的参数
            
        Returns:
            VLMClient 实例
            
        Raises:
            ValueError: 当提供不支持的提供商时
        """
        config = ConfigManager()
        
        # 如果未指定provider，从配置中读取
        if provider is None:
            provider = config.get('default_vlm_provider', 'qwen')
            
        # 根据提供商创建相应的客户端
        if provider.lower() == 'qwen':
            return QwenVLMaxClient(**kwargs)
        else:
            raise ValueError(f"不支持的VLM提供商: {provider}")


class VLMService:
    """
    视觉语言模型服务类，提供对多种VLM的统一访问接口
    """
    
    def __init__(self, provider: Optional[str] = None):
        """
        初始化VLM服务
        
        Args:
            provider: VLM提供商，默认从配置中读取
        """
        self.config = ConfigManager()
        self.provider = provider
        self.client = VLMFactory.create_client(provider)
    
    def analyze_image(self, image_path: str) -> Dict[str, Any]:
        """
        分析图像内容
        
        Args:
            image_path: 图像路径
            
        Returns:
            分析结果
            
        Raises:
            Exception: 当分析失败时
        """
        try:
            return self.client.inference(image_path)
        except Exception as e:
            # 记录错误并重新抛出
            raise Exception(f"图像分析失败: {str(e)}") from e
    
    def switch_provider(self, provider: str, **kwargs) -> None:
        """
        切换VLM提供商
        
        Args:
            provider: 新的提供商名称
            **kwargs: 传递给客户端构造函数的参数
        """
        self.provider = provider
        self.client = VLMFactory.create_client(provider, **kwargs) 