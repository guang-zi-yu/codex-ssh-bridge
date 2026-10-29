'use strict';
const {AppServer}=require('../client/src/protocol');const {tools,instructions}=require('../client/src/tools');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
(async()=>{const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'codex-ssh-protocol-'));const server=new AppServer(process.env.BRIDGE_CODEX_PATH||'codex',{cwd});server.on('log',()=>{});server.on('request',m=>server.error(m.id,'No execution during handshake test'));
 try{await server.start();const account=await server.request('account/read',{refreshToken:false});console.log(JSON.stringify({handshake:true,authenticated:!!account.account,authType:account.account?.type||null}));
 const t=await server.request('thread/start',{cwd,approvalPolicy:'never',sandbox:'read-only',developerInstructions:instructions('/tmp/remote-test-only'),dynamicTools:tools,config:{'features.shell_tool':false},ephemeral:true});
 console.log(JSON.stringify({threadStarted:!!t.thread.id,model:t.model,sandbox:t.sandbox,tools:tools.map(t=>t.name)}));
 await server.request('thread/unsubscribe',{threadId:t.thread.id});
 }finally{server.dispose();await fs.rm(cwd,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
