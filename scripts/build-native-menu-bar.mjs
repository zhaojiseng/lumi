import {mkdir,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

if(process.platform==='darwin'){
  const directory=path.resolve('dist-native');await mkdir(directory,{recursive:true});
  const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
  const output=path.join(directory,'lumi-menu-bar');
  execFileSync('/usr/bin/xcrun',['swiftc','native/macos/UsageMenuBar.swift','-o',output,'-sdk',sdk,'-target',process.arch+'-apple-macosx14.0','-swift-version','5','-O','-framework','AppKit','-framework','QuartzCore'],{stdio:'inherit'});
  await chmod(output,0o755);
  execFileSync('/usr/bin/codesign',['--force','--sign','-',output],{stdio:'inherit'});
  console.log('Built signed native macOS menu-bar usage card.');
}
