import SwiftUI

struct SearchView: View {
    @StateObject private var viewModel = SearchViewModel()
    @State private var searchText = ""
    @State private var selectedLevel = 1
    @State private var selectedTitle = ""
    
    var body: some View {
        NavigationView {
            VStack {
                // 搜索栏
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
                .padding(.horizontal)
                
                // 知识点选择
                VStack(alignment: .leading, spacing: 15) {
                    Text("按知识点筛选")
                        .font(.headline)
                        .padding(.horizontal)
                    
                    // 级别选择器
                    Picker("级别", selection: $selectedLevel) {
                        Text("一级").tag(1)
                        Text("二级").tag(2)
                        Text("三级").tag(3)
                    }
                    .pickerStyle(SegmentedPickerStyle())
                    .padding(.horizontal)
                    
                    // 知识点列表
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(knowledgePoints(for: selectedLevel), id: \.self) { title in
                                KnowledgePointChip(
                                    title: title,
                                    isSelected: selectedTitle == title
                                ) {
                                    if selectedTitle == title {
                                        selectedTitle = ""
                                    } else {
                                        selectedTitle = title
                                    }
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                }
                .padding(.vertical)
                
                // 搜索按钮
                Button(action: {
                    Task {
                        await viewModel.searchErrorLogs(level: selectedLevel, title: selectedTitle)
                    }
                }) {
                    HStack {
                        if viewModel.isLoading {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                .padding(.trailing, 5)
                        }
                        Text("搜索")
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(10)
                }
                .padding(.horizontal)
                .disabled(viewModel.isLoading || (selectedTitle.isEmpty && searchText.isEmpty))
                
                // 搜索结果
                if viewModel.isLoading {
                    Spacer()
                    ProgressView("搜索中...")
                    Spacer()
                } else if let errorMessage = viewModel.errorMessage {
                    Spacer()
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 50))
                            .foregroundColor(.orange)
                        
                        Text("搜索失败")
                            .font(.headline)
                        
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    Spacer()
                } else if viewModel.hasSearched && viewModel.searchResults.isEmpty {
                    Spacer()
                    VStack(spacing: 15) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        
                        Text("未找到相关错题")
                            .font(.headline)
                        
                        Text("请尝试其他搜索条件")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .padding()
                    Spacer()
                } else if viewModel.hasSearched {
                    List {
                        ForEach(viewModel.searchResults) { errorLog in
                            NavigationLink(destination: ErrorLogDetailView(errorLog: errorLog)) {
                                ErrorLogRow(errorLog: errorLog)
                            }
                        }
                    }
                    .listStyle(PlainListStyle())
                } else {
                    // 初始状态
                    Spacer()
                    VStack(spacing: 20) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 60))
                            .foregroundColor(.gray)
                        
                        Text("按知识点搜索错题")
                            .font(.title3)
                            .fontWeight(.semibold)
                        
                        Text("选择知识点分类或输入关键词进行搜索")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    Spacer()
                }
            }
            .navigationTitle("知识点搜索")
        }
    }
    
    private func knowledgePoints(for level: Int) -> [String] {
        switch level {
        case 1:
            return ["数学", "物理", "化学", "生物", "语文", "英语", "历史", "地理", "政治"]
        case 2:
            if selectedTitle == "数学" {
                return ["代数", "几何", "函数", "概率统计", "三角函数", "立体几何", "解析几何"]
            } else if selectedTitle == "物理" {
                return ["力学", "热学", "电磁学", "光学", "原子物理"]
            } else {
                return ["请先选择一级知识点"]
            }
        case 3:
            if selectedTitle == "函数" {
                return ["函数定义", "函数图像", "函数性质", "函数应用", "导数", "积分"]
            } else if selectedTitle == "力学" {
                return ["牛顿定律", "动量", "能量守恒", "圆周运动", "简谐运动"]
            } else {
                return ["请先选择二级知识点"]
            }
        default:
            return []
        }
    }
}

struct KnowledgePointChip: View {
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

class SearchViewModel: ObservableObject {
    @Published var searchResults: [ErrorLog] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var hasSearched = false
    
    private let apiService = APIService()
    
    @MainActor
    func searchErrorLogs(level: Int, title: String) async {
        isLoading = true
        errorMessage = nil
        
        do {
            let publisher = apiService.searchErrorLogs(level: level, title: title)
            
            for await value in publisher.values {
                self.searchResults = value.errorLogs
                self.hasSearched = true
                break
            }
        } catch {
            errorMessage = "搜索失败: \(error.localizedDescription)"
        }
        
        isLoading = false
    }
}

struct SearchView_Previews: PreviewProvider {
    static var previews: some View {
        SearchView()
    }
} 