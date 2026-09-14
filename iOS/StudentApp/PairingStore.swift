import Foundation
import Security

enum PairingStore {
  private static func query(scope: String) throws -> [String: Any] {
    guard let account = PairingScope.account(collectionName: scope) else { throw RecognitionClientError.invalidPairing }
    return [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "com.supererrorlog.local-recognition",
     kSecAttrAccount as String: account]
  }
  static func load(scope: String) throws -> PairingConfiguration? {
    var query = try query(scope: scope)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw RecognitionClientError.service("无法读取本机配对信息，请解锁设备后重试。") }
    let saved = try JSONDecoder().decode(PairingConfiguration.self, from: data)
    return try PairingConfiguration(baseURL: saved.baseURL.absoluteString, token: saved.token)
  }
  static func save(_ pairing: PairingConfiguration, scope: String) throws {
    let query = try query(scope: scope)
    let data = try JSONEncoder().encode(pairing)
    let attributes: [String: Any] = [kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw RecognitionClientError.service("配对信息未保存，请解锁设备后重试。") }
  }

  #if DEBUG
  // QA only: root may place this one scoped file in the app collection. No launch token or bundle secret.
  static func consumeBootstrap(in directory: URL) throws {
    let file = directory.appendingPathComponent("pairing-bootstrap.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    let incoming = try JSONDecoder().decode(PairingConfiguration.self, from: Data(contentsOf: file))
    let checked = try PairingConfiguration(baseURL: incoming.baseURL.absoluteString, token: incoming.token)
    try save(checked, scope: directory.lastPathComponent)
    try FileManager.default.removeItem(at: file)
  }
  #endif
}
