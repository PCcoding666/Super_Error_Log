import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

/// 上传前把相册 / 相机的照片转成真正的 JPEG（对照 client/src/lib/uploader.ts 的 prepare）：
/// 最长边不超过 4096、按拍摄方向转正、去掉拍摄信息（位置等 EXIF），超过 15 MB 逐级降质量；
/// 转换成功才上传。HEIC 由系统解码。
enum ImagePreparer {
  static let maxEdge = 4096
  static let maxBytes = 15 * 1024 * 1024
  static let qualities: [Double] = [0.92, 0.85, 0.78, 0.7]

  enum Failure: Error, Equatable { case decode, encode, tooBig }

  static func prepare(_ data: Data, maxEdge: Int = ImagePreparer.maxEdge, maxBytes: Int = ImagePreparer.maxBytes) throws -> Data {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { throw Failure.decode }
    guard let image = thumbnail(source, longestEdge: maxEdge) else { throw Failure.decode }
    let flat = flattened(image) ?? image
    for (index, quality) in qualities.enumerated() {
      guard let jpeg = encode(flat, quality: quality), !jpeg.isEmpty else { throw Failure.encode }
      if jpeg.count <= maxBytes { return jpeg }
      if index == qualities.count - 1 { throw Failure.tooBig }
    }
    throw Failure.tooBig
  }

  /// 列表里的小预览（不上传）。
  static func preview(_ data: Data, longestEdge: Int = 240) -> Data? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = thumbnail(source, longestEdge: longestEdge) else { return nil }
    return encode(flattened(image) ?? image, quality: 0.7)
  }

  /// 按方向转正后缩到最长边 ≤ longestEdge；原图更小就不放大。
  private static func thumbnail(_ source: CGImageSource, longestEdge: Int) -> CGImage? {
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = (properties?[kCGImagePropertyPixelWidth] as? Int) ?? 0
    let height = (properties?[kCGImagePropertyPixelHeight] as? Int) ?? 0
    guard width > 0, height > 0 else { return nil }
    let edge = min(longestEdge, max(width, height))
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: edge,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }

  /// 带透明通道的图（截图）先铺白底再编码，免得 JPEG 里透明处变黑。
  private static func flattened(_ image: CGImage) -> CGImage? {
    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast: return nil
    default: break
    }
    guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(rect)
    context.draw(image, in: rect)
    return context.makeImage()
  }

  private static func encode(_ image: CGImage, quality: Double) -> Data? {
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? output as Data : nil
  }
}
