import {readExtensionPackage,scanExtensionPackages} from '../electron/extensions/packages.ts';
const input=process.argv[2];
if(input){const pkg=await readExtensionPackage(input);console.log(`${pkg.manifest.id} ${pkg.manifest.version} · ${pkg.files.size} files · ${pkg.digest}`);}
else{const result=await scanExtensionPackages(['extensions/packages']);for(const pkg of result.packages)console.log(`${pkg.manifest.id} ${pkg.manifest.version} · ${pkg.digest}`);if(result.diagnostics.length){console.error(result.diagnostics);process.exitCode=1;}}
