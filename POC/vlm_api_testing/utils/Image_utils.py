import os
import base64
from google.cloud import storage
from datetime import datetime, timedelta

def encode_image_to_base64(image_path: str, image_format: str = "png") -> str:
    """
    读取本地文件并转换为 Base64 编码。
    :param image_path: 本地图片路径
    :param image_format: 图片格式，如 "png", "jpeg"
    :return: Base64 编码后的字符串，符合 data:image/{format};base64,{base64_data}
    """
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


# --------------------------
# 测试代码
# --------------------------
if __name__ == "__main__":
    local_image = "/Users/chengpeng/MyProject/Super_Error_Log/POC/vlm_api_testing/temp_file/测试示例.png"
    # print("Base64 编码:", encode_image_to_base64(local_image, "png"))

    # 使用指定的 GCS 存储桶
    print("GCS URL:", upload_image_to_gcs(local_image, "uploads/test.png"))
