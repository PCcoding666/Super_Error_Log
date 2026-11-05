import XCTest
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import StudentCore

// 原生端和网页版对齐（2026-10-25）：题干表格、接口形状、网页路径映射、上传队列、错题本筛选、登录会话。
// 全部走合成传输 / 假接口，不连真实服务、不调模型。

// MARK: - 题干表格（对照 src/text/stemBlocks.ts 的测试）

final class StemBlocksTests: XCTestCase {
  func testPlainTextIsKeptVerbatim() {
    let text = "10. 已知 -x² + 2*3 = |x-1|，求 x_1。"
    XCTAssertEqual(StemBlocks.parse(text), [.text(text)])
  }

  func testPipeTableWithHeaderAndDelimiterBecomesATable() {
    let blocks = StemBlocks.parse("先看表：\n| x | y |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |\n再回答。")
    XCTAssertEqual(blocks, [
      .text("先看表："),
      .table(head: ["x", "y"], align: [.left, .right], rows: [["1", "2"], ["3", "4"]]),
      .text("再回答。"),
    ])
  }

  func testCenterAndNoAlignment() {
    let blocks = StemBlocks.parse("a|b\n:-:|---\n1|2")
    XCTAssertEqual(blocks, [.table(head: ["a", "b"], align: [.center, nil], rows: [["1", "2"]])])
  }

  func testRowWithWrongCellCountEndsTheTableAndStaysText() {
    let blocks = StemBlocks.parse("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 | 5 |\n结尾")
    XCTAssertEqual(blocks, [
      .table(head: ["a", "b"], align: [nil, nil], rows: [["1", "2"]]),
      .text("| 3 | 4 | 5 |\n结尾"),
    ])
  }

  func testPipedHeaderRequiresPipedBodyRows() {
    let blocks = StemBlocks.parse("| a | b |\n| - | - |\n1 | 2")
    XCTAssertEqual(blocks, [.table(head: ["a", "b"], align: [nil, nil], rows: []), .text("1 | 2")])
  }

  func testEscapedPipeStaysInsideTheCell() {
    let blocks = StemBlocks.parse("| 式子 | 值 |\n| - | - |\n| a\\|b | 1 |")
    XCTAssertEqual(blocks, [.table(head: ["式子", "值"], align: [nil, nil], rows: [["a|b", "1"]])])
  }

  func testLineWithPipeButNoDelimiterIsText() {
    XCTAssertEqual(StemBlocks.parse("|x-1| = 2\n求 x"), [.text("|x-1| = 2\n求 x")])
  }

  func testEmptyTextFallsBackToOneTextBlock() {
    XCTAssertEqual(StemBlocks.parse(""), [.text("")])
  }
}

// MARK: - 接口形状

final class WebModelsTests: XCTestCase {
  func testNotebookResponseDecodesAndFlattensGroups() throws {
    let json = #"""
    {"subject":"数学","subjects":["数学","物理"],"grade":"初中","stages":["初中","高中"],"chapter":"","chapters":["一元二次方程"],
     "status":"","tag":"","tags":["判别式"],"q":"","total":3,"shown":2,"todo":2,"finding":1,"pendingIntake":0,
     "groups":[{"key":"today","title":"今天","items":[
       {"id":"itm_0123456789abcdef","shortId":"A1","subject":"数学","grade":"初中","chapter":"一元二次方程","knowledgeTags":["判别式"],
        "excerpt":"解方程","status":"todo","statusLabel":"待做","thumb":"/s/img/item/itm_0123456789abcdef?s=thumb","intakeDay":"2026-10-25"}]},
      {"key":"earlier","title":"更早","items":[
       {"id":"itm_fedcba9876543210","shortId":null,"subject":"数学","grade":null,"chapter":"未分类","knowledgeTags":[],
        "excerpt":"","status":"weird","statusLabel":"?","thumb":"/s/img/item/itm_fedcba9876543210?s=thumb","intakeDay":null}]}]}
    """#
    let response = try JSONDecoder().decode(NotebookResponse.self, from: Data(json.utf8))
    XCTAssertEqual(response.items.map(\.id), ["itm_0123456789abcdef", "itm_fedcba9876543210"])
    XCTAssertEqual(response.items[0].statusValue, .todo)
    XCTAssertEqual(response.items[1].statusValue, .todo, "未知状态按待做处理")
    XCTAssertNil(response.items[1].intakeDay)
    XCTAssertEqual(response.finding, 1)
  }

  func testItemDetailAndCategoryChapters() throws {
    let json = #"""
    {"item":{"id":"itm_0123456789abcdef","shortId":"A1","subject":"数学","grade":"初中","chapter":"一元二次方程","knowledgeTags":["判别式"],
      "excerpt":"x","status":"todo","statusLabel":"待做","thumb":"/s/img/item/itm_0123456789abcdef?s=thumb","intakeDay":"2026-10-25"},
     "questionText":"解方程 x²=4","badge":"low","revision":3,
     "images":[{"url":"/s/img/item/itm_0123456789abcdef?scope=page","fullUrl":"/s/img/item/itm_0123456789abcdef?scope=full&s=big","title":"原图"}],
     "notes":[{"kind":"student_work","title":"你写的","text":"x=2"}],"canDiscard":true,
     "category":{"grade":"初中","subject":"数学","chapter":"一元二次方程","stages":["初中","高中"],"subjects":["数学","物理"],
       "chapterOptions":[{"grade":"初中","subject":"数学","chapters":["一元二次方程","相似"]},{"grade":"初中","subject":"物理","chapters":["力"]}]},
     "materialUrl":null}
    """#
    let detail = try JSONDecoder().decode(ItemDetailResponse.self, from: Data(json.utf8))
    XCTAssertEqual(detail.badge, "low")
    XCTAssertEqual(detail.revision, 3)
    XCTAssertEqual(detail.images.first?.title, "原图")
    XCTAssertEqual(detail.category.chapters(grade: "初中", subject: "数学"), ["一元二次方程", "相似"])
    XCTAssertEqual(detail.category.chapters(grade: "高中", subject: "数学"), [])
  }

  func testIntakeResponseModeAndPhotoState() throws {
    let json = #"""
    {"mode":"materials","draftNamespace":"ns-1","busy":true,"photos":[
      {"id":"a1","number":2,"takenAt":"2026-10-25T01:02:03.000Z","thumb":"/s/img/photo/a1","full":"/s/img/photo/a1?full=1","state":"needsPick",
       "statusText":"等你勾选","questions":[],"candidates":[{"id":"c1","label":"第 3 题","excerpt":"求值","crop":null}],"failure":null},
      {"id":"b2","number":1,"takenAt":"2026-10-25T01:00:00Z","thumb":"/s/img/photo/b2","full":"/s/img/photo/b2?full=1","state":"failed",
       "statusText":"没识别出来","questions":[],"candidates":[],"failure":{"title":"失败","detail":"图片太糊","retryable":true}}]}
    """#
    let intake = try JSONDecoder().decode(IntakeResponse.self, from: Data(json.utf8))
    XCTAssertEqual(intake.uploadMode, .materials(namespace: "ns-1"))
    XCTAssertEqual(intake.photos[0].stateValue, .needsPick)
    XCTAssertNotNil(intake.photos[0].takenDate)
    XCTAssertNotNil(intake.photos[1].takenDate, "不带毫秒的时间也认")
    XCTAssertEqual(intake.photos[1].failure?.retryable, true)
    let legacy = try JSONDecoder().decode(UploadModeResponse.self, from: Data(#"{"mode":"legacy","draftNamespace":null}"#.utf8))
    XCTAssertEqual(legacy.uploadMode, .legacy)
    let missingNamespace = try JSONDecoder().decode(UploadModeResponse.self, from: Data(#"{"mode":"materials","draftNamespace":null}"#.utf8))
    XCTAssertEqual(missingNamespace.uploadMode, .legacy, "材料流程没有命名空间时退回旧流程，不拿空命名空间去传")
  }

  func testInviteExpiresSoonOnlyWithinSevenDays() throws {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func settings(_ expires: String?) throws -> SettingsResponse {
      let tail = expires.map { "\"\($0)\"" } ?? "null"
      return try JSONDecoder().decode(SettingsResponse.self, from: Data(
        #"{"grade":"初中","stages":["初中","高中"],"invitation":true,"accountRole":null,"accountRoleLabel":null,"inviteExpires":\#(tail),"version":"0.5.0"}"#.utf8))
    }
    XCTAssertFalse(try settings(nil).inviteExpiresSoon(now: now))
    XCTAssertFalse(try settings("none").inviteExpiresSoon(now: now))
    XCTAssertTrue(try settings(ISO8601DateFormatter().string(from: now.addingTimeInterval(3 * 86400))).inviteExpiresSoon(now: now))
    XCTAssertFalse(try settings(ISO8601DateFormatter().string(from: now.addingTimeInterval(30 * 86400))).inviteExpiresSoon(now: now))
  }

  func testNotebookQueryOmitsEmptyFields() {
    XCTAssertEqual(NotebookQuery().items, [])
    let query = NotebookQuery(subject: "数学", grade: "", chapter: "相似", tag: "", q: "三角")
    XCTAssertEqual(query.items.map(\.name), ["subject", "chapter", "q"])
    XCTAssertEqual(query.items.map(\.value), ["数学", "相似", "三角"])
  }
}

// MARK: - WebClient：路径映射、请求形状、错误信封、上传表单

final class WebClientTests: XCTestCase {
  static let entry = "https://study.pccoding666.com/s/native"
  static let token = "issued-session-token-32-bytes-test!!"

  private func makeClient() throws -> WebClient {
    let configuration = try PairingConfiguration.invitation(
      baseURL: Self.entry, serviceId: "3f7b69dc-9d37-4aaa-b965-bb61243445a0", token: Self.token, expiresAt: nil)
    let session = URLSessionConfiguration.ephemeral
    session.protocolClasses = [WebSyntheticProtocol.self]
    WebSyntheticProtocol.reset()
    return WebClient(configuration: configuration, sessionConfiguration: session)
  }

  func testServerPathsMapUnderTheNativeWebPrefix() throws {
    let client = try makeClient()
    XCTAssertEqual(client.url(forServerPath: "/s/img/item/itm_0123456789abcdef?s=thumb")?.absoluteString,
      "https://study.pccoding666.com/s/native/web/img/item/itm_0123456789abcdef?s=thumb")
    XCTAssertEqual(client.url(forServerPath: "/s/materials/assets/abc/image")?.absoluteString,
      "https://study.pccoding666.com/s/native/web/materials/assets/abc/image")
    XCTAssertNil(client.url(forServerPath: "/other/img/x"), "不是网页路径不拼")
    XCTAssertNil(client.url(forServerPath: "https://evil.example/s/img/x"), "绝对地址不拼，令牌不会被带到别处")
  }

  func testNotebookRequestShapeAndDecoding() async throws {
    let client = try makeClient()
    WebSyntheticProtocol.respond(to: "/s/native/web/api/notebook", status: 200, body: WebSyntheticProtocol.emptyNotebook)
    let response = try await client.notebook(NotebookQuery(subject: "数学", chapter: "相似"))
    XCTAssertEqual(response.subject, "数学")
    let request = try XCTUnwrap(WebSyntheticProtocol.requests().last)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + Self.token)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
    XCTAssertEqual(components.path, "/s/native/web/api/notebook")
    XCTAssertEqual(components.queryItems?.first { $0.name == "subject" }?.value, "数学")
    XCTAssertEqual(components.queryItems?.first { $0.name == "chapter" }?.value, "相似")
  }

  func testErrorEnvelopesBecomeTypedErrors() async throws {
    let client = try makeClient()
    WebSyntheticProtocol.respond(to: "/s/native/web/api/notebook", status: 409, body: #"{"error":{"code":"stage_required","message":"先选学段。"}}"#)
    do { _ = try await client.notebook(NotebookQuery()); XCTFail("应当抛错") }
    catch let error as WebAPIError {
      XCTAssertTrue(error.isStageRequired)
      XCTAssertEqual(error.message, "先选学段。")
      XCTAssertFalse(error.isUnauthorized)
    }
    WebSyntheticProtocol.respond(to: "/s/native/web/api/settings", status: 401, body: #"{"error":{"code":"unauthorized","message":"登录已失效，请重新输入邀请码。"}}"#)
    do { _ = try await client.settings(); XCTFail("应当抛错") }
    catch let error as WebAPIError { XCTAssertTrue(error.isUnauthorized) }
    WebSyntheticProtocol.respond(to: "/s/native/web/api/intake", status: 200, body: "<html>登录页</html>")
    do { _ = try await client.intake(); XCTFail("应当抛错") }
    catch let error as WebAPIError { XCTAssertEqual(error, .badResponse, "200 但不是约定形状不算成功") }
  }

  func testPostBodiesAndImageFetch() async throws {
    let client = try makeClient()
    WebSyntheticProtocol.respond(to: "/s/native/web/api/items/discard", status: 200, body: #"{"removed":["itm_a"],"failed":[]}"#)
    let result = try await client.discard(ids: ["itm_a"])
    XCTAssertEqual(result.removed, ["itm_a"])
    let post = try XCTUnwrap(WebSyntheticProtocol.requests().last)
    XCTAssertEqual(post.httpMethod, "POST")
    XCTAssertEqual(post.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(post.httpBody)) as? [String: Any])
    XCTAssertEqual(body["ids"] as? [String], ["itm_a"])

    WebSyntheticProtocol.respond(to: "/s/native/web/img/item/itm_a", status: 200, body: "JPEGBYTES")
    let image = try await client.imageData(serverPath: "/s/img/item/itm_a?s=thumb")
    XCTAssertEqual(String(decoding: image, as: UTF8.self), "JPEGBYTES")
    XCTAssertEqual(WebSyntheticProtocol.requests().last?.value(forHTTPHeaderField: "Accept"), "image/*")
  }

  func testImageRedirectsAreFollowedInsideTheNativeWebPrefixOnly() async throws {
    let client = try makeClient()
    WebSyntheticProtocol.respond(to: "/s/native/web/img/item/itm_a", status: 303, body: "", headers: ["Location": "/s/materials/fragments/mfr_1/crop?revision=2"])
    WebSyntheticProtocol.respond(to: "/s/native/web/materials/fragments/mfr_1/crop", status: 200, body: "CROP")
    let image = try await client.imageData(serverPath: "/s/img/item/itm_a?s=thumb")
    XCTAssertEqual(String(decoding: image, as: UTF8.self), "CROP")
    let paths = WebSyntheticProtocol.requests().compactMap { $0.url?.path }
    XCTAssertEqual(paths, ["/s/native/web/img/item/itm_a", "/s/native/web/materials/fragments/mfr_1/crop"])
    XCTAssertEqual(WebSyntheticProtocol.requests().last?.value(forHTTPHeaderField: "Authorization"), "Bearer " + Self.token)
    // 重定向到别的站：不跟，也不带令牌
    WebSyntheticProtocol.respond(to: "/s/native/web/img/item/itm_b", status: 303, body: "", headers: ["Location": "https://evil.example/steal"])
    do { _ = try await client.imageData(serverPath: "/s/img/item/itm_b"); XCTFail("不该跟到站外") }
    catch let error as WebAPIError { XCTAssertEqual(error, .badResponse) }
    XCTAssertFalse(WebSyntheticProtocol.requests().contains { $0.url?.host == "evil.example" })
    // 无限重定向：最多跟几次就放弃
    WebSyntheticProtocol.respond(to: "/s/native/web/img/item/loop", status: 303, body: "", headers: ["Location": "/s/img/item/loop"])
    do { _ = try await client.imageData(serverPath: "/s/img/item/loop"); XCTFail("不该无限跟") }
    catch let error as WebAPIError { XCTAssertEqual(error, .badResponse) }
  }

  func testMaterialsUploadSendsNamespaceUploadIdAndForm() async throws {
    let client = try makeClient()
    WebSyntheticProtocol.respond(to: "/s/native/web/materials/captures", status: 200, body: #"{"id":"cap-1"}"#)
    let capture = try await client.createMaterialsCapture(namespace: "ns-1", requestID: "req-1")
    XCTAssertEqual(capture, "cap-1")
    let first = try XCTUnwrap(WebSyntheticProtocol.requests().last)
    XCTAssertEqual(first.value(forHTTPHeaderField: "X-Draft-Namespace"), "ns-1")
    XCTAssertEqual((try JSONSerialization.jsonObject(with: try XCTUnwrap(first.httpBody)) as? [String: Any])?["requestId"] as? String, "req-1")

    WebSyntheticProtocol.respond(to: "/s/native/web/materials/uploads", status: 200, body: #"{"ok":true,"assetId":"asset-1","job":{"id":"j1","kind":"extract"}}"#)
    let asset = try await client.uploadMaterials(namespace: "ns-1", captureID: "cap-1", uploadID: "up-1", jpeg: Data("JPG".utf8), progress: { _ in })
    XCTAssertEqual(asset, "asset-1")
    let upload = try XCTUnwrap(WebSyntheticProtocol.requests().last)
    XCTAssertEqual(upload.value(forHTTPHeaderField: "X-Upload-Id"), "up-1")
    XCTAssertTrue(upload.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
    let form = String(decoding: try XCTUnwrap(upload.httpBody), as: UTF8.self)
    XCTAssertTrue(form.contains("name=\"captureId\"\r\n\r\ncap-1"))
    XCTAssertTrue(form.contains("name=\"hints\"\r\n\r\n{}"))
    XCTAssertTrue(form.contains("name=\"photo\"; filename=\"photo.jpg\""))
    XCTAssertTrue(form.hasSuffix("--\r\n"), "表单以结尾边界收尾")
  }

  func testLegacyUploadAndFailureMapping() async throws {
    let client = try makeClient()
    WebSyntheticProtocol.respond(to: "/s/native/web/capture", status: 200, body: #"{"ok":true,"jobId":"job-1"}"#)
    let id = try await client.uploadLegacy(key: "key-1", jpeg: Data("JPG".utf8), progress: { _ in })
    XCTAssertEqual(id, "job-1")
    XCTAssertTrue(String(decoding: try XCTUnwrap(WebSyntheticProtocol.requests().last?.httpBody), as: UTF8.self).contains("name=\"key\"\r\n\r\nkey-1"))

    WebSyntheticProtocol.respond(to: "/s/native/web/capture", status: 400, body: #"{"error":{"code":"invalid_image","message":"这张图读不了。"}}"#)
    do { _ = try await client.uploadLegacy(key: "k", jpeg: Data("x".utf8), progress: { _ in }); XCTFail() }
    catch let failure as UploadFailure { XCTAssertEqual(failure, UploadFailure(message: "这张图读不了。", retryable: false)) }

    WebSyntheticProtocol.respond(to: "/s/native/web/capture", status: 503, body: #"{"error":{"code":"unavailable","message":"你的学习空间正在准备中。"}}"#)
    do { _ = try await client.uploadLegacy(key: "k", jpeg: Data("x".utf8), progress: { _ in }); XCTFail() }
    catch let failure as UploadFailure { XCTAssertTrue(failure.retryable); XCTAssertEqual(failure.message, "你的学习空间正在准备中。") }

    WebSyntheticProtocol.respond(to: "/s/native/web/capture", status: 200, body: #"{"ok":true}"#)
    do { _ = try await client.uploadLegacy(key: "k", jpeg: Data("x".utf8), progress: { _ in }); XCTFail("没有 jobId 不算成功") }
    catch let failure as UploadFailure { XCTAssertEqual(failure, .generic) }
  }
}

final class WebSyntheticProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var recorded: [URLRequest] = []
  nonisolated(unsafe) private static var routes: [String: (Int, String, [String: String])] = [:]
  static let emptyNotebook = #"{"subject":"数学","subjects":["数学"],"grade":"初中","stages":["初中","高中"],"chapter":"","chapters":[],"status":"","tag":"","tags":[],"q":"","total":0,"shown":0,"todo":0,"groups":[],"finding":0,"pendingIntake":0}"#
  static func reset() { lock.withLock { recorded = []; routes = [:] } }
  static func requests() -> [URLRequest] { lock.withLock { recorded } }
  static func respond(to path: String, status: Int, body: String, headers: [String: String] = [:]) { lock.withLock { routes[path] = (status, body, headers) } }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    if let stream = request.httpBodyStream {
      stream.open()
      var bytes = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        bytes.append(buffer, count: count)
      }
      stream.close()
      captured.httpBody = bytes
    }
    Self.lock.withLock { Self.recorded.append(captured) }
    let path = request.url?.path ?? ""
    let route = Self.lock.withLock { Self.routes[path] } ?? (404, #"{"error":{"code":"not_found","message":"接口不存在。"}}"#, [:])
    let response = HTTPURLResponse(url: request.url!, statusCode: route.0, httpVersion: nil, headerFields: ["Content-Type": "application/json"].merging(route.2) { _, new in new })!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(route.1.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

// MARK: - 照片转换

final class ImagePreparerTests: XCTestCase {
  static func makeImage(width: Int, height: Int, format: UTType = .jpeg) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.4, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let output = NSMutableData()
    let destination = CGImageDestinationCreateWithData(output, format.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return output as Data
  }

  private func size(of data: Data) -> (Int, Int)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
    return (properties[kCGImagePropertyPixelWidth] as? Int ?? 0, properties[kCGImagePropertyPixelHeight] as? Int ?? 0)
  }

  func testLargePhotoIsScaledToLongestEdgeAndBecomesJPEG() throws {
    let prepared = try ImagePreparer.prepare(Self.makeImage(width: 5000, height: 3000, format: .png))
    XCTAssertEqual(Array(prepared.prefix(3)), [0xff, 0xd8, 0xff], "真正的 JPEG")
    let (width, height) = try XCTUnwrap(size(of: prepared))
    XCTAssertEqual(max(width, height), 4096)
    XCTAssertEqual(width > height, true, "保持横竖比例")
  }

  func testSmallPhotoIsNotUpscaled() throws {
    let prepared = try ImagePreparer.prepare(Self.makeImage(width: 800, height: 600))
    let (width, height) = try XCTUnwrap(size(of: prepared))
    XCTAssertEqual(width, 800)
    XCTAssertEqual(height, 600)
  }

  func testNonImageDataFailsToDecode() {
    XCTAssertThrowsError(try ImagePreparer.prepare(Data("not an image".utf8))) { XCTAssertEqual($0 as? ImagePreparer.Failure, .decode) }
    XCTAssertThrowsError(try ImagePreparer.prepare(Data())) { XCTAssertEqual($0 as? ImagePreparer.Failure, .decode) }
  }

  func testOversizeResultAfterAllQualityStepsIsRejected() {
    XCTAssertThrowsError(try ImagePreparer.prepare(Self.makeImage(width: 1200, height: 900), maxBytes: 10)) {
      XCTAssertEqual($0 as? ImagePreparer.Failure, .tooBig)
    }
  }

  func testPreviewIsSmall() throws {
    let preview = try XCTUnwrap(ImagePreparer.preview(Self.makeImage(width: 3000, height: 2000)))
    let (width, height) = try XCTUnwrap(size(of: preview))
    XCTAssertEqual(max(width, height), 240)
  }
}
