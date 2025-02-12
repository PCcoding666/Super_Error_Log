import os
import base64
from google.cloud import storage

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

def upload_image_to_gcs(local_file_path: str, bucket_name: str, destination_blob_name: str) -> str:
    """
    将本地文件上传到 GCS 并返回公开访问 URL。
    :param local_file_path: 本地文件路径
    :param bucket_name: GCS 存储桶名称
    :param destination_blob_name: 上传后在 GCS 中的文件路径
    :return: GCS 公开 URL
    """
    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(destination_blob_name)

    blob.upload_from_filename(local_file_path)
    blob.make_public()
    return blob.public_url

# --------------------------
# 测试代码
# --------------------------
if __name__ == "__main__":
    local_image = "test.png"
    print("Base64 编码:", encode_image_to_base64(local_image, "png"))

    # 替换为真实 GCS 存储桶
    bucket = "your-gcs-bucket"
    print("GCS URL:", upload_image_to_gcs(local_image, bucket, "uploads/test.png"))
