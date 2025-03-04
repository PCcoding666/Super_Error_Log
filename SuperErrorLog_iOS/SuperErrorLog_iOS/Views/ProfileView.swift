import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @State private var showingLogoutAlert = false
    
    var body: some View {
        NavigationView {
            List {
                // 用户信息
                Section {
                    HStack(spacing: 15) {
                        Image(systemName: "person.circle.fill")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 60, height: 60)
                            .foregroundColor(.blue)
                        
                        VStack(alignment: .leading, spacing: 5) {
                            Text(authViewModel.currentUser?.name ?? "未登录")
                                .font(.headline)
                            
                            if let user = authViewModel.currentUser {
                                Text(user.email)
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                                
                                HStack {
                                    Text(subscriptionText)
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(subscriptionColor.opacity(0.1))
                                        .foregroundColor(subscriptionColor)
                                        .cornerRadius(5)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }
                
                // 账户设置
                Section(header: Text("账户设置")) {
                    NavigationLink(destination: Text("个人信息设置")) {
                        SettingRow(icon: "person.fill", title: "个人信息", color: .blue)
                    }
                    
                    NavigationLink(destination: Text("订阅管理")) {
                        SettingRow(icon: "creditcard.fill", title: "订阅管理", color: .purple)
                    }
                    
                    NavigationLink(destination: Text("通知设置")) {
                        SettingRow(icon: "bell.fill", title: "通知设置", color: .orange)
                    }
                }
                
                // 应用设置
                Section(header: Text("应用设置")) {
                    NavigationLink(destination: Text("主题设置")) {
                        SettingRow(icon: "paintbrush.fill", title: "主题设置", color: .pink)
                    }
                    
                    NavigationLink(destination: Text("语言设置")) {
                        SettingRow(icon: "globe", title: "语言设置", color: .green)
                    }
                    
                    NavigationLink(destination: Text("隐私设置")) {
                        SettingRow(icon: "lock.fill", title: "隐私设置", color: .gray)
                    }
                }
                
                // 支持
                Section(header: Text("支持")) {
                    NavigationLink(destination: Text("帮助中心")) {
                        SettingRow(icon: "questionmark.circle.fill", title: "帮助中心", color: .blue)
                    }
                    
                    NavigationLink(destination: Text("联系我们")) {
                        SettingRow(icon: "envelope.fill", title: "联系我们", color: .blue)
                    }
                    
                    NavigationLink(destination: Text("关于我们")) {
                        SettingRow(icon: "info.circle.fill", title: "关于我们", color: .blue)
                    }
                }
                
                // 退出登录
                Section {
                    Button(action: {
                        showingLogoutAlert = true
                    }) {
                        HStack {
                            Image(systemName: "arrow.right.square.fill")
                                .foregroundColor(.red)
                            Text("退出登录")
                                .foregroundColor(.red)
                        }
                    }
                }
            }
            .listStyle(InsetGroupedListStyle())
            .navigationTitle("我的")
            .alert(isPresented: $showingLogoutAlert) {
                Alert(
                    title: Text("退出登录"),
                    message: Text("确定要退出当前账号吗？"),
                    primaryButton: .destructive(Text("退出")) {
                        authViewModel.logout()
                    },
                    secondaryButton: .cancel(Text("取消"))
                )
            }
        }
    }
    
    private var subscriptionText: String {
        guard let user = authViewModel.currentUser else { return "" }
        
        switch user.subscription {
        case .free:
            return "免费版"
        case .standard:
            return "标准版"
        case .professional:
            return "专业版"
        }
    }
    
    private var subscriptionColor: Color {
        guard let user = authViewModel.currentUser else { return .gray }
        
        switch user.subscription {
        case .free:
            return .gray
        case .standard:
            return .blue
        case .professional:
            return .purple
        }
    }
}

struct SettingRow: View {
    let icon: String
    let title: String
    let color: Color
    
    var body: some View {
        HStack {
            Image(systemName: icon)
                .foregroundColor(color)
                .frame(width: 24)
            Text(title)
        }
    }
}

struct ProfileView_Previews: PreviewProvider {
    static var previews: some View {
        ProfileView()
            .environmentObject(AuthViewModel())
    }
} 