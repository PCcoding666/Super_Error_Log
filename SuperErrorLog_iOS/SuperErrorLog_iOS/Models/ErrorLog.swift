import Foundation

struct ErrorLog: Codable, Identifiable {
    let id: String
    let title: String
    let question: String
    let studentAnswer: String
    let correctAnswer: String
    let analysis: String
    let imagePath: String?
    let createdAt: Date
    let level1Title: String
    let level2Title: String
    let level3Title: String
    
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case question
        case studentAnswer = "student_answer"
        case correctAnswer = "correct_answer"
        case analysis
        case imagePath = "image_path"
        case createdAt = "created_at"
        case level1Title = "level1_title"
        case level2Title = "level2_title"
        case level3Title = "level3_title"
    }
    
    var imageURL: URL? {
        guard let path = imagePath else { return nil }
        return URL(string: "\(APIService.baseURL)/uploads/\(path)")
    }
}

struct ErrorLogResponse: Codable {
    let errorLogs: [ErrorLog]
    let total: Int
    
    enum CodingKeys: String, CodingKey {
        case errorLogs = "error_logs"
        case total
    }
} 