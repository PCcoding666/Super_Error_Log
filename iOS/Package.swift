// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "StudentCore",
    platforms: [.macOS(.v14), .iOS(.v18)],
    products: [.library(name: "StudentCore", targets: ["StudentCore"])],
    targets: [
        .target(name: "StudentCore", path: "StudentApp", exclude: ["Resources", "Theme.swift", "RecognitionView.swift", "ThisWeekView.swift", "ReflectionView.swift", "ReviewPackView.swift", "ReviewPDF.swift", "SourcePhotoView.swift", "SuperErrorLogApp.swift", "CameraScanner.swift", "LoopHomeView.swift", "CorrectionSheet.swift", "SpeechInput.swift", "LoopSettingsView.swift", "LoopPracticeSection.swift", "PracticePickView.swift", "PracticeDetailView.swift", "FollowupView.swift"], sources: ["Domain", "RecognitionClient.swift", "PairingStore.swift", "StudyStore.swift", "V2Client.swift", "LoopStore.swift"]),
        .testTarget(name: "StudentCoreTests", dependencies: ["StudentCore"], path: "Tests")
    ]
)
