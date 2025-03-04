import Foundation

struct User: Codable, Identifiable {
    let id: String
    let name: String
    let email: String
    let createdAt: Date
    let subscription: SubscriptionType
    
    enum CodingKeys: String, CodingKey {
        case id
        case name
        case email
        case createdAt = "created_at"
        case subscription
    }
}

enum SubscriptionType: String, Codable {
    case free = "free"
    case standard = "standard"
    case professional = "professional"
}

struct AuthResponse: Codable {
    let user: User
    let token: String
} 