# 超级错题本

超级错题本是一个智能错题管理系统，可以帮助用户分析题目、识别错误并提供解决方案。系统利用通义千问视觉模型识别题目内容和学生答案，然后使用DeepSeek大语言模型进行分析和解答。

## 功能特点

- **智能识别**：自动识别题目内容和学生答案
- **智能分析**：提供正确解法和错误分析
- **知识点分类**：自动将题目按学科、知识模块和具体知识点分类
- **历史记录**：保存所有上传的题目和分析结果
- **知识点搜索**：按知识点分类搜索错题记录

## 技术架构

- **前端**：HTML, CSS, JavaScript, Bootstrap 5
- **后端**：Python, Flask
- **数据库**：SQLite
- **AI模型**：
  - 通义千问视觉模型 (Qwen-VL-Max)：用于识别题目内容和学生答案
  - DeepSeek大语言模型：用于分析题目、提供解法和错误分析

## 安装与运行

### 环境要求

- Python 3.8+
- pip 包管理器

### 安装步骤

1. 克隆项目代码：

```bash
git clone <项目仓库地址>
cd Super_Error_Log
```

2. 安装依赖：

```bash
pip install -r SuperErrorLog/requirements.txt
```

3. 配置API密钥：

在 `SuperErrorLog/config.py` 文件中配置通义千问和DeepSeek的API密钥，或者设置环境变量：

```bash
export QWEN_API_KEY=your_qwen_api_key
export DEEPSEEK_API_KEY=your_deepseek_api_key
```

4. 运行应用：

```bash
python -m SuperErrorLog.app
```

5. 在浏览器中访问：

```
http://localhost:8080
```

## 使用方法

1. **上传题目**：
   - 点击"上传题目"按钮
   - 选择或拖拽题目图片到上传区域
   - 点击"开始分析"按钮
   - 等待系统分析完成

2. **查看历史记录**：
   - 点击"历史记录"查看所有上传的题目
   - 使用筛选功能按学科类型、日期范围或关键词筛选

3. **知识点搜索**：
   - 点击"搜索"进入搜索页面
   - 选择标题级别（学科类型、知识模块或具体知识点）
   - 选择具体标题内容
   - 点击"搜索"按钮查看匹配的记录

## 项目结构

```
SuperErrorLog/
├── api_clients/            # API客户端
│   ├── qwen_client.py      # 通义千问视觉模型客户端
│   └── deepseek_client.py  # DeepSeek模型客户端
├── database/               # 数据库相关
│   └── models.py           # 数据库模型
├── static/                 # 静态文件
│   ├── css/                # CSS样式
│   ├── js/                 # JavaScript脚本
│   └── uploads/            # 上传的图片
├── templates/              # HTML模板
│   ├── base.html           # 基础模板
│   ├── index.html          # 首页
│   ├── upload.html         # 上传页面
│   ├── logs.html           # 历史记录页面
│   ├── view_log.html       # 查看单个记录页面
│   └── search.html         # 搜索页面
├── utils/                  # 工具类
│   ├── image_utils.py      # 图片处理工具
│   └── pipeline.py         # 处理流程管道
├── app.py                  # 应用主文件
├── config.py               # 配置文件
└── requirements.txt        # 依赖列表
```

## 依赖项

主要依赖项包括：

- Flask：Web框架
- OpenAI：用于调用DeepSeek API
- Requests：HTTP请求库
- SQLite3：数据库

详细依赖列表请参见 `requirements.txt` 文件。

## 注意事项

- 图片上传大小限制为10MB
- 支持的图片格式：PNG、JPG、JPEG、WEBP
- API调用可能需要一定时间，请耐心等待

## 许可证

MIT License 