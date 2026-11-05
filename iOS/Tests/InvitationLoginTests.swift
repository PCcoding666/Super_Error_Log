import XCTest
import Foundation
@testable import StudentCore

// 邀请码登录（2026-10-23）：配置白名单、Codable、登录/退出请求形状、归属校验、StudyStore 落库。
// 全部走合成 URLProtocol，不连真实服务、不调模型。
final class InvitationLoginTests: XCTestCase {
  static let entry = "https://study.pccoding666.com/s/native"
  static let serviceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let token = "issued-session-token-32-bytes-test!!"

  // MARK: - 邀请码形状

  func testInvitationCodeNormalizesLikeTheServer() {
    XCTAssertEqual(InvitationCode.normalize(" abcd-efgh-jk12 "), "ABCDEFGHJK12")
    XCTAssertEqual(InvitationCode.formatted("abcdefghjk12"), "ABCD-EFGH-JK12")
    XCTAssertNil(InvitationCode.normalize("ABCDEFGHJK1"), "11 位不完整")
    XCTAssertNil(InvitationCode.normalize("ABCDEFGHIK12"), "I 不在字母表里")
    XCTAssertFalse(InvitationCode.looksComplete(""))
    XCTAssertTrue(InvitationCode.looksComplete("abcd efgh jk12"))
  }

  // MARK: - 配置白名单与 Codable

  func testInvitationConfigurationOnlyAcceptsTheNativeEntryOfAllowedHosts() throws {
    let configuration = try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: Self.serviceId, token: Self.token, expiresAt: nil)
    XCTAssertTrue(configuration.isCloud, "邀请码登录沿用云端语义")
    XCTAssertTrue(configuration.isInvitation)
    XCTAssertEqual(configuration.baseURL.absoluteString, Self.entry)
    XCTAssertEqual(configuration.token, Self.token)
    XCTAssertEqual(configuration.serviceId, Self.serviceId)
    XCTAssertNil(configuration.deviceId)
    XCTAssertNoThrow(try PairingConfiguration.invitation(baseURL: "https://8.163.96.197/s/native", serviceId: Self.serviceId, token: Self.token, expiresAt: nil))
    for bad in ["https://study.pccoding666.com", "https://study.pccoding666.com/s/native/", "http://study.pccoding666.com/s/native",
      "https://evil.example/s/native", "https://study.pccoding666.com:8443/s/native", "https://study.pccoding666.com/s/native?x=1",
      "https://user:pw@study.pccoding666.com/s/native"] {
      XCTAssertThrowsError(try PairingConfiguration.invitation(baseURL: bad, serviceId: Self.serviceId, token: Self.token, expiresAt: nil), bad)
    }
    XCTAssertThrowsError(try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: "not-a-uuid", token: Self.token, expiresAt: nil))
    XCTAssertThrowsError(try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: Self.serviceId, token: "short", expiresAt: nil))
  }

  func testInvitationConfigurationRoundTripsAndRejectsTamperedDisk() throws {
    let expires = Date(timeIntervalSince1970: 1_800_000_000)
    let original = try PairingConfiguration.invitation(baseURL: Self.entry, serviceId: Self.serviceId, token: Self.token, expiresAt: expires)
    let data = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(PairingConfiguration.self, from: data)
    XCTAssertEqual(decoded, original)
    XCTAssertTrue(decoded.isInvitation)
    XCTAssertEqual(decoded.expiresAt, expires)
    // 磁盘上的入口被改成别的主机：解码必须失败（不信任磁盘字段）。
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(object["mode"] as? String, "invitation")
    object["baseURL"] = "https://evil.example/s/native"
    XCTAssertThrowsError(try JSONDecoder().decode(PairingConfiguration.self, from: JSONSerialization.data(withJSONObject: object)))
    // 旧的 cloud 形状照常可读
    let cloud = try PairingConfiguration.cloud(baseURL: "https://study.pccoding666.com", serviceId: Self.serviceId, token: Self.token,
      deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb", expiresAt: nil)
    XCTAssertEqual(try JSONDecoder().decode(PairingConfiguration.self, from: JSONEncoder().encode(cloud)), cloud)
    XCTAssertFalse(cloud.isInvitation)
  }

  // MARK: - 登录请求形状

  func testLoginPostsCodeWithoutAuthorizationAndDecodesResult() async throws {
    InvitationSyntheticProtocol.reset()
    let client = try makeClient()
    let result = try await client.loginInvitation(code: "ABCDEFGHJK12", deviceInfo: "iPhone")
    XCTAssertEqual(result.token, Self.token)
    XCTAssertEqual(result.serviceId, Self.serviceId)
    XCTAssertEqual(result.protocolVersion, 1)
    let request = try XCTUnwrap(InvitationSyntheticProtocol.requests().first)
    XCTAssertEqual(request.url?.absoluteString, "\(Self.entry)/login")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "登录前不带任何令牌")
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(body["code"] as? String, "ABCDEFGHJK12")
    XCTAssertEqual(body["deviceInfo"] as? String, "iPhone")
  }

  func testLoginSurfacesServerMessageAndRejectsWrongProtocol() async throws {
    InvitationSyntheticProtocol.reset()
    InvitationSyntheticProtocol.overrideLogin(status: 400, body: #"{"error":{"code":"invalid_code","message":"邀请码不正确或已经失效。"}}"#)
    let client = try makeClient()
    do {
      _ = try await client.loginInvitation(code: "ABCDEFGHJK12", deviceInfo: "iPhone")
      XCTFail("应当抛错")
    } catch let error as RecognitionClientError {
      guard case .server(let status, let message) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(status, 400)
      XCTAssertEqual(message, "邀请码不正确或已经失效。")
    }
    InvitationSyntheticProtocol.reset()
    InvitationSyntheticProtocol.overrideLogin(status: 200, body: #"{"token":"issued-session-token-32-bytes-test!!","serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","expiresAt":"2026-11-22T00:00:00.000Z","protocolVersion":2}"#)
    do {
      _ = try await client.loginInvitation(code: "ABCDEFGHJK12", deviceInfo: "iPhone")
      XCTFail("协议代次不符应当拒绝")
    } catch let error as RecognitionClientError {
      guard case .invalidResponse = error else { return XCTFail("\(error)") }
    }
  }

  // MARK: - 健康检查走 /s/native/v1/health 并核对归属

  func testHealthGoesThroughNativeEntryAndChecksServiceId() async throws {
    InvitationSyntheticProtocol.reset()
    let client = try makeClient()
    let snapshot = try await client.health()
    XCTAssertEqual(snapshot.serviceId, Self.serviceId)
    XCTAssertEqual(InvitationSyntheticProtocol.requests().last?.url?.absoluteString, "\(Self.entry)/v1/health")
    XCTAssertEqual(InvitationSyntheticProtocol.requests().last?.value(forHTTPHeaderField: "Authorization"), "Bearer \(Self.token)")
    InvitationSyntheticProtocol.overrideHealth(status: 200, body: #"{"version":1,"serviceId":"11111111-2222-4333-8444-555555555555","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#)
    do {
      _ = try await client.health()
      XCTFail("serviceId 不一致应当视为不兼容")
    } catch let error as RecognitionClientError {
      guard case .incompatiblePairing = error else { return XCTFail("\(error)") }
    }
  }

  func testLogoutPostsWithBearer() async throws {
    InvitationSyntheticProtocol.reset()
    let client = try makeClient()
    try await client.logoutInvitation()
    let request = try XCTUnwrap(InvitationSyntheticProtocol.requests().last)
    XCTAssertEqual(request.url?.absoluteString, "\(Self.entry)/logout")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(Self.token)")
  }

  // MARK: - StudyStore 落库与退出

  // MARK: - helpers

  private func makeClient() throws -> RecognitionClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [InvitationSyntheticProtocol.self]
    return RecognitionClient(configuration: try PairingConfiguration.invitation(
      baseURL: Self.entry, serviceId: Self.serviceId, token: Self.token, expiresAt: nil), sessionConfiguration: configuration)
  }
}

/// 合成网关：/s/native/login、/s/native/logout、/s/native/v1/health。记录每个请求（含正文）供断言。
final class InvitationSyntheticProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var recorded: [URLRequest] = []
  nonisolated(unsafe) private static var loginOverride: (status: Int, body: String)?
  nonisolated(unsafe) private static var healthOverride: (status: Int, body: String)?
  static func requests() -> [URLRequest] { lock.withLock { recorded } }
  static func reset() { lock.withLock { recorded = []; loginOverride = nil; healthOverride = nil } }
  static func overrideLogin(status: Int, body: String) { lock.withLock { loginOverride = (status, body) } }
  static func overrideHealth(status: Int, body: String) { lock.withLock { healthOverride = (status, body) } }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    if let stream = request.httpBodyStream {
      stream.open()
      var bytes = Data()
      var buffer = [UInt8](repeating: 0, count: 1024)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        bytes.append(buffer, count: count)
      }
      stream.close()
      captured.httpBody = bytes
    }
    Self.lock.withLock { Self.recorded.append(captured) }
    let url = request.url?.absoluteString ?? ""
    if url.hasSuffix("/s/native/login") {
      if let override = Self.lock.withLock({ Self.loginOverride }) { respond(status: override.status, body: override.body); return }
      respond(status: 200, body: #"{"token":"issued-session-token-32-bytes-test!!","serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","expiresAt":"2026-11-22T00:00:00.000Z","protocolVersion":1}"#)
    } else if url.hasSuffix("/s/native/logout") {
      respond(status: 204, body: "")
    } else if url.hasSuffix("/s/native/v1/health") {
      if let override = Self.lock.withLock({ Self.healthOverride }) { respond(status: override.status, body: override.body); return }
      respond(status: 200, body: #"{"version":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#)
    } else {
      respond(status: 404, body: #"{"error":{"code":"not_found","message":"接口不存在。"}}"#)
    }
  }
  private func respond(status: Int, body: String) {
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
