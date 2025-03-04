import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // 欢迎信息
                    VStack(alignment: .leading, spacing: 5) {
                        Text("欢迎，\(authViewModel.currentUser?.name ?? "同学")")
                            .font(.largeTitle)
                            .fontWeight(.bold)
                        
                        Text("今天要学习什么呢？")
                            .font(.headline)
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal)
                    .padding(.top, 10)
                    
                    // 快捷操作卡片
                    VStack(spacing: 15) {
                        NavigationLink(destination: UploadView()) {
                            ActionCard(
                                title: "上传错题",
                                description: "拍照或选择图片上传错题",
                                icon: "camera.fill",
                                color: .blue
                            )
                        }
                        
                        NavigationLink(destination: ErrorLogListView()) {
                            ActionCard(
                                title: "我的错题本",
                                description: "查看所有已保存的错题",
                                icon: "book.fill",
                                color: .green
                            )
                        }
                        
                        NavigationLink(destination: SearchView()) {
                            ActionCard(
                                title: "知识点搜索",
                                description: "按知识点查找错题",
                                icon: "magnifyingglass",
                                color: .orange
                            )
                        }
                    }
                    .padding(.horizontal)
                    
                    // 统计数据
                    VStack(alignment: .leading, spacing: 10) {
                        Text("学习统计")
                            .font(.title2)
                            .fontWeight(.bold)
                            .padding(.horizontal)
                        
                        HStack(spacing: 15) {
                            StatCard(title: "总错题数", value: "32", icon: "doc.text.fill", color: .blue)
                            StatCard(title: "本周新增", value: "5", icon: "plus.circle.fill", color: .green)
                            StatCard(title: "待复习", value: "12", icon: "clock.fill", color: .orange)
                        }
                        .padding(.horizontal)
                    }
                    
                    // 最近错题
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("最近错题")
                                .font(.title2)
                                .fontWeight(.bold)
                            
                            Spacer()
                            
                            NavigationLink(destination: ErrorLogListView()) {
                                Text("查看全部")
                                    .font(.subheadline)
                                    .foregroundColor(.blue)
                            }
                        }
                        .padding(.horizontal)
                        
                        // 示例错题列表
                        VStack(spacing: 15) {
                            ForEach(1...3, id: \.self) { _ in
                                RecentErrorLogCard()
                            }
                        }
                        .padding(.horizontal)
                    }
                    
                    // 订阅信息
                    if let user = authViewModel.currentUser, user.subscription == .free {
                        VStack {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("升级到标准版")
                                        .font(.headline)
                                    Text("解锁更多功能和无限错题分析")
                                        .font(.subheadline)
                                        .foregroundColor(.secondary)
                                }
                                
                                Spacer()
                                
                                Button(action: {
                                    // 跳转到订阅页面
                                }) {
                                    Text("升级")
                                        .fontWeight(.semibold)
                                        .padding(.horizontal, 15)
                                        .padding(.vertical, 8)
                                        .background(Color.blue)
                                        .foregroundColor(.white)
                                        .cornerRadius(8)
                                }
                            }
                            .padding()
                            .background(Color(.systemGray6))
                            .cornerRadius(12)
                            .padding(.horizontal)
                        }
                    }
                }
                .padding(.bottom, 20)
            }
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarItems(trailing: Button(action: {
                // 打开设置
            }) {
                Image(systemName: "gearshape.fill")
                    .foregroundColor(.primary)
            })
        }
    }
}

// 快捷操作卡片
struct ActionCard: View {
    let title: String
    let description: String
    let icon: String
    let color: Color
    
    var body: some View {
        HStack {
            Image(systemName: icon)
                .font(.system(size: 30))
                .foregroundColor(color)
                .frame(width: 60, height: 60)
                .background(color.opacity(0.1))
                .cornerRadius(15)
            
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.headline)
                
                Text(description)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            
            Spacer()
            
            Image(systemName: "chevron.right")
                .foregroundColor(.secondary)
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.05), radius: 5, x: 0, y: 2)
    }
}

// 统计卡片
struct StatCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color
    
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 24))
                .foregroundColor(color)
            
            Text(value)
                .font(.title)
                .fontWeight(.bold)
            
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.05), radius: 5, x: 0, y: 2)
    }
}

// 最近错题卡片
struct RecentErrorLogCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("数学")
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.blue.opacity(0.1))
                    .foregroundColor(.blue)
                    .cornerRadius(5)
                
                Text("函数")
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.green.opacity(0.1))
                    .foregroundColor(.green)
                    .cornerRadius(5)
                
                Spacer()
                
                Text("2023-10-15")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Text("已知函数f(x)=x²-2x+3，求f(x)的最小值")
                .font(.headline)
                .lineLimit(2)
            
            HStack {
                Text("错误原因：")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                
                Text("求导公式应用错误")
                    .font(.subheadline)
                    .foregroundColor(.red)
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.05), radius: 5, x: 0, y: 2)
    }
}

struct HomeView_Previews: PreviewProvider {
    static var previews: some View {
        HomeView()
            .environmentObject(AuthViewModel())
    }
} 