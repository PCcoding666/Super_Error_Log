import json
import re
from typing import Dict, Any, Optional, Union


class ResponseParser:
    """
    视觉语言模型响应结果解析器
    """
    
    @staticmethod
    def extract_json_from_text(text: str) -> Optional[Dict[str, Any]]:
        """
        从文本中提取JSON对象
        
        Args:
            text: 包含JSON的文本
            
        Returns:
            提取的JSON对象，如果提取失败则返回None
        """
        # 尝试查找JSON对象
        json_match = re.search(r'({.*})', text, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                return None
        return None
    
    @staticmethod
    def parse_qwen_response(response: Dict[str, Any]) -> Dict[str, Any]:
        """
        解析通义千问VLM的响应
        
        Args:
            response: 原始响应数据
            
        Returns:
            解析后的结果
        """
        try:
            # 提取响应文本
            choices = response.get('choices', [])
            if not choices:
                return {"error": "无效的响应格式：没有choices字段"}
                
            message = choices[0].get('message', {})
            content = message.get('content', '')
            
            # 尝试直接解析JSON
            try:
                parsed_json = json.loads(content)
                return {
                    "question": parsed_json.get("question", ""),
                    "student_answer": parsed_json.get("student_answer", "")
                }
            except json.JSONDecodeError:
                # 如果失败，尝试从文本中提取JSON
                extracted_json = ResponseParser.extract_json_from_text(content)
                if extracted_json:
                    return {
                        "question": extracted_json.get("question", ""),
                        "student_answer": extracted_json.get("student_answer", "")
                    }
                
            # 如果还是失败，返回原始内容
            return {
                "raw_content": content,
                "error": "无法解析为JSON格式"
            }
            
        except Exception as e:
            return {"error": f"解析响应时出错: {str(e)}"}
    
    @staticmethod
    def format_as_markdown(result: Dict[str, Any]) -> str:
        """
        将结果格式化为Markdown
        
        Args:
            result: 解析后的结果
            
        Returns:
            格式化的Markdown文本
        """
        md_text = "## 题目\n\n"
        md_text += result.get("question", "未识别到题目") + "\n\n"
        md_text += "## 学生解答过程\n\n"
        md_text += result.get("student_answer", "未识别到答题过程")
        return md_text
    
    @staticmethod
    def format_error(error: Union[str, Exception]) -> Dict[str, str]:
        """
        格式化错误信息
        
        Args:
            error: 错误信息或异常
            
        Returns:
            包含错误信息的字典
        """
        error_str = str(error)
        return {
            "error": error_str,
            "status": "error"
        } 