# 超级错题本 iOS客户端

超级错题本iOS客户端是一个基于SwiftUI开发的原生iOS应用，为超级错题本智能错题管理系统提供移动端支持。本应用提供与Web应用相同的核心功能，并针对移动设备进行了优化。

## 功能特点

- **用户认证**：支持账号注册、登录和管理
- **错题管理**：查看、搜索和管理错题记录
- **拍照上传**：直接使用相机拍摄错题并上传
- **知识点分类**：按知识点分类浏览错题
- **离线访问**：支持部分内容的离线访问

## 技术架构

- **UI框架**：SwiftUI
- **状态管理**：Combine框架
- **网络层**：URLSession + Combine
- **本地存储**：UserDefaults + Keychain
- **图片处理**：UIKit集成

## 项目结构

```
SuperErrorLog_iOS/
├── SuperErrorLogApp.swift     # 应用入口
├── ContentView.swift          # 主内容视图
├── Models/                    # 数据模型
│   ├── User.swift             # 用户模型
│   └── ErrorLog.swift         # 错题记录模型
├── Views/                     # 视图组件
│   ├── AuthView.swift         # 认证视图
│   ├── MainTabView.swift      # 主标签视图
│   ├── HomeView.swift         # 首页视图
│   ├── ErrorLogListView.swift # 错题列表视图
│   ├── ErrorLogDetailView.swift # 错题详情视图
│   ├── SearchView.swift       # 搜索视图
│   ├── UploadView.swift       # 上传视图
│   └── ProfileView.swift      # 个人资料视图
├── ViewModels/                # 视图模型
│   ├── AuthViewModel.swift    # 认证视图模型
│   └── ErrorLogListViewModel.swift # 错题列表视图模型
├── Services/                  # 服务层
│   └── APIService.swift       # API服务
└── Helpers/                   # 辅助工具
    └── KeychainHelper.swift   # Keychain助手
```

## 安装要求

- iOS 15.0+
- Xcode 13.0+
- Swift 5.5+

## 构建步骤

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

## 主要功能实现

### 用户认证

- 支持邮箱注册和登录
- 使用Keychain安全存储用户令牌
- 自动登录功能

### 错题管理

- 查看错题列表和详情
- 按知识点分类筛选错题
- 搜索错题功能

### 上传错题

- 支持相机拍照和相册选择
- 自动识别题目内容
- 知识点分类选择

## 开发指南

### 添加新视图

1. 在`Views`文件夹中创建新的SwiftUI视图
2. 如需状态管理，在`ViewModels`文件夹中创建对应的视图模型
3. 在`MainTabView.swift`或其他导航中添加新视图的入口

### API集成

所有网络请求都通过`APIService.swift`进行，遵循以下步骤添加新的API调用：

1. 在`APIService.swift`中添加新的方法
2. 使用Combine框架处理异步响应
3. 在视图模型中调用API方法并更新UI状态

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
- 项目主页：https://github.com/yourusername/super-error-log-ios
- 问题跟踪：https://github.com/yourusername/super-error-log-ios/issues 