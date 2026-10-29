'use strict';
const api = acquireVsCodeApi();
const savedPanel = api.getState() || {};
const $ = id => document.getElementById(id);
const post = (type, extra = {}) => api.postMessage({type, ...extra});
const effortNames = {none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '超高'};
const permissionNames = {'read-only': '只读', ask: '逐次批准', full: '完全访问'};
const menus = {more: 'more-menu', permission: 'permission-menu', model: 'model-menu'};
const entries = new Map();
let busy = false;
let state = {models: [], model: '', effort: '', permission: 'ask'};
let catalogKey = '';
let measuredDraft = null;
let screen = 'chat';
let historyRows = [];
const headerMenus = {root: 'project-menu', preferences: 'preferences-menu'};
function closeHeaderMenus(focus = false) {
 let owner;
 for (const [id, menu] of Object.entries(headerMenus)) {
  if (!$(menu).hidden) owner = id;
  $(menu).hidden = true; $(id).setAttribute('aria-expanded', 'false');
 }
 if (focus && owner) $(owner).focus();
}
function showScreen(next) {
 screen = next; closeHeaderMenus(); closeMenus();
 $('messages').hidden = next !== 'chat'; $('history-view').hidden = next !== 'history';
 document.querySelector('.chat-footer').hidden = next !== 'chat';
 $('history').setAttribute('aria-pressed', String(next === 'history'));
 if (next === 'history') $('history-search').focus(); else $('prompt').focus();
}
function selectedModel() {return state.models.find(x => x.id === state.model) || state.models.find(x => x.isDefault) || state.models[0];}
function closeMenus(focus = false) {
 let owner;
 for (const [button, menu] of Object.entries(menus)) {
  if (!$(menu).hidden) owner = button;
  $(menu).hidden = true; $(button).setAttribute('aria-expanded', 'false');
 }
 $('model-list').hidden = true; $('model-entry').setAttribute('aria-expanded', 'false');
 if (focus && owner) $(owner).focus();
}
function toggleMenu(button) {
 if (busy) return;
 const open = $(menus[button]).hidden; closeMenus();
 if (open) {
  $(menus[button]).hidden = false; $(button).setAttribute('aria-expanded', 'true');
  (button === 'model' && !$('effort-slider').disabled ? $('effort-slider') : $(menus[button]).querySelector('button:not(:disabled)'))?.focus();
 }
}
function updateSend() {
 const prompt = $('prompt'); api.setState({draft: prompt.value}); $('send').disabled = busy || !prompt.value.trim();
 if (measuredDraft !== prompt.value) {
  measuredDraft = prompt.value; prompt.style.height = 'auto';
  prompt.style.height = Math.min(260, Math.max(52, prompt.scrollHeight)) + 'px';
 }
}
function send() {
 const text = $('prompt').value.trim(); if (!text || busy) return;
 closeMenus(); busy = true; updateSend(); post('send', {text});
 // Keep the draft until the host confirms it was accepted.
}
for (const id of ['connect', 'login', 'install', 'reset', 'stop', 'logs', 'project']) $(id).addEventListener('click', () => {closeHeaderMenus(); post(id);});
for (const [id, menu] of Object.entries(headerMenus)) $(id).addEventListener('click', () => {
 const open = $(menu).hidden; closeHeaderMenus(); closeMenus();
 if (open) {
  $(menu).hidden = false; $(id).setAttribute('aria-expanded', 'true');
  if (id === 'root') post('root');
  else $(menu).querySelector('button:not(:disabled)')?.focus();
 }
});
$('history').addEventListener('click', () => {
 if (screen === 'history') {showScreen('chat'); return;}
 showScreen('history'); $('history-status').textContent = '正在加载…'; post('history');
});
$('history-back').addEventListener('click', () => showScreen('chat'));
$('history-search').addEventListener('input', renderHistory);
$('create-project').addEventListener('click', () => {closeHeaderMenus(); post('createProject');});
$('open-project').addEventListener('click', () => {closeHeaderMenus(); post('openDirectory');});

$('attach').addEventListener('click', () => {closeMenus(); post('attach');});
$('model-entry').addEventListener('click', () => {
 const open = $('model-list').hidden;
 $('model-list').hidden = !open; $('model-entry').setAttribute('aria-expanded', String(open));
 if (open) $('model-list').querySelector('button:not(:disabled):not([hidden])')?.focus();
});
$('reset-effort').addEventListener('click', () => {if (!busy) post('settings', {effort: ''});});
$('effort-slider').addEventListener('input', () => previewEffort(Number($('effort-slider').value)));
$('effort-slider').addEventListener('change', () => {
 const option = selectedModel()?.efforts?.[Number($('effort-slider').value)];
 if (!busy && option) post('settings', {effort: option.id});
});
$('load-models').addEventListener('click', () => post('connect'));
for (const button of Object.keys(menus)) $(button).addEventListener('click', () => toggleMenu(button));
$('send').addEventListener('click', send);
$('prompt').value = typeof savedPanel.draft === 'string' ? savedPanel.draft : '';
$('prompt').addEventListener('input', updateSend);
$('prompt').addEventListener('keydown', e => {if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {e.preventDefault(); send();}});
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => {$('prompt').value = button.dataset.prompt; updateSend(); $('prompt').focus();});
for (const button of document.querySelectorAll('[data-permission]')) button.addEventListener('click', () => {
 closeMenus(true); post('settings', {permission: button.dataset.permission});
});
document.addEventListener('click', e => {
 if (!e.target.closest('.composer-popover, #more, #permission, #model')) closeMenus();
 if (!e.target.closest('.chat-header')) closeHeaderMenus();
});
document.addEventListener('keydown', e => {
 if (e.key === 'Escape') {closeHeaderMenus(true); closeMenus(true); return;}
 const menu = e.target.closest('.composer-popover, .header-popover');
 if (e.target.matches('input[type="range"]')) return;
 if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
 e.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')].filter(b => !b.closest('[hidden]'));
 if (!buttons.length) return;
 const index = buttons.indexOf(document.activeElement);
 const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
 buttons[next].focus();
});
document.addEventListener('focusin', e => {if (!e.target.closest('.composer')) closeMenus(); if (!e.target.closest('.chat-header')) closeHeaderMenus();});
function choice(label, checked, onClick, hint = '') {
 const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(checked));
 const mark = document.createElement('span'); mark.className = 'choice-mark';
 const text = document.createElement('span'); text.textContent = label; button.append(mark, text); button.title = hint || label;
 button.addEventListener('click', onClick); return button;
}
function previewEffort(index) {
 const options = selectedModel()?.efforts || [];
 const option = options[index];
 $('reasoning-value').textContent = option ? effortNames[option.id] || option.id : '—';
 $('effort-slider').setAttribute('aria-valuetext', option ? effortNames[option.id] || option.id : '暂无可用档位');
 $('effort-slider').title = option?.description || (option ? effortNames[option.id] || option.id : '连接后选择推理强度');
 $('reasoning-track').style.setProperty('--effort-ratio', String(options.length > 1 ? index / (options.length - 1) : 0));
 for (const [i, tick] of [...$('effort-ticks').children].entries()) tick.classList.toggle('active', i <= index);
}
function renderSettings() {
 const selected = selectedModel();
 $('model-label').textContent = selected?.name || '默认模型';
 const effort = state.effort || selected?.defaultEffort;
 $('effort-label').textContent = effort ? effortNames[effort] || effort : '';
 $('model').title = `${selected?.name || '选择模型'}${effort ? ' · 推理强度：' + (effortNames[effort] || effort) : ''}（仅当前对话）`;
 $('permission-label').textContent = permissionNames[state.permission] || permissionNames.ask;
 $('permission').title = `远程操作权限：${permissionNames[state.permission] || permissionNames.ask}（仅当前对话）`;
 for (const button of document.querySelectorAll('[data-permission]')) button.setAttribute('aria-checked', String(button.dataset.permission === state.permission));
 const nextKey = JSON.stringify([state.models, state.model, state.effort]);
 if (catalogKey === nextKey) return;
 catalogKey = nextKey;
 $('model-options').replaceChildren(); $('effort-ticks').replaceChildren();
 $('reasoning-model-name').textContent = selected?.name || '默认模型';
 $('load-models').hidden = !!state.models.length;
 for (const model of state.models) $('model-options').append(choice(model.name, model.id === selected?.id, () => {
  $('model-list').hidden = true; $('model-entry').setAttribute('aria-expanded', 'false'); $('model-entry').focus();
  post('settings', {model: model.id});
 }, model.id));
 const options = selected?.efforts || [];
 const index = Math.max(0, options.findIndex(option => option.id === effort));
 $('effort-slider').max = String(Math.max(0, options.length - 1)); $('effort-slider').value = String(index);
 $('effort-slider').disabled = busy || options.length < 2;
 $('reset-effort').disabled = busy || !options.length;
 $('effort-empty').hidden = !!options.length; $('reasoning-track').hidden = !options.length;
 for (let i = 0; i < options.length; i++) {
  const tick = document.createElement('span'); tick.style.left = `${options.length > 1 ? i / (options.length - 1) * 100 : 0}%`;
  $('effort-ticks').append(tick);
 }
 previewEffort(index);
}
function relativeTime(timestamp) {
 const date = new Date(timestamp * 1000); const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
 return days === 0 ? '今天' : days < 7 ? `${days} 天前` : days < 30 ? `${Math.floor(days / 7)} 周前` : date.toLocaleDateString();
}
function renderHistory() {
 const query = $('history-search').value.trim().toLocaleLowerCase();
 const rows = historyRows.filter(row => (row.title + ' ' + row.projectName).toLocaleLowerCase().includes(query));
 $('history-list').replaceChildren(); $('history-empty').hidden = !!rows.length;
 $('history-empty').textContent = query ? '没有匹配的对话' : '当前远程还没有历史对话';
 for (const row of rows) {
  const item = document.createElement('div'); item.className = 'history-row';
  const open = document.createElement('button'); open.className = 'history-open'; open.disabled = busy;
  const title = document.createElement('span'); title.className = 'history-title'; title.textContent = row.title;
  const project = document.createElement('span'); project.className = 'history-project'; project.textContent = row.projectName;
  open.append(title, project); open.title = row.title + '\n' + row.projectName;
  const request = type => post(type, {threadId: row.id, projectKey: row.projectKey});
  open.addEventListener('click', () => request('openHistory'));
  const date = document.createElement('time'); date.className = 'history-date'; date.textContent = relativeTime(row.updatedAt); date.dateTime = new Date(row.updatedAt * 1000).toISOString();
  const actions = document.createElement('div'); actions.className = 'history-row-actions'; actions.append($('history-actions').content.cloneNode(true));
  actions.querySelector('.history-open-codex').addEventListener('click', () => request('historyCodex'));
  actions.querySelector('.history-delete').addEventListener('click', () => request('deleteHistory'));
  for (const button of actions.querySelectorAll('button')) button.disabled = busy;
  item.append(open, date, actions); $('history-list').append(item);
 }
}
function renderProjects(data) {
 $('project-options').replaceChildren();
 const options = [{key: null, name: '不选择项目', path: '对话归类到当前远程'}, ...data.projects];
 for (const option of options) {
  const button = choice(option.name, option.key === data.selected, () => {closeHeaderMenus(true); post('selectProject', {key: option.key});}, option.path);
  button.setAttribute('role', 'menuitemradio'); button.disabled = busy;
  $('project-options').append(button);
 }
}
window.addEventListener('message', event => {
 const m = event.data;
 if (m.type === 'state') {
  state = {...state, ...m}; busy = m.busy;
  $('local-status').textContent = m.local; $('remote-status').textContent = m.remote;
  $('project-name').textContent = m.project?.unassigned ? '不选择项目' : m.project?.name || '不选择项目';
  $('root').title = m.root?.path || '选择或创建项目';
  $('project').disabled = busy || !m.project;
  $('send').hidden = !!m.running; $('stop').hidden = !m.running;
  $('hint').textContent = m.running ? '正在处理 · 可停止当前任务' : busy ? '正在准备…' : 'Enter 发送 · Shift+Enter 换行';
  for (const id of ['more', 'permission', 'model', 'reset', 'root', 'connect', 'install', 'login', 'history', 'load-models', 'create-project', 'open-project']) $(id).disabled = busy;
  for (const button of document.querySelectorAll('.composer-popover button')) button.disabled = busy;
  for (const button of document.querySelectorAll('#project-options button, .history-row button')) button.disabled = busy;
  if (busy) closeMenus();
  if (m.running) closeHeaderMenus();
  if (!busy && screen === 'history') $('history-status').textContent = '';
  renderSettings();
  $('effort-slider').disabled = busy || (selectedModel()?.efforts?.length || 0) < 2;
  $('reset-effort').disabled = busy || !selectedModel()?.efforts?.length;
  updateSend();
 } else if (m.type === 'history') {historyRows = m.threads; $('history-status').textContent = ''; renderHistory();}
 else if (m.type === 'projects') renderProjects(m);
 else if (m.type === 'uiError' && screen === 'history') {$('history-status').textContent = '操作失败'; $('history-empty').textContent = m.message; $('history-empty').hidden = false;}
 else if (m.type === 'screen') showScreen(m.screen);
 else if (m.type === 'message') {
  $('welcome')?.remove(); const container = $('messages'); const stick = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  let element = entries.get(m.id);
  if (!element) {
   element = document.createElement(m.role === 'tool' ? 'details' : 'article'); element.className = 'message ' + m.role;
   const label = document.createElement(m.role === 'tool' ? 'summary' : 'div'); label.className = 'label'; label.textContent = ({user: '你', assistant: 'CODEX', error: '连接提示', system: '系统', tool: '远程操作'})[m.role] || m.role;
   const body = document.createElement('div'); body.className = 'body'; element.append(label, body); container.append(element); entries.set(m.id, element);
  }
  element.querySelector('.body').textContent = m.text; if (stick) container.scrollTop = container.scrollHeight;
 } else if (m.type === 'sent') {if ($('prompt').value.trim() === m.text.trim()) $('prompt').value = ''; updateSend();}
 else if (m.type === 'clear') {for (const el of entries.values()) el.remove(); entries.clear();}
 else if (m.type === 'attach') {$('prompt').value += m.text; updateSend(); $('prompt').focus();}
});
updateSend();
post('ready');
