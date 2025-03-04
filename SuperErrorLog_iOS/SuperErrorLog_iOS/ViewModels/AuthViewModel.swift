import Foundation
import Combine

class AuthViewModel: ObservableObject {
    @Published var isAuthenticated = false
    @Published var currentUser: User?
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    private let apiService = APIService()
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        // 检查是否有保存的用户会话
        checkSavedSession()
    }
    
    private func checkSavedSession() {
        // 从UserDefaults或Keychain中读取保存的会话信息
        if let userData = UserDefaults.standard.data(forKey: "currentUser"),
           let user = try? JSONDecoder().decode(User.self, from: userData),
           let token = KeychainHelper.standard.read(service: "com.supererrorlog.token", account: "user") {
            self.currentUser = user
            self.isAuthenticated = true
            apiService.setAuthToken(token: String(data: token, encoding: .utf8) ?? "")
        }
    }
    
    func login(email: String, password: String) {
        isLoading = true
        errorMessage = nil
        
        apiService.login(email: email, password: password)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                self?.isLoading = false
                if case .failure(let error) = completion {
                    self?.errorMessage = error.localizedDescription
                }
            } receiveValue: { [weak self] response in
                self?.currentUser = response.user
                self?.isAuthenticated = true
                
                // 保存用户信息和令牌
                if let userData = try? JSONEncoder().encode(response.user) {
                    UserDefaults.standard.set(userData, forKey: "currentUser")
                }
                
                if let tokenData = response.token.data(using: .utf8) {
                    KeychainHelper.standard.save(tokenData, service: "com.supererrorlog.token", account: "user")
                }
                
                self?.apiService.setAuthToken(token: response.token)
            }
            .store(in: &cancellables)
    }
    
    func register(name: String, email: String, password: String) {
        isLoading = true
        errorMessage = nil
        
        apiService.register(name: name, email: email, password: password)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                self?.isLoading = false
                if case .failure(let error) = completion {
                    self?.errorMessage = error.localizedDescription
                }
            } receiveValue: { [weak self] response in
                self?.currentUser = response.user
                self?.isAuthenticated = true
                
                // 保存用户信息和令牌
                if let userData = try? JSONEncoder().encode(response.user) {
                    UserDefaults.standard.set(userData, forKey: "currentUser")
                }
                
                if let tokenData = response.token.data(using: .utf8) {
                    KeychainHelper.standard.save(tokenData, service: "com.supererrorlog.token", account: "user")
                }
                
                self?.apiService.setAuthToken(token: response.token)
            }
            .store(in: &cancellables)
    }
    
    func logout() {
        // 清除用户数据和令牌
        UserDefaults.standard.removeObject(forKey: "currentUser")
        KeychainHelper.standard.delete(service: "com.supererrorlog.token", account: "user")
        
        currentUser = nil
        isAuthenticated = false
        apiService.clearAuthToken()
    }
} 