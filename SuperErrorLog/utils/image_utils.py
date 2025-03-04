import os
import uuid
import shutil
from datetime import datetime
from typing import Optional

# 图片保存的根目录
UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static', 'uploads')

# 确保上传目录存在
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def save_uploaded_image(uploaded_file_path: str) -> Optional[str]:
    """
    保存上传的图片到本地存储
    
    Args:
        uploaded_file_path: 临时上传文件的路径
        
    Returns:
        保存后的文件相对路径，如果保存失败则返回None
    """
    try:
        # 检查文件是否存在
        if not os.path.exists(uploaded_file_path):
            print(f"上传的文件不存在: {uploaded_file_path}")
            return None
            
        # 生成唯一文件名
        file_extension = os.path.splitext(uploaded_file_path)[1].lower()
        unique_filename = f"{uuid.uuid4()}{file_extension}"
        
        # 按年月日组织文件夹
        today = datetime.now()
        year_month_day = today.strftime("%Y/%m/%d")
        target_dir = os.path.join(UPLOAD_FOLDER, year_month_day)
        os.makedirs(target_dir, exist_ok=True)
        
        # 目标文件路径
        target_path = os.path.join(target_dir, unique_filename)
        
        # 复制文件
        shutil.copy2(uploaded_file_path, target_path)
        
        # 返回相对路径（用于存储在数据库中）
        relative_path = os.path.join('uploads', year_month_day, unique_filename)
        return relative_path.replace('\\', '/')  # 确保路径分隔符统一
        
    except Exception as e:
        print(f"保存图片时出错: {str(e)}")
        return None

def get_image_path(relative_path: str) -> str:
    """
    获取图片的完整路径
    
    Args:
        relative_path: 数据库中存储的相对路径
        
    Returns:
        图片的完整路径
    """
    static_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static')
    return os.path.join(static_dir, relative_path) 