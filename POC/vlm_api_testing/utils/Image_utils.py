import os
import base64
from google.cloud import storage
from datetime import datetime, timedelta
from typing import Optional

def encode_image_to_base64(image_path: str, image_format: Optional[str] = None) -> str:
    """
    读取本地文件并转换为 Base64 编码。
    
    Args:
        image_path: 本地图片路径
        image_format: 图片格式，如 "png", "jpeg"。如果为None则从文件扩展名推断
        
    Returns:
        Base64 编码后的字符串，符合 data:image/{format};base64,{base64_data}
        
    Raises:
        FileNotFoundError: 当文件不存在时
        ValueError: 当无法确定图像格式时
    """
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"文件不存在: {image_path}")
        
    # 如果未指定格式，从文件扩展名推断
    if image_format is None:
        ext = os.path.splitext(image_path)[1].lower().replace('.', '')
        if ext in ('jpg', 'jpeg'):
            image_format = 'jpeg'
        elif ext in ('png', 'webp', 'gif'):
            image_format = ext
        else:
            raise ValueError(f"无法推断图像格式: {ext}")
    
    with open(image_path, "rb") as image_file:
        base64_data = base64.b64encode(image_file.read()).decode("utf-8")
    
    return f"data:image/{image_format};base64,{base64_data}"

def upload_image_to_gcs(local_file_path: str, destination_blob_name: str) -> str:
    """
    将本地文件上传到 GCS 并返回签名 URL。
    """
    try:
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm_api_testing/crypto-galaxy-407901-55c76baa3f01.json"
        bucket_name = "vlm_api_test_storage"
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(destination_blob_name)

        # 上传文件
        blob.upload_from_filename(local_file_path)
        
        # 生成签名 URL（有效期1小时）
        url = blob.generate_signed_url(
            version="v4",
            expiration=timedelta(hours=1),
            method="GET",
        )
        
        print(f"文件已上传到 GCS，签名 URL: {url}")
        return url

    except Exception as e:
        print(f"上传到 GCS 失败: {str(e)}")
        raise

def verify_image(image_path: str, supported_formats: Optional[list] = None, max_size_mb: float = 10) -> bool:
    """
    验证图像文件格式和大小
    
    Args:
        image_path: 图像的本地路径
        supported_formats: 支持的文件格式列表，默认为['.jpg', '.jpeg', '.png', '.webp']
        max_size_mb: 最大文件大小（MB），默认为10MB
        
    Returns:
        验证是否通过
        
    Raises:
        FileNotFoundError: 当文件不存在时
        ValueError: 当文件格式不支持或大小超限时
    """
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
    
    return True

# --------------------------
# 测试代码
# --------------------------
if __name__ == "__main__":
    local_image = "/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm_api_testing/temp_file/测试示例.png"
    # print("Base64 编码:", encode_image_to_base64(local_image, "png"))

    # 使用指定的 GCS 存储桶
    print("GCS URL:", upload_image_to_gcs(local_image, "uploads/test.png"))
