import XCTest
import Foundation
@testable import StudentCore

// Task 4 RED: cloud pairing, QR parsing, health snapshot decode, connection state machine.
// Synthetic documents only; these tests never contact a service or a model.
final class CloudPairingTests: XCTestCase {
  static let cloudURL = "https://study.pccoding666.com"

  // MARK: - QR payload parsing

  func testQRRefusesArbitraryServerAndRequiresHTTPS() throws {
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"s","httpsUrl":"https://evil.example","sessionId":"x","secret":"y"}"#))
    // Shared interface contract: serviceId/sessionId must be UUIDs; secret >= 32 base64url chars.
    XCTAssertNoThrow(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
  }

  func testQRValidatesProtocolVersionAndDomainAndUUIDShapeAndSecretLength() throws {
    // v must be exactly 1
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":2,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    // scheme must be https (no http, no credentials, no port/path/query)
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"http://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://user:pass@study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com:8443","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com/path","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com/?x=1","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    // serviceId and sessionId must be UUIDs
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"not-a-uuid","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec"}"#))
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"not-a-uuid","secret":"256bitsecret256bitsecret256bitsec"}"#))
    // secret must be at least 32 chars base64url-ish (no whitespace/newline)
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"short"}"#))
    XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"has space and newline\n"}"#))
    // unknown keys tolerated (forward compatibility), extra fields do not break parse
    XCTAssertNoThrow(try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"256bitsecret256bitsecret256bitsec","extra":"ignored"}"#))
  }

  func testQRPayloadExposesServiceAndBaseURL() throws {
    let payload = try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"2_39bX4iG76643WfiJRfvW-jYJVxbBdm9ACmHrgGjJ0"}"#)
    XCTAssertEqual(payload.serviceId, "3f7b69dc-9d37-4aaa-b965-bb61243445a0")
    XCTAssertEqual(payload.sessionId, "099ea4a5-e4bf-4182-b986-a9fc7db383e9")
    XCTAssertEqual(payload.httpsUrl, Self.cloudURL)
    XCTAssertEqual(payload.secret, "2_39bX4iG76643WfiJRfvW-jYJVxbBdm9ACmHrgGjJ0")
  }

  // MARK: - Health snapshot decoding

  func testHealthSnapshotRejectsMissingServiceId() throws {
    XCTAssertThrowsError(try RecognitionCodec.decoder().decode(HealthSnapshot.self,
      from: Data(#"{"version":1,"storageAvailable":true,"visionConfigured":true,"acceptingJobs":true}"#.utf8)))
  }

  func testHealthSnapshotDecodesFullCloudShapeAndRejectsWrongVersion() throws {
    let full = try RecognitionCodec.decoder().decode(HealthSnapshot.self,
      from: Data(#"{"version":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#.utf8))
    XCTAssertEqual(full.serviceId, "3f7b69dc-9d37-4aaa-b965-bb61243445a0")
    XCTAssertEqual(full.protocolVersion, 1)
    XCTAssertTrue(full.acceptingJobs)
    XCTAssertThrowsError(try RecognitionCodec.decoder().decode(HealthSnapshot.self,
      from: Data(#"{"version":2,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#.utf8)))
    XCTAssertThrowsError(try RecognitionCodec.decoder().decode(HealthSnapshot.self,
      from: Data(#"{"version":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":2}"#.utf8)))
  }

  // MARK: - Redeem request shape over synthetic URLProtocol

  func testSyntheticRedeemSendsClientIDAndPayloadAndDecodesRedeemResult() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SyntheticRedeemProtocol.self]
    let client = RecognitionClient(
      configuration: try PairingConfiguration.cloud(
        baseURL: Self.cloudURL, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
        token: "synthetic-device-token-32-bytes-test!",
        deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb",
        expiresAt: nil),
      sessionConfiguration: configuration)
    let qr = try CloudPairing.parse(#"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"https://study.pccoding666.com","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"2_39bX4iG76643WfiJRfvW-jYJVxbBdm9ACmHrgGjJ0"}"#)
    let result = try await client.redeem(qr: qr, clientId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb", deviceInfo: "iPhone")
    XCTAssertEqual(result.deviceId, "8b411cca-f903-4d8c-a5d0-41435e2a66bb")
    XCTAssertEqual(result.serviceId, "3f7b69dc-9d37-4aaa-b965-bb61243445a0")
    XCTAssertEqual(result.protocolVersion, 1)
    let request = try XCTUnwrap(SyntheticRedeemProtocol.requests().last)
    XCTAssertEqual(request.url?.absoluteString, "https://study.pccoding666.com/v1/pairing/redeem")
    XCTAssertEqual(request.httpMethod, "POST")
    // redeem is the one unauthenticated entry: no Authorization header
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    var bodyData: Data? = request.httpBody
    if bodyData == nil, let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(buffer, count: count)
      }
      bodyData = data
    }
    let body = try XCTUnwrap(bodyData)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(json["clientId"] as? String, "8b411cca-f903-4d8c-a5d0-41435e2a66bb")
    XCTAssertEqual(json["deviceInfo"] as? String, "iPhone")
    let payload = try XCTUnwrap(json["payload"] as? [String: Any])
    XCTAssertEqual(payload["serviceId"] as? String, "3f7b69dc-9d37-4aaa-b965-bb61243445a0")
    XCTAssertEqual(payload["httpsUrl"] as? String, "https://study.pccoding666.com")
    // Body must stay under 16kb
    XCTAssertLessThan(body.count, 16 * 1024)
  }

  func testSyntheticHealthCheckSendsBearerAndDecodesSnapshot() async throws {
    SyntheticRedeemProtocol.resetState()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SyntheticRedeemProtocol.self]
    let client = RecognitionClient(
      configuration: try PairingConfiguration.cloud(
        baseURL: Self.cloudURL, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
        token: "synthetic-device-token-32-bytes-test!",
        deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb",
        expiresAt: nil),
      sessionConfiguration: configuration)
    let snapshot = try await client.health()
    XCTAssertEqual(snapshot.serviceId, "3f7b69dc-9d37-4aaa-b965-bb61243445a0")
    XCTAssertTrue(snapshot.acceptingJobs)
    let request = try XCTUnwrap(SyntheticRedeemProtocol.requests().last)
    XCTAssertEqual(request.url?.absoluteString, "https://study.pccoding666.com/v1/health")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-device-token-32-bytes-test!")
  }

  // MARK: - Cloud pairing configuration validation

  func testCloudPairingConfigurationAcceptsOnlyFixedDomain() throws {
    XCTAssertNoThrow(try PairingConfiguration.cloud(
      baseURL: Self.cloudURL, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
      token: "synthetic-device-token-32-bytes-test!",
      deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb",
      expiresAt: nil))
    // token must be non-trivial and clean
    XCTAssertThrowsError(try PairingConfiguration.cloud(
      baseURL: Self.cloudURL, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
      token: "short",
      deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb",
      expiresAt: nil))
    // deviceId must be a UUID
    XCTAssertThrowsError(try PairingConfiguration.cloud(
      baseURL: Self.cloudURL, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
      token: "synthetic-device-token-32-bytes-test!",
      deviceId: "not-a-uuid",
      expiresAt: nil))
    // serviceId must be a UUID
    XCTAssertThrowsError(try PairingConfiguration.cloud(
      baseURL: Self.cloudURL, serviceId: "nope",
      token: "synthetic-device-token-32-bytes-test!",
      deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb",
      expiresAt: nil))
  }

  // MARK: - Connection state machine

  func testConnectionStateCoversAllChineseSemantics() {
    // distinct cases with distinct guidance
    let states: [ConnectionState] = [
      .unpaired, .pairedNeedsCheck, .checking, .ready, .busy,
      .failed, .unauthorized, .incompatible,
    ]
    XCTAssertEqual(Set(states.map(\.title)).count, states.count, "Every state needs a distinct Chinese title")
    // 登录失效与版本不兼容的下一步都是「重新登录」，所以操作文案不要求互不相同。
    XCTAssertTrue(states.allSatisfy { !$0.actionTitle.isEmpty })
    for state in states { XCTAssertFalse(state.title.isEmpty) }
    XCTAssertTrue(ConnectionState.ready.canUpload)
    XCTAssertFalse(ConnectionState.busy.canUpload)
    XCTAssertFalse(ConnectionState.unpaired.canUpload)
    XCTAssertFalse(ConnectionState.unauthorized.canUpload)
  }

  // MARK: - Task 4 review R1: classification must use the HTTP status, not message substrings

  @MainActor
  func testClassifyUsesHTTPStatusNotMessageSubstrings() {
    // 401 without any 令牌/授权 wording must still classify as unauthorized —
    // server copy changes must never break the state machine.
    XCTAssertEqual(ConnectionTracker.classify(RecognitionClientError.server(status: 401, message: "认证失败")), .unauthorized)
    // A 500 whose message merely mentions 令牌 must stay a generic failure.
    XCTAssertEqual(ConnectionTracker.classify(RecognitionClientError.server(status: 500, message: "请核对令牌后再试")), .failed)
    // Transport-level errors carry no status and remain retryable failures.
    XCTAssertEqual(ConnectionTracker.classify(RecognitionClientError.service("暂时连不上识别服务。")), .failed)
    XCTAssertEqual(ConnectionTracker.classify(URLError(.timedOut)), .failed)
    // Protocol/ownership incompatibility has its own state.
    XCTAssertEqual(ConnectionTracker.classify(RecognitionClientError.incompatiblePairing), .incompatible)
  }

  func testHealthUnauthorizedCarriesHTTPStatus() async throws {
    SyntheticRedeemProtocol.resetState()
    SyntheticRedeemProtocol.overrideHealth(status: 401,
      json: #"{"error":{"code":"unauthorized","message":"设备令牌无效。"}}"#)
    let client = try Self.makeCloudClient()
    do {
      _ = try await client.health()
      XCTFail("health must throw on 401")
    } catch {
      guard case RecognitionClientError.server(let status, _) = error else {
        return XCTFail("expected .server with status, got \(error)")
      }
      XCTAssertEqual(status, 401, "The HTTP status must survive to the caller for classification")
    }
    XCTAssertEqual(SyntheticRedeemProtocol.requests().last?.url?.absoluteString, "https://study.pccoding666.com/v1/health")
  }

  func testHealthVersionMismatchIsIncompatibleNotGeneric() async throws {
    SyntheticRedeemProtocol.resetState()
    SyntheticRedeemProtocol.overrideHealth(status: 200, json: #"{"version":2,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#)
    let client = try Self.makeCloudClient()
    do {
      _ = try await client.health()
      XCTFail("health must throw on protocol version mismatch")
    } catch {
      guard case RecognitionClientError.incompatiblePairing = error else {
        return XCTFail("version mismatch must surface as .incompatiblePairing, got \(error)")
      }
    }
  }

  func testHealthServiceIDMismatchIsIncompatible() async throws {
    SyntheticRedeemProtocol.resetState()
    // A 200 response whose serviceId belongs to another deployment: re-pair territory.
    SyntheticRedeemProtocol.overrideHealth(status: 200, json: #"{"version":1,"serviceId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#)
    let client = try Self.makeCloudClient()
    do {
      _ = try await client.health()
      XCTFail("health must throw on serviceId mismatch")
    } catch {
      guard case RecognitionClientError.incompatiblePairing = error else {
        return XCTFail("serviceId mismatch must surface as .incompatiblePairing, got \(error)")
      }
    }
  }

  private static func makeCloudClient() throws -> RecognitionClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SyntheticRedeemProtocol.self]
    return RecognitionClient(
      configuration: try PairingConfiguration.cloud(
        baseURL: Self.cloudURL, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
        token: "synthetic-device-token-32-bytes-test!",
        deviceId: "8b411cca-f903-4d8c-a5d0-41435e2a66bb",
        expiresAt: nil),
      sessionConfiguration: configuration)
  }

  // MARK: - Task 4 review R2: ownership persists with the task, survives relaunch

}

/// Task 4 review: synthetic cloud transport for store-level ownership tests.
/// Health always reports service A accepting; jobs echo the uploaded photo name.
final class SyntheticRedeemProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var recorded: [URLRequest] = []
  nonisolated(unsafe) private static var healthOverride: (status: Int, json: String)?
  static func requests() -> [URLRequest] { lock.withLock { recorded } }
  static func resetState() { lock.withLock { recorded = []; healthOverride = nil } }
  static func overrideHealth(status: Int, json: String) { lock.withLock { healthOverride = (status, json) } }
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
    if url.hasSuffix("/v1/pairing/redeem") {
      let body = #"{"token":"issued-device-token-32-bytes-test!","deviceId":"8b411cca-f903-4d8c-a5d0-41435e2a66bb","serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","expiresAt":"2026-10-17T00:00:00.000Z","protocolVersion":1}"#
      respond(status: 200, body: body)
    } else if url.hasSuffix("/v1/health") {
      if let override = Self.lock.withLock({ Self.healthOverride }) {
        respond(status: override.status, body: override.json)
      } else {
        let body = #"{"version":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","storageAvailable":true,"visionConfigured":true,"acceptingJobs":true,"protocolVersion":1}"#
        respond(status: 200, body: body)
      }
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
