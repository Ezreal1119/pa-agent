'use strict';
const $ = id => document.getElementById(id);
const stages = [['prepare-catalog','准备资料'],['resolve-project','匹配项目'],['select-sop-source','确认流程'],['resolve-processes','匹配工序'],['generate-sop','生成 Excel']];
const labels = { running:'正在运行', awaiting_clarification:'等待确认', awaiting_image_review:'等待图片确认', completed:'已完成', failed:'运行失败', terminated:'已终止', cancelled:'已取消' };
const types = { assemble:'Assembly', assembly_test:'Assembly Test', pcba_test:'PCBA Test', aging_test:'Aging Test', factory_test:'Factory Test' };
/** 临时只开放「装配」：把类型加回 ENABLED_SOP_TYPES 即恢复下拉选项；服务端仍支持全部类型。 */
const SOP_TYPE_OPTIONS = [['assembly_test','Assembly Test · 整机测试'],['assemble','Assembly · 装配'],['pcba_test','PCBA Test · 主板测试'],['aging_test','Aging Test · 老化测试'],['factory_test','Factory Test · 工厂测试']];
const ENABLED_SOP_TYPES = ['assemble'];
function applySopTypeOptions() {
  const select = $('sop-type');
  if (!select) return;
  select.replaceChildren(...SOP_TYPE_OPTIONS.filter(([value]) => ENABLED_SOP_TYPES.includes(value)).map(([value, text]) => new Option(text, value)));
  select.value = ENABLED_SOP_TYPES[0];
}
applySopTypeOptions();
let logged = false, offline = false, current = null, selected = null, generation = 0, pending = false, polling = false, shownQuestion = null;
let renderedReview = '';
let viewingTrash=false,listRequest=0;
const trashToggle=el('button','回收站','trash-toggle');trashToggle.type='button';$('refresh').parentElement.append(trashToggle);
trashToggle.addEventListener('click',safely(async()=>{viewingTrash=!viewingTrash;trashToggle.textContent=viewingTrash?'返回最近任务':'回收站';await refreshList();}));
const cropDialog = new window.CkdCropDialog();
const savedFiles = new Map(), downloadsInFlight = new Map();
function el(tag, text, cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; }
function notice(text='', retry=false) { $('notice').hidden=!text; $('notice-text').textContent=text; $('retry').hidden=!retry; }
function friendlyError(text, code) {
  const raw = String(text ?? '').trim();
  if (code === 'offline' || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|Failed to fetch|socket hang up|连接被拒绝/i.test(raw)) return '无法连接服务器，请检查网络后重试。';
  if (code === 401 || (/401|登录.*(过期|失效)|session|token/i.test(raw) && logged)) return '登录已过期，请重新登录。';
  if (/timeout|timed out|超时/i.test(raw)) return '服务响应超时，请稍后重试。';
  if (/\b(500|502|503|504)\b|Internal Server Error|服务不可用/i.test(raw)) return '服务暂不可用，请稍后重试。';
  return raw;
}
function remember(id) { try { if(id)localStorage.setItem('ckd.client.selected',id);else localStorage.removeItem('ckd.client.selected'); } catch {} }
let currentAccount = '';
function loginView() { cropDialog.close(true);renderedReview='';logged=false;generation++;current=null;selected=null;pending=false;polling=false;currentAccount='';savedFiles.clear();downloadsInFlight.clear();for(const id of ['task-list','run-details','scores','downloads','image-review-scores','question-options','steps'])$(id).replaceChildren();for(const id of ['account-label','password-account','run-title','run-subtitle','run-error','question-title','question-help','working-title','working-detail','delivery-status'])$(id).textContent='';$('answer-text').value='';$('create-form').reset();$('password-form').reset();$('password-view').hidden=true;$('workspace').hidden=true;$('login-view').hidden=false;$('password').value='';remember(null); }
function passwordView(required) { cropDialog.close(true);$('password-form').reset();$('password-title').textContent=required?'设置你的新密码':'修改密码';$('password-help').textContent=required?'首次登录或密码已被重置，设置新密码后才能使用工作台。':'修改后所有登录将失效，请使用新密码重新登录。';$('password-account').textContent='账号：'+currentAccount;$('password-back').hidden=required;$('workspace').hidden=true;$('login-view').hidden=true;$('password-view').hidden=false;notice();$('password-form').elements.currentPassword.focus(); }
async function call(method,...args) {
  const result=await window.ckd[method](...args);
  if(!result.ok) {
    if(result.code===401&&logged)loginView();
    offline=result.code==='offline';const message=friendlyError(result.error,result.code);notice(message,offline);
    const error=new Error(message);error.code=result.code;throw error;
  }
  offline=false;return result.value;
}
function safely(action) { return async(...args)=>{try{await action(...args);}catch(error){notice(friendlyError(error.message,error.code),error.code==='offline');}}; }
function factoryVisibility() {
  const type=$('sop-type').value,form=$('create-form');$('factory-field').hidden=type!=='factory_test';form.elements.factoryTestProcesses.required=type==='factory_test';
  for(const [id,key] of [['revision-reason-field','revisionReason'],['revision-content-field','revisionContent']]) {$(id).hidden=type!=='assemble';form.elements[key].disabled=type!=='assemble';}
}
function newTask(input) {
  cropDialog.close();renderedReview='';
  generation++;current=null;selected=null;shownQuestion=null;notice();$('run-view').hidden=true;$('create-view').hidden=false;$('create-form').reset();
  if(input) { const form=$('create-form'); const select=form.elements.sopType; if(input.sopType!==undefined && [...select.options].some(option=>option.value===input.sopType)) select.value=input.sopType; for(const key of ['templateLanguage','projectName','documentNumber','sopName','author','revisionReason','revisionContent'])if(input[key]!==undefined && input[key]!=='')form.elements[key].value=input[key];form.elements.factoryTestProcesses.value=(input.factoryTestProcesses||[]).join('\n'); }
  factoryVisibility();
}
async function refreshList() {
  const ticket=generation,isTrash=viewingTrash,request=++listRequest,{runs}=await call(isTrash?'deleted':'list');if(!logged||ticket!==generation||request!==listRequest||isTrash!==viewingTrash)return;
  $('task-list').replaceChildren();if(!runs.length)$('task-list').append(el('p',isTrash?'回收站为空。':'还没有任务。','muted small'));
  for(const run of runs.slice(0,isTrash?runs.length:30)) {
    const button=el('button',undefined,run.id===selected?'selected':'');button.type='button';button.append(el('strong',run.inputs.sopName||'未命名 SOP'));
    const meta=el('span',undefined,'task-meta');meta.append(el('span',run.inputs.projectName),el('span',labels[run.status]||run.status));button.append(meta);
    button.disabled=isTrash;button.addEventListener('click',safely(()=>selectTask(run.id)));
    const row=el('div',undefined,'task-row'),action=el('button',isTrash?'恢复':'删除','task-delete');action.type='button';action.disabled=!!run.busy||pending;action.title=isTrash?'恢复任务':'移入回收站（可恢复，不影响Library）';action.setAttribute('aria-label',`${isTrash?'恢复':'删除'} ${run.inputs.sopName||'未命名 SOP'}`);
    action.addEventListener('click',safely(async()=>{action.disabled=true;try{await call(isTrash?'restore':'trash',run.id);if(selected===run.id){remember(null);newTask();}await refreshList();}finally{action.disabled=false;}}));row.append(button,action);$('task-list').append(row);
  }
}
async function selectTask(id) {
  if(pending)return;cropDialog.close();renderedReview='';const ticket=++generation;selected=id;shownQuestion=null;notice();
  const {run}=await call('get',id);if(ticket!==generation||!logged)return;remember(id);render(run);await refreshList();
}
function render(run) {
  current=run;$('create-view').hidden=true;$('run-view').hidden=false;$('run-title').textContent=run.inputs.sopName;$('run-status').textContent=labels[run.status]||run.status;
  $('run-subtitle').textContent=`${run.inputs.projectName} · ${types[run.inputs.sopType]||''} · ${run.inputs.templateLanguage}`;
  const displayStages=run.imagePhase?[...stages.slice(0,4),['image-review','图片评分与确认'],['generate-sop','生成 Excel']]:stages;
  const activeStage=run.imagePhase==='reviewing'&&run.currentNodeId==='generate-sop'?'image-review':run.currentNodeId;
  const index=displayStages.findIndex(([id])=>id===activeStage);
  $('steps').classList.toggle('with-image-review',!!run.imagePhase);
  $('steps').replaceChildren(...displayStages.map(([id,label],i)=>{const n=el('li',`${i+1}. ${label}`,run.status==='completed'||i<index?'done':id===activeStage?'active':'');if(id===activeStage)n.setAttribute('aria-current','step');return n;}));
  $('run-details').replaceChildren();for(const [label,value]of [['项目名称',run.inputs.projectName],['文档编号',run.inputs.documentNumber],['作者',run.inputs.author],...(run.inputs.sopType==='assemble'?[['修订原因',run.inputs.revisionReason||'未填写'],['修订内容',run.inputs.revisionContent||'未填写']]:[]),['创建时间',new Date(run.createdAt).toLocaleString('zh-CN')]]) {const group=el('div');group.append(el('dt',label),el('dd',value));$('run-details').append(group);}
  const q=run.pendingQuestion,canAnswer=!!q&&!run.busy&&!pending&&run.status==='awaiting_clarification';$('question-panel').hidden=!q;
  if(q){$('question-title').textContent=q.question;const ordered=q.inputUi?.widget==='ordered-string-list-dialog';$('question-help').textContent=ordered?'每行一个工序，按希望的顺序排列。':q.allowFreeText?'选择选项，或填写回答。':'请点击一个选项继续。';$('answer-label').textContent=ordered?'有序工序列表':'你的回答';
    if(shownQuestion!==q.id){$('answer-text').value='';shownQuestion=q.id;}
    $('question-options').replaceChildren(...q.options.map((option,i)=>{const button=el('button');button.type='button';button.disabled=!canAnswer;button.append(el('span',`${i+1}.`),document.createTextNode(option));button.addEventListener('click',safely(()=>mutate('answer',q.id,option)));return button;}));
    $('answer-form').hidden=!q.allowFreeText;$('answer-text').required=q.answerRequired;$('answer-text').disabled=!canAnswer;$('answer-submit').disabled=!canAnswer;
  }
  renderImageReview(run);
  const working=run.busy||pending;$('working').hidden=!working;$('working-title').textContent=run.currentNodeId==='generate-sop'&&!run.result?(run.imagePhase==='generating'?'生成 Excel':'准备图片与评分'):stages.find(([id])=>id===run.currentNodeId)?.[1]||'正在处理';
  const check=run.imageCheck;
  if(check?.status==='running'&&working)$('working-title').textContent=`${run.result?.provisional?'Excel 已生成，':''}${check.phase==='focus'?'正在检查工序重点':'正在检查图片'} ${check.completed}/${check.total}`;
  $('working-detail').textContent=check?.status==='running'?`${check.processName??''}${check.imageName?' / '+check.imageName:''}。检查结果会自动更新。`:'任务在服务端执行，请稍候。';
  $('run-error').hidden=!run.error;$('run-error').textContent=run.error||'';
  $('resume').hidden=working||!!q||!['running','failed'].includes(run.status);$('cancel').hidden=['completed','terminated','cancelled'].includes(run.status);$('cancel').disabled=pending;
  $('reuse').disabled=pending;$('new-task').disabled=pending;$('result-panel').hidden=!run.result;
  if(run.result){
    $('delivery-status').textContent=run.result.provisional?`Excel 已生成，可以下载。图片与 AI 工序检查${run.status==='cancelled'?'已取消':run.status==='failed'?'失败，需继续任务或人工复核':run.busy?'尚未完成，报告完成后自动更新':'已中断，可点击继续任务'}；当前不能视为检查通过。`:'Excel 与检查报告已生成，请查看分项结果及人工复核提示。';
    $('delivery-status').className=run.result.provisional?'warning':'muted small';renderDownloads(run);renderScores(run.result.output||{});
  }
}
async function mutate(method,...args) {
  if(!current||pending)return;const id=current.id,ticket=generation;pending=true;notice();render(current);
  try {const {run}=await call(method,id,...args);if(ticket!==generation||!logged)return;pending=false;render(run);await refreshList();}
  finally {pending=false;if(current&&ticket===generation)render(current);}
}
function renderDownloads(run) {
  $('downloads').replaceChildren();for(const [index,file]of run.result.artifacts.entries()){
    if(file.name==='image-quality.json')continue;
    const card=el('div',undefined,'file-card'),buttons=el('div',undefined,'buttons'),message=el('p','', 'muted small');card.append(el('strong',file.name),buttons,message);
    const key=run.id+':'+index,record=savedFiles.get(key),save=el('button',record?'另存为…':file.name.endsWith('.json')?'保存评分报告':'保存 Excel','primary');buttons.append(save);
    const download=downloadsInFlight.get(key);save.disabled=!!download;message.dataset.downloadKey=key;if(download)message.textContent=download.message;
    if(record){if(!download)message.textContent=record.path;for(const [method,label]of [['open','打开文件'],['show','打开所在目录']]){const button=el('button',label);button.addEventListener('click',safely(()=>call(method,record.handle)));buttons.append(button);}}
    save.addEventListener('click',safely(async()=>{const ticket=generation;downloadsInFlight.set(key,{message:'正在读取文件信息，请稍候…'});renderDownloads(run);try{const result=await call('save',run.id,index);if(logged&&ticket===generation&&!result.cancelled)savedFiles.set(key,result);}finally{downloadsInFlight.delete(key);if(logged&&current?.id===run.id)renderDownloads(current);}}));$('downloads').append(card);
  }
}
window.ckd.onDownloadProgress(progress=>{
  const key=progress.id+':'+progress.index;if(!logged||!downloadsInFlight.has(key))return;
  const mb=bytes=>(bytes/1048576).toFixed(1)+' MB';
  const text=progress.state==='validating'?'下载完成，正在校验并保存…':progress.state==='completed'?'文件已保存。':`正在下载：${mb(progress.received)}${progress.total?` / ${mb(progress.total)}（${Math.min(100,Math.floor(progress.received/progress.total*100))}%）`:''}`;
  downloadsInFlight.set(key,{message:text});
  for(const node of $('downloads').querySelectorAll('[data-download-key]'))if(node.dataset.downloadKey===key)node.textContent=text;
});
function renderImageReview(run) {
  const review=run.imageReview,panel=$('image-review-panel');panel.hidden=!review;
  if(!review){renderedReview='';return;}
  const key=run.id+':'+review.id+':'+review.revision;
  if(key!==renderedReview){renderedReview=key;renderScores(review.output,$('image-review-scores'),review);}
  $('generate-sop').disabled=run.busy||pending;
  $('generate-sop').onclick=safely(()=>mutate('generate',review.id,review.revision));
}
function table(headers,rows) {const wrapper=el('div',undefined,'table-scroll'),t=el('table'),head=el('tr');head.append(...headers.map(h=>el('th',h)));t.append(head);for(const row of rows){const tr=el('tr');tr.append(...row.map(c=>el('td',String(c??''))));t.append(tr);}wrapper.append(t);return wrapper;}
function processScores(reviews, expanded) {
  const card=el('section',undefined,'card'),list=el('div',undefined,'process-score-list');card.append(el('h2','工序资料评分'));
  const heading=el('div',undefined,'process-score-heading');heading.append(el('span','工序'),el('span','评分'));card.append(heading);
  const sourceLabels={project:'目标项目',common:'公共资料',missing:'缺失',generated:'自动生成'};
  const assessmentLabels=[['operationAssessment','操作步骤'],['completenessAssessment','资料完整度'],['crossLayerAssessment','跨层资料缺口'],['semanticAssessment','语义匹配度']];
  for(const [index,review] of reviews.entries()){
    const detail=el('details',undefined,'process-score-detail'),summary=el('summary',undefined,'process-score-summary');
    detail.dataset.processIndex=String(index);detail.open=expanded.has(String(index));
    summary.append(el('span',review.processName||review.resolvedProcessName||review.requestedProcess||review.processId||'未命名工序'),el('span',`${review.score??'—'} / 100`,'process-score-value'));detail.append(summary);
    if(review.sourceType==='placeholder'||review.contentStatus==='content_missing')detail.append(el('p','此工序为资料占位页；没有可用的目标项目或公共资料。','warning small'));
    if(review.reason)detail.append(el('p',review.reason,'small'));
    if(review.overview)detail.append(el('p',review.overview,'muted small'));
    const assessments=assessmentLabels.filter(([key])=>review[key]).map(([key,label])=>[label,`-${review[key].deduction??0}`,review[key].comment||'']);
    if(assessments.length){detail.append(el('h3','评分明细'),table(['项目','扣分','说明'],assessments));if(review.totalDeduction!=null)detail.append(el('p',`总扣分：${review.totalDeduction} 分。`,'small'));}
    const sources=Object.entries(review.fileSources||{});
    if(sources.length){detail.append(el('h3','资料来源'),table(['资料','来源'],sources.map(([name,source])=>[name,sourceLabels[source]||source])));}
    for(const warning of review.warnings||[])detail.append(el('p',warning,'warning small'));
    if(detail.children.length===1)detail.append(el('p','该任务没有保存更详细的评分说明。','muted small'));
    list.append(detail);
  }
  card.append(list);return card;
}
function renderScores(output, target=$('scores'), review) {
  const expanded=new Set([...target.querySelectorAll('.process-score-detail[open]')].map(node=>node.dataset.processIndex));
  target.replaceChildren();
  if(output.processReviews?.length)target.append(processScores(output.processReviews,expanded));
  for(const warning of output.warnings||[])target.append(el('p',warning,'warning'));
  if(output.imagesConfirmed)return;
  const quality=output.imageQuality;if(!quality){target.append(el('p',target===$('scores')&&current?.result?.provisional?'图片检查尚未完成，最终报告将在完成后显示。':'本任务没有图片质量报告。','muted'));return;}
  const card=el('section',undefined,'card');card.append(el('h2','图片质量评分'),el('div',quality.overallScore==null?'未评分':`${quality.overallScore} / 100`,'hero-score'+(quality.reminderCount?' warning':'')));
  card.append(el('p',`共 ${quality.totalImages} 张图片，${quality.reminderCount??0} 张需要修改或复核，${quality.errorCount??0} 张识别失败。`,'muted'));
  if(quality.scoringNote)card.append(el('p',quality.scoringNote,'muted small'));if(quality.status==='no_images')card.append(el('p','工序中没有图片，无需图片评分。','muted'));target.append(card);
  if(quality.failureNote)card.append(el('p',quality.failureNote,'warning small'));
  for(const [imageIndex,image] of (quality.images||[]).entries()){const r=image.result,detail=el('details');detail.append(el('summary',`${image.processName} / ${image.path.split(/[\\/]/u).pop()} · ${r?.score==null?'未评分':r.score+' 分'}${r?.reminder?' · 需修改 / 复核':''}`));
    if(review){
      const item=review.images[imageIndex],summary=detail.firstChild;
      if(item){
        if(item.cropped){summary.firstChild.textContent=`${item.processName} / ${item.name} · 已人工裁剪（原图评分 ${r?.score??image.fallback?.score??'未评分'}）`;}
        summary.classList.add('image-review-summary');const crop=el('button','裁剪');crop.type='button';crop.disabled=!!item.previewError;
        crop.addEventListener('click',safely(async event=>{event.preventDefault();event.stopPropagation();const ticket=generation,id=current.id;const {dataUrl}=await call('image',id,item.id,true);if(ticket!==generation||!logged||cropDialog.dialog.open)return;await cropDialog.open(dataUrl,item.rect,async rect=>{if(ticket!==generation||current?.id!==id)throw new Error('任务已切换，请重新打开裁剪。');await mutate('crop',item.id,review.id,review.revision,rect);},{width:item.sourceWidth??item.width,height:item.sourceHeight??item.height});}));summary.append(crop);
        if(item.previewError){detail.append(el('p','预览不可用：'+item.previewError,'warning'));const retry=el('button','重试预览');retry.type='button';retry.disabled=!!current?.busy;retry.addEventListener('click',safely(()=>mutate('resume')));detail.append(retry);}
        else detail.addEventListener('toggle',safely(async()=>{if(!detail.open||detail.dataset.preview)return;detail.dataset.preview='loading';const ticket=generation,id=current.id;try{const {dataUrl}=await call('image',id,item.id,false);if(ticket!==generation||!detail.isConnected)return;const img=el('img',undefined,'review-preview');img.src=dataUrl;img.alt=item.processName+' / '+item.name;detail.insertBefore(img,detail.children[1]);detail.dataset.preview='loaded';}catch(error){delete detail.dataset.preview;throw error;}}));
      }
    }
    if(!r){if(image.fallback){detail.firstChild.firstChild.textContent=`${image.processName} / ${image.path.split(/[\\/]/u).pop()} · ${review?.images[imageIndex]?.cropped?'已人工裁剪（原图分析失败，0 分）':'0 分 · 分析失败，必须复核'}`;detail.append(el('p',image.fallback.reason,'warning'));}detail.append(el('p','图片识别失败：'+image.error,'warning'));target.append(detail);continue;}
    detail.append(el('p',r.subject,'muted'));if(r.reason)detail.append(el('p',r.reason,'small'));
    if(r.reminder)detail.append(el('p','此图片需要修改或人工复核。','warning'));
    for(const cap of r.appliedCaps||[])detail.append(el('p',`评分上限 ${cap.maximum}：${cap.reason}`,'warning small'));
    for(const warning of r.conservativeReview?.warnings||[])detail.append(el('p',warning,'warning small'));
    detail.append(table(['评分项目','得分','分析 / 扣分原因'],(r.components||[]).map(c=>[c.label,`${c.score} / ${c.maximum}`,c.comment])));
    if(r.components?.some(c=>c.modelComment)){
      const evidence=el('details');evidence.append(el('summary','查看原始模型观察（与程序计分依据分开展示）'));
      evidence.addEventListener('toggle',()=>{if(!evidence.open||evidence.dataset.loaded)return;evidence.dataset.loaded='true';evidence.append(el('p','原始描述与结构化档位可能不一致；若有冲突，请人工复核，程序不会凭积极描述自动提分。','muted small'));for(const c of r.components)if(c.modelComment)evidence.append(el('p',`${c.label}：${c.modelComment}`,'small'));});
      detail.append(evidence);
    }
    if(r.mainDeductions?.length){detail.append(el('h3','计分差额（含保守余量）'));for(const d of r.mainDeductions)detail.append(el('p',`${d.label}差额 ${d.lost} 分：${d.comment}`,'small'));}
    if(r.recommendations?.length)detail.append(el('p','建议：'+r.recommendations.join('；'),'recommendation'));
    if(image.operationFocus)detail.append(el('p','工序重点：'+image.operationFocus.comment,'small'));if(image.focusError)detail.append(el('p','工序重点待人工复核：'+image.focusError,'warning small'));
    if(r.nearestReferences?.length)detail.append(el('p','接近的基准：'+r.nearestReferences.map(n=>`${n.file}（人工 ${n.humanScore} 分）`).join('、'),'small'));target.append(detail);
  }
}
$('login-form').addEventListener('submit',safely(async event=>{
  event.preventDefault();$('login-submit').disabled=true;notice();
  try{const user=await call('login',{account:$('account').value.trim(),password:$('password').value});logged=true;currentAccount=user.account;$('account-label').textContent='账号 '+user.account;if(user.mustChangePassword){passwordView(true);return;}$('password-view').hidden=true;$('login-view').hidden=true;$('workspace').hidden=false;newTask();await call('status');await refreshList();let last;try{last=localStorage.getItem('ckd.client.selected');}catch{}if(last){try{await selectTask(last);}catch(error){if(error.code===404){notice();selected=null;newTask();}else throw error;}}}
  finally{$('login-submit').disabled=false;$('password').value='';}
}));
$('create-form').addEventListener('submit',safely(async event=>{
  event.preventDefault();if(pending)return;const data=Object.fromEntries(new FormData(event.currentTarget));for(const key of ['projectName','documentNumber','sopName','author'])data[key]=data[key].trim();
  if(data.sopType==='factory_test')data.factoryTestProcesses=data.factoryTestProcesses.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean);else delete data.factoryTestProcesses;
  for(const key of ['revisionReason','revisionContent']) {if(data.sopType==='assemble')data[key]=(data[key]||'').trim();else delete data[key];}
  const ticket=generation;pending=true;$('start').disabled=true;notice();
  try{const {run}=await call('start',data);if(ticket!==generation||!logged)return;selected=run.id;remember(selected);pending=false;render(run);await refreshList();}
  finally{pending=false;$('start').disabled=false;}
}));
$('answer-form').addEventListener('submit',safely(async event=>{event.preventDefault();if(current?.pendingQuestion)await mutate('answer',current.pendingQuestion.id,$('answer-text').value);}));
$('sop-type').addEventListener('change',factoryVisibility);
$('new-task').addEventListener('click',safely(async()=>{if(pending)return;newTask();await refreshList();}));
$('refresh').addEventListener('click',safely(refreshList));
$('resume').addEventListener('click',safely(()=>mutate('resume')));
$('cancel').addEventListener('click',safely(()=>mutate('cancel')));
$('reuse').addEventListener('click',()=>{if(!pending)newTask(current?.inputs);});
$('open-editor').addEventListener('click',safely(()=>call('openEditor')));
$('logout').addEventListener('click',safely(async()=>{try{await call('logout');}finally{loginView();notice();}}));
$('change-password').addEventListener('click',safely(async()=>{await call('me');passwordView(false);}));
$('password-back').addEventListener('click',()=>{$('password-form').reset();$('password-view').hidden=true;$('workspace').hidden=false;notice();});
$('password-logout').addEventListener('click',safely(async()=>{try{await call('logout');}finally{loginView();notice();}}));
$('password-form').addEventListener('submit',safely(async event=>{
  event.preventDefault();const form=event.currentTarget;
  const passwordLength=Array.from(form.elements.newPassword.value).length;
  if(passwordLength<8||passwordLength>128)throw new Error('新密码须为 8–128 个字符。');
  if(form.elements.newPassword.value!==form.elements.confirmation.value)throw new Error('两次输入的新密码不一致。');
  $('password-submit').disabled=true;
  try{await call('changePassword',{currentPassword:form.elements.currentPassword.value,newPassword:form.elements.newPassword.value});loginView();notice('密码已更新，请使用新密码登录。');}
  finally{$('password-submit').disabled=false;form.reset();}
}));
$('retry').addEventListener('click',safely(async()=>{notice();if(!logged){$('account').focus();return;}await call('status');if(selected)await selectTask(selected);else await refreshList();}));
setInterval(async()=>{if(!logged||!$('password-view').hidden||offline||!current||pending||polling||!['running','awaiting_clarification'].includes(current.status))return;const ticket=generation,id=current.id;polling=true;try{const {run}=await call('get',id);if(ticket===generation&&logged){render(run);if(!run.busy)await refreshList();}}catch{}finally{polling=false;}},1500);
factoryVisibility();
