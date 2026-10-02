import AppKit
import Foundation
import Darwin
import QuartzCore

// Menu-card behavior references CodexBar (MIT), Copyright (c) 2026 Peter Steinberger.
// Reference: https://github.com/steipete/CodexBar/tree/f46a125af227254ac14de591968bce88d9fcc0f5
// Attribution and complete license: public/third-party/codexbar-LICENSE.txt (bundled with Lumi).
// NSMenu owns the system material; no web window or simulated glass background is used.
struct ChartPoint: Decodable { let label: String; let value: Double; let cost: String; let tokens: String; let requests: String }
struct ModelRow: Decodable { let name: String; let cost: String; let share: Double }
enum MenuBarSection: String, Decodable, CaseIterable { case balance, totals, tokenDetail, efficiency, chart, models }
final class CardMenuItem: NSMenuItem { override var isHighlighted: Bool { false } }
struct UsageState: Decodable {
    let type: String; let schemaVersion: Int; let phase: String; let siteName: String; let accountLabel: String
    let viewKey: String?
    let theme: String?
    let palette: [String: [Double]]?
    let contents: [MenuBarSection]?
    let days: Int; let tool: String; let balance: String; let cost: String; let tokens: String; let requests: String
    let tokenDetail: String; let cacheDetail: String; let cacheHitRate: String; let tokenSpeed: String
    let message: String; let updatedLabel: String; let canRefresh: Bool; let chartCaption: String
    let totalsCaption: String?
    let chart: [ChartPoint]?; let models: [ModelRow]; let modelsMessage: String
}
func emit(_ data: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: data) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}

final class SpendChart: NSView {
    var accent = NSColor.controlAccentColor { didSet { needsDisplay = true } }
    var muted = NSColor.secondaryLabelColor { didSet { needsDisplay = true } }
    var border = NSColor.separatorColor { didSet { needsDisplay = true } }
    var points: [ChartPoint]? { didSet { updateBars(); if let index = hover, index >= (points?.count ?? 0) { hover = nil }; detail?(hover.flatMap { points?[$0] }); needsDisplay = true } }
    private var heights: [CGFloat] = []
    private var targetHeights: [CGFloat] = []
    private var animation: Timer?
    var animatesChanges = false { didSet { if !animatesChanges { cancelAnimation() } } }
    private var hover: Int? { didSet { needsDisplay = true; detail?(hover.flatMap { points?[$0] }) } }
    var detail: ((ChartPoint?) -> Void)?
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }
    override var allowsVibrancy: Bool { true }
    private func updateBars() {
        let maximum = max(points?.map(\.value).max() ?? 0, 0.001)
        let target = points?.map { $0.value > 0 ? max(2, (bounds.height - 4) * CGFloat($0.value / maximum)) : 2 } ?? []
        if target == targetHeights { return }; targetHeights = target
        animation?.invalidate(); animation = nil
        guard animatesChanges, window?.isVisible == true, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, !target.isEmpty else { heights = target; return }
        let from = heights.count == target.count ? heights : Array(repeating: CGFloat(2), count: target.count)
        let started = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1 / 60, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let progress = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 1 : min(1, (CACurrentMediaTime() - started) / 0.22)
            let eased = CGFloat(1 - pow(1 - progress, 3))
            self.heights = zip(from, target).map { $0.0 + ($0.1 - $0.0) * eased }; self.needsDisplay = true
            if progress >= 1 { timer.invalidate(); self.animation = nil }
        }
        animation = timer; RunLoop.main.add(timer, forMode: .common); RunLoop.main.add(timer, forMode: .eventTracking)
    }
    func cancelAnimation() {
        animation?.invalidate(); animation = nil
        heights = targetHeights; needsDisplay = true
    }
    deinit { animation?.invalidate() }
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
            caption.draw(at: NSPoint(x: 0, y: 20), withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: muted]); return
        }
        let maximum = max(points.map(\.value).max() ?? 0, 0.001)
        border.setFill(); NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
        for (index, point) in points.enumerated() {
            let width = bounds.width / CGFloat(max(points.count, 1)), height = index < heights.count ? heights[index] : point.value > 0 ? max(2, (bounds.height - 4) * CGFloat(point.value / maximum)) : 2
            (point.value > 0 ? accent.withAlphaComponent(hover == index ? 1 : 0.72) : muted.withAlphaComponent(0.25)).setFill()
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
    private let totalsTitle = NSTextField(labelWithString: "本期消费")
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
    private var sectionViews: [MenuBarSection: [(NSView, NSRect)]] = [:]
    private var buildingSection: MenuBarSection?
    private var state: UsageState?
    private var displayedModelCount = 0
    private var isMenuTracking = false
    private var pendingSelectionSections = Set<MenuBarSection>()
    private var transitionViews: [NSView] = []
    private var transitionGeneration: UInt64 = 0
    private var suppressValueAnimations = false
    private var accessibilityObserver: NSObjectProtocol?
    private var fieldTones: [NSTextField: Bool] = [:]
    var selected: ((Int, String) -> Void)?
    override var isFlipped: Bool { true }
    override var allowsVibrancy: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 380, height: 450))
        field(title, x: 18, y: 10, width: 344, size: 15, weight: .semibold)
        field(account, x: 18, y: 31, width: 344, size: 11, muted: true)
        for (index, control) in [tools, days].enumerated() {
            control.frame = NSRect(x: 18, y: 53 + CGFloat(index) * 36, width: 344, height: 28)
            // Let AppKit choose the native bezel and selection indicator for this OS/context.
            // https://developer.apple.com/documentation/appkit/nssegmentedcontrol/style/automatic
            control.segmentStyle = .automatic; control.controlSize = .regular
            control.segmentDistribution = .fillEqually
            control.selectedSegment = 0
            control.target = self; control.action = #selector(changeSelection); addSubview(control)
        }
        tools.setAccessibilityLabel("统计工具"); days.setAccessibilityLabel("统计时间")
        buildingSection = .balance
        label("账户余额", x: 18, y: 124, width: 150, size: 12, muted: true)
        field(balance, x: 181, y: 122, width: 181, size: 18, weight: .semibold); balance.alignment = .right
        buildingSection = .totals
        for (index, pair) in [(totalsTitle, cost), (NSTextField(labelWithString: "Tokens"), tokens), (NSTextField(labelWithString: "请求数"), requests)].enumerated() {
            let x = 18 + CGFloat(index) * 116
            field(pair.0, x: x, y: 155, width: 110, size: 11, muted: true)
            field(pair.1, x: x, y: 173, width: 110, size: 19, weight: .semibold)
        }
        buildingSection = .tokenDetail
        field(tokenDetail, x: 18, y: 199, width: 344, size: 10, muted: true)
        buildingSection = .efficiency
        label("缓存命中率", x: 18, y: 225, width: 155, size: 11, muted: true)
        field(cache, x: 18, y: 241, width: 155, size: 14, weight: .medium)
        label("平均 Token 速率", x: 196, y: 225, width: 166, size: 11, muted: true)
        field(speed, x: 196, y: 241, width: 166, size: 14, weight: .medium)
        buildingSection = .chart
        field(chartTitle, x: 18, y: 270, width: 344, size: 11, weight: .medium)
        chart.wantsLayer = true
        chart.frame = NSRect(x: 18, y: 289, width: 344, height: 53); addSubview(chart)
        sectionViews[.chart, default: []].append((chart, chart.frame))
        chart.detail = { [weak self] point in
            guard let self else { return }
            self.chartDetail.stringValue = point.map { "\($0.label) · \($0.cost) · \($0.tokens) Tokens · \($0.requests) 次" } ?? self.state?.chartCaption ?? "等待同步"
        }
        field(chartDetail, x: 18, y: 347, width: 344, size: 10, muted: true)
        buildingSection = .models
        label("主要模型 · 按消费", x: 18, y: 371, width: 344, size: 11, weight: .medium)
        for (index, fields) in modelFields.enumerated() {
            let y = 390 + CGFloat(index) * 17
            field(fields.0, x: 18, y: y, width: 252, size: 10, muted: true)
            field(fields.1, x: 275, y: y, width: 87, size: 10); fields.1.alignment = .right
        }
        buildingSection = nil
        field(footer, x: 18, y: 434, width: 344, size: 9, muted: true)
        reflow(MenuBarSection.allCases, modelCount: 0)
        setAccessibilityLabel("Lumi 用量面板")
        accessibilityObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { self?.cancelSelectionTransition(); self?.chart.cancelAnimation() }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    deinit {
        if let accessibilityObserver { NSWorkspace.shared.notificationCenter.removeObserver(accessibilityObserver) }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { setMenuTracking(false) }
    }
    private func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat, weight: NSFont.Weight = .regular, muted: Bool = false) {
        field(NSTextField(labelWithString: text), x: x, y: y, width: width, size: size, weight: weight, muted: muted)
    }
    private func field(_ field: NSTextField, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat, weight: NSFont.Weight = .regular, muted: Bool = false) {
        // Create backing layers before any hidden-row parking or later menu reflow.
        field.wantsLayer = true
        field.frame = NSRect(x: x, y: y, width: width, height: size + 7)
        field.font = NSFont.systemFont(ofSize: size, weight: weight)
        field.textColor = muted ? .secondaryLabelColor : .labelColor
        fieldTones[field] = muted
        field.lineBreakMode = .byTruncatingTail; field.maximumNumberOfLines = 1
        addSubview(field)
        if let buildingSection { sectionViews[buildingSection, default: []].append((field, field.frame)) }
    }
    private func reflow(_ contents: [MenuBarSection], modelCount: Int) {
        withoutAnimations { reflowImmediately(contents, modelCount: modelCount); layoutSubtreeIfNeeded() }
    }
    private func reflowImmediately(_ contents: [MenuBarSection], modelCount: Int) {
        let visible = Set(contents)
        let rows = max(1, min(3, modelCount))
        var y: CGFloat = 122
        // Original local positions keep AppKit text sizing and native material intact.
        let sections: [(MenuBarSection, CGFloat, CGFloat)] = [(.balance, 122, 31), (.totals, 153, 46), (.tokenDetail, 199, 24), (.efficiency, 223, 47), (.chart, 270, 101), (.models, 371, 20 + CGFloat(rows) * 17 + 6)]
        for (id, origin, height) in sections {
            for (view, original) in sectionViews[id] ?? [] {
                view.isHidden = !visible.contains(id)
                // Hidden views also stay inside the compact card's bounds.
                view.frame = NSRect(x: original.minX, y: visible.contains(id) ? y + original.minY - origin : 0, width: original.width, height: original.height)
            }
            if visible.contains(id) { y += height }
        }
        for (index, fields) in modelFields.enumerated() {
            let hidden = !visible.contains(.models) || index >= rows
            fields.0.isHidden = hidden; fields.1.isHidden = hidden || modelCount == 0
            if hidden { fields.0.setFrameOrigin(NSPoint(x: 18, y: 0)); fields.1.setFrameOrigin(NSPoint(x: 275, y: 0)) }
        }
        footer.setFrameOrigin(NSPoint(x: 18, y: y))
        setFrameSize(NSSize(width: 380, height: y + footer.frame.height))
    }
    func apply(_ state: UsageState) {
        let previous = self.state
        restoreSelectionContent()
        if isMenuTracking, window?.isVisible == true, let previous {
            let oldTool = previous.tool == "codex" ? 1 : previous.tool == "claude" ? 2 : 0
            let newTool = state.tool == "codex" ? 1 : state.tool == "claude" ? 2 : 0
            let oldDays = previous.days == 7 ? 1 : previous.days == 30 ? 2 : 0
            let newDays = state.days == 7 ? 1 : state.days == 30 ? 2 : 0
            let totalsChanged = previous.totalsCaption != state.totalsCaption || (state.totalsCaption == nil && oldDays != newDays)
            let chartChanged = previous.chartCaption != state.chartCaption
            var sections = Set<MenuBarSection>()
            if oldTool != newTool || totalsChanged { sections.formUnion([.totals, .tokenDetail, .efficiency, .models]) }
            if oldTool != newTool || chartChanged { sections.insert(.chart) }
            if !sections.isEmpty {
                pendingSelectionSections.formUnion(sections)
            }
        } else {
            pendingSelectionSections.removeAll()
        }
        suppressValueAnimations = !pendingSelectionSections.isEmpty
        defer { suppressValueAnimations = false }
        self.state = state
        func color(_ key: String, fallback: NSColor) -> NSColor {
            guard let channels = state.palette?[key], channels.count == 4 else { return fallback }
            return NSColor(srgbRed: CGFloat(channels[0] / 255), green: CGFloat(channels[1] / 255), blue: CGFloat(channels[2] / 255), alpha: CGFloat(channels[3]))
        }
        for (field, muted) in fieldTones { field.textColor = color(muted ? "text-secondary" : "text", fallback: muted ? .secondaryLabelColor : .labelColor) }
        chart.accent = color("accent", fallback: .controlAccentColor)
        chart.muted = color("text-muted", fallback: .secondaryLabelColor)
        chart.border = color("border", fallback: .separatorColor)
        let toolSegment = state.tool == "codex" ? 1 : state.tool == "claude" ? 2 : 0
        let daySegment = state.days == 7 ? 1 : state.days == 30 ? 2 : 0
        // selectedSegment is not a documented animatable property; AppKit owns its feedback.
        if tools.selectedSegment != toolSegment { tools.selectedSegment = toolSegment }
        if days.selectedSegment != daySegment { days.selectedSegment = daySegment }
        if ["idle", "loading"].contains(state.phase), let previous, let key = previous.viewKey, key == state.viewKey {
            // Loading snapshots contain no model rows; preserve the last rendered geometry.
            reflow(state.contents ?? MenuBarSection.allCases, modelCount: displayedModelCount)
            footer.stringValue = "正在刷新用量…"; return
        }
        reflow(state.contents ?? MenuBarSection.allCases, modelCount: state.models.count)
        displayedModelCount = state.models.count
        title.stringValue = state.siteName; account.stringValue = state.accountLabel
        totalsTitle.stringValue = state.totalsCaption.map { $0 + "消费" } ?? "本期消费"; totalsTitle.toolTip = totalsTitle.stringValue
        setValue(balance, state.balance); setValue(cost, state.cost); setValue(tokens, state.tokens); setValue(requests, state.requests)
        tokenDetail.stringValue = state.tokenDetail; tokenDetail.toolTip = state.tokenDetail
        setValue(cache, state.cacheHitRate); cache.toolTip = state.cacheDetail
        setValue(speed, state.tokenSpeed); speed.toolTip = "输出 Tokens 合计 ÷ 有效请求总耗时，包含首字等待"
        chartTitle.stringValue = state.chartCaption + " · 消费趋势"; chart.points = state.chart
        chartDetail.stringValue = state.chartCaption; chart.setAccessibilityLabel(state.chartCaption + "消费曲线")
        for (index, fields) in modelFields.enumerated() {
            let row = index < state.models.count ? state.models[index] : nil
            fields.0.stringValue = row?.name ?? (index == 0 ? state.modelsMessage : "")
            fields.0.toolTip = row?.name; fields.1.stringValue = row?.cost ?? ""
        }
        footer.stringValue = state.message + " · " + state.updatedLabel; footer.toolTip = footer.stringValue
        // Wait for the selected data, so loading packets do not restart the content animation.
        if !["idle", "loading"].contains(state.phase), !pendingSelectionSections.isEmpty {
            let sections = pendingSelectionSections
            pendingSelectionSections.removeAll()
            animateSelectionContent(sections: sections)
        }
        needsDisplay = true
    }
    private func withoutAnimations(_ changes: () -> Void) {
        NSAnimationContext.beginGrouping()
        let context = NSAnimationContext.current
        context.duration = 0; context.allowsImplicitAnimation = false
        CATransaction.begin(); CATransaction.setDisableActions(true)
        changes()
        CATransaction.commit()
        NSAnimationContext.endGrouping()
    }
    private func restoreSelectionContent() {
        transitionGeneration &+= 1
        let views = transitionViews
        transitionViews.removeAll()
        guard !views.isEmpty else { return }
        // Cancel only opacity. Never replay frames captured before the latest reflow.
        withoutAnimations {
            for view in views { view.animator().alphaValue = 1; view.alphaValue = 1 }
        }
    }
    func cancelSelectionTransition() {
        pendingSelectionSections.removeAll()
        restoreSelectionContent()
    }
    func setMenuTracking(_ tracking: Bool) {
        isMenuTracking = tracking
        cancelSelectionTransition()
        chart.animatesChanges = tracking
    }
    private func animateSelectionContent(sections: Set<MenuBarSection>) {
        let views = MenuBarSection.allCases.filter { sections.contains($0) }.flatMap { sectionViews[$0] ?? [] }.compactMap { view, _ in
            view.isHidden ? nil : view
        }
        fadeContent(views, duration: 0.20)
    }
    private func fadeContent(_ views: [NSView], duration: TimeInterval) {
        guard isMenuTracking, window?.isVisible == true, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, !views.isEmpty else { return }
        let generation = transitionGeneration
        transitionViews.append(contentsOf: views)
        // Geometry and backing layers are settled before opacity changes; no frame animator.
        withoutAnimations {
            layoutSubtreeIfNeeded()
            for view in views { view.alphaValue = 0.72 }
        }
        // https://developer.apple.com/documentation/appkit/nsanimationcontext
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration; context.allowsImplicitAnimation = false
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for view in views { view.animator().alphaValue = 1 }
        }, completionHandler: { [weak self] in
            guard let self, self.transitionGeneration == generation else { return }
            self.transitionViews.removeAll { view in views.contains { $0 === view } }
        })
    }
    private func setValue(_ field: NSTextField, _ value: String) {
        guard field.stringValue != value else { return }
        field.stringValue = value
        guard !suppressValueAnimations, !field.isHidden else { field.alphaValue = 1; return }
        fadeContent([field], duration: 0.18)
    }
    @objc private func changeSelection() {
        guard (0..<3).contains(days.selectedSegment), (0..<3).contains(tools.selectedSegment) else { return }
        restoreSelectionContent()
        selected?([1, 7, 30][days.selectedSegment], ["all", "codex", "claude"][tools.selectedSegment])
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
    private func lumiIcon() -> NSImage {
        // Lumi's L + dot mark, rendered as a white vector at every Retina scale.
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
            NSColor.white.setStroke(); NSColor.white.setFill()
            let scale = rect.width / 36
            let mark = NSBezierPath(); mark.lineWidth = 5 * scale; mark.lineCapStyle = .round; mark.lineJoinStyle = .round
            mark.move(to: NSPoint(x: 11 * scale, y: 8 * scale)); mark.line(to: NSPoint(x: 11 * scale, y: 22 * scale))
            mark.curve(to: NSPoint(x: 16 * scale, y: 27 * scale), controlPoint1: NSPoint(x: 11 * scale, y: 26 * scale), controlPoint2: NSPoint(x: 12 * scale, y: 27 * scale))
            mark.line(to: NSPoint(x: 28 * scale, y: 27 * scale)); mark.stroke()
            NSBezierPath(ovalIn: NSRect(x: 22 * scale, y: 6 * scale, width: 8 * scale, height: 8 * scale)).fill(); return true
        }
        image.isTemplate = false; image.accessibilityDescription = "Lumi 用量"; return image
    }
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
                button.image = lumiIcon(); button.toolTip = "Lumi · 余额与用量"
                statusItem?.menu = menu
            }
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in self?.readInput() }; source.resume(); inputSource = source
        emit(["type": "ready", "schemaVersion": 1, "nativeCard": card.superview != nil || menu.items[0].view === card, "nativeChart": card.chart.superview === card, "nativeSelectors": card.tools.superview === card && card.days.superview === card, "equalSelectorHeight": card.tools.frame.height == card.days.frame.height, "lumiIcon": !lumiIcon().isTemplate, "layoutValid": card.subviews.allSatisfy { card.bounds.contains($0.frame) }])
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
    func menuWillOpen(_ menu: NSMenu) { card.setMenuTracking(true); menu.appearance = card.appearance ?? NSApp.effectiveAppearance; emit(["type": "opened"]) }
    func menuDidClose(_ menu: NSMenu) { card.setMenuTracking(false); emit(["type": "closed"]) }
    private func readInput() {
        var buffer = [UInt8](repeating: 0, count: 16384)
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        guard count > 0 else { NSApp.terminate(nil); return }
        pending.append(contentsOf: buffer.prefix(count))
        if pending.count > 262144 { pending.removeAll(); return }
        while let end = pending.firstIndex(of: 10) {
            let line = Data(pending[..<end]); pending.removeSubrange(...end)
            guard let state = try? JSONDecoder().decode(UsageState.self, from: line), state.type == "state", state.schemaVersion == 1, [1, 7, 30].contains(state.days), ["all", "codex", "claude"].contains(state.tool), (state.contents?.count ?? 0) <= MenuBarSection.allCases.count, (state.chart?.count ?? 0) <= 60, state.models.count <= 3 else { continue }
            guard state.theme == nil || state.theme == "light" || state.theme == "dark" else { continue }
            if let palette = state.palette {
                let keys: Set<String> = ["panel", "panel-strong", "panel-soft", "text", "text-secondary", "text-muted", "accent", "accent-hover", "accent-soft", "border", "line", "hover", "hover-strong", "blue", "blue-soft", "purple", "purple-soft", "orange", "orange-soft", "red", "red-soft"]
                guard Set(palette.keys) == keys, palette.values.allSatisfy({ values in values.count == 4 && values.enumerated().allSatisfy { index, value in value.isFinite && value >= 0 && value <= (index == 3 ? 1 : 255) && (index == 3 || value.rounded() == value) } }) else { continue }
            }
            let appearance = state.theme.flatMap { NSAppearance(named: $0 == "dark" ? .darkAqua : .aqua) }
            menu.appearance = appearance; card.appearance = appearance; card.chart.needsDisplay = true
            card.apply(state); refreshItem.isEnabled = state.canRefresh; menu.update()
            statusItem?.button?.toolTip = "Lumi · 余额 " + state.balance + " · 本期 " + state.cost
            if smoke { emit(["type": "applied", "schemaVersion": 1, "contents": (state.contents ?? MenuBarSection.allCases).map(\.rawValue), "cardHeight": card.frame.height, "layoutValid": card.subviews.allSatisfy { card.bounds.contains($0.frame) }]) }
        }
    }
}
let controller = MenuController()
let application = NSApplication.shared
application.delegate = controller
application.run()
