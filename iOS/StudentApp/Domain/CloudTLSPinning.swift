import Foundation
import Security

/// IP 直连入口的证书固定（2026-10-03）。
///
/// 按 IP 连接时 ATS 不做约束，系统也不信任服务器的自签证书；这里是 IP 入口唯一的 TLS 校验：
/// 服务器出示的叶子证书必须与 App 内打包的那张逐字节一致才继续，否则取消连接——
/// 包括系统信任的证书在内，其他任何证书一律拒绝。没有打包证书时 IP 入口全部拒绝。
/// 域名入口和其他主机不经过这里，沿用系统默认校验（行为不变）。
///
/// 证书文件：`StudentApp/Resources/cloud-ip-cert.pem`（服务器上 deploy/generate-ip-cert.sh 生成的
/// cert.pem 原样拷回）。换证书只换这个文件并重新构建 App（deploy/README.md §9）。
struct CloudTLSPinning: Sendable {
  /// 需要固定证书的主机（生产为 IP 入口）。
  let host: String
  /// 固定证书的 DER 字节；nil 表示 App 里没有证书，该主机的连接一律拒绝。
  let certificate: Data?

  static let resourceName = "cloud-ip-cert"
  static let production = CloudTLSPinning(host: CloudPairing.ipHost, certificate: bundledCertificate(in: .main))

  static func bundledCertificate(in bundle: Bundle) -> Data? {
    guard let url = bundle.url(forResource: resourceName, withExtension: "pem"),
      let text = try? String(contentsOf: url, encoding: .utf8)
    else { return nil }
    return certificateDER(fromPEM: text)
  }

  /// 只接受恰好一张证书的 PEM；解码结果必须能被系统解析为证书，否则返回 nil（等同没有证书）。
  static func certificateDER(fromPEM text: String) -> Data? {
    let begin = "-----BEGIN CERTIFICATE-----"
    let end = "-----END CERTIFICATE-----"
    let afterBegin = text.components(separatedBy: begin)
    guard afterBegin.count == 2 else { return nil }
    let body = afterBegin[1].components(separatedBy: end)
    guard body.count == 2,
      let der = Data(base64Encoded: body[0], options: .ignoreUnknownCharacters), !der.isEmpty,
      SecCertificateCreateWithData(nil, der as CFData) != nil
    else { return nil }
    return der
  }

  /// URLSession 服务器信任质询的处置。只处理 `host` 的 ServerTrust 质询，其余交给系统默认处理。
  func disposition(for challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, space.host == host else {
      return (.performDefaultHandling, nil)
    }
    guard let certificate, let trust = space.serverTrust,
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first, SecCertificateCopyData(leaf) as Data == certificate
    else { return (.cancelAuthenticationChallenge, nil) }
    return (.useCredential, URLCredential(trust: trust))
  }
}
