'use strict';
const vscode=require('vscode');
const os=require('node:os');
const crypto=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs/promises');
const core=require('./core');
const active=new Map();const cancelled=new Set();const previews=new Map();
async function hasDirtyEditor(target){
 for(const doc of vscode.workspace.textDocuments){
  if(!doc.isDirty||!['file','vscode-remote'].includes(doc.uri.scheme))continue;
  try{if(await fs.realpath(doc.uri.fsPath)===target)return true;}catch{if(path.resolve(doc.uri.fsPath)===target)return true;}
 }
 return false;
}
function activate(context){
 context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('codex-bridge-preview',{provideTextDocumentContent:uri=>previews.get(uri.toString())||''}));
 context.subscriptions.push(vscode.commands.registerCommand('codexSSH.remote.invoke',async request=>{
  if(!vscode.env.remoteName)throw new Error('Remote helper must run in an SSH remote workspace');
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before using the remote helper');
  if(!request||typeof request!=='object')throw new Error('Invalid request');
  if(request.action==='hello')return {hostname:os.hostname(),arch:os.arch(),platform:os.platform(),remoteName:vscode.env.remoteName,version:context.extension.packageJSON.version,permissionModes:['read-only','ask','full'],roots:(vscode.workspace.workspaceFolders||[]).filter(f=>['file','vscode-remote'].includes(f.uri.scheme)).map(f=>({name:f.name,path:f.uri.fsPath,uri:f.uri.toString()}))};
  if(request.action==='cancel'){cancelled.add(request.jobId);for(const [id,p]of active)if(p.jobId===request.jobId){p.controller.abort();active.delete(id);}return {cancelled:true};}
  const root=(vscode.workspace.workspaceFolders||[]).find(f=>['file','vscode-remote'].includes(f.uri.scheme)&&f.uri.fsPath===request.root);
  if(!root)throw new Error('Selected root is not an open remote workspace folder');
  const permission=request.permission??'ask';
  if(!['read-only','ask','full'].includes(permission))throw new Error('Invalid remote permission mode');
  const args=request.args||{};const job=request.jobId;
  const check=()=>{if(cancelled.has(job))throw new Error('Operation was cancelled');};check();
  if(['read','list','search'].includes(request.action))return core[request.action](root.uri.fsPath,args);
  if(!['edit','create','exec'].includes(request.action))throw new Error('Unsupported action');
  if(permission==='read-only')throw new Error('当前对话为只读权限，不能修改文件或执行命令。');
  if(request.action!=='exec'){
   const target=await core.safePath(root.uri.fsPath,args.path,request.action==='create');
   if(await hasDirtyEditor(target))throw new Error('File has unsaved editor changes; save or resolve them first');
   let before='',after='';
   if(request.action==='edit'){const edit=await core.prepareEdit(root.uri.fsPath,args);before=edit.before;after=edit.after;}
   else {try{await fs.lstat(target);throw new Error('File already exists');}catch(e){if(e.code!=='ENOENT')throw e;}if(typeof args.content!=='string'||Buffer.byteLength(args.content)>1024*1024)throw new Error('File exceeds limit');after=args.content;}
   const id=crypto.randomUUID();const left=vscode.Uri.parse('codex-bridge-preview:/'+id+'/before/'+path.basename(target));const right=vscode.Uri.parse('codex-bridge-preview:/'+id+'/after/'+path.basename(target));
   previews.set(left.toString(),before);previews.set(right.toString(),after);
   try{
    await vscode.commands.executeCommand('vscode.diff',left,right,'Codex SSH: '+args.path,{preview:true});
    const answer=permission==='full'?'应用本次修改':await vscode.window.showWarningMessage('允许修改远程文件 '+args.path+'？',{modal:true,detail:'请检查已打开的差异。仅本次修改会被应用。'},'应用本次修改');check();
    if(answer!=='应用本次修改')throw new Error('User declined the file change');
    if(await hasDirtyEditor(target))throw new Error('File now has unsaved editor changes');
    return request.action==='edit'?await core.applyEdit(root.uri.fsPath,args):await core.create(root.uri.fsPath,args);
   }finally{previews.delete(left.toString());previews.delete(right.toString());}
  }
  await core.safePath(root.uri.fsPath,args.cwd||'.');
  const answer=permission==='full'?'执行一次':await vscode.window.showWarningMessage('在远程 '+os.hostname()+' 执行命令？',{modal:true,detail:'工作目录：'+(args.cwd||'.')+'\n\n'+args.command+'\n\n命令以远程登录用户身份执行，可访问该用户的文件。'},'执行一次');check();
  if(answer!=='执行一次')throw new Error('User declined the command');
  const id=crypto.randomUUID();const controller=new AbortController();active.set(id,{controller,jobId:job});
  try{return await core.execute(root.uri.fsPath,args,controller.signal);}finally{active.delete(id);}
 }));
 context.subscriptions.push(vscode.commands.registerCommand('codexSSH.remote.selfTest',async()=>{
  if(!vscode.env.remoteName||!vscode.workspace.isTrusted)throw new Error('Diagnostics require a trusted remote workspace');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-ssh-bridge-smoke-'));
  try{
   await core.create(dir,{path:'probe.txt',content:'before\n'});
   const before=await core.read(dir,{path:'probe.txt'});
   await core.applyEdit(dir,{path:'probe.txt',expected_sha256:before.sha256,old_text:'before',new_text:'after'});
   const found=await core.search(dir,{query:'after'});
   const run=await core.execute(dir,{command:"printf 'remote-exec-ok'",timeout_ms:5000});
   if(found.results.length!==1||run.stdout!=='remote-exec-ok'||run.exit_code!==0)throw new Error('Remote smoke test did not pass');
   return {ok:true,hostname:os.hostname(),arch:os.arch(),remoteName:vscode.env.remoteName,create:true,read:true,edit:true,search:true,exec:true,temporaryDirectoryRemoved:true};
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 }));
 context.subscriptions.push({dispose(){for(const v of active.values())v.controller.abort();active.clear();cancelled.clear();}});
}
module.exports={activate};
