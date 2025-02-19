def format_markdown_output(result: dict) -> str:
    """
    将 API 返回结果格式化为 Markdown 格式字符串
    :param result: 包含 'question' 和 'student_answer' 键的字典
    :return: 格式化后的 Markdown 字符串
    """
    md_text = "## 题目\n\n"
    md_text += result.get("question", "未识别到题目") + "\n\n"
    md_text += "## 学生解答过程\n\n"
    md_text += result.get("student_answer", "未识别到答题过程")
    return md_text
