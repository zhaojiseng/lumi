const sdk=window.lumiExtension,note=document.getElementById('note'),status=document.getElementById('status');
function theme(context){document.documentElement.dataset.theme=context.theme;}
sdk.ready.then(async ({context,view})=>{theme(context);sdk.onContext(theme);if(view.slot==='connection')document.getElementById('description').textContent='使用 Lumi 提供的独立本机存储，无需站点或密钥。';note.value=await sdk.storage.read('note') || '';}).catch(error=>status.textContent=error.message);
document.getElementById('save').addEventListener('click',async()=>{try{await sdk.storage.write('note',note.value);status.textContent='已保存';}catch(error){status.textContent=error.message;}});
