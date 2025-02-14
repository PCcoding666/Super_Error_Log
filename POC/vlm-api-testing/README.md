# VLM API 测试

本项目旨在测试各种视觉大模型的 API 调用，例如 Qwen-VL-Max。通过上传图片识别题目和学生答题过程，并在前端以 Markdown 格式展示（支持数学公式的正确渲染）。

## 项目结构

- **main.py**：基于 Gradio 实现的前端测试界面。
- **api_clients/**：存放不同视觉大模型的 API 客户端代码。
  - **base_client.py**：定义基础客户端抽象类。
  - **qwen_vl_max_client.py**：Qwen-VL-Max API 客户端的示例实现。
- **utils/**：存放工具函数。
  - **markdown_utils.py**：用于将输出格式化为 Markdown 的工具函数。
- **requirements.txt**：项目依赖列表。

## 安装

运行以下命令以安装所需的依赖项：

```bash
pip install -r requirements.txt
```

## 使用方法

1. 在 `.env` 文件中设置环境变量。
2. 运行 `main.py` 启动 Gradio 前端。
3. 上传图片或提供 URL 以测试 API。

## 环境变量

请确保在 `.env` 文件中设置以下环境变量：

- `qwen_api_key`：用于访问 Qwen-VL-Max 服务的 API 密钥。
- `qwen_endpoint_url`：Qwen-VL-Max API 的端点 URL。