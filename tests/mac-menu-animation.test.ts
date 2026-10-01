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
  const plan=between('let totalsChanged =','suppressValueAnimations = pendingSelectionDirection');
  assert.match(plan,/previous\.totalsCaption != state\.totalsCaption/);
  assert.match(plan,/state\.totalsCaption == nil && oldDays != newDays/);
  assert.match(plan,/let chartChanged = previous\.chartCaption != state\.chartCaption/);
  assert.match(plan,/if oldTool != newTool \|\| totalsChanged \{ sections\.formUnion\(\[\.totals, \.tokenDetail, \.efficiency, \.models\]\) \}/);
  assert.match(plan,/if oldTool != newTool \|\| chartChanged \{ sections\.insert\(\.chart\) \}/);
  assert.match(source,/let daySegment = state\.days == 7 \? 1 : state\.days == 30 \? 2 : 0/);
  assert.match(source,/if !\["idle", "loading"\]\.contains\(state\.phase\), let direction = pendingSelectionDirection/);
});

test('content transitions respect visibility and reduce motion and settle through public AppKit APIs',()=>{
  const animation=between('private func animateSelectionContent','private func setValue');
  assert.match(animation,/guard window\?\.isVisible == true, !NSWorkspace\.shared\.accessibilityDisplayShouldReduceMotion/);
  assert.match(animation,/view\.isHidden \? nil/);
  assert.match(animation,/NSAnimationContext\.runAnimationGroup/);
  assert.match(animation,/view\.animator\(\)\.frame = frame; view\.animator\(\)\.alphaValue = 1/);
  assert.doesNotMatch(animation,/Timer|DispatchQueue|backgroundColor|cornerRadius|mask|addSublayer/);
  const restore=between('private func restoreSelectionContent','private func animateSelectionContent');
  assert.match(restore,/context\.duration = 0/);
  assert.match(restore,/view\.animator\(\)\.frame = frame; view\.animator\(\)\.alphaValue = 1/);
  assert.match(restore,/pendingSelectionSections\.removeAll\(\)/);
  assert.match(source,/NSWorkspace\.shared\.notificationCenter\.addObserver\(forName: NSWorkspace\.accessibilityDisplayOptionsDidChangeNotification/);
  assert.match(source,/func menuDidClose[^\n]+card\.cancelSelectionTransition\(\)/);
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
