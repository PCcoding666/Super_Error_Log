# 超级错题本 (Super Error Log)

超级错题本是一个智能错题管理系统，帮助学生高效学习，提高成绩。系统利用AI技术，自动识别题目内容，分析错误原因，提供详细解答，让学习更高效。

## 功能特点

- **智能识别**：通过通义千问视觉模型，自动识别题目内容和学生答案，无需手动输入。
- **智能分析**：利用DeepSeek大语言模型，提供正确解法和错误分析，帮助理解错误原因。
- **知识点分类**：自动将题目按学科、知识模块和具体知识点分类，方便复习和查找。
- **历史记录**：保存所有上传的题目和分析结果，随时查看和复习，跟踪学习进度。
- **知识点搜索**：按知识点分类搜索错题记录，快速找到需要复习的内容。
- **云端存储**：所有数据安全存储在云端，多设备同步，随时随地访问。

## 系统架构

超级错题本采用前后端分离的架构设计：

### 后端服务

- **Web服务**：基于Flask的RESTful API服务
- **数据库**：SQLite（开发环境）/ PostgreSQL（生产环境）
- **AI服务集成**：
  - 通义千问视觉模型：用于图像识别和文字提取
  - DeepSeek大语言模型：用于错题分析和解答生成

### 前端应用

- **Web应用**：基于Bootstrap 5的响应式网页应用
- **iOS客户端**：基于SwiftUI的原生iOS应用
- **Android客户端**：（规划中）

## 快速开始

### 环境要求

- Python 3.8+
- pip
- 虚拟环境（推荐）

### 安装步骤

1. 克隆仓库

```bash
git clone https://github.com/yourusername/super-error-log.git
cd super-error-log
```

2. 创建并激活虚拟环境

```bash
python -m venv venv
source venv/bin/activate  # 在Windows上使用 venv\Scripts\activate
```

3. 安装依赖

```bash
pip install -r requirements.txt
```

4. 配置环境变量

复制`.env.example`文件为`.env`并填写必要的配置信息：

```bash
cp .env.example .env
# 编辑.env文件，填写API密钥等信息
```

5. 初始化数据库

```bash
flask db init
flask db migrate
flask db upgrade
```

6. 运行应用

```bash
python run.py
```

应用将在 http://localhost:8080 上运行。

## iOS客户端

超级错题本iOS客户端是一个基于SwiftUI开发的原生iOS应用，提供与Web应用相同的核心功能，并针对移动设备进行了优化。

### 功能特点

- **用户认证**：支持账号注册、登录和管理
- **错题管理**：查看、搜索和管理错题记录
- **拍照上传**：直接使用相机拍摄错题并上传
- **知识点分类**：按知识点分类浏览错题
- **离线访问**：支持部分内容的离线访问

### 安装要求

- iOS 15.0+
- Xcode 13.0+
- Swift 5.5+

### 构建步骤

1. 克隆仓库

```bash
git clone https://github.com/yourusername/super-error-log-ios.git
cd super-error-log-ios
```

2. 打开Xcode项目

```bash
open SuperErrorLog_iOS.xcodeproj
```

3. 配置API端点

在`APIService.swift`文件中配置正确的API端点：

```swift
static let baseURL = "https://your-api-endpoint.com"
```

4. 构建并运行应用

在Xcode中选择目标设备或模拟器，然后点击运行按钮。

## API文档

API文档使用Swagger UI提供，可在应用运行后访问：

```
http://localhost:8080/api/docs
```

## 贡献指南

我们欢迎所有形式的贡献，包括但不限于：

- 代码贡献
- 文档改进
- 错误报告
- 功能建议

请遵循以下步骤：

1. Fork仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建Pull Request

## 许可证

本项目采用MIT许可证 - 详情请参阅 [LICENSE](LICENSE) 文件。

## 联系方式

如有任何问题或建议，请通过以下方式联系我们：

- 电子邮件：support@supererrorlog.com
- 项目主页：https://github.com/yourusername/super-error-log
- 问题跟踪：https://github.com/yourusername/super-error-log/issues 