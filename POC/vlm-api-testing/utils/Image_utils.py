import base64

def image_to_base64(image_path: str) -> str:
    """
    将图片转换为 base64 编码的字符串
    :param image_path: 图片文件路径
    :return: base64 编码的字符串
    """
    with open(image_path, "rb") as image_file:
        encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
    return encoded_string
# 这个函数是将图片转换成base64编码的函数