# VLM API 测试工具

这是一个用于测试视觉语言模型(VLM)API的工具，目前支持通义千问VLM Max模型。该工具可以上传图片，提取图片中的题目内容和学生解答，并以结构化JSON格式返回结果。

## 特性

- 支持上传本地图片进行识别分析
- 使用通义千问VLM模型进行图像内容识别
- 自动从图像中提取题目和学生解答
- 通过Google Cloud Storage存储图片并获取可访问URL
- 友好的Gradio Web界面
- 可配置的运行环境

## 项目结构

```
vlm_api_testing/
├── api_clients/            # API客户端实现
│   ├── __init__.py
│   ├── base_client.py      # 抽象基类
│   └── qwen_vl_max_client.py  # 通义千问客户端
├── config/                 # 配置管理
│   ├── __init__.py
│   └── config_manager.py   # 配置管理器
├── services/               # 服务层
│   ├── __init__.py
│   ├── storage_service.py  # 存储服务
│   └── vlm_service.py      # VLM服务
├── utils/                  # 工具函数
│   ├── __init__.py
│   ├── Image_utils.py      # 图像工具
│   ├── markdown_utils.py   # Markdown工具
│   └── response_parser.py  # 响应解析器
├── temp_file/              # 临时文件存储
├── .env                    # 环境变量
├── .env.example            # 环境变量示例
├── .gitignore
├── Gradio_frontend.py      # Gradio前端
├── main.py                 # 入口程序
└── requirements.txt        # 依赖项
```

## 优化内容

本项目从原始POC代码进行了以下优化：

1. **应用OOP原则**：
   - 创建类继承层次结构
   - 使用抽象基类定义接口
   - 实现单一职责原则

2. **改进代码组织**：
   - 模块化设计
   - 清晰的类和函数职责
   - 按功能分离代码到不同目录

3. **增强可扩展性**：
   - 工厂模式创建客户端和服务
   - 可配置的服务提供商
   - 抽象存储服务接口

4. **提高代码可维护性**：
   - 一致的命名规范
   - 完整的类型注释
   - 详细的函数文档

5. **配置集中化**：
   - 单例配置管理器
   - 使用环境变量
   - 消除硬编码路径和凭证

## 安装和使用

1. 克隆仓库
2. 安装依赖: `pip install -r requirements.txt`
3. 复制 `.env.example` 为 `.env` 并填写配置
4. 运行应用: `python main.py`

## 依赖

- gradio==4.12.0
- openai==1.3.5
- google-cloud-storage==2.8.0
- 详见 `requirements.txt`

