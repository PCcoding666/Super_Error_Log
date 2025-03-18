import os
from pathlib import Path
from typing import Dict, Any, Optional
from dotenv import load_dotenv


class ConfigManager:
    """
    配置管理类，负责加载和提供应用程序配置
    """
    _instance = None
    
    def __new__(cls):
        """单例模式实现"""
        if cls._instance is None:
            cls._instance = super(ConfigManager, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        """初始化配置管理器"""
        if self._initialized:
            return
            
        # 获取项目根目录
        self.project_root = Path(__file__).parent.parent.absolute()
        
        # 加载环境变量
        env_file = os.path.join(self.project_root, '.env')
        load_dotenv(env_file)
        
        # 初始化配置字典
        self.config = {
            # API配置
            'qwen_api_key': os.getenv('qwen_api_key'),
            'qwen_model': os.getenv('qwen_model', 'qwen-vl-max'),
            
            # GCS配置
            'gcs_bucket_name': os.getenv('gcs_bucket_name', 'vlm_api_test_storage'),
            'gcs_credentials_path': os.getenv('gcs_credentials_path', 
                                             os.path.join(self.project_root, 'crypto-galaxy-407901-55c76baa3f01.json')),
            
            # 文件存储配置
            'temp_dir': os.path.join(self.project_root, 'temp_file'),
            'upload_dir': 'uploads',
            
            # 服务器配置
            'server_host': os.getenv('SERVER_HOST', '0.0.0.0'),
            'server_port': int(os.getenv('SERVER_PORT', '7860')),
            'share': os.getenv('SHARE', 'True').lower() == 'true',
        }
        
        # 确保临时目录存在
        os.makedirs(self.config['temp_dir'], exist_ok=True)
        
        self._initialized = True
    
    def get(self, key: str, default: Any = None) -> Any:
        """获取配置值"""
        return self.config.get(key, default)
    
    def get_all(self) -> Dict[str, Any]:
        """获取所有配置"""
        return self.config.copy()
    
    def update(self, key: str, value: Any) -> None:
        """更新配置值"""
        self.config[key] = value
        
    def get_file_path(self, relative_path: str) -> str:
        """获取相对于项目根目录的文件路径"""
        return os.path.join(self.project_root, relative_path) 