'use strict';
const api=acquireVsCodeApi();
const $=id=>document.getElementById(id);
const post=(type,extra={})=>api.postMessage({type,...extra});
let busy=false;const entries=new Map();
function send(){const text=$('prompt').value.trim();if(!text||busy)return;$('prompt').value='';post('send',{text});}
for(const id of ['connect','login','install','reset','root','stop','attach','logs'])$(id).addEventListener('click',()=>post(id));
$('send').addEventListener('click',send);
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}});
$('model').addEventListener('change',()=>post('model',{value:$('model').value}));
for(const button of document.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>{$('prompt').value=button.dataset.prompt;$('prompt').focus();});
window.addEventListener('message',event=>{
 const m=event.data;
 if(m.type==='state'){
  busy=m.busy;$('local-status').textContent=m.local;$('remote-status').textContent=m.remote;
  $('local-dot').classList.toggle('on',m.local.startsWith('已登录'));$('remote-dot').classList.toggle('on',m.remote!=='未连接');
  $('root').textContent=m.root?m.root.path:'选择远程工作区';$('root').title=m.root?.path||'';
  $('send').hidden=busy;$('stop').hidden=!busy;$('hint').textContent=busy?'正在处理 · 修改和命令会请求确认':'Enter 发送 · Shift+Enter 换行';
  for(const id of ['model','reset','root','connect','install','login'])$(id).disabled=busy;
  const auto=(m.models||[]).find(x=>x.isDefault);const models=[{id:'',name:auto?'默认 · '+auto.name:'Codex 默认模型'},...(m.models||[])];
  if(JSON.stringify(models)!==$('model').dataset.models){$('model').replaceChildren();for(const item of models){const o=document.createElement('option');o.value=item.id;o.textContent=item.name;$('model').append(o);}$('model').dataset.models=JSON.stringify(models);}
  $('model').value=m.model||'';
 }else if(m.type==='message'){
  $('welcome')?.remove();const container=$('messages');const stick=container.scrollHeight-container.scrollTop-container.clientHeight<100;
  let element=entries.get(m.id);
  if(!element){element=document.createElement(m.role==='tool'?'details':'article');element.className='message '+m.role;
   const label=document.createElement(m.role==='tool'?'summary':'div');label.className='label';label.textContent=({user:'你',assistant:'CODEX',error:'连接提示',system:'系统',tool:'远程操作'})[m.role]||m.role;
   const body=document.createElement('div');body.className='body';element.append(label,body);container.append(element);entries.set(m.id,element);}
  element.querySelector('.body').textContent=m.text;if(stick)container.scrollTop=container.scrollHeight;
 }else if(m.type==='clear'){for(const el of entries.values())el.remove();entries.clear();}
 else if(m.type==='attach'){$('prompt').value+=m.text;$('prompt').focus();}
});
post('ready');
