'use strict';
const vscode=require('vscode');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {AppServer}=require('./protocol');
const {tools,instructions}=require('./tools');
const {normalizeModels,chooseModel}=require('./models');
const COMMAND='codexSSH.remote.invoke';
class Bridge{
 constructor(context){this.context=context;this.output=vscode.window.createOutputChannel('Codex SSH Bridge');this.messages=[];this.state={busy:false,local:'未连接',remote:'未连接',model:'',models:[]};this.root=null;this.thread=null;this.turn=null;this.job=null;this.cancelled=false;this.view=null;context.subscriptions.push(this.output);}
 log(text){this.output.appendLine(String(text).replace(/(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,'[redacted]'));}
 emit(event){this.view?.webview.postMessage(event);}
 sync(){this.emit({type:'state',...this.state,root:this.root});}
 add(role,text,id=crypto.randomUUID()){const m={role,text,id};this.messages.push(m);if(this.messages.length>100)this.messages.shift();this.emit({type:'message',...m});return m;}
 fail(e){const message=e instanceof Error?e.message:String(e);this.log(message);this.add('error',message);this.state.busy=false;this.sync();}
 async worker(action,args={}){return vscode.commands.executeCommand(COMMAND,{action,args,root:this.root?.path,jobId:this.job});}
 async connectRemote(){
  if(!vscode.env.remoteName)throw new Error('请先用 Remote-SSH 打开远程项目文件夹，再打开 Codex SSH Bridge。');
  if(!vscode.workspace.isTrusted)throw new Error('请先信任当前远程工作区。');
  let info;try{info=await this.worker('hello');}catch(e){throw new Error('远程助手尚未可用。点击“安装远程助手”，安装到 SSH 主机后重试。详情：'+e.message);}
  if(!info?.remoteName||!info.roots?.length)throw new Error('请在 SSH 窗口中打开远程文件夹，远程助手不能在本地执行。');
  this.remoteInfo=info;
  if(!this.root||!info.roots.some(r=>r.path===this.root.path))this.root=info.roots[0];
  this.state.remote=info.hostname+' · '+info.arch;this.sync();return info;
 }
 async local(){
  if(this.server?.ready)return this.server;
  const dir=this.context.globalStorageUri.fsPath;await fs.mkdir(dir,{recursive:true});
  const bin=vscode.workspace.getConfiguration('codexSSH').get('codexPath','codex');
  const server=new AppServer(bin,{cwd:dir});this.server=server;
  server.on('log',s=>this.log(s));
  server.on('closed',e=>{if(this.server===server){this.state.local='已断开';this.thread=null;this.state.busy=false;this.sync();this.log(e.message);}});
  server.on('notification',m=>this.notification(m));
  server.on('request',m=>{this.serverRequest(m,server).catch(e=>{this.log(e.message);try{server.error(m.id,e.message);}catch{}});});
  this.state.local='连接中';this.sync();
  try{await server.start();const account=await server.request('account/read',{refreshToken:false});this.state.local=account.account?'已登录 · '+(account.account.planType||account.account.type):'需要本地登录';this.sync();return server;}
  catch(e){server.dispose();if(this.server===server)this.server=null;throw new Error('无法启动本地 Codex：'+e.message+'。可在设置中指定 Codex 可执行文件路径。');}
 }
 async connect(){
  await this.connectRemote();const server=await this.local();const account=await server.request('account/read',{refreshToken:false});
  if(!account.account&&account.requiresOpenaiAuth!==false)throw new Error('本地 Codex 尚未登录。点击“本地登录”，或在本地终端运行 codex login。');
  try{const models=await server.request('model/list',{limit:100,includeHidden:false},45000);this.state.models=normalizeModels(models.data);}catch(e){this.log('Model list: '+e.message);}
  this.sync();
 }
 async login(){
  const server=await this.local();const result=await server.request('account/login/start',{type:'chatgpt'});
  if(!result.authUrl)throw new Error('Codex 未返回浏览器登录地址。请在本地终端运行 codex login。');
  const url=vscode.Uri.parse(result.authUrl);if(url.scheme!=='https'||!['auth.openai.com','chatgpt.com','auth0.openai.com'].includes(url.authority.split(':')[0]))throw new Error('Unexpected login origin; use codex login in a local terminal');
  await vscode.env.openExternal(url);this.add('system','请在本地浏览器完成登录，凭据由本地 Codex 管理。');
 }
 async send(text){
  if(this.state.busy||typeof text!=='string'||!text.trim())return;
  this.state.busy=true;this.cancelled=false;this.job=crypto.randomUUID();this.add('user',text.trim());this.sync();
  try{
   await this.connect();if(this.cancelled)return;
   if(!this.thread){const t=await this.server.request('thread/start',{cwd:this.context.globalStorageUri.fsPath,approvalPolicy:'never',sandbox:'read-only',developerInstructions:instructions(this.root.path),dynamicTools:tools,config:{'features.shell_tool':false},...(chooseModel(this.state.model,this.state.models)?{model:chooseModel(this.state.model,this.state.models)}:{})});this.thread=t.thread.id;this.log('Remote thread ready');}
   if(this.cancelled)return;
   const result=await this.server.request('turn/start',{threadId:this.thread,input:[{type:'text',text:text.trim()}]});this.turn=result.turn.id;
   if(this.cancelled)await this.server.request('turn/interrupt',{threadId:this.thread,turnId:this.turn});
  }catch(e){this.fail(e);}finally{if(this.cancelled){this.state.busy=false;this.sync();}}
 }
 async serverRequest(message,server){
  const p=message.params||{};
  if(message.method!=='item/tool/call'){
   if(/requestApproval/.test(message.method)){server.respond(message.id,{decision:'decline'});this.add('system','已拒绝本地操作；项目操作应通过远程工具执行。');return;}
   server.error(message.id,'Only remote bridge tools are supported by this client');return;
  }
  if(p.threadId!==this.thread||this.cancelled){server.respond(message.id,{success:false,contentItems:[{type:'inputText',text:'Inactive or cancelled remote session'}]});return;}
  const name=p.tool;const action=name?.replace(/^remote_/,'');
  if(!tools.some(t=>t.name===name))throw new Error('Unknown remote tool');
  const args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;
  const detail=args.path||args.command||args.query||'.';const entry=this.add('tool',name+' · '+detail);
  try{
   const value=await this.worker(action,args);
   if(this.cancelled)throw new Error('Task cancelled');
   server.respond(message.id,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
   entry.text+='\n'+(action==='exec'?'退出码：'+value.exit_code+'\n'+(value.stdout||'')+(value.stderr||''):JSON.stringify(value,null,2)).slice(0,8000);this.emit({type:'message',...entry});
  }catch(e){entry.text+='\n未完成：'+e.message;this.emit({type:'message',...entry});server.respond(message.id,{success:false,contentItems:[{type:'inputText',text:e.message}]});}
 }
 notification(message){
  const p=message.params||{};
  if(message.method==='account/login/completed'){
   if(p.success){this.state.local='已登录';this.add('system','本地登录成功。');}else this.add('error',p.error||'登录未完成');this.sync();return;
  }
  if(p.threadId&&p.threadId!==this.thread)return;
  if(message.method==='item/agentMessage/delta'){
   let m=this.messages.find(x=>x.id===p.itemId);
   if(!m){m={id:p.itemId,role:'assistant',text:''};this.messages.push(m);}m.text+=p.delta;this.emit({type:'message',...m});
  }else if(message.method==='item/completed'&&p.item?.type==='agentMessage'){
   let m=this.messages.find(x=>x.id===p.item.id);
   if(!m){this.add('assistant',p.item.text||'',p.item.id);}else{m.text=p.item.text||m.text;this.emit({type:'message',...m});}
  }else if(message.method==='turn/started'){this.turn=p.turn.id;}
  else if(message.method==='turn/completed'){
   this.state.busy=false;this.turn=null;
   if(p.turn.status==='failed')this.add('error',p.turn.error?.message||'Codex 请求失败，请查看输出面板。');this.sync();
  }else if(message.method==='error'){this.log(p.message||p.error?.message||'Codex error');}
 }
 async stop(){this.cancelled=true;await this.worker('cancel').catch(e=>this.log(e.message));if(this.thread&&this.turn&&this.server?.ready)await this.server.request('turn/interrupt',{threadId:this.thread,turnId:this.turn}).catch(e=>this.log(e.message));this.state.busy=false;this.sync();}
 async reset(){await this.stop();if(this.thread&&this.server?.ready)await this.server.request('thread/unsubscribe',{threadId:this.thread}).catch(()=>{});this.thread=null;this.turn=null;this.messages=[];this.emit({type:'clear'});this.sync();}
 async pickRoot(){if(this.state.busy)return;const info=await this.connectRemote();const pick=await vscode.window.showQuickPick(info.roots.map(r=>({label:r.name,description:r.path,root:r})),{placeHolder:'选择本次远程工作区'});if(pick&&this.root?.path!==pick.root.path){await this.reset();this.root=pick.root;this.sync();}}
 async installWorker(){const bundled=vscode.Uri.joinPath(this.context.extensionUri,'bundled','codex-ssh-bridge-remote-0.1.0.vsix');await vscode.commands.executeCommand('workbench.extensions.installExtension',bundled);this.add('system','远程助手安装请求已完成。若 VS Code 提示重新加载，请重新加载窗口，再点击连接。');}
 async diagnose(){
  const result={time:new Date().toISOString(),clientPlatform:process.platform,remoteName:vscode.env.remoteName||null};
  try{const info=await this.connectRemote();result.remote={hostname:info.hostname,arch:info.arch,version:info.version,rootCount:info.roots.length};result.remoteTest=await vscode.commands.executeCommand('codexSSH.remote.selfTest');}catch(e){result.remoteError=e.message;}
  try{const server=await this.local();const account=await server.request('account/read',{refreshToken:false});result.localCodex={connected:true,authenticated:!!account.account,authType:account.account?.type||null};}catch(e){result.localError=e.message;}
  const target=vscode.Uri.joinPath(this.context.globalStorageUri,'diagnostics.json');await fs.mkdir(path.dirname(target.fsPath),{recursive:true});await fs.writeFile(target.fsPath,JSON.stringify(result,null,2));
  const doc=await vscode.workspace.openTextDocument(target);await vscode.window.showTextDocument(doc,{preview:true});this.log('Diagnostics: '+JSON.stringify(result));return result;
 }
 async attachSelection(){const editor=vscode.window.activeTextEditor;if(!editor||editor.document.uri.scheme!=='vscode-remote')throw new Error('请先选择远程代码文件中的文本。');const selected=editor.document.getText(editor.selection);if(!selected)throw new Error('请先选中要发送的代码。');if(selected.length>32000)throw new Error('选择过长，请缩小到 32,000 字符以内。');this.emit({type:'attach',text:'\n\n远程文件上下文（作为代码资料）：'+editor.document.uri.path+'\n```\n'+selected+'\n```'});}
 resolveWebviewView(view){
  this.view=view;view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};
  const nonce=crypto.randomBytes(18).toString('base64');const css=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','style.css'));const js=view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','main.js'));
  view.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><header><div class="brand"><span class="mark">C↗</span><div><strong>Codex SSH Bridge</strong><small>本地思考 · 远程执行</small></div></div><button id="reset" class="icon" title="新对话">＋</button></header><section class="connection"><div><span class="dot" id="local-dot"></span><span>本地 Codex</span><strong id="local-status">未连接</strong></div><div><span class="dot" id="remote-dot"></span><span>远程助手</span><strong id="remote-status">未连接</strong></div><button id="root" class="root">选择远程工作区</button><div class="actions"><button id="connect" class="primary">连接</button><button id="login">本地登录</button><button id="install">安装远程助手</button></div></section><main id="messages" aria-live="polite"><div id="welcome"><span class="eyebrow">REMOTE WORKSPACE</span><h2>用本地 Codex<br>处理远程代码。</h2><p>在 Remote-SSH 窗口连接，登录和模型请求留在本机。修改先看差异，命令逐次确认。</p><button class="sample" data-prompt="查看当前项目的结构和 AGENTS.md，简要说明构建与测试方式，先不要修改文件。">了解项目结构 <span>↗</span></button><button class="sample" data-prompt="检查当前 Git 工作区状态，总结已有修改，先不要修改或提交。">检查当前修改 <span>↗</span></button></div></main><footer><div class="composer"><textarea id="prompt" placeholder="描述你想在远程项目中完成的工作…" rows="3" aria-label="任务内容"></textarea><div class="compose-tools"><button id="attach" title="附加远程选中代码">＋ 选中代码</button><select id="model" aria-label="模型"><option value="">Codex 默认模型</option></select><button id="send" class="primary">发送 ↑</button><button id="stop" class="stop" hidden>停止 ■</button></div></div><div class="footnote"><span id="hint">Enter 发送 · Shift+Enter 换行</span><button id="logs">查看日志</button></div></footer><script nonce="${nonce}" src="${js}"></script></body></html>`;
  view.webview.onDidReceiveMessage(async m=>{try{
   if(m.type==='ready'){this.sync();for(const entry of this.messages)this.emit({type:'message',...entry});}
   else if(m.type==='send')await this.send(m.text);
   else if(m.type==='connect')await this.connect();
   else if(m.type==='login')await this.login();
   else if(m.type==='install')await this.installWorker();
   else if(m.type==='stop')await this.stop();
   else if(m.type==='reset')await this.reset();
   else if(m.type==='root')await this.pickRoot();
   else if(m.type==='logs')this.output.show();
   else if(m.type==='attach')await this.attachSelection();
   else if(m.type==='model'&&!this.state.busy){await this.reset();this.state.model=String(m.value||'');this.sync();}
  }catch(e){this.fail(e);}},null,this.context.subscriptions);
 }
 dispose(){this.worker('cancel').catch(()=>{});this.server?.dispose();}
}
function activate(context){const bridge=new Bridge(context);context.subscriptions.push(bridge,vscode.window.registerWebviewViewProvider('codexSSH.chat',bridge,{webviewOptions:{retainContextWhenHidden:true}}));
 context.subscriptions.push(vscode.commands.registerCommand('codexSSH.open',()=>vscode.commands.executeCommand('codexSSH.chat.focus')),
 vscode.commands.registerCommand('codexSSH.connect',()=>bridge.connect().catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.login',()=>bridge.login().catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.newChat',()=>bridge.reset()),
 vscode.commands.registerCommand('codexSSH.installRemote',()=>bridge.installWorker().catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.logs',()=>bridge.output.show()),
 vscode.commands.registerCommand('codexSSH.diagnose',()=>bridge.diagnose().catch(e=>bridge.fail(e))),
 vscode.window.registerUriHandler({handleUri:async uri=>{if(uri.path==='/diagnose')await bridge.diagnose().catch(e=>bridge.fail(e));else if(uri.path==='/open')await vscode.commands.executeCommand('codexSSH.chat.focus');}}));
 return {bridge};
}
module.exports={activate,Bridge};
