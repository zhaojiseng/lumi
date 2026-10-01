import AppKit
import Foundation
import Darwin

// Original implementation inspired by CodexBar's NSMenu + custom-view usage cards.
// NSMenu owns the system material; no web window or simulated glass background is used.
struct ChartPoint: Decodable { let label: String; let value: Double; let cost: String; let tokens: String; let requests: String }
struct ModelRow: Decodable { let name: String; let cost: String; let share: Double }
final class CardMenuItem: NSMenuItem { override var isHighlighted: Bool { false } }
struct UsageState: Decodable {
    let type: String; let schemaVersion: Int; let phase: String; let siteName: String; let accountLabel: String
    let days: Int; let tool: String; let balance: String; let cost: String; let tokens: String; let requests: String
    let tokenDetail: String; let cacheDetail: String; let cacheHitRate: String; let tokenSpeed: String
    let message: String; let updatedLabel: String; let canRefresh: Bool; let chartCaption: String
    let chart: [ChartPoint]?; let models: [ModelRow]; let modelsMessage: String
}
func emit(_ data: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: data) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}

final class SpendChart: NSView {
    var points: [ChartPoint]? { didSet { hover = nil; needsDisplay = true } }
    private var hover: Int? { didSet { needsDisplay = true; detail?(hover.flatMap { points?[$0] }) } }
    var detail: ((ChartPoint?) -> Void)?
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }
    override var allowsVibrancy: Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func mouseMoved(with event: NSEvent) {
        guard let points, !points.isEmpty else { hover = nil; return }
        let x = convert(event.locationInWindow, from: nil).x
        hover = min(points.count - 1, max(0, Int(x / max(1, bounds.width) * CGFloat(points.count))))
    }
    override func mouseExited(with event: NSEvent) { hover = nil }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let points else {
            let caption = "消费曲线暂不可用" as NSString
            caption.draw(at: NSPoint(x: 0, y: 20), withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]); return
        }
        let maximum = max(points.map(\.value).max() ?? 0, 0.001)
        NSColor.separatorColor.setFill(); NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        for (index, point) in points.enumerated() {
            let width = bounds.width / CGFloat(max(points.count, 1)), height = point.value > 0 ? max(2, (bounds.height - 4) * CGFloat(point.value / maximum)) : 2
            (point.value > 0 ? NSColor.systemGreen.withAlphaComponent(hover == index ? 1 : 0.72) : NSColor.tertiaryLabelColor.withAlphaComponent(0.25)).setFill()
            let rect = NSRect(x: CGFloat(index) * width + 1, y: bounds.height - height, width: max(1, width - 3), height: height)
            NSBezierPath(roundedRect: rect, xRadius: 2, yRadius: 2).fill()
        }
    }
}

/// Keep a single menu card alive while data updates, so selectors and pointer tracking stay stable.
final class UsageCard: NSView {
    let tools = NSSegmentedControl(labels: ["全部", "Codex", "Claude"], trackingMode: .selectOne, target: nil, action: nil)
    let days = NSSegmentedControl(labels: ["今日", "7 天", "30 天"], trackingMode: .selectOne, target: nil, action: nil)
    let chart = SpendChart()
    private let title = NSTextField(labelWithString: "Lumi")
    private let account = NSTextField(labelWithString: "等待同步")
    private let balance = NSTextField(labelWithString: "—")
    private let cost = NSTextField(labelWithString: "—")
    private let tokens = NSTextField(labelWithString: "—")
    private let requests = NSTextField(labelWithString: "—")
    private let tokenDetail = NSTextField(labelWithString: "输入 / 输出明细暂不可用")
    private let cache = NSTextField(labelWithString: "—")
    private let speed = NSTextField(labelWithString: "—")
    private let chartTitle = NSTextField(labelWithString: "消费趋势")
    private let chartDetail = NSTextField(labelWithString: "等待同步")
    private let footer = NSTextField(labelWithString: "点击刷新读取用量")
    private let modelFields = (0..<3).map { _ in (NSTextField(labelWithString: ""), NSTextField(labelWithString: "")) }
    private var state: UsageState?
    var selected: ((Int, String) -> Void)?
    override var isFlipped: Bool { true }
    override var allowsVibrancy: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 380, height: 450))
        field(title, x: 18, y: 10, width: 344, size: 15, weight: .semibold)
        field(account, x: 18, y: 31, width: 344, size: 11, muted: true)
        tools.frame = NSRect(x: 18, y: 53, width: 344, height: 25); tools.segmentStyle = .rounded
        tools.target = self; tools.action = #selector(changeSelection); addSubview(tools)
        days.frame = NSRect(x: 18, y: 87, width: 344, height: 23); days.segmentStyle = .rounded; days.controlSize = .small
        days.target = self; days.action = #selector(changeSelection); addSubview(days)
        label("账户余额", x: 18, y: 124, width: 150, size: 12, muted: true)
        field(balance, x: 181, y: 122, width: 181, size: 18, weight: .semibold); balance.alignment = .right
        for (index, pair) in [("本期消费", cost), ("Tokens", tokens), ("请求数", requests)].enumerated() {
            let x = 18 + CGFloat(index) * 116
            label(pair.0, x: x, y: 155, width: 110, size: 11, muted: true)
            field(pair.1, x: x, y: 173, width: 110, size: 19, weight: .semibold)
        }
        field(tokenDetail, x: 18, y: 199, width: 344, size: 10, muted: true)
        label("缓存命中率", x: 18, y: 225, width: 155, size: 11, muted: true)
        field(cache, x: 18, y: 241, width: 155, size: 14, weight: .medium)
        label("平均 Token 速率", x: 196, y: 225, width: 166, size: 11, muted: true)
        field(speed, x: 196, y: 241, width: 166, size: 14, weight: .medium)
        field(chartTitle, x: 18, y: 270, width: 344, size: 11, weight: .medium)
        chart.frame = NSRect(x: 18, y: 289, width: 344, height: 53); addSubview(chart)
        chart.detail = { [weak self] point in
            guard let self else { return }
            self.chartDetail.stringValue = point.map { "\($0.label) · \($0.cost) · \($0.tokens) Tokens · \($0.requests) 次" } ?? self.state?.chartCaption ?? "等待同步"
        }
        field(chartDetail, x: 18, y: 347, width: 344, size: 10, muted: true)
        label("主要模型 · 按消费", x: 18, y: 371, width: 344, size: 11, weight: .medium)
        for (index, fields) in modelFields.enumerated() {
            let y = 390 + CGFloat(index) * 15
            field(fields.0, x: 18, y: y, width: 252, size: 10, muted: true)
            field(fields.1, x: 275, y: y, width: 87, size: 10); fields.1.alignment = .right
        }
        field(footer, x: 18, y: 434, width: 344, size: 9, muted: true)
        setAccessibilityLabel("Lumi 用量面板")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    private func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat, weight: NSFont.Weight = .regular, muted: Bool = false) {
        field(NSTextField(labelWithString: text), x: x, y: y, width: width, size: size, weight: weight, muted: muted)
    }
    private func field(_ field: NSTextField, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat, weight: NSFont.Weight = .regular, muted: Bool = false) {
        field.frame = NSRect(x: x, y: y, width: width, height: size + 7)
        field.font = NSFont.systemFont(ofSize: size, weight: weight)
        field.textColor = muted ? .secondaryLabelColor : .labelColor
        field.lineBreakMode = .byTruncatingTail; field.maximumNumberOfLines = 1
        addSubview(field)
    }
    func apply(_ state: UsageState) {
        self.state = state; title.stringValue = state.siteName; account.stringValue = state.accountLabel
        tools.selectedSegment = state.tool == "codex" ? 1 : state.tool == "claude" ? 2 : 0
        days.selectedSegment = state.days == 7 ? 1 : state.days == 30 ? 2 : 0
        balance.stringValue = state.balance; cost.stringValue = state.cost; tokens.stringValue = state.tokens; requests.stringValue = state.requests
        tokenDetail.stringValue = state.tokenDetail; tokenDetail.toolTip = state.tokenDetail
        cache.stringValue = state.cacheHitRate; cache.toolTip = state.cacheDetail
        speed.stringValue = state.tokenSpeed; speed.toolTip = "输出 Tokens 合计 ÷ 有效请求总耗时，包含首字等待"
        chartTitle.stringValue = state.chartCaption + " · 消费趋势"; chart.points = state.chart
        chartDetail.stringValue = state.chartCaption; chart.setAccessibilityLabel(state.chartCaption + "消费曲线")
        for (index, fields) in modelFields.enumerated() {
            let row = index < state.models.count ? state.models[index] : nil
            fields.0.stringValue = row?.name ?? (index == 0 ? state.modelsMessage : "")
            fields.0.toolTip = row?.name; fields.1.stringValue = row?.cost ?? ""
        }
        footer.stringValue = state.message + " · " + state.updatedLabel; footer.toolTip = footer.stringValue
        needsDisplay = true
    }
    @objc private func changeSelection() {
        selected?([1, 7, 30][max(0, days.selectedSegment)], ["all", "codex", "claude"][max(0, tools.selectedSegment)])
    }
}

final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let menu = NSMenu()
    let card = UsageCard()
    private var statusItem: NSStatusItem?
    private var refreshItem: NSMenuItem!
    private var inputSource: DispatchSourceRead?
    private var pending = Data()
    let smoke = CommandLine.arguments.contains("--smoke")
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        menu.autoenablesItems = false; menu.delegate = self
        let cardItem = CardMenuItem(); cardItem.view = card; menu.addItem(cardItem)
        menu.addItem(.separator())
        refreshItem = item("刷新用量", action: "refresh", key: "r")
        _ = item("打开工作台", action: "overview", key: "1")
        _ = item("用量分析", action: "usage", key: "2")
        _ = item("设置…", action: "settings", key: ",")
        menu.addItem(.separator()); _ = item("退出 Lumi", action: "quit", key: "q")
        card.selected = { days, tool in emit(["type": "select", "days": days, "tool": tool]) }
        if !smoke {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem?.autosaveName = "LumiUsage"
            if let button = statusItem?.button {
                let image = NSImage(systemSymbolName: "chart.bar.fill", accessibilityDescription: "Lumi 用量")
                image?.isTemplate = true; image?.size = NSSize(width: 17, height: 17)
                button.image = image; button.toolTip = "Lumi · 余额与用量"
                statusItem?.menu = menu
            }
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in self?.readInput() }; source.resume(); inputSource = source
        emit(["type": "ready", "schemaVersion": 1, "nativeCard": card.superview != nil || menu.items[0].view === card, "nativeChart": card.chart.superview === card, "nativeSelectors": card.tools.superview === card && card.days.superview === card, "layoutValid": card.subviews.allSatisfy { card.bounds.contains($0.frame) }])
    }
    private func item(_ title: String, action: String, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(performMenuAction(_:)), keyEquivalent: key)
        item.target = self; item.representedObject = action; menu.addItem(item); return item
    }
    @objc private func performMenuAction(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        if ["overview", "usage", "settings"].contains(action) { emit(["type": "navigate", "page": action]) }
        else { emit(["type": action]) }
    }
    func menuWillOpen(_ menu: NSMenu) { menu.appearance = NSApp.effectiveAppearance; emit(["type": "opened"]) }
    func menuDidClose(_ menu: NSMenu) { emit(["type": "closed"]) }
    private func readInput() {
        var buffer = [UInt8](repeating: 0, count: 16384)
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        guard count > 0 else { NSApp.terminate(nil); return }
        pending.append(contentsOf: buffer.prefix(count))
        if pending.count > 262144 { pending.removeAll(); return }
        while let end = pending.firstIndex(of: 10) {
            let line = Data(pending[..<end]); pending.removeSubrange(...end)
            guard let state = try? JSONDecoder().decode(UsageState.self, from: line), state.type == "state", state.schemaVersion == 1, [1, 7, 30].contains(state.days), ["all", "codex", "claude"].contains(state.tool), (state.chart?.count ?? 0) <= 60, state.models.count <= 3 else { continue }
            card.apply(state); refreshItem.isEnabled = state.canRefresh
            statusItem?.button?.toolTip = "Lumi · 余额 " + state.balance + " · 本期 " + state.cost
            if smoke { emit(["type": "applied", "schemaVersion": 1]) }
        }
    }
}
let controller = MenuController()
let application = NSApplication.shared
application.delegate = controller
application.run()
