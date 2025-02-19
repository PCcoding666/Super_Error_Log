# VLM API 测试

本项目旨在测试视觉大模型 API 的调用功能，例如 Qwen-VL-Max。用户可以通过上传图片来识别题目和学生的答题过程，并在前端以支持数学公式渲染的 Markdown 格式展示结果。

## 项目结构

- **main.py**：提供基于 Gradio 的前端测试界面。
- **api_clients/**：包含不同视觉大模型的 API 客户端代码。
  - **base_client.py**：定义了基础客户端的抽象类。
  - **qwen_vl_max_client.py**：Qwen-VL-Max API 客户端的具体实现。
- **utils/**：包含工具函数。
  - **markdown_utils.py**：用于将输出格式化为 Markdown 的工具函数。
- **requirements.txt**：列出了项目的依赖项。

## 安装步骤

请运行以下命令以安装项目所需的依赖项：

```bash
pip install -r requirements.txt
```

