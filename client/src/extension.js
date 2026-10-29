'use strict';
const vscode=require('vscode');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {AppServer}=require('./protocol');
const {tools,instructions}=require('./tools');
const {normalizeModels,chooseModel,modelInfo,chooseEffort}=require('./models');
const {composerMarkup}=require('./composer');
const {Projects,identity,scopeIdentity}=require('./projects');
const {shellMarkup}=require('./shell');
const COMMAND='codexSSH.remote.invoke';
class Bridge{
 constructor(context){this.context=context;this.projects=new Projects();this.project=null;this.threadLoaded=false;this.saving=Promise.resolve();this.output=vscode.window.createOutputChannel('Codex SSH Bridge');this.messages=[];this.state={busy:false,local:'未连接',remote:'未连接',model:'',effort:'',permission:'ask',models:[]};this.root=null;this.thread=null;this.turn=null;this.job=null;this.cancelled=false;this.view=null;context.subscriptions.push(this.output);}
 log(text){this.output.appendLine(String(text).replace(/(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,'[redacted]'));}
 emit(event){this.view?.webview.postMessage(event);}
 sync(){this.emit({type:'state',...this.state,busy:this.state.busy||!!this.changing,running:this.state.busy,root:this.root,project:this.project?{name:this.project.displayName||path.posix.basename(this.project.remotePath),cwd:this.project.cwd,key:this.project.key,unassigned:!!this.project.unassigned}:null});}
 add(role,text,id=crypto.randomUUID()){const m={role,text,id};this.messages.push(m);if(this.messages.length>100)this.messages.shift();this.emit({type:'message',...m});this.saveSoon();return m;}
 fail(e){const message=e instanceof Error?e.message:String(e);this.log(message);this.add('error',message);this.state.busy=false;this.sync();}
 async idle(action){if(this.state.busy||this.changing)return;this.changing=true;this.sync();try{return await action();}finally{this.changing=false;this.sync();}}
 async worker(action,args={}){
  if(this.state.permission==='read-only'&&['edit','create','exec'].includes(action))throw new Error('当前对话为只读权限，不能修改文件或执行命令。');
  if(this.state.permission==='full'&&['edit','create','exec'].includes(action)&&!this.remoteInfo?.permissionModes?.includes('full'))throw new Error('请先更新远程助手，再使用完全访问权限。');
  return vscode.commands.executeCommand(COMMAND,{action,args,root:this.root?.path,jobId:this.job,permission:this.state.permission});
 }
 async connectRemote(){
  if(!vscode.env.remoteName)throw new Error('请先用 Remote-SSH 打开远程项目文件夹，再打开 Codex SSH Bridge。');
  if(!vscode.workspace.isTrusted)throw new Error('请先信任当前远程工作区。');
  let info;try{info=await this.worker('hello');}catch(e){throw new Error('远程助手尚未可用。点击“安装远程助手”，安装到 SSH 主机后重试。详情：'+e.message);}
  if(!info?.remoteName||!info.roots?.length)throw new Error('请在 SSH 窗口中打开远程文件夹，远程助手不能在本地执行。');
  this.remoteInfo=info;
  info.roots=info.roots.map(root=>{const folder=vscode.workspace.workspaceFolders?.find(f=>f.uri.scheme==='vscode-remote'&&f.uri.path===root.path);return {...root,uri:folder?.uri.toString()||root.uri};});
  if(!this.root||!info.roots.some(r=>r.path===this.root.path))this.root=info.roots[0];
  else this.root=info.roots.find(r=>r.path===this.root.path);
  this.state.remote=info.hostname+' · '+info.arch;this.sync();return info;
 }
 async local(){
  if(this.server?.ready)return this.server;
  const dir=this.context.globalStorageUri.fsPath;await fs.mkdir(dir,{recursive:true});
  const bin=vscode.workspace.getConfiguration('codexSSH').get('codexPath','codex');
  const server=new AppServer(bin,{cwd:dir});this.server=server;
  server.on('log',s=>this.log(s));
  server.on('closed',e=>{if(this.server===server){this.state.local='已断开';this.threadLoaded=false;this.state.busy=false;this.sync();this.log(e.message);}});
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
  await this.prepareProject(server);this.sync();
 }
 async login(){
  const server=await this.local();const result=await server.request('account/login/start',{type:'chatgpt'});
  if(!result.authUrl)throw new Error('Codex 未返回浏览器登录地址。请在本地终端运行 codex login。');
  const url=vscode.Uri.parse(result.authUrl);if(url.scheme!=='https'||!['auth.openai.com','chatgpt.com','auth0.openai.com'].includes(url.authority.split(':')[0]))throw new Error('Unexpected login origin; use codex login in a local terminal');
  await vscode.env.openExternal(url);this.add('system','请在本地浏览器完成登录，凭据由本地 Codex 管理。');
 }
 async send(text){
  if(this.state.busy||this.changing||typeof text!=='string'||!text.trim())return;
  this.state.busy=true;this.cancelled=false;this.job=crypto.randomUUID();this.sync();
  try{
   await this.connect();if(this.cancelled)return;
   await this.ensureThread();
   this.add('user',text.trim());await this.save();
   if(this.cancelled)return;
   const result=await this.server.request('turn/start',{threadId:this.thread,input:[{type:'text',text:text.trim()}],model:chooseModel(this.state.model,this.state.models),effort:chooseEffort(this.state.effort,modelInfo(this.state.model,this.state.models))});this.turn=result.turn.id;this.emit({type:'sent',text:text.trim()});
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
   const operationId=crypto.randomUUID();
   await this.projects.record(this.project,{operationId,phase:'started',threadId:this.thread,tool:name,args});
   let value;
   try{value=await this.worker(action,args);}catch(e){await this.projects.record(this.project,{operationId,phase:'failed',threadId:this.thread,tool:name,error:e.message}).catch(error=>this.log('保存操作记录失败：'+error.message));throw e;}
   await this.projects.record(this.project,{operationId,phase:'completed',threadId:this.thread,tool:name,result:value}).catch(error=>this.add('error','远程操作已完成，但保存记录失败：'+error.message));
   if(this.cancelled)throw new Error('Task cancelled');
   server.respond(message.id,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
   entry.text+='\n'+(action==='exec'?'退出码：'+value.exit_code+'\n'+(value.stdout||'')+(value.stderr||''):JSON.stringify(value,null,2)).slice(0,8000);this.emit({type:'message',...entry});this.saveSoon();
  }catch(e){entry.text+='\n未完成：'+e.message;this.emit({type:'message',...entry});this.saveSoon();server.respond(message.id,{success:false,contentItems:[{type:'inputText',text:e.message}]});}
 }
 notification(message){
  const p=message.params||{};
  if(message.method==='account/login/completed'){
   if(p.success){this.state.local='已登录';this.add('system','本地登录成功。');}else this.add('error',p.error||'登录未完成');this.sync();return;
  }
  if(p.threadId&&p.threadId!==this.thread)return;
  if(message.method==='item/agentMessage/delta'){
   let m=this.messages.find(x=>x.id===p.itemId);
   if(!m){m={id:p.itemId,role:'assistant',text:''};this.messages.push(m);}m.text+=p.delta;this.emit({type:'message',...m});this.saveSoon();
  }else if(message.method==='item/completed'&&p.item?.type==='agentMessage'){
   let m=this.messages.find(x=>x.id===p.item.id);
   if(!m){this.add('assistant',p.item.text||'',p.item.id);}else{m.text=p.item.text||m.text;this.emit({type:'message',...m});this.saveSoon();}
  }else if(message.method==='turn/started'){this.turn=p.turn.id;}
  else if(message.method==='turn/completed'){
   this.state.busy=false;this.turn=null;this.save().catch(e=>this.log(e.message));
   if(p.turn.status==='failed')this.add('error',p.turn.error?.message||'Codex 请求失败，请查看输出面板。');this.sync();
  }else if(message.method==='error'){this.log(p.message||p.error?.message||'Codex error');}
 }
 async stop(){this.cancelled=true;await this.worker('cancel').catch(e=>this.log(e.message));if(this.thread&&this.turn&&this.server?.ready)await this.server.request('turn/interrupt',{threadId:this.thread,turnId:this.turn}).catch(e=>this.log(e.message));this.state.busy=false;this.sync();}
 saveSoon(){if(!this.project||this.saveTimer)return;this.saveTimer=setTimeout(()=>{this.saveTimer=null;this.save().catch(e=>this.log('保存对话失败：'+e.message));},200);}
 save(){
  clearTimeout(this.saveTimer);this.saveTimer=null;
  if(!this.project)return Promise.resolve();
  this.saving=this.projects.save(this.project,{threadId:this.thread,model:this.state.model,effort:this.state.effort,permission:this.state.permission,root:this.root,messages:this.messages.slice(-100)});return this.saving;
 }
 restore(snapshot){
  this.thread=snapshot?.threadId||null;this.threadLoaded=false;this.turn=null;
  this.state.model=snapshot?.model||'';this.state.effort=snapshot?.effort||'';this.state.permission=['read-only','ask','full'].includes(snapshot?.permission)?snapshot.permission:'ask';this.messages=(snapshot?.messages||[]).slice(-100);
  this.emit({type:'clear'});for(const entry of this.messages)this.emit({type:'message',...entry});this.sync();
 }
 async prepareProject(server){
  const records=await this.projects.catalog(identity(this.root).authority);
  const match=records.find(p=>!p.unassigned&&p.remotePath===identity(this.root).remotePath);
  const intent=await this.projects.takeHandoff(identity(this.root).authority,this.root.path);
  if(intent)await this.context.workspaceState?.update('codexSSH.projectMode',intent.unassigned?'none':'auto');
  const unassigned=intent?intent.unassigned:this.context.workspaceState?.get('codexSSH.projectMode')==='none'||!match;
  const key=scopeIdentity(this.root,unassigned).key;
  if(intent&&intent.key!==key)throw new Error('远程项目跳转信息不匹配，请重新选择项目。');
  if(this.project?.key!==key||this.project?.remotePath!==this.root.path||intent){
   await this.save();
   if(this.threadLoaded&&this.thread)await server.request('thread/unsubscribe',{threadId:this.thread});
   const project=await this.projects.open(this.root,{unassigned});
   let snapshot=await this.projects.load(project,intent?.threadId);
   if(snapshot?.root&&snapshot.root.path!==this.root.path)snapshot=null;
   if(intent?.threadId){
    const result=await server.request('thread/read',{threadId:intent.threadId});
    if(!project.projectId||result.thread.projectId!==project.projectId)throw new Error('跳转的对话不属于选定项目。');
    snapshot={...snapshot,threadId:intent.threadId,root:this.root,messages:await this.projects.readMessages(server,intent.threadId)};
   }
   this.project=project;this.restore(snapshot);
  }
  {
   try{await this.projects.register(server,this.project);}catch(e){throw new Error('无法保存到本地 Codex 项目。请使用支持项目接口的 Codex CLI。详情：'+e.message);}
  }
 }
 threadOptions(){const model=chooseModel(this.state.model,this.state.models);return {cwd:this.project.cwd,approvalPolicy:'never',sandbox:'read-only',developerInstructions:instructions(this.root.path,this.state.permission),config:{'features.shell_tool':false},...(model?{model}:{})};}
 async ensureThread(){
  if(this.threadLoaded)return;
  if(this.thread){
   const result=await this.server.request('thread/read',{threadId:this.thread});
   if(result.thread.projectId!==this.project.projectId)throw new Error('保存的对话不属于当前 SSH 项目，请选择正确的历史对话或新建对话。');
   await this.server.request('thread/resume',{threadId:this.thread,excludeTurns:true,...this.threadOptions()});
  }else{
   const result=await this.server.request('thread/start',{...this.threadOptions(),projectId:this.project.projectId,dynamicTools:tools,ephemeral:false});
   this.thread=result.thread.id;
  }
  this.threadLoaded=true;await this.save();this.log('SSH project thread ready: '+this.project.name);
 }
 async changeSettings(update){
  await this.connect();
  const next={model:this.state.model,effort:this.state.effort,permission:this.state.permission};
  if(Object.hasOwn(update,'model')){
   if(typeof update.model!=='string')throw new Error('Invalid model selection');
   chooseModel(update.model,this.state.models);next.model=update.model;
   if(!modelInfo(next.model,this.state.models)?.efforts.some(e=>e.id===next.effort))next.effort='';
  }
  if(Object.hasOwn(update,'effort')){if(typeof update.effort!=='string')throw new Error('Invalid reasoning selection');chooseEffort(update.effort,modelInfo(next.model,this.state.models));next.effort=update.effort;}
  if(Object.hasOwn(update,'permission')){
   if(!['read-only','ask','full'].includes(update.permission))throw new Error('Invalid permission selection');
   if(update.permission==='full'&&this.state.permission!=='full'){
    if(!this.remoteInfo?.permissionModes?.includes('full'))throw new Error('请先更新远程助手，再选择完全访问权限。');
    const answer=await vscode.window.showWarningMessage('允许当前远程对话完全访问？',{modal:true,detail:'项目：'+this.root.path+'\n\n此对话可自动修改远程工作区文件并执行远程命令，不再逐次询问。命令以远程登录用户身份执行，可访问该用户的其他文件。其他对话的权限不受影响。'},'允许本对话');
    if(answer!=='允许本对话'){this.sync();return;}
   }
   next.permission=update.permission;
  }
  const previous={model:this.state.model,effort:this.state.effort,permission:this.state.permission};
  Object.assign(this.state,next);
  try{await this.save();}catch(e){Object.assign(this.state,previous);throw e;}
  if(previous.permission!==next.permission)this.threadLoaded=false;
  this.sync();
 }
 async reset(){await this.stop();await this.save();if(this.threadLoaded&&this.thread&&this.server?.ready)await this.server.request('thread/unsubscribe',{threadId:this.thread}).catch(()=>{});this.restore(null);await this.save();this.emit({type:'screen',screen:'chat'});}
 async history(){
  await this.connect();await this.save();
  const threads=await this.projects.remoteHistory(this.server,this.project.authority);
  this.emit({type:'history',threads});
 }
 async historyTarget(projectKey,threadId){
  if(typeof projectKey!=='string'||typeof threadId!=='string')throw new Error('无效的历史对话。');
  await this.connect();
  const project=(await this.projects.catalog(this.project.authority)).find(p=>p.key===projectKey);
  if(!project?.projectId)throw new Error('找不到当前远程的项目。');
  const result=await this.server.request('thread/read',{threadId});
  if(result.thread.projectId!==project.projectId)throw new Error('历史对话不属于当前远程项目。');
  return project;
 }
 async openHistory(projectKey,threadId){
  const project=await this.historyTarget(projectKey,threadId);
  const snapshot=await this.projects.load(project,threadId);
  const root=snapshot?.root||{path:project.remotePath,uri:vscode.Uri.from({scheme:'vscode-remote',authority:project.authority,path:project.remotePath}).toString()};
  if(identity(root).authority!==this.project.authority)throw new Error('历史对话的远程主机不匹配。');
  const messages=await this.projects.readMessages(this.server,threadId);
  await this.save();
  if(root.path!==this.root.path){
   // Hand the selected thread to its matching SSH window without replacing this chat.
   await this.navigateProject(project,root,threadId);return;
  }
  await this.save();
  if(this.threadLoaded&&this.thread)await this.server.request('thread/unsubscribe',{threadId:this.thread});
  await this.context.workspaceState?.update('codexSSH.projectMode',project.unassigned?'none':'auto');
  this.project=project;this.restore({...snapshot,threadId,messages});await this.save();
  this.emit({type:'screen',screen:'chat'});
 }
 async openHistoryInCodex(projectKey,threadId){
  await this.historyTarget(projectKey,threadId);
  if(!await vscode.env.openExternal(vscode.Uri.parse('codex://threads/'+encodeURIComponent(threadId))))throw new Error('无法打开本地 Codex。');
 }
 async deleteHistory(projectKey,threadId){
  const project=await this.historyTarget(projectKey,threadId);
  await this.save();
  if(this.thread===threadId&&this.threadLoaded)await this.server.request('thread/unsubscribe',{threadId});
  await this.projects.remove(this.server,project,threadId);
  if(this.thread===threadId){this.restore(null);await this.save();}
  await this.history();
 }
 async projectChoices(){
  const root=this.root||vscode.workspace.workspaceFolders?.find(f=>f.uri.scheme==='vscode-remote')?.uri;
  if(!root)throw new Error('请先打开 SSH 远程文件夹。');
  const info=root.uri?root:{path:root.path,uri:root.toString()};
  const projects=(await this.projects.catalog(identity(info).authority)).filter(p=>!p.unassigned);
  this.emit({type:'projects',projects:projects.map(p=>({key:p.key,name:p.displayName,path:p.remotePath})),selected:this.project?.unassigned?null:this.project?.key||null});
 }
 async selectProject(key){
  await this.connect();
  if(key===null){
   await this.context.workspaceState?.update('codexSSH.projectMode','none');await this.prepareProject(this.server);this.sync();return;
  }
  const project=(await this.projects.catalog(this.project.authority)).find(p=>p.key===key&&!p.unassigned);
  if(!project)throw new Error('项目不存在，请先创建项目。');
  if(project.remotePath!==this.root.path){await this.save();await this.navigateProject(project);return;}
  await this.context.workspaceState?.update('codexSSH.projectMode','auto');await this.prepareProject(this.server);this.sync();
 }
 async navigateProject(project,root,threadId){
  const remotePath=root?.path||project.remotePath;
  const uri=vscode.Uri.from({scheme:'vscode-remote',authority:project.authority,path:remotePath});
  const stat=await vscode.workspace.fs.stat(uri);
  if(!(stat.type&vscode.FileType.Directory))throw new Error('远程项目目录不存在或不是文件夹：'+remotePath);
  await this.projects.handoff(project,{path:remotePath,uri:uri.toString()},threadId);
  await vscode.commands.executeCommand('vscode.openFolder',uri,{forceNewWindow:true});
 }
 async createProject(openOnly=false){
  await this.connect();
  const remotePath=await vscode.window.showInputBox({title:openOnly?'打开远程目录':'创建项目',prompt:'远程项目的绝对目录（不会新建或移动代码文件）',value:this.root.path,validateInput:value=>path.posix.isAbsolute(value.trim())?null:'请输入以 / 开头的远程绝对目录'});
  if(remotePath===undefined)return;
  const normalized=path.posix.normalize(remotePath.trim());
  const uri=vscode.Uri.from({scheme:'vscode-remote',authority:this.project.authority,path:normalized});
  const stat=await vscode.workspace.fs.stat(uri);
  if(!(stat.type&vscode.FileType.Directory))throw new Error('远程项目目录不是文件夹。');
  if(openOnly){await this.save();await vscode.commands.executeCommand('vscode.openFolder',uri,{forceNewWindow:true});return;}
  const name=await vscode.window.showInputBox({title:'项目名称',prompt:'可自定义名称；留空使用目录名',value:path.posix.basename(normalized)||'/'});
  if(name===undefined)return;
  const project=await this.projects.open({path:normalized,uri:uri.toString()},{name:name.trim()||path.posix.basename(normalized)||'/'});
  await this.projects.register(this.server,project);await this.selectProject(project.key);
 }

 async openProject(){if(this.state.busy)return;await this.connect();const link='codex://new?path='+encodeURIComponent(this.project.cwd);if(!await vscode.env.openExternal(vscode.Uri.parse(link)))throw new Error('无法打开本地 Codex，请确认桌面应用已安装。');}

 async pickRoot(){if(this.state.busy)return;const info=await this.connectRemote();const pick=await vscode.window.showQuickPick(info.roots.map(r=>({label:r.name,description:r.path,root:r})),{placeHolder:'选择本次远程工作区'});if(pick&&this.root?.path!==pick.root.path){await this.stop();await this.save();if(this.threadLoaded&&this.thread&&this.server?.ready)await this.server.request('thread/unsubscribe',{threadId:this.thread});this.threadLoaded=false;this.root=pick.root;if(this.server?.ready)await this.prepareProject(this.server);this.sync();}}
 async installWorker(){const bundled=vscode.Uri.joinPath(this.context.extensionUri,'bundled',`codex-ssh-bridge-remote-${this.context.extension.packageJSON.version}.vsix`);await vscode.commands.executeCommand('workbench.extensions.installExtension',bundled);this.add('system','远程助手安装请求已完成。若 VS Code 提示重新加载，请重新加载窗口，再点击连接。');}
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
  view.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body>${shellMarkup()}<main id="messages" aria-live="polite"><div id="welcome"><span class="eyebrow">REMOTE WORKSPACE</span><h2>用本地 Codex<br>处理远程代码。</h2><p>在 Remote-SSH 窗口连接，登录和模型请求留在本机。修改先看差异，命令逐次确认。</p><button class="sample" data-prompt="查看当前项目的结构和 AGENTS.md，简要说明构建与测试方式，先不要修改文件。">了解项目结构 <span>↗</span></button><button class="sample" data-prompt="检查当前 Git 工作区状态，总结已有修改，先不要修改或提交。">检查当前修改 <span>↗</span></button></div></main>${composerMarkup()}<script nonce="${nonce}" src="${js}"></script></body></html>`;
  view.webview.onDidReceiveMessage(async m=>{try{
   if(m.type==='ready'){this.sync();for(const entry of this.messages)this.emit({type:'message',...entry});if(!this.project&&!this.state.busy&&!this.changing&&vscode.env.remoteName)await this.idle(()=>this.connect());}
   else if(m.type==='send')await this.send(m.text);
   else if(m.type==='connect')await this.idle(()=>this.connect());
   else if(m.type==='login')await this.idle(()=>this.login());
   else if(m.type==='install')await this.idle(()=>this.installWorker());
   else if(m.type==='stop')await this.stop();
   else if(m.type==='reset')await this.idle(()=>this.reset());
   else if(m.type==='root')await this.idle(()=>this.projectChoices());
   else if(m.type==='selectProject')await this.idle(()=>this.selectProject(m.key));
   else if(m.type==='createProject')await this.idle(()=>this.createProject());
   else if(m.type==='openDirectory')await this.idle(()=>this.createProject(true));
   else if(m.type==='openHistory')await this.idle(()=>this.openHistory(m.projectKey,m.threadId));
   else if(m.type==='historyCodex')await this.idle(()=>this.openHistoryInCodex(m.projectKey,m.threadId));
   else if(m.type==='deleteHistory')await this.idle(()=>this.deleteHistory(m.projectKey,m.threadId));
   else if(m.type==='history')await this.idle(()=>this.history());
   else if(m.type==='project')await this.idle(()=>this.openProject());
   else if(m.type==='logs')this.output.show();
   else if(m.type==='attach')await this.attachSelection();
   else if(m.type==='settings')await this.idle(()=>this.changeSettings(m));
  }catch(e){this.fail(e);this.emit({type:'uiError',message:e.message});}},null,this.context.subscriptions);
 }
 dispose(){if(!this.disposing)this.disposing=(async()=>{await this.save().catch(e=>this.log(e.message));await this.worker('cancel').catch(()=>{});this.server?.dispose();})();return this.disposing;}
}
let activeBridge;
function activate(context){const bridge=new Bridge(context);activeBridge=bridge;context.subscriptions.push(bridge,vscode.window.registerWebviewViewProvider('codexSSH.chat',bridge,{webviewOptions:{retainContextWhenHidden:true}}));
 context.subscriptions.push(vscode.commands.registerCommand('codexSSH.open',()=>vscode.commands.executeCommand('codexSSH.chat.focus')),
 vscode.commands.registerCommand('codexSSH.connect',()=>bridge.idle(()=>bridge.connect()).catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.login',()=>bridge.idle(()=>bridge.login()).catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.newChat',()=>bridge.idle(()=>bridge.reset()).catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.history',()=>bridge.idle(()=>bridge.history()).catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.openProject',()=>bridge.idle(()=>bridge.openProject()).catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.installRemote',()=>bridge.idle(()=>bridge.installWorker()).catch(e=>bridge.fail(e))),
 vscode.commands.registerCommand('codexSSH.logs',()=>bridge.output.show()),
 vscode.commands.registerCommand('codexSSH.diagnose',()=>bridge.idle(()=>bridge.diagnose()).catch(e=>bridge.fail(e))),
 vscode.window.registerUriHandler({handleUri:async uri=>{if(uri.path==='/diagnose')await bridge.idle(()=>bridge.diagnose()).catch(e=>bridge.fail(e));else if(uri.path==='/open')await vscode.commands.executeCommand('codexSSH.chat.focus');}}));
 return {bridge};
}
module.exports={activate,deactivate:()=>activeBridge?.dispose(),Bridge};
