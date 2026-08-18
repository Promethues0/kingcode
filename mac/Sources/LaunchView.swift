// 启动页：引擎装配插件树要几秒，这几秒必须有品牌在场，不能白屏。
import AppKit

final class LaunchView: NSView {
    private let statusLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let markView = MarkView()
    private let logButton = NSButton()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        setup()
    }

    required init?(coder: NSCoder) { fatalError("未使用 nib") }

    override func updateLayer() {
        layer?.backgroundColor = Palette.windowBackground.cgColor
    }

    private func setup() {
        markView.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.alignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        detailLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        detailLabel.alignment = .center
        detailLabel.maximumNumberOfLines = 6
        detailLabel.isHidden = true
        detailLabel.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        logButton.title = "打开日志"
        logButton.bezelStyle = .rounded
        logButton.isHidden = true
        logButton.target = self
        logButton.action = #selector(openLog)
        logButton.translatesAutoresizingMaskIntoConstraints = false

        for v in [markView, statusLabel, detailLabel, spinner, logButton] { addSubview(v) }

        NSLayoutConstraint.activate([
            markView.centerXAnchor.constraint(equalTo: centerXAnchor),
            markView.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -54),
            markView.widthAnchor.constraint(equalToConstant: 64),
            markView.heightAnchor.constraint(equalToConstant: 64),

            statusLabel.topAnchor.constraint(equalTo: markView.bottomAnchor, constant: 22),
            statusLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 32),

            spinner.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 14),
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),

            detailLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 14),
            detailLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            detailLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 460),

            logButton.topAnchor.constraint(equalTo: detailLabel.bottomAnchor, constant: 16),
            logButton.centerXAnchor.constraint(equalTo: centerXAnchor),
        ])

        applyColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColors()
        needsDisplay = true
        markView.needsDisplay = true
    }

    private func applyColors() {
        statusLabel.textColor = Palette.label
        detailLabel.textColor = Palette.secondaryLabel
    }

    var logPath: String = ""

    @objc private func openLog() {
        guard !logPath.isEmpty else { return }
        NSWorkspace.shared.selectFile(logPath, inFileViewerRootedAtPath: "")
    }

    func showStarting(_ text: String) {
        statusLabel.stringValue = text
        statusLabel.textColor = Palette.label
        detailLabel.isHidden = true
        logButton.isHidden = true
        spinner.isHidden = false
        spinner.startAnimation(nil)
    }

    func showFailure(_ text: String) {
        statusLabel.stringValue = "引擎没能起来"
        statusLabel.textColor = Palette.errorColor
        detailLabel.stringValue = text
        detailLabel.isHidden = false
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        logButton.isHidden = logPath.isEmpty
    }

    /// 独立出来的一小块，只负责画 K —— 与应用图标同一份几何。
    private final class MarkView: NSView {
        override func draw(_ dirtyRect: NSRect) {
            KMark.draw(in: bounds,
                       stemColor: Palette.label,
                       armColor: Palette.markEnd)
        }
    }
}
