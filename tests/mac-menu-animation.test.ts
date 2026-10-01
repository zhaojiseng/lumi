import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sourcePath=fileURLToPath(new URL('../native/macos/UsageMenuBar.swift',import.meta.url));
const source=readFileSync(sourcePath,'utf8');
function between(start:string,end:string){
  const from=source.indexOf(start),to=source.indexOf(end,from+start.length);
  assert.ok(from>=0 && to>from,`Missing Swift section: ${start}`);
  return source.slice(from,to);
}
function inOrder(text:string,...steps:string[]){
  let position=-1;
  for(const step of steps){
    position=text.indexOf(step,position+1);
    assert.ok(position>=0,`Missing or out-of-order lifecycle step: ${step}`);
  }
}

// Source contracts are runnable on Windows; they cannot verify AppKit rendering or Swift types.
test('mac selectors keep the native three-choice system style without a custom glass indicator',()=>{
  const controls=[...source.matchAll(/NSSegmentedControl\(labels: \[([^\]]+)\], trackingMode: \.selectOne/g)];
  assert.equal(controls.length,2);
  assert.deepEqual(controls.map(match=>[...match[1].matchAll(/"([^"]+)"/g)].map(label=>label[1])),[['全部','Codex','Claude'],['今日','7 天','30 天']]);
  const setup=between('for (index, control) in [tools, days].enumerated()', 'tools.setAccessibilityLabel');
  assert.match(setup,/control\.segmentStyle = \.automatic/);
  assert.match(setup,/control\.segmentDistribution = \.fillEqually/);
  assert.doesNotMatch(setup,/layer|draw\(|NSVisualEffectView|NSGlassEffectView|selectedSegmentBezelColor/);
  assert.doesNotMatch(source,/animator\(\)\.selectedSegment|NSClassFromString|perform\(Selector|value\(forKey:/);
});

test('mac totals caption is optional and adds consumption without changing the fixed column headings',()=>{
  assert.match(between('struct UsageState: Decodable','func emit'),/let totalsCaption: String\?/);
  assert.match(source,/totalsTitle\.stringValue = state\.totalsCaption\.map \{ \$0 \+ "消费" \} \?\? "本期消费"/);
  assert.match(source,/totalsTitle\.toolTip = totalsTitle\.stringValue/);
  const totals=between('buildingSection = .totals','buildingSection = .tokenDetail');
  assert.match(totals,/NSTextField\(labelWithString: "Tokens"\)/);
  assert.match(totals,/NSTextField\(labelWithString: "请求数"\)/);
  assert.match(totals,/y: 155, width: 110, size: 11/);
  assert.match(totals,/y: 173, width: 110, size: 19/);
});

test('independent totals and chart scopes animate their own content while global days controls the selector',()=>{
  const plan=between('let totalsChanged =','suppressValueAnimations = !pendingSelectionSections.isEmpty');
  assert.match(plan,/previous\.totalsCaption != state\.totalsCaption/);
  assert.match(plan,/state\.totalsCaption == nil && oldDays != newDays/);
  assert.match(plan,/let chartChanged = previous\.chartCaption != state\.chartCaption/);
  assert.match(plan,/if oldTool != newTool \|\| totalsChanged \{ sections\.formUnion\(\[\.totals, \.tokenDetail, \.efficiency, \.models\]\) \}/);
  assert.match(plan,/if oldTool != newTool \|\| chartChanged \{ sections\.insert\(\.chart\) \}/);
  assert.match(source,/let daySegment = state\.days == 7 \? 1 : state\.days == 30 \? 2 : 0/);
  assert.match(source,/if !\["idle", "loading"\]\.contains\(state\.phase\), !pendingSelectionSections\.isEmpty/);
});

test('content fades at final geometry and cannot animate a parked model row from y=0',()=>{
  const animation=between('private func animateSelectionContent','private func setValue');
  assert.match(animation,/view\.isHidden \? nil/);
  assert.match(source,/private var transitionViews: \[NSView\] = \[\]/);
  assert.doesNotMatch(animation,/view\.frame|view\.wantsLayer|offsetBy|setFrameOrigin|NSRect/);
  assert.doesNotMatch(source,/animator\(\)\.(?:frame|frameOrigin|frameSize)|layer\??\.(?:position|transform)|removeAllAnimations/);
  inOrder(animation,'withoutAnimations {','layoutSubtreeIfNeeded()','view.alphaValue = 0.72','NSAnimationContext.runAnimationGroup');
  assert.match(animation,/context\.allowsImplicitAnimation = false/);
  assert.match(animation,/NSAnimationContext\.runAnimationGroup/);
  assert.match(animation,/view\.animator\(\)\.alphaValue = 1/);
  assert.match(animation,/fadeContent\(views, duration: 0\.20\)/);
  assert.doesNotMatch(animation,/Timer|DispatchQueue|backgroundColor|cornerRadius|mask|addSublayer/);

  const fields=between('private func field','private func reflow');
  inOrder(fields,'field.wantsLayer = true','field.frame =','addSubview(field)');
  inOrder(source,'chart.wantsLayer = true','chart.frame =');
  const geometry=between('private func reflowImmediately','func apply');
  assert.match(geometry,/if hidden \{ fields\.0\.setFrameOrigin\(NSPoint\(x: 18, y: 0\)\)/);
  assert.doesNotMatch(geometry,/animator\(\)|NSAnimationContext/);
});

test('all layout mutations settle synchronously with AppKit and backing-layer actions disabled',()=>{
  const reflow=between('private func reflow(','private func reflowImmediately');
  inOrder(reflow,'withoutAnimations {','reflowImmediately(contents, modelCount: modelCount)','layoutSubtreeIfNeeded()');
  const immediate=between('private func withoutAnimations','private func restoreSelectionContent');
  inOrder(immediate,'NSAnimationContext.beginGrouping()','NSAnimationContext.current','context.duration = 0','context.allowsImplicitAnimation = false','CATransaction.begin()','CATransaction.setDisableActions(true)','changes()','CATransaction.commit()','NSAnimationContext.endGrouping()');
  const apply=between('func apply','private func withoutAnimations');
  inOrder(apply,'restoreSelectionContent()','reflow(state.contents ?? MenuBarSection.allCases, modelCount: state.models.count)','fields.0.stringValue = row?.name','animateSelectionContent(sections: sections)');
});

test('repeated same-key loading snapshots preserve rendered model geometry and defer the pending fade',()=>{
  const loading=between('if ["idle", "loading"].contains(state.phase)','reflow(state.contents ?? MenuBarSection.allCases, modelCount: state.models.count)');
  assert.match(loading,/key == state\.viewKey/);
  assert.match(loading,/modelCount: displayedModelCount/);
  assert.doesNotMatch(loading,/previous\.models\.count|state\.models\.count|displayedModelCount\s*=|animateSelectionContent|pendingSelectionSections\.removeAll/);
  assert.match(loading,/footer\.stringValue = "正在刷新用量…"; return/);
  const apply=between('func apply','private func withoutAnimations');
  inOrder(apply,'modelCount: state.models.count)','displayedModelCount = state.models.count','fields.0.stringValue = row?.name');
  const ready=apply.slice(apply.indexOf('// Wait for the selected data'));
  inOrder(ready,'!["idle", "loading"].contains(state.phase)','let sections = pendingSelectionSections','pendingSelectionSections.removeAll()','animateSelectionContent(sections: sections)');
});

test('rapid switches and late completion handlers cannot restore stale frames or clear a newer fade',()=>{
  const restore=between('private func restoreSelectionContent','func cancelSelectionTransition');
  inOrder(restore,'transitionGeneration &+= 1','let views = transitionViews','transitionViews.removeAll()','guard !views.isEmpty','withoutAnimations {','view.animator().alphaValue = 1');
  assert.doesNotMatch(restore,/\.frame|setFrame|NSRect/);
  const fade=between('private func fadeContent','private func setValue');
  inOrder(fade,'let generation = transitionGeneration','transitionViews.append(contentsOf: views)','NSAnimationContext.runAnimationGroup','completionHandler: { [weak self]','self.transitionGeneration == generation','self.transitionViews.removeAll');
  const completion=fade.slice(fade.indexOf('completionHandler:'));
  assert.doesNotMatch(completion,/\.frame|\.alphaValue\s*=|pendingSelectionSections/);
  const selection=between('@objc private func changeSelection','final class MenuController');
  inOrder(selection,'guard (0..<3).contains','restoreSelectionContent()','selected?(');
  const values=between('private func setValue','@objc private func changeSelection');
  assert.match(values,/fadeContent\(\[field\], duration: 0\.18\)/);
  assert.doesNotMatch(values,/NSAnimationContext|animator\(\)/);
});

test('menu closure, detached windows and reduce motion cancel fades and bar timers',()=>{
  const tracking=between('func setMenuTracking','private func animateSelectionContent');
  inOrder(tracking,'isMenuTracking = tracking','cancelSelectionTransition()','chart.animatesChanges = tracking');
  assert.match(source,/func menuWillOpen[^\n]+card\.setMenuTracking\(true\)/);
  assert.match(source,/func menuDidClose[^\n]+card\.setMenuTracking\(false\)/);
  assert.match(source,/if window == nil \{ setMenuTracking\(false\) \}/);
  const cancel=between('func cancelSelectionTransition','func setMenuTracking');
  inOrder(cancel,'pendingSelectionSections.removeAll()','restoreSelectionContent()');
  const apply=between('func apply','private func withoutAnimations');
  assert.match(apply,/if isMenuTracking, window\?\.isVisible == true, let previous/);
  assert.match(apply,/\} else \{\s*pendingSelectionSections\.removeAll\(\)/);
  const fade=between('private func fadeContent','private func setValue');
  assert.match(fade,/guard isMenuTracking, window\?\.isVisible == true, !NSWorkspace\.shared\.accessibilityDisplayShouldReduceMotion/);
  assert.match(source,/NSWorkspace\.shared\.notificationCenter\.addObserver\(forName: NSWorkspace\.accessibilityDisplayOptionsDidChangeNotification/);
  assert.match(source,/accessibilityDisplayShouldReduceMotion \{ self\?\.cancelSelectionTransition\(\); self\?\.chart\.cancelAnimation\(\)/);
  assert.match(source,/var animatesChanges = false \{ didSet \{ if !animatesChanges \{ cancelAnimation\(\)/);
  assert.match(source,/guard animatesChanges, window\?\.isVisible == true, !NSWorkspace\.shared\.accessibilityDisplayShouldReduceMotion/);
  const bars=between('func cancelAnimation','deinit { animation');
  inOrder(bars,'animation?.invalidate()','animation = nil','heights = targetHeights');
});

test('native card retains attribution and optional content settings',()=>{
  assert.match(source,/Copyright \(c\) 2026 Peter Steinberger/);
  assert.match(source,/public\/third-party\/codexbar-LICENSE\.txt/);
  assert.match(source,/let contents: \[MenuBarSection\]\?/);
  assert.match(source,/let visible = Set\(contents\)/);
  assert.match(source,/reflow\(state\.contents \?\? MenuBarSection\.allCases/);
  assert.match(source,/guard \(0\.\.<3\)\.contains\(days\.selectedSegment\), \(0\.\.<3\)\.contains\(tools\.selectedSegment\)/);
});

test('Swift AppKit typechecks on macOS without launching the helper',{
  skip:process.platform==='darwin' ? false : 'Windows cannot typecheck Swift against the macOS AppKit SDK',
},()=>{
  const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8',timeout:30000}).trim();
  execFileSync('/usr/bin/xcrun',['swiftc','-typecheck',sourcePath,'-sdk',sdk,'-target',process.arch+'-apple-macosx14.0','-swift-version','5','-framework','AppKit','-framework','QuartzCore'],{stdio:'pipe',timeout:60000});
});
