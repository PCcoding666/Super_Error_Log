# VLM API Test

本项目用于测试不同视觉大模型 API 的调用，例如 Qwen-VL-Max。通过上传图片识别题目和学生答题过程，并在前端以 Markdown 格式展示（数学公式部分支持正确渲染）。

## 项目结构

- **main.py**：前端测试界面，基于 Gradio 实现。
- **api_clients/**：存放不同视觉大模型 API 客户端代码。git
  - **base_client.py**：定义基础客户端抽象类。
  - **qwen_vl_max_client.py**：Qwen-VL-Max API 客户端的示例实现。
- **utils/**：存放工具函数。
  - **markdown_utils.py**：格式化输出为 Markdown 的工具函数。
- **requirements.txt**：项目依赖列表。

## 安装依赖

```bash
pip install -r requirements.txt
