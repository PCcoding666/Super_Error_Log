from abc import ABC, abstractmethod

class BaseVLMClient(ABC):
    """
    视觉大模型 API 的基础客户端抽象类
    """

    @abstractmethod
    def analyze_image(self, image_path: str) -> dict:
        """
        分析图片，并返回包含题目和学生答题过程的结果字典
        :param image_path: 图片文件路径
        :return: {'question': '题目内容', 'student_answer': '答题过程'}
        """
        pass
