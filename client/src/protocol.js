'use strict';
const {EventEmitter}=require('node:events');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
class AppServer extends EventEmitter{
 constructor(executable,options={}){super();this.executable=executable;this.options=options;this.pending=new Map();this.sequence=0;this.child=null;this.ready=false;}
 async start(){
  if(this.ready)return;
  if(this.starting)return this.starting;
  this.starting=this.open();
  try{await this.starting;}finally{this.starting=null;}
 }
 async open(){
  const env={...process.env,...this.options.env};
  if(process.platform!=='win32')env.PATH=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].filter(Boolean).join(':');
  this.child=(this.options.spawn||spawn)(this.executable,['app-server','--listen','stdio://','--disable','shell_tool'],{cwd:this.options.cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  this.child.stderr.on('data',data=>this.emit('log',data.toString()));
  this.child.on('error',e=>this.fail(e));
  this.child.on('exit',(code,signal)=>this.fail(new Error(`本地 Codex 已退出 (${code??signal})`)));
  const lines=readline.createInterface({input:this.child.stdout});
  lines.on('line',line=>{try{this.receive(JSON.parse(line));}catch(e){this.emit('log','Ignored non-JSON app-server output');}});
  await this.request('initialize',{clientInfo:{name:'codex_ssh_bridge',title:'Codex SSH Bridge',version:'0.1.0'},capabilities:{experimentalApi:true}});
  this.notify('initialized',{});this.ready=true;
 }
 receive(msg){
  if(msg.id!==undefined&&msg.method){this.emit('request',msg);return;}
  if(msg.id!==undefined){const p=this.pending.get(msg.id);if(!p)return;this.pending.delete(msg.id);clearTimeout(p.timer);if(msg.error)p.reject(new Error(msg.error.message||JSON.stringify(msg.error)));else p.resolve(msg.result);return;}
  if(msg.method)this.emit('notification',msg);
 }
 write(msg){if(!this.child?.stdin?.writable)throw new Error('Codex app-server is not running');this.child.stdin.write(JSON.stringify(msg)+'\n');}
 request(method,params={},timeout=120000){return new Promise((resolve,reject)=>{const id='bridge-'+(++this.sequence);const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex request timed out: ${method}`));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 notify(method,params){this.write({method,params});}
 respond(id,result){this.write({id,result});}
 error(id,message){this.write({id,error:{code:-32601,message}});}
 fail(error){this.ready=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('closed',error);}
 dispose(){this.ready=false;const child=this.child;this.child=null;if(child){child.stdin.end();child.kill('SIGTERM');const t=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},2000);t.unref();}this.fail(new Error('Codex connection closed'));}
}
module.exports={AppServer};
