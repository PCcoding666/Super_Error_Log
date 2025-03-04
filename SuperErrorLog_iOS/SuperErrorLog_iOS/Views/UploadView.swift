import SwiftUI
import PhotosUI

struct UploadView: View {
    @StateObject private var viewModel = UploadViewModel()
    @State private var showingImagePicker = false
    @State private var showingCamera = false
    @State private var showingActionSheet = false
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    // 上传区域
                    VStack(spacing: 15) {
                        if let selectedImage = viewModel.selectedImage {
                            Image(uiImage: selectedImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxHeight: 300)
                                .cornerRadius(10)
                        } else {
                            ZStack {
                                RoundedRectangle(cornerRadius: 10)
                                    .fill(Color(.systemGray6))
                                    .frame(height: 200)
                                
                                VStack(spacing: 15) {
                                    Image(systemName: "photo")
                                        .font(.system(size: 50))
                                        .foregroundColor(.gray)
                                    
                                    Text("点击上传错题图片")
                                        .font(.headline)
                                        .foregroundColor(.secondary)
                                }
                            }
                            .onTapGesture {
                                showingActionSheet = true
                            }
                        }
                        
                        if viewModel.selectedImage != nil {
                            Button(action: {
                                showingActionSheet = true
                            }) {
                                HStack {
                                    Image(systemName: "arrow.triangle.2.circlepath")
                                    Text("更换图片")
                                }
                                .foregroundColor(.blue)
                            }
                        }
                    }
                    .padding(.horizontal)
                    
                    // 表单
                    if viewModel.selectedImage != nil {
                        VStack(alignment: .leading, spacing: 20) {
                            Text("错题信息")
                                .font(.headline)
                                .padding(.horizontal)
                            
                            VStack(alignment: .leading, spacing: 10) {
                                Text("标题")
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                                
                                TextField("请输入错题标题", text: $viewModel.title)
                                    .textFieldStyle(RoundedBorderTextFieldStyle())
                            }
                            .padding(.horizontal)
                            
                            VStack(alignment: .leading, spacing: 10) {
                                Text("知识点分类")
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                                
                                HStack {
                                    Picker("一级", selection: $viewModel.level1) {
                                        ForEach(viewModel.level1Options, id: \.self) { option in
                                            Text(option).tag(option)
                                        }
                                    }
                                    .pickerStyle(MenuPickerStyle())
                                    .frame(maxWidth: .infinity)
                                    .padding(8)
                                    .background(Color(.systemGray6))
                                    .cornerRadius(8)
                                    
                                    Picker("二级", selection: $viewModel.level2) {
                                        ForEach(viewModel.level2Options, id: \.self) { option in
                                            Text(option).tag(option)
                                        }
                                    }
                                    .pickerStyle(MenuPickerStyle())
                                    .frame(maxWidth: .infinity)
                                    .padding(8)
                                    .background(Color(.systemGray6))
                                    .cornerRadius(8)
                                }
                                
                                Picker("三级", selection: $viewModel.level3) {
                                    ForEach(viewModel.level3Options, id: \.self) { option in
                                        Text(option).tag(option)
                                    }
                                }
                                .pickerStyle(MenuPickerStyle())
                                .frame(maxWidth: .infinity)
                                .padding(8)
                                .background(Color(.systemGray6))
                                .cornerRadius(8)
                            }
                            .padding(.horizontal)
                            
                            VStack(alignment: .leading, spacing: 10) {
                                Text("我的答案")
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                                
                                TextEditor(text: $viewModel.studentAnswer)
                                    .frame(height: 100)
                                    .padding(4)
                                    .background(Color(.systemGray6))
                                    .cornerRadius(8)
                            }
                            .padding(.horizontal)
                            
                            // 上传按钮
                            Button(action: {
                                Task {
                                    await viewModel.uploadErrorLog()
                                }
                            }) {
                                HStack {
                                    if viewModel.isLoading {
                                        ProgressView()
                                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                            .padding(.trailing, 5)
                                    }
                                    Text("上传错题")
                                }
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(Color.blue)
                                .foregroundColor(.white)
                                .cornerRadius(10)
                            }
                            .disabled(viewModel.isLoading || !viewModel.isFormValid)
                            .padding(.horizontal)
                        }
                    }
                    
                    // 错误信息
                    if let errorMessage = viewModel.errorMessage {
                        Text(errorMessage)
                            .foregroundColor(.red)
                            .font(.subheadline)
                            .padding(.horizontal)
                    }
                    
                    // 成功信息
                    if viewModel.isSuccess {
                        VStack(spacing: 15) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 50))
                                .foregroundColor(.green)
                            
                            Text("上传成功！")
                                .font(.headline)
                            
                            Text("您的错题已成功上传并分析")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .multilineTextAlignment(.center)
                            
                            Button(action: {
                                // 查看错题详情
                            }) {
                                Text("查看错题")
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
                    }
                }
                .padding(.vertical)
            }
            .navigationTitle("上传错题")
            .actionSheet(isPresented: $showingActionSheet) {
                ActionSheet(
                    title: Text("选择图片来源"),
                    buttons: [
                        .default(Text("拍照")) {
                            showingCamera = true
                        },
                        .default(Text("从相册选择")) {
                            showingImagePicker = true
                        },
                        .cancel()
                    ]
                )
            }
            .sheet(isPresented: $showingImagePicker) {
                ImagePicker(image: $viewModel.selectedImage, sourceType: .photoLibrary)
            }
            .sheet(isPresented: $showingCamera) {
                ImagePicker(image: $viewModel.selectedImage, sourceType: .camera)
            }
        }
    }
}

struct ImagePicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    var sourceType: UIImagePickerController.SourceType
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = sourceType
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: ImagePicker
        
        init(_ parent: ImagePicker) {
            self.parent = parent
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.image = image
            }
            
            picker.dismiss(animated: true)
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
        }
    }
}

class UploadViewModel: ObservableObject {
    @Published var selectedImage: UIImage?
    @Published var title = ""
    @Published var level1 = "数学"
    @Published var level2 = "请选择"
    @Published var level3 = "请选择"
    @Published var studentAnswer = ""
    
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var isSuccess = false
    
    private let apiService = APIService()
    
    var level1Options = ["数学", "物理", "化学", "生物", "语文", "英语", "历史", "地理", "政治"]
    
    var level2Options: [String] {
        switch level1 {
        case "数学":
            return ["代数", "几何", "函数", "概率统计", "三角函数", "立体几何", "解析几何"]
        case "物理":
            return ["力学", "热学", "电磁学", "光学", "原子物理"]
        default:
            return ["请选择"]
        }
    }
    
    var level3Options: [String] {
        switch level2 {
        case "函数":
            return ["函数定义", "函数图像", "函数性质", "函数应用", "导数", "积分"]
        case "力学":
            return ["牛顿定律", "动量", "能量守恒", "圆周运动", "简谐运动"]
        default:
            return ["请选择"]
        }
    }
    
    var isFormValid: Bool {
        guard let _ = selectedImage else { return false }
        return !title.isEmpty && level1 != "请选择" && level2 != "请选择" && level3 != "请选择"
    }
    
    @MainActor
    func uploadErrorLog() async {
        guard let image = selectedImage, let imageData = image.jpegData(compressionQuality: 0.8) else {
            errorMessage = "图片处理失败"
            return
        }
        
        isLoading = true
        errorMessage = nil
        
        // 模拟上传过程
        do {
            // 上传图片
            try await Task.sleep(nanoseconds: 2_000_000_000) // 模拟2秒网络延迟
            
            // 模拟成功
            isSuccess = true
            
            // 重置表单
            // selectedImage = nil
            // title = ""
            // level1 = "数学"
            // level2 = "请选择"
            // level3 = "请选择"
            // studentAnswer = ""
        } catch {
            errorMessage = "上传失败: \(error.localizedDescription)"
        }
        
        isLoading = false
    }
}

struct UploadView_Previews: PreviewProvider {
    static var previews: some View {
        UploadView()
    }
} 