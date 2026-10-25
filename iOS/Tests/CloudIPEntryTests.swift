import XCTest
import Foundation
import Security
import os
@testable import StudentCore
#if os(macOS)
import Network
#endif

// 2026-10-03 IP 直连入口：配对白名单、入口地址持久化、IP 入口证书固定。
// 合成数据与本机回环 TLS 服务；证书和私钥在测试运行时临时生成、用后删除；不连接任何真实服务。
final class CloudIPEntryTests: XCTestCase {
  static let ipURL = "https://8.163.96.197"
  static let domainURL = "https://study.pccoding666.com"
  static let serviceId = "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
  static let deviceId = "8b411cca-f903-4d8c-a5d0-41435e2a66bb"
  static let token = "synthetic-device-token-32-bytes-test!"

  static func qr(_ httpsUrl: String) -> String {
    #"{"v":1,"serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","httpsUrl":"\#(httpsUrl)","sessionId":"099ea4a5-e4bf-4182-b986-a9fc7db383e9","secret":"2_39bX4iG76643WfiJRfvW-jYJVxbBdm9ACmHrgGjJ0"}"#
  }

  // MARK: - 配对二维码白名单

  func testQRAcceptsIPEntryAndKeepsItsAddress() throws {
    XCTAssertEqual(try CloudPairing.parse(Self.qr("https://8.163.96.197")).httpsUrl, Self.ipURL)
    XCTAssertEqual(try CloudPairing.parse(Self.qr("https://8.163.96.197/")).httpsUrl, Self.ipURL, "尾斜杠规范化为无斜杠")
  }

  func testQRStillAcceptsDomainEntry() throws {
    XCTAssertEqual(try CloudPairing.parse(Self.qr("https://study.pccoding666.com")).httpsUrl, Self.domainURL)
  }

  func testQRRejectsEveryOtherHostOrShape() {
    let rejected = [
      "https://8.163.96.198", "https://8.163.96.19", "https://08.163.96.197", "https://140.82.112.3",
      "https://8.163.96.197.evil.example", "https://evil.example", "https://[::1]", "https://127.0.0.1",
      "https://8.163.96.197@evil.example", "https://user@8.163.96.197", "https://8.163.96.197:443",
      "https://8.163.96.197:8443", "http://8.163.96.197", "https://8.163.96.197/v1", "https://8.163.96.197/?x=1",
      "https://8.163.96.197#f", "https://pccoding666.com", "https://abc.pccoding666.com",
    ]
    for url in rejected {
      XCTAssertThrowsError(try CloudPairing.parse(Self.qr(url)), url) { error in
        XCTAssertEqual(error as? CloudPairing.QRParseError, .invalidURL, url)
      }
    }
  }

  // MARK: - 配对配置记住扫码时的入口

  func testCloudConfigurationUsesPairedEntryAndRejectsOthers() throws {
    let ip = try PairingConfiguration.cloud(baseURL: Self.ipURL, serviceId: Self.serviceId,
      token: Self.token, deviceId: Self.deviceId, expiresAt: nil)
    XCTAssertEqual(ip.baseURL.absoluteString, Self.ipURL)
    let domain = try PairingConfiguration.cloud(baseURL: Self.domainURL, serviceId: Self.serviceId,
      token: Self.token, deviceId: Self.deviceId, expiresAt: nil)
    XCTAssertEqual(domain.baseURL.absoluteString, Self.domainURL)
    XCTAssertNotEqual(ip, domain, "换入口必须触发客户端重建")
    for url in ["https://8.163.96.197/", "http://8.163.96.197", "https://8.163.96.198", "https://evil.example", ""] {
      XCTAssertThrowsError(try PairingConfiguration.cloud(baseURL: url, serviceId: Self.serviceId,
        token: Self.token, deviceId: Self.deviceId, expiresAt: nil), url)
    }
  }

  func testStoredPairingRoundTripsEntryAndLegacyPairingStaysOnDomain() throws {
    let ip = try PairingConfiguration.cloud(baseURL: Self.ipURL, serviceId: Self.serviceId,
      token: Self.token, deviceId: Self.deviceId, expiresAt: nil)
    let restored = try JSONDecoder().decode(PairingConfiguration.self, from: JSONEncoder().encode(ip))
    XCTAssertEqual(restored, ip)
    XCTAssertEqual(restored.baseURL.absoluteString, Self.ipURL)
    // 2026-10-03 之前保存的云端配对没有入口字段：按域名读取（原行为）。
    let legacy = try JSONDecoder().decode(PairingConfiguration.self, from: Data(
      #"{"mode":"cloud","serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","token":"synthetic-device-token-32-bytes-test!","deviceId":"8b411cca-f903-4d8c-a5d0-41435e2a66bb"}"#.utf8))
    XCTAssertEqual(legacy.baseURL.absoluteString, Self.domainURL)
    // 磁盘上的入口同样过白名单。
    XCTAssertThrowsError(try JSONDecoder().decode(PairingConfiguration.self, from: Data(
      #"{"mode":"cloud","baseURL":"https://evil.example","serviceId":"3f7b69dc-9d37-4aaa-b965-bb61243445a0","token":"synthetic-device-token-32-bytes-test!","deviceId":"8b411cca-f903-4d8c-a5d0-41435e2a66bb"}"#.utf8)))
  }

  func testRedeemAndHealthGoToTheIPEntryAndEchoItsAddress() async throws {
    SyntheticRedeemProtocol.resetState()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SyntheticRedeemProtocol.self]
    let client = RecognitionClient(configuration: try PairingConfiguration.cloud(baseURL: Self.ipURL,
      serviceId: Self.serviceId, token: Self.token, deviceId: Self.deviceId, expiresAt: nil),
      sessionConfiguration: configuration)
    defer { client.close() }
    let qr = try CloudPairing.parse(Self.qr("https://8.163.96.197"))
    _ = try await client.redeem(qr: qr, clientId: Self.deviceId, deviceInfo: "iPhone")
    let redeem = try XCTUnwrap(SyntheticRedeemProtocol.requests().last)
    XCTAssertEqual(redeem.url?.absoluteString, "https://8.163.96.197/v1/pairing/redeem")
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(redeem.httpBody)) as? [String: Any])
    XCTAssertEqual((body["payload"] as? [String: Any])?["httpsUrl"] as? String, Self.ipURL, "兑换原样回送二维码里的入口")
    _ = try await client.health()
    XCTAssertEqual(SyntheticRedeemProtocol.requests().last?.url?.absoluteString, "https://8.163.96.197/v1/health")
  }

  // MARK: - 证书固定（不联网的部分）

  func testProductionPinningTargetsTheIPHostOnly() {
    XCTAssertEqual(CloudTLSPinning.production.host, "8.163.96.197")
    XCTAssertEqual(CloudTLSPinning.resourceName, "cloud-ip-cert")
  }

  func testPinnedCertificateMustBeExactlyOnePEMCertificate() throws {
    let directory = try Self.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    #if os(macOS)
    let first = try TemporaryCertificate(commonName: "8.163.96.197", in: directory, name: "first")
    let second = try TemporaryCertificate(commonName: "8.163.96.197", in: directory, name: "second")
    XCTAssertEqual(CloudTLSPinning.certificateDER(fromPEM: first.pem), first.der)
    XCTAssertNil(CloudTLSPinning.certificateDER(fromPEM: first.pem + second.pem), "两张证书：拒绝，不猜用哪张")
    // 资源名与扩展名：App 从 bundle 根目录读取 cloud-ip-cert.pem。
    let bundleURL = directory.appendingPathComponent("Synthetic.bundle", isDirectory: true)
    try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    try first.pem.write(to: bundleURL.appendingPathComponent("cloud-ip-cert.pem"), atomically: true, encoding: .utf8)
    XCTAssertEqual(CloudTLSPinning.bundledCertificate(in: try XCTUnwrap(Bundle(url: bundleURL))), first.der)
    #endif
    XCTAssertNil(CloudTLSPinning.certificateDER(fromPEM: ""))
    XCTAssertNil(CloudTLSPinning.certificateDER(fromPEM: "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n"))
    XCTAssertNil(CloudTLSPinning.bundledCertificate(in: Bundle(for: Self.self)), "测试 bundle 里没有证书")
  }

  func testChallengeRoutingWithoutNetwork() throws {
    let pinning = CloudTLSPinning(host: "8.163.96.197", certificate: Data([1, 2, 3]))
    // 域名入口：交给系统默认校验，行为不变。
    XCTAssertEqual(pinning.disposition(for: Self.challenge(host: "study.pccoding666.com")).0, .performDefaultHandling)
    // IP 入口：没有可比对的服务器证书即拒绝。
    XCTAssertEqual(pinning.disposition(for: Self.challenge(host: "8.163.96.197")).0, .cancelAuthenticationChallenge)
    XCTAssertEqual(CloudTLSPinning(host: "8.163.96.197", certificate: nil)
      .disposition(for: Self.challenge(host: "8.163.96.197")).0, .cancelAuthenticationChallenge)
    // 非服务器信任质询不由这里处理。
    XCTAssertEqual(pinning.disposition(for: Self.challenge(host: "8.163.96.197",
      method: NSURLAuthenticationMethodHTTPBasic)).0, .performDefaultHandling)
    // 两个客户端的会话代理（登录用的 RecognitionClient 与网页接口的 WebClient）都走同一判定。
    let configuration = try PairingConfiguration.cloud(baseURL: Self.ipURL, serviceId: Self.serviceId,
      token: Self.token, deviceId: Self.deviceId, expiresAt: nil)
    let recognition = RecognitionClient(configuration: configuration, pinning: pinning)
    let v2 = WebClient(configuration: configuration, pinning: pinning)
    defer { recognition.close(); v2.close() }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    for host in ["8.163.96.197", "study.pccoding666.com"] {
      let expected = pinning.disposition(for: Self.challenge(host: host)).0
      let seen = OSAllocatedUnfairLock<[URLSession.AuthChallengeDisposition]>(initialState: [])
      recognition.urlSession(session, didReceive: Self.challenge(host: host)) { disposition, _ in seen.withLock { $0.append(disposition) } }
      v2.urlSession(session, didReceive: Self.challenge(host: host)) { disposition, _ in seen.withLock { $0.append(disposition) } }
      XCTAssertEqual(seen.withLock { $0 }, [expected, expected], host)
    }
  }

  // MARK: - 证书固定（本机回环 TLS 服务，真实握手）

  #if os(macOS)
  func testPinnedCertificateMatchConnectsAndMismatchIsRefused() async throws {
    let directory = try Self.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let served = try TemporaryCertificate(commonName: "127.0.0.1", in: directory, name: "served")
    let other = try TemporaryCertificate(commonName: "127.0.0.1", in: directory, name: "other")
    let server = try await LoopbackTLSServer.start(identity: served.identity())
    defer { server.stop() }
    let url = try XCTUnwrap(URL(string: "https://127.0.0.1:\(server.port)/"))
    let configuration = try PairingConfiguration.cloud(baseURL: Self.ipURL, serviceId: Self.serviceId,
      token: Self.token, deviceId: Self.deviceId, expiresAt: nil)

    // 先跑拒绝的情形：此前没有成功的 TLS 会话，排除会话复用掩盖校验的可能。
    // 固定的是另一张证书：拒绝。
    let mismatched = RecognitionClient(configuration: configuration,
      pinning: CloudTLSPinning(host: "127.0.0.1", certificate: other.der))
    defer { mismatched.close() }
    await Self.assertRefused(url, delegate: mismatched, code: .cancelled)
    // App 里没有证书：拒绝。
    let missing = WebClient(configuration: configuration, pinning: CloudTLSPinning(host: "127.0.0.1", certificate: nil))
    defer { missing.close() }
    await Self.assertRefused(url, delegate: missing, code: .cancelled)
    // 对照：该主机不在固定范围内时走系统默认校验，系统同样不信任这张自签证书。
    let unpinned = RecognitionClient(configuration: configuration,
      pinning: CloudTLSPinning(host: "8.163.96.197", certificate: served.der))
    defer { unpinned.close() }
    await Self.assertRefused(url, delegate: unpinned, code: .serverCertificateUntrusted)

    // 固定证书与服务器证书一致：连接成功（两个客户端的会话代理（登录用的 RecognitionClient 与网页接口的 WebClient））。
    let matching = CloudTLSPinning(host: "127.0.0.1", certificate: served.der)
    let recognition = RecognitionClient(configuration: configuration, pinning: matching)
    let v2 = WebClient(configuration: configuration, pinning: matching)
    defer { recognition.close(); v2.close() }
    let recognitionStatus = try await Self.fetch(url, delegate: recognition)
    XCTAssertEqual(recognitionStatus, 200)
    let v2Status = try await Self.fetch(url, delegate: v2)
    XCTAssertEqual(v2Status, 200)
  }

  static func fetch(_ url: URL, delegate: URLSessionDelegate) async throws -> Int {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.connectionProxyDictionary = [:]
    configuration.timeoutIntervalForRequest = 10
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (_, response) = try await session.data(from: url)
    return (response as? HTTPURLResponse)?.statusCode ?? 0
  }

  /// 证书固定拒绝时 URLSession 报 .cancelled（质询被取消）；系统默认校验拒绝自签证书时报 .serverCertificateUntrusted。
  static func assertRefused(_ url: URL, delegate: URLSessionDelegate, code: URLError.Code, line: UInt = #line) async {
    do {
      let status = try await fetch(url, delegate: delegate)
      XCTFail("连接本应被拒绝，实际返回 \(status)", line: line)
    } catch {
      XCTAssertEqual((error as? URLError)?.code, code, "拒绝原因不符：\(error)", line: line)
    }
  }
  #endif

  // MARK: - helpers

  static func temporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CloudIPEntry-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  static func challenge(host: String, method: String = NSURLAuthenticationMethodServerTrust) -> URLAuthenticationChallenge {
    let space = URLProtectionSpace(host: host, port: 443, protocol: NSURLProtectionSpaceHTTPS, realm: nil, authenticationMethod: method)
    return URLAuthenticationChallenge(protectionSpace: space, proposedCredential: nil, previousFailureCount: 0,
      failureResponse: nil, error: nil, sender: NoopChallengeSender())
  }
}

private final class NoopChallengeSender: NSObject, URLAuthenticationChallengeSender {
  func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
  func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
  func cancel(_ challenge: URLAuthenticationChallenge) {}
}

#if os(macOS)
/// 测试专用临时自签证书：/usr/bin/openssl 生成到临时目录；身份只导入进程内存（不进钥匙串）。
private struct TemporaryCertificate {
  let pem: String
  let der: Data
  private let bundle: String

  init(commonName: String, in directory: URL, name: String) throws {
    let key = directory.appendingPathComponent("\(name)-key.pem").path
    let cert = directory.appendingPathComponent("\(name)-cert.pem").path
    let bundle = directory.appendingPathComponent("\(name).p12").path
    try Self.openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-days", "1",
      "-subj", "/CN=\(commonName)", "-keyout", key, "-out", cert])
    try Self.openssl(["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", bundle, "-passout", "pass:synthetic",
      "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "sha1"])
    pem = try String(contentsOfFile: cert, encoding: .utf8)
    guard let der = CloudTLSPinning.certificateDER(fromPEM: pem) else { throw CocoaError(.fileReadCorruptFile) }
    self.der = der
    self.bundle = bundle
  }

  /// 服务端身份（证书 + 私钥）只导入进程内存；kSecImportToMemoryOnly 需要 macOS 15+。
  func identity() throws -> SecIdentity {
    guard #available(macOS 15, *) else { throw XCTSkip("进程内导入证书身份需要 macOS 15+") }
    var items: CFArray?
    let options = [kSecImportExportPassphrase as String: "synthetic", kSecImportToMemoryOnly as String: true] as CFDictionary
    let status = SecPKCS12Import(try Data(contentsOf: URL(fileURLWithPath: bundle)) as CFData, options, &items)
    guard status == errSecSuccess, let first = (items as? [[String: Any]])?.first,
      let identity = first[kSecImportItemIdentity as String]
    else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return identity as! SecIdentity
  }

  private static func openssl(_ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw CocoaError(.executableLoad) }
  }
}

/// 只监听 127.0.0.1 的进程内 TLS 服务：任何请求回 200 "ok" 后关闭连接。
private final class LoopbackTLSServer: @unchecked Sendable {
  private let listener: NWListener
  let port: UInt16

  private init(listener: NWListener, port: UInt16) {
    self.listener = listener
    self.port = port
  }

  static func start(identity: SecIdentity) async throws -> LoopbackTLSServer {
    let tls = NWProtocolTLS.Options()
    sec_protocol_options_set_local_identity(tls.securityProtocolOptions, sec_identity_create(identity)!)
    let parameters = NWParameters(tls: tls)
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    let queue = DispatchQueue(label: "loopback-tls-server")
    listener.newConnectionHandler = { connection in
      connection.stateUpdateHandler = { state in
        if case .failed = state { connection.cancel() }
      }
      connection.start(queue: queue)
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, _, error in
        guard error == nil else { connection.cancel(); return }
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
      }
    }
    let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
      let resumed = OSAllocatedUnfairLock(initialState: false)
      listener.stateUpdateHandler = { state in
        let value: Result<UInt16, Error>?
        switch state {
        case .ready: value = listener.port.map { .success($0.rawValue) } ?? .failure(CocoaError(.featureUnsupported))
        case .failed(let error): value = .failure(error)
        default: value = nil
        }
        guard let value, resumed.withLock({ done in defer { done = true }; return !done }) else { return }
        continuation.resume(with: value)
      }
      listener.start(queue: queue)
    }
    return LoopbackTLSServer(listener: listener, port: port)
  }

  func stop() { listener.cancel() }
}
#endif
