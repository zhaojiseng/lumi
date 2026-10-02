import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSessionEvent,updateSessionMetadata} from '../electron/services/local-session-parser';
import type {LocalSessionMetadata,Tool} from '../shared/types';

// Synthetic fixtures only. No log discovery, user files, network or tool execution.
const at='2026-10-02T04:05:06.123Z',seconds=Date.parse(at)/1000;
const codex=<T>(payload:T,type='response_item')=>({type,timestamp:at,payload});
const codexMessage=(role:string,content:unknown)=>codex({type:'message',role,content});
const claude=(type:string,content:unknown,extra={})=>({type,timestamp:at,sessionId:'claude-session',message:{id:'message-fixture',role:type,model:'claude-fixture',content},...extra});
const text=(value:string)=>({type:'text',text:value});
const user=(value:string)=>codexMessage('user',[{type:'input_text',text:value}]);
function metadata(tool:Tool,events:unknown[],initial:LocalSessionMetadata={}){
  return events.reduce<LocalSessionMetadata>((current,event)=>updateSessionMetadata(tool,event,current),initial);
}
function deepFreeze<T>(value:T):T {
  if(value && typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}
  return value;
}

test('Codex metadata accumulates explicit title and session/project fields without mutating input',()=>{
  const current=deepFreeze({firstPrompt:'Earlier real request',title:'Old name'});
  const event=deepFreeze(codex({id:'codex-session',title:'Explicit title',cwd:'E:\\workspace\\cyg',git:{branch:'codex/parser'},cli_version:'0.160.0',source:'cli'},'session_meta'));
  const result=updateSessionMetadata('codex',event,current);
  assert.deepEqual(result,{title:'Explicit title',firstPrompt:'Earlier real request',sessionKey:'codex-session',cwd:'E:\\workspace\\cyg',project:'cyg',gitBranch:'codex/parser',version:'0.160.0',source:'cli'});
  assert.notEqual(result,current);assert.deepEqual(current,{firstPrompt:'Earlier real request',title:'Old name'});
  assert.equal(event.payload.title,'Explicit title');
});

for(const field of ['title','name','thread_name','thread_title','session_title']){
  test('Codex session_meta recognizes explicit '+field,()=>{
    const result=metadata('codex',[user('Fallback request'),codex({id:'session',[field]:' Named session '},'session_meta'),user('Later request')]);
    assert.equal(result.title,'Named session');assert.equal(result.firstPrompt,'Fallback request');
  });
}

for(const fixture of [
  {type:'custom-title',customTitle:'Custom Claude title'},
  {type:'custom-title',title:'Custom Claude title'},
  {type:'session-name',sessionName:'Custom Claude title'},
  {type:'session-name',name:'Custom Claude title'},
  {type:'session_name',session_name:'Custom Claude title'},
]){
  test('Claude '+fixture.type+' title: '+Object.keys(fixture)[1],()=>{
    const event=deepFreeze({...fixture,sessionId:'session',cwd:'/fixture/project/',gitBranch:'feature/parser',version:'2.1.0',source:'cli'});
    const result=metadata('claude',[claude('user','Fallback prompt'),event]);
    assert.deepEqual(result,{title:'Custom Claude title',firstPrompt:'Fallback prompt',sessionKey:'session',cwd:'/fixture/project/',project:'project',gitBranch:'feature/parser',version:'2.1.0',source:'cli'});
  });
}

test('firstPrompt provides title fallback and later explicit names take precedence',()=>{
  for(const tool of ['codex','claude'] as const){
    const request=tool==='codex' ? user('Fix the parser') : claude('user',[text('Fix the parser')]);
    const first=metadata(tool,[request]);assert.equal(first.title,undefined);assert.equal(first.title ?? first.firstPrompt,'Fix the parser');
    const renamed=updateSessionMetadata(tool,tool==='codex' ? codex({type:'thread_title_updated',name:'Named work'},'event_msg') : {type:'session-name',sessionName:'Named work'},first);
    assert.equal(renamed.title ?? renamed.firstPrompt,'Named work');assert.equal(renamed.firstPrompt,'Fix the parser');
    assert.equal(updateSessionMetadata(tool,{type:'unrelated',name:'Not a title'},renamed).title,'Named work');
  }
});

test('Codex skips environment, AGENTS and non-user messages before the first real request',()=>{
  const skipped=[
    codexMessage('system',[text('system secret')]),codexMessage('developer',[text('developer instructions')]),
    codexMessage('assistant',[text('assistant answer')]),
    user('<environment_context>cwd and shell only</environment_context>'),
    user('# AGENTS.md instructions for E:\\workspace\\cyg\n<INSTRUCTIONS>project rules</INSTRUCTIONS>'),
    user('# AGENTS.md instructions for /fixture\nall project rules'),
    user('<system-reminder>internal instructions</system-reminder>'),
    user('<developer_instructions>runtime rules</developer_instructions>'),
    user('<environment_context>unfinished injected context'),
    codex({type:'user_message',message:'synthetic request',is_meta:true},'event_msg'),
  ];
  assert.deepEqual(metadata('codex',skipped),{});
  const result=metadata('codex',[...skipped,user('First genuine request'),codex({type:'user_message',message:'Later duplicate'},'event_msg')]);
  assert.equal(result.firstPrompt,'First genuine request');
});

test('both Codex user message sources and coalesced injected blocks yield real prompt text',()=>{
  assert.equal(metadata('codex',[codex({type:'user_message',message:'Event source request'},'event_msg')]).firstPrompt,'Event source request');
  assert.equal(metadata('codex',[codexMessage('user',[
    text('<environment_context>environment</environment_context>'),
    {type:'input_image',image_url:'data:image/png;base64,PRIVATE'},
    text('<system-reminder>rules</system-reminder>\nReal request\nsecond line'),
  ])]).firstPrompt,'Real request second line');
  assert.equal(metadata('codex',[user('# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>rules</INSTRUCTIONS>\nPlease fix it')]).firstPrompt,'Please fix it');
  assert.equal(metadata('codex',[user('<environment_context>'+'e'.repeat(100000)+'</environment_context>\nRequest after large injection')]).firstPrompt,'Request after large injection');
  assert.equal(metadata('codex',[user('# Context from my IDE:\n## Open tabs:\nfixture.ts\n## My request for Codex:\nFix my tests')]).firstPrompt,'Fix my tests');
});

test('Claude skips synthetic/meta messages, tool results, reminders and interrupts',()=>{
  const skipped=[
    claude('assistant',[text('Answer')]),{type:'system',message:'System content'},
    claude('user','Injected meta message',{isMeta:true}),claude('user','Injected synthetic message',{isSynthetic:true}),
    claude('user','Injected compaction summary',{isCompactSummary:true}),
    claude('user',[{type:'tool_result',tool_use_id:'call',content:'Tool output'}]),
    claude('user',[text('<system-reminder>Injected reminder</system-reminder>')]),
    claude('user','[Request interrupted by user for tool use]'),
    claude('user','<local-command-stdout>Command output</local-command-stdout>'),
  ];
  assert.equal(metadata('claude',skipped).firstPrompt,undefined);
  const result=metadata('claude',[...skipped,claude('user',[text('<system-reminder>Hidden</system-reminder>\nReal Claude request'),text('with detail')]),claude('user','Later request')]);
  assert.equal(result.firstPrompt,'Real Claude request with detail');
});

test('firstPrompt is bounded to 320 Unicode characters and normalizes whitespace',()=>{
  for(const tool of ['codex','claude'] as const){
    const prompt='  '+('中😀'.repeat(200))+'\n extra';
    const result=metadata(tool,[tool==='codex' ? user(prompt) : claude('user',prompt)]);
    assert.equal(Array.from(result.firstPrompt!).length,320);assert.equal(result.firstPrompt,'中😀'.repeat(160));
    assert.ok(!result.firstPrompt!.includes('\ufffd'));
  }
  assert.equal(metadata('claude',[claude('user','  hello\n\t world  ')]).firstPrompt,'hello world');
});

test('metadata tolerates partial records, preserves explicit projects and updates derived cwd projects',()=>{
  assert.deepEqual(updateSessionMetadata('codex',null,{}),{});
  assert.deepEqual(updateSessionMetadata('claude',{type:'user',message:null,version:42},{}),{});
  const first=metadata('codex',[codex({cwd:'/fixture/one',model:'not-a-title'},'turn_context')]);
  assert.equal(first.project,'one');assert.equal(first.title,undefined);
  assert.equal(updateSessionMetadata('codex',codex({cwd:'/fixture/two'},'turn_context'),first).project,'two');
  assert.equal(updateSessionMetadata('codex',codex({cwd:'/fixture/two'},'turn_context'),{...first,project:'Explicit project'}).project,'Explicit project');
  assert.equal(metadata('codex',[codex({id:'s',source:{subagent:{thread_spawn:{depth:1}}}},'session_meta')]).source,'subagent');
  for(const cwd of ['/', 'C:\\'])assert.equal(metadata('codex',[codex({cwd},'session_meta')]).project,undefined);
  const initial={title:'Keep',firstPrompt:'Keep prompt',sessionKey:'Keep key',version:'Keep version'};
  assert.deepEqual(updateSessionMetadata('codex',codex({title:' ',id:null,cli_version:undefined},'session_meta'),initial),initial);
});

test('attachment titles and tool names cannot replace the explicit session title',()=>{
  const initial={title:'Session name',firstPrompt:'Real request'};
  for(const event of [codex({type:'input_file',title:'Document title'}),codex({type:'function_call',name:'Tool name'}),codex({type:'message',role:'user',metadata:{title:'Message title'}})]){
    assert.deepEqual(updateSessionMetadata('codex',event,initial),initial);
  }
  assert.equal(metadata('codex',[codex({id:'s',metadata:{name:'Nested explicit name'}},'session_meta')]).title,'Nested explicit name');
});

test('parser displays Codex and Claude message text, roles, timestamps and whitelisted details',()=>{
  const fixtures:[Tool,unknown,string][]=[
    ['codex',codexMessage('user',[{type:'input_text',text:'Question'}]),'user'],
    ['codex',codexMessage('assistant',[{type:'output_text',text:'Question'}]),'assistant'],
    ['codex',codexMessage('developer',[text('Question')]),'system'],
    ['claude',claude('user','Question'),'user'],
    ['claude',claude('assistant',[text('Question')]),'assistant'],
  ];
  for(const [tool,event,role] of fixtures){
    const result=parseSessionEvent(tool,deepFreeze(event),'given-id');
    assert.equal(result.id,'given-id');assert.equal(result.role,role);assert.equal(result.kind,'message');assert.equal(result.text,'Question');
    assert.equal(result.createdAt,seconds);assert.equal(result.truncated,undefined);assert.equal(result.rawBytes,undefined);
    if(tool==='claude')assert.ok(result.details.some(item=>item.label==='message.model' && item.value==='claude-fixture'));
  }
});

test('Codex duplicate message sources remain independent for backend canonical selection',()=>{
  const event=parseSessionEvent('codex',codex({type:'agent_message',message:'Shared answer'},'event_msg'),'event-id');
  const response=parseSessionEvent('codex',codexMessage('assistant',[{type:'output_text',text:'Shared answer'}]),'response-id');
  assert.equal(event.text,response.text);assert.equal(event.kind,'message');assert.equal(event.role,'assistant');
  assert.notEqual(event.id,response.id);assert.notDeepEqual(event.details,response.details);
});

test('reasoning and thinking previews retain readable summaries and omit opaque encrypted data',()=>{
  const fixtures:[Tool,unknown,string[]][]=[
    ['codex',codex({type:'reasoning',summary:[{type:'summary_text',text:'Plan summary'}],content:[{type:'reasoning_text',text:'Reasoning text'}],encrypted_content:'ENCRYPTED_PRIVATE'}),['Plan summary','Reasoning text']],
    ['codex',codex({type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'Without summary'}]}),['Without summary']],
    ['codex',codex({type:'agent_reasoning',text:'Event reasoning'},'event_msg'),['Event reasoning']],
    ['claude',claude('assistant',[{type:'thinking',thinking:'Claude thinking',signature:'SIGNED_PRIVATE'}]),['Claude thinking']],
    ['claude',claude('assistant',[{type:'redacted_thinking',data:'REDACTED_PRIVATE'}]),['已隐藏']],
  ];
  for(const [tool,event,expected] of fixtures){
    const result=parseSessionEvent(tool,event,'reason');assert.equal(result.kind,'reasoning');assert.equal(result.role,'assistant');
    for(const value of expected)assert.ok(result.text.includes(value));
    assert.ok(!JSON.stringify(result).includes('_PRIVATE'));
  }
  const mixed=parseSessionEvent('claude',claude('assistant',[{type:'thinking',thinking:'Plan'},text('Answer')]),'mixed');
  assert.equal(mixed.kind,'message');assert.ok(mixed.text.includes('[思考]'));assert.ok(mixed.text.includes('Answer'));
});

for(const fixture of [
  {tool:'codex' as const,event:codex({type:'function_call',name:'exec_command',call_id:'call',arguments:'{"cmd":"echo fixture"}'})},
  {tool:'codex' as const,event:codex({type:'custom_tool_call',name:'apply_patch',call_id:'call',input:'*** Begin Patch\nfixture\n*** End Patch'})},
  {tool:'claude' as const,event:claude('assistant',[{type:'tool_use',name:'Bash',id:'call',input:{command:'echo fixture',timeout:1000}}])},
]){
  test(fixture.tool+' '+(fixture.event as any).type+' tool call displays inert arguments and identifiers',()=>{
    const frozen=deepFreeze(fixture.event),result=parseSessionEvent(fixture.tool,frozen,'call-event');
    assert.equal(result.role,'assistant');assert.equal(result.kind,'tool_call');assert.equal(result.toolCallId,'call');
    assert.ok(result.toolName);assert.ok(result.text.includes('fixture'));assert.ok(result.text.includes(result.toolName!));
    assert.ok(result.details.some(item=>item.label==='toolCallId' && item.value==='call'));
  });
}

test('Claude mixed messages and multiple calls preserve all blocks and call identifiers',()=>{
  const result=parseSessionEvent('claude',claude('assistant',[
    text('I will inspect it'),{type:'thinking',thinking:'Plan'},
    {type:'tool_use',id:'one',name:'Read',input:{file_path:'/fixture/a.ts'}},
    {type:'tool_use',id:'two',name:'Bash',input:{command:'echo fixture'}},
  ]),'multi');
  assert.equal(result.role,'assistant');assert.equal(result.kind,'message');assert.equal(result.toolName,'Read');assert.equal(result.toolCallId,'one');
  for(const value of ['I will inspect it','Plan','Read','Bash','/fixture/a.ts'])assert.ok(result.text.includes(value));
  assert.deepEqual(result.details.filter(item=>item.label==='toolCallId').map(item=>item.value),['one','two']);
});

test('Codex function/custom results and Claude tool_result blocks have a tool role',()=>{
  const fixtures:[Tool,unknown][]=[
    ['codex',codex({type:'function_call_output',call_id:'call',output:'Result output'})],
    ['codex',codex({type:'custom_tool_call_output',call_id:'call',output:{stdout:'Result output',exit_code:0}})],
    ['claude',claude('user',[{type:'tool_result',tool_use_id:'call',content:[text('Result output'),{type:'image',source:{type:'base64',media_type:'image/png',data:'PRIVATE'}}]}])],
  ];
  for(const [tool,event] of fixtures){
    const result=parseSessionEvent(tool,event,'result');assert.equal(result.role,'tool');assert.equal(result.kind,'tool_result');
    assert.equal(result.toolCallId,'call');assert.ok(result.text.includes('Result output'));assert.ok(!result.text.includes('PRIVATE'));
  }
});

test('errors retain readable messages and failed tool call metadata',()=>{
  const fixtures:[Tool,unknown,string,string][]=[
    ['codex',codex({type:'error',error:{message:'Request failed',code:'E_FIXTURE'}},'event_msg'),'Request failed','event'],
    ['codex',codex({type:'function_call_output',call_id:'bad-call',is_error:true,output:'Permission denied'}),'Permission denied','tool'],
    ['claude',claude('user',[{type:'tool_result',tool_use_id:'bad-call',is_error:true,content:'Permission denied'}]),'Permission denied','tool'],
    ['claude',claude('assistant',[text('API unavailable')],{isApiErrorMessage:true}),'API unavailable','assistant'],
    ['claude',{type:'result',subtype:'error_during_execution',is_error:true,errors:['Session failed']},'Session failed','event'],
    ['codex',codexMessage('assistant',[{type:'error',message:'Block failed'}]),'Block failed','assistant'],
  ];
  for(const [tool,event,message,role] of fixtures){
    const result=parseSessionEvent(tool,event,'error');assert.equal(result.kind,'error');assert.equal(result.role,role);assert.ok(result.text.includes(message));
    if(role==='tool'){assert.equal(result.toolCallId,'bad-call');assert.ok(result.details.some(item=>item.label==='is_error' && item.value==='true'));}
  }
});

test('images, documents and remote media become descriptions without URL or base64 payloads',()=>{
  const fixtures:[Tool,unknown][]=[
    ['codex',codexMessage('user',[text('Look at this'),{type:'input_image',image_url:'https://fixture.invalid/PRIVATE.png',detail:'high'},{type:'input_file',filename:'fixture.pdf',file_data:'data:application/pdf;base64,PRIVATE'}])],
    ['claude',claude('user',[{type:'image',source:{type:'base64',media_type:'image/png',data:'PRIVATE'}},{type:'document',title:'fixture.pdf',source:{type:'url',url:'https://fixture.invalid/PRIVATE.pdf',media_type:'application/pdf'}}])],
    ['codex',codex({type:'user_message',message:'Look at this',images:['https://fixture.invalid/PRIVATE.png'],attachments:[{filename:'fixture.pdf',source:{url:'https://fixture.invalid/PRIVATE.pdf'}}]},'event_msg')],
  ];
  for(const [tool,event] of fixtures){
    const result=parseSessionEvent(tool,event,'attachments');assert.ok(result.text.includes('图片附件'));assert.ok(result.text.includes('fixture.pdf'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('https://'));assert.ok(!result.text.includes('!['));
  }
  const standalone=parseSessionEvent('codex',codex({type:'input_image',image_url:'https://fixture.invalid/PRIVATE.png'}),'image');
  assert.equal(standalone.kind,'attachment');assert.equal(standalone.text,'[图片附件]');
});

test('preview byte bounds are exact for ASCII and safe for Chinese/emoji text',()=>{
  const limit=32*1024;
  const exact=parseSessionEvent('codex',user('x'.repeat(limit)),'exact');
  assert.equal(Buffer.byteLength(exact.text),limit);assert.equal(exact.truncated,undefined);
  for(const value of ['x'.repeat(2*1024*1024),'中😀'.repeat(50000),'a'.repeat(limit-1)+'😀tail']){
    const fixture=user(value),result=parseSessionEvent('codex',fixture,'large');
    assert.equal(result.truncated,true);assert.ok(Buffer.byteLength(result.text)<=limit);assert.ok(value.startsWith(result.text));assert.ok(!result.text.includes('\ufffd'));
    assert.equal((fixture.payload as any).content[0].text,value);assert.equal(result.rawBytes,undefined);
  }
});

test('large structured arguments and block arrays stop traversal and remain bounded',()=>{
  const args={command:'echo fixture',huge:'x'.repeat(2*1024*1024),last:'AFTER_LIMIT'};
  const result=parseSessionEvent('claude',claude('assistant',[{type:'tool_use',id:'call',name:'Bash',input:args}]),'huge-args');
  assert.equal(result.truncated,true);assert.ok(Buffer.byteLength(result.text)<=32*1024);assert.ok(!result.text.includes('AFTER_LIMIT'));
  const many=parseSessionEvent('claude',claude('assistant',Array.from({length:10000},()=>text('block'))),'many');
  assert.equal(many.truncated,true);assert.ok(many.text.length<10000);
  const cycle:any={command:'echo fixture'};cycle.self=cycle;
  const cyclic=parseSessionEvent('codex',codex({type:'function_call',name:'fixture',arguments:cycle}),'cycle');
  assert.equal(cyclic.truncated,true);assert.ok(cyclic.text.includes('循环引用'));
});

test('unknown events expose kind, readable summary and selected metadata without serializing raw data',()=>{
  const opaque={large:'PRIVATE'.repeat(500000),toJSON(){throw new Error('Must not stringify opaque data');}};
  const event={type:'response_item',timestamp:at,payload:{type:'future_event',summary:'Readable future summary',model:'fixture-model',cwd:'/fixture/project',metadata:{status:'queued',secret:'PRIVATE'},opaque},toJSON(){throw new Error('Must not stringify the event');}};
  const result=parseSessionEvent('codex',event,'future');
  assert.equal(result.kind,'future_event');assert.equal(result.role,'event');assert.ok(result.text.includes('Readable future summary'));
  assert.ok(result.details.some(item=>item.label==='payload.model' && item.value==='fixture-model'));
  assert.ok(result.details.some(item=>item.label==='metadata.status' && item.value==='queued'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.equal(result.truncated,undefined);
  assert.equal(opaque.large.length,3500000);
});

test('system/init and token events expose useful whitelisted metadata',()=>{
  const system=parseSessionEvent('claude',{type:'system',subtype:'init',cwd:'/fixture',session_id:'s',model:'fixture-model',apiKey:'PRIVATE'},'init');
  assert.equal(system.role,'system');assert.equal(system.kind,'system');assert.ok(system.text.includes('init'));
  assert.ok(system.details.some(item=>item.label==='model' && item.value==='fixture-model'));assert.ok(!JSON.stringify(system).includes('PRIVATE'));
  const tokens=parseSessionEvent('codex',codex({type:'token_count',info:{total_token_usage:{input_tokens:120,output_tokens:10,cached_input_tokens:50},last_token_usage:{input_tokens:20},hidden:'PRIVATE'}},'event_msg'),'tokens');
  assert.equal(tokens.kind,'token_count');assert.ok(tokens.details.some(item=>item.label==='info.total_token_usage.input_tokens' && item.value==='120'));
  assert.ok(!JSON.stringify(tokens).includes('PRIVATE'));
});

test('malformed/unknown inputs and timestamps are handled deterministically',()=>{
  for(const tool of ['codex','claude'] as const){
    for(const input of [null,undefined,[],42,'raw text',{type:'response_item',payload:null},{type:42,message:{role:{},content:42}}]){
      const parsed=parseSessionEvent(tool,input,'invalid');assert.equal(parsed.id,'invalid');assert.ok(parsed.text);assert.ok(Array.isArray(parsed.details));
    }
  }
  assert.equal(parseSessionEvent('codex',{type:'future',timestamp:'invalid'},'ts').createdAt,undefined);
  assert.equal(parseSessionEvent('claude',{type:'future',timestamp:seconds},'ts').createdAt,seconds);
  assert.equal(parseSessionEvent('claude',{type:'future',timestamp:seconds*1000},'ts').createdAt,seconds);
  assert.equal(parseSessionEvent('codex',{type:'future',timestamp:Infinity},'ts').createdAt,undefined);
  assert.equal(parseSessionEvent('codex',{type:'future',timestamp:1e25},'ts').createdAt,undefined);
});

test('large metadata is bounded and unknown event kinds cannot carry a huge raw string',()=>{
  const result=parseSessionEvent('claude',{type:'x'.repeat(100000),model:'m'.repeat(100000),cwd:'c'.repeat(100000)},'metadata');
  assert.equal(result.truncated,true);assert.ok(Buffer.byteLength(result.kind)<=128);assert.ok(Buffer.byteLength(result.text)<=32*1024);
  assert.ok(result.details.every(item=>Buffer.byteLength(item.value)<=1024));
  assert.ok(result.details.reduce((bytes,item)=>bytes+Buffer.byteLength(item.value),0)<=8*1024);
});

test('XSS, HTML, URLs and shell text stay literal inert text in messages, titles and tool arguments',()=>{
  const xss='<script>globalThis.parserExecuted=true</script><img src="https://fixture.invalid/x" onerror="alert(1)">';
  const before=(globalThis as any).parserExecuted;
  for(const tool of ['codex','claude'] as const){
    const fixture=tool==='codex' ? user(xss) : claude('user',[text(xss)]);
    assert.equal(parseSessionEvent(tool,fixture,'xss').text,xss);
    assert.equal(metadata(tool,[fixture]).firstPrompt,xss);
    const name=tool==='codex' ? codex({title:xss},'session_meta') : {type:'custom-title',customTitle:xss};
    assert.equal(updateSessionMetadata(tool,name,{}).title,xss);
  }
  const command='$(dangerous-command); <script>alert(1)</script>';
  const parsed=parseSessionEvent('codex',codex({type:'custom_tool_call',name:'fixture',input:command}),'inert-call');
  assert.ok(parsed.text.includes(command));assert.equal((globalThis as any).parserExecuted,before);
});
