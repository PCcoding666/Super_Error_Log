import SwiftUI

struct ErrorLogListView: View {
    @StateObject private var viewModel = ErrorLogListViewModel()
    @State private var searchText = ""
    @State private var showingFilters = false
    
    var body: some View {
        NavigationView {
            VStack {
                // 搜索栏
                HStack {
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.secondary)
                        
                        TextField("搜索错题...", text: $searchText)
                            .autocapitalization(.none)
                        
                        if !searchText.isEmpty {
                            Button(action: {
                                searchText = ""
                            }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color(.systemGray6))
                    .cornerRadius(10)
                    
                    Button(action: {
                        showingFilters.toggle()
                    }) {
                        Image(systemName: "line.3.horizontal.decrease.circle\(showingFilters ? ".fill" : "")")
                            .foregroundColor(.blue)
                    }
                }
                .padding(.horizontal)
                
                // 筛选选项
                if showingFilters {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            FilterChip(title: "全部", isSelected: viewModel.currentFilter == .all) {
                                viewModel.currentFilter = .all
                            }
                            
                            FilterChip(title: "数学", isSelected: viewModel.currentFilter == .math) {
                                viewModel.currentFilter = .math
                            }
                            
                            FilterChip(title: "物理", isSelected: viewModel.currentFilter == .physics) {
                                viewModel.currentFilter = .physics
                            }
                            
                            FilterChip(title: "化学", isSelected: viewModel.currentFilter == .chemistry) {
                                viewModel.currentFilter = .chemistry
                            }
                            
                            FilterChip(title: "最近添加", isSelected: viewModel.currentFilter == .recent) {
                                viewModel.currentFilter = .recent
                            }
                        }
                        .padding(.horizontal)
                    }
                    .padding(.vertical, 5)
                }
                
                if viewModel.isLoading {
                    Spacer()
                    ProgressView("加载中...")
                    Spacer()
                } else if viewModel.errorLogs.isEmpty {
                    Spacer()
                    VStack(spacing: 15) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        
                        Text("暂无错题记录")
                            .font(.headline)
                        
                        Text("上传您的第一道错题开始学习吧")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        
                        Button(action: {
                            // 跳转到上传页面
                        }) {
                            Text("上传错题")
                                .fontWeight(.semibold)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 10)
                                .background(Color.blue)
                                .foregroundColor(.white)
                                .cornerRadius(8)
                        }
                        .padding(.top, 10)
                    }
                    .padding()
                    Spacer()
                } else {
                    List {
                        ForEach(filteredLogs) { errorLog in
                            NavigationLink(destination: ErrorLogDetailView(errorLog: errorLog)) {
                                ErrorLogRow(errorLog: errorLog)
                            }
                        }
                    }
                    .listStyle(PlainListStyle())
                    .refreshable {
                        await viewModel.fetchErrorLogs()
                    }
                }
            }
            .navigationTitle("错题本")
            .navigationBarItems(trailing: Button(action: {
                // 排序选项
            }) {
                Image(systemName: "arrow.up.arrow.down")
                    .foregroundColor(.primary)
            })
            .onAppear {
                Task {
                    await viewModel.fetchErrorLogs()
                }
            }
        }
    }
    
    private var filteredLogs: [ErrorLog] {
        if searchText.isEmpty {
            return viewModel.errorLogs
        } else {
            return viewModel.errorLogs.filter { errorLog in
                errorLog.title.localizedCaseInsensitiveContains(searchText) ||
                errorLog.question.localizedCaseInsensitiveContains(searchText) ||
                errorLog.level1Title.localizedCaseInsensitiveContains(searchText) ||
                errorLog.level2Title.localizedCaseInsensitiveContains(searchText) ||
                errorLog.level3Title.localizedCaseInsensitiveContains(searchText)
            }
        }
    }
}

struct ErrorLogRow: View {
    let errorLog: ErrorLog
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(errorLog.level1Title)
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.blue.opacity(0.1))
                    .foregroundColor(.blue)
                    .cornerRadius(5)
                
                Text(errorLog.level2Title)
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.green.opacity(0.1))
                    .foregroundColor(.green)
                    .cornerRadius(5)
                
                Spacer()
                
                Text(formatDate(errorLog.createdAt))
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Text(errorLog.title)
                .font(.headline)
                .lineLimit(2)
            
            Text(errorLog.question)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 8)
    }
    
    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(isSelected ? Color.blue : Color(.systemGray6))
                .foregroundColor(isSelected ? .white : .primary)
                .cornerRadius(15)
        }
    }
}

class ErrorLogListViewModel: ObservableObject {
    @Published var errorLogs: [ErrorLog] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var currentFilter: FilterOption = .all
    
    private let apiService = APIService()
    
    enum FilterOption {
        case all, math, physics, chemistry, recent
    }
    
    @MainActor
    func fetchErrorLogs() async {
        isLoading = true
        errorMessage = nil
        
        do {
            let publisher = apiService.getErrorLogs()
            
            for await value in publisher.values {
                self.errorLogs = value.errorLogs
                break
            }
        } catch {
            errorMessage = "加载错题失败: \(error.localizedDescription)"
        }
        
        isLoading = false
    }
}

struct ErrorLogDetailView: View {
    let errorLog: ErrorLog
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // 题目信息
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(errorLog.level1Title)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.blue.opacity(0.1))
                            .foregroundColor(.blue)
                            .cornerRadius(5)
                        
                        Text(errorLog.level2Title)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.green.opacity(0.1))
                            .foregroundColor(.green)
                            .cornerRadius(5)
                        
                        Text(errorLog.level3Title)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.orange.opacity(0.1))
                            .foregroundColor(.orange)
                            .cornerRadius(5)
                    }
                    
                    Text(errorLog.title)
                        .font(.title2)
                        .fontWeight(.bold)
                }
                
                // 题目图片
                if let imageURL = errorLog.imageURL {
                    AsyncImage(url: imageURL) { phase in
                        switch phase {
                        case .empty:
                            ProgressView()
                                .frame(height: 200)
                        case .success(let image):
                            image
                                .resizable()
                                .scaledToFit()
                                .cornerRadius(10)
                        case .failure:
                            Image(systemName: "photo")
                                .font(.largeTitle)
                                .foregroundColor(.gray)
                                .frame(height: 200)
                        @unknown default:
                            EmptyView()
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                
                // 题目内容
                VStack(alignment: .leading, spacing: 15) {
                    Text("题目")
                        .font(.headline)
                    
                    Text(errorLog.question)
                        .padding()
                        .background(Color(.systemGray6))
                        .cornerRadius(10)
                }
                
                // 学生答案
                VStack(alignment: .leading, spacing: 15) {
                    Text("我的答案")
                        .font(.headline)
                    
                    Text(errorLog.studentAnswer)
                        .padding()
                        .background(Color(.systemGray6))
                        .cornerRadius(10)
                }
                
                // 正确答案
                VStack(alignment: .leading, spacing: 15) {
                    Text("正确答案")
                        .font(.headline)
                    
                    Text(errorLog.correctAnswer)
                        .padding()
                        .background(Color(.systemGray6))
                        .cornerRadius(10)
                }
                
                // 解析
                VStack(alignment: .leading, spacing: 15) {
                    Text("解析")
                        .font(.headline)
                    
                    Text(errorLog.analysis)
                        .padding()
                        .background(Color(.systemGray6))
                        .cornerRadius(10)
                }
            }
            .padding()
        }
        .navigationTitle("错题详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ErrorLogListView_Previews: PreviewProvider {
    static var previews: some View {
        ErrorLogListView()
    }
} 