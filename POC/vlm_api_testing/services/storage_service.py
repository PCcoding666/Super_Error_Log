from abc import ABC, abstractmethod
from datetime import timedelta
from typing import Optional
import os

from ..config.config_manager import ConfigManager


class StorageService(ABC):
    """
    存储服务抽象基类
    """
    
    @abstractmethod
    def upload_file(self, local_file_path: str, destination_path: str) -> str:
        """
        上传文件到存储服务
        
        Args:
            local_file_path: 本地文件路径
            destination_path: 目标存储路径
            
        Returns:
            文件的公共访问URL
            
        Raises:
            Exception: 上传失败时
        """
        pass


class GCSStorageService(StorageService):
    """
    Google Cloud Storage 存储服务实现
    """
    
    def __init__(self):
        """初始化 GCS 存储服务"""
        self.config = ConfigManager()
        self.bucket_name = self.config.get('gcs_bucket_name')
        credentials_path = self.config.get('gcs_credentials_path')
        
        # 设置 GCS 认证
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
    
    def upload_file(self, local_file_path: str, destination_path: Optional[str] = None) -> str:
        """
        上传文件到 GCS 并返回签名 URL
        
        Args:
            local_file_path: 本地文件路径
            destination_path: 目标存储路径，如果为None则使用原文件名
            
        Returns:
            签名URL
            
        Raises:
            Exception: 上传失败时
        """
        try:
            from google.cloud import storage
            
            if destination_path is None:
                # 使用原文件名，放在配置的上传目录中
                destination_path = f"{self.config.get('upload_dir')}/{os.path.basename(local_file_path)}"
                
            # 初始化 GCS 客户端
            storage_client = storage.Client()
            bucket = storage_client.bucket(self.bucket_name)
            blob = bucket.blob(destination_path)

            # 上传文件
            blob.upload_from_filename(local_file_path)
            
            # 生成签名 URL（有效期1小时或配置的时间）
            expiration_hours = int(self.config.get('url_expiration_hours', 1))
            url = blob.generate_signed_url(
                version="v4",
                expiration=timedelta(hours=expiration_hours),
                method="GET",
            )
            
            return url

        except Exception as e:
            raise Exception(f"上传到 GCS 失败: {str(e)}")


# 工厂方法，根据配置创建适当的存储服务
def create_storage_service() -> StorageService:
    """
    创建存储服务实例
    
    Returns:
        StorageService 实例
    """
    # 目前只支持 GCS，未来可扩展支持其他存储服务
    return GCSStorageService() 