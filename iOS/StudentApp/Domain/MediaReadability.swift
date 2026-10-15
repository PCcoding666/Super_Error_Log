import Foundation
import ImageIO

enum MediaReadability {
  // Request eager decoding: a JPEG signature or a partially decoded image is not evidence.
  static func isReadableJPEG(_ data: Data) -> Bool {
    guard data.starts(with: [0xff, 0xd8, 0xff]),
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetStatus(source) == .statusComplete,
      CGImageSourceGetCount(source) == 1,
      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
      CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
      image.width > 0, image.height > 0, image.dataProvider?.data != nil
    else { return false }
    return true
  }

  static func readableFile(_ url: URL) async -> Bool {
    await Task.detached { (try? Data(contentsOf: url)).map(isReadableJPEG) == true }.value
  }

  static func preserve(_ data: Data, in directory: URL, mediaID: String) throws {
    let folder = directory.appendingPathComponent("CorruptMedia", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try StudyPersistence.excludeFromBackup(folder)
    try data.write(to: folder.appendingPathComponent(mediaID + "-" + UUID().uuidString + ".jpg"), options: .atomic)
  }
}
