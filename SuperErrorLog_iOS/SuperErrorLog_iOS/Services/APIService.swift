import Foundation
import Combine

enum APIError: Error {
    case invalidURL
    case invalidResponse
    case httpError(Int)
    case decodingError(Error)
    case serverError(String)
    case networkError(Error)
    
    var localizedDescription: String {
        switch self {
        case .invalidURL:
            return "无效的URL"
        case .invalidResponse:
            return "无效的响应"
        case .httpError(let code):
            return "HTTP错误: \(code)"
        case .decodingError:
            return "数据解析错误"
        case .serverError(let message):
            return message
        case .networkError(let error):
            return "网络错误: \(error.localizedDescription)"
        }
    }
}

class APIService {
    static let baseURL = "https://api.supererrorlog.com"
    private var authToken: String?
    
    private let jsonDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
    
    func setAuthToken(token: String) {
        self.authToken = token
    }
    
    func clearAuthToken() {
        self.authToken = nil
    }
    
    private func createRequest(endpoint: String, method: String, body: Data? = nil) -> URLRequest? {
        guard let url = URL(string: "\(APIService.baseURL)\(endpoint)") else {
            return nil
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        if let body = body {
            request.httpBody = body
        }
        
        return request
    }
    
    // MARK: - 认证API
    
    func login(email: String, password: String) -> AnyPublisher<AuthResponse, APIError> {
        let loginData = ["email": email, "password": password]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: loginData) else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        guard let request = createRequest(endpoint: "/auth/login", method: "POST", body: jsonData) else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        return URLSession.shared.dataTaskPublisher(for: request)
            .tryMap { data, response in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                
                if httpResponse.statusCode != 200 {
                    if let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let errorMessage = errorResponse["message"] {
                        throw APIError.serverError(errorMessage)
                    }
                    throw APIError.httpError(httpResponse.statusCode)
                }
                
                return data
            }
            .decode(type: AuthResponse.self, decoder: jsonDecoder)
            .mapError { error in
                if let apiError = error as? APIError {
                    return apiError
                }
                if let decodingError = error as? DecodingError {
                    return APIError.decodingError(decodingError)
                }
                return APIError.networkError(error)
            }
            .eraseToAnyPublisher()
    }
    
    func register(name: String, email: String, password: String) -> AnyPublisher<AuthResponse, APIError> {
        let registerData = ["name": name, "email": email, "password": password]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: registerData) else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        guard let request = createRequest(endpoint: "/auth/register", method: "POST", body: jsonData) else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        return URLSession.shared.dataTaskPublisher(for: request)
            .tryMap { data, response in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                
                if httpResponse.statusCode != 200 {
                    if let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let errorMessage = errorResponse["message"] {
                        throw APIError.serverError(errorMessage)
                    }
                    throw APIError.httpError(httpResponse.statusCode)
                }
                
                return data
            }
            .decode(type: AuthResponse.self, decoder: jsonDecoder)
            .mapError { error in
                if let apiError = error as? APIError {
                    return apiError
                }
                if let decodingError = error as? DecodingError {
                    return APIError.decodingError(decodingError)
                }
                return APIError.networkError(error)
            }
            .eraseToAnyPublisher()
    }
    
    // MARK: - 错题记录API
    
    func getErrorLogs() -> AnyPublisher<ErrorLogResponse, APIError> {
        guard let request = createRequest(endpoint: "/logs", method: "GET") else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        return URLSession.shared.dataTaskPublisher(for: request)
            .tryMap { data, response in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                
                if httpResponse.statusCode != 200 {
                    if let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let errorMessage = errorResponse["message"] {
                        throw APIError.serverError(errorMessage)
                    }
                    throw APIError.httpError(httpResponse.statusCode)
                }
                
                return data
            }
            .decode(type: ErrorLogResponse.self, decoder: jsonDecoder)
            .mapError { error in
                if let apiError = error as? APIError {
                    return apiError
                }
                if let decodingError = error as? DecodingError {
                    return APIError.decodingError(decodingError)
                }
                return APIError.networkError(error)
            }
            .eraseToAnyPublisher()
    }
    
    func getErrorLog(id: String) -> AnyPublisher<ErrorLog, APIError> {
        guard let request = createRequest(endpoint: "/logs/\(id)", method: "GET") else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        return URLSession.shared.dataTaskPublisher(for: request)
            .tryMap { data, response in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                
                if httpResponse.statusCode != 200 {
                    if let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let errorMessage = errorResponse["message"] {
                        throw APIError.serverError(errorMessage)
                    }
                    throw APIError.httpError(httpResponse.statusCode)
                }
                
                return data
            }
            .decode(type: ErrorLog.self, decoder: jsonDecoder)
            .mapError { error in
                if let apiError = error as? APIError {
                    return apiError
                }
                if let decodingError = error as? DecodingError {
                    return APIError.decodingError(decodingError)
                }
                return APIError.networkError(error)
            }
            .eraseToAnyPublisher()
    }
    
    func searchErrorLogs(level: Int, title: String) -> AnyPublisher<ErrorLogResponse, APIError> {
        let searchData = ["level": level, "title": title]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: searchData) else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        guard let request = createRequest(endpoint: "/api/search", method: "POST", body: jsonData) else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        return URLSession.shared.dataTaskPublisher(for: request)
            .tryMap { data, response in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                
                if httpResponse.statusCode != 200 {
                    if let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let errorMessage = errorResponse["message"] {
                        throw APIError.serverError(errorMessage)
                    }
                    throw APIError.httpError(httpResponse.statusCode)
                }
                
                return data
            }
            .decode(type: ErrorLogResponse.self, decoder: jsonDecoder)
            .mapError { error in
                if let apiError = error as? APIError {
                    return apiError
                }
                if let decodingError = error as? DecodingError {
                    return APIError.decodingError(decodingError)
                }
                return APIError.networkError(error)
            }
            .eraseToAnyPublisher()
    }
    
    // MARK: - 上传图片API
    
    func uploadImage(imageData: Data) -> AnyPublisher<String, APIError> {
        guard let url = URL(string: "\(APIService.baseURL)/upload") else {
            return Fail(error: APIError.invalidURL).eraseToAnyPublisher()
        }
        
        let boundary = UUID().uuidString
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        var body = Data()
        
        // 添加图片数据
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"image.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n".data(using: .utf8)!)
        
        // 结束标记
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        
        request.httpBody = body
        
        return URLSession.shared.dataTaskPublisher(for: request)
            .tryMap { data, response in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIError.invalidResponse
                }
                
                if httpResponse.statusCode != 200 {
                    if let errorResponse = try? JSONDecoder().decode([String: String].self, from: data),
                       let errorMessage = errorResponse["message"] {
                        throw APIError.serverError(errorMessage)
                    }
                    throw APIError.httpError(httpResponse.statusCode)
                }
                
                guard let responseDict = try? JSONDecoder().decode([String: String].self, from: data),
                      let imagePath = responseDict["image_path"] else {
                    throw APIError.decodingError(NSError(domain: "APIService", code: 0, userInfo: [NSLocalizedDescriptionKey: "无法解析图片路径"]))
                }
                
                return imagePath
            }
            .mapError { error in
                if let apiError = error as? APIError {
                    return apiError
                }
                return APIError.networkError(error)
            }
            .eraseToAnyPublisher()
    }
} 