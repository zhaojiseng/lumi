import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';

if(process.platform==='darwin'){
  const directory=path.resolve('dist-native');await mkdir(directory,{recursive:true});
  const sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
  const require=createRequire(import.meta.url),headers=require('node-api-headers').include_dir;
  const output=path.join(directory,'lumi-widget-glass.node');
  execFileSync('/usr/bin/xcrun',['clang++','native/macos/WidgetGlass.mm','-o',output,'-bundle','-undefined','dynamic_lookup','-fobjc-arc','-std=c++17','-arch',process.arch,'-isysroot',sdk,'-mmacosx-version-min=14.0','-DNAPI_VERSION=8','-I',headers,'-O2','-framework','AppKit'],{stdio:'inherit'});
  execFileSync('/usr/bin/codesign',['--force','--sign','-',output],{stdio:'inherit'});
  console.log('Built signed native macOS widget glass.');
}
