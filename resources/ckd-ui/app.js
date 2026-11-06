const $ = id => document.getElementById(id);
const adminBase = location.pathname.startsWith('/admin') ? '/admin' : '';
const adminUrl = path => adminBase + path;
if (!adminBase) { $('admin-logout').hidden = true; $('user-management').hidden = true; }
const labels = { running: '正在运行', awaiting_clarification: '等待确认', completed: '已完成', failed: '运行失败', terminated: '已终止', cancelled: '已取消' };
const stages = [['prepare-catalog','准备资料'],['resolve-project','匹配项目'],['select-sop-source','确认流程'],['resolve-processes','匹配工序'],['generate-sop','生成 Excel']];
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
let current = null, selectedId = null, pending = false, shownQuestion = null, generation = 0;
let viewingTrash=false,listRequest=0;
const trashToggle=document.createElement('button');trashToggle.type='button';trashToggle.className='text-button';trashToggle.textContent='回收站';$('refresh').parentElement.append(trashToggle);
trashToggle.addEventListener('click',()=>{viewingTrash=!viewingTrash;trashToggle.textContent=viewingTrash?'返回最近任务':'回收站';refreshList().catch(e=>notice(e.message));});
function remember(id) { try { if(id) localStorage.setItem('ckd.selectedTask', id); else localStorage.removeItem('ckd.selectedTask'); } catch {} }
function notice(message) { $('notice').textContent = message || ''; $('notice').hidden = !message; }
async function api(url, data) {
  const response = await fetch(adminUrl(url), data === undefined ? {headers:{'X-CKD-Partial-Results':'1'}} : { method:'POST', headers:{'Content-Type':'application/json','X-CKD-UI':'1','X-CKD-Partial-Results':'1'}, body:JSON.stringify(data) });
  const result = await response.json(); if(response.status===401&&adminBase)location.assign(adminBase+'/login'); if(!response.ok) throw new Error(result.error || '操作失败，请重试。'); return result;
}
$('admin-logout').addEventListener('click',async()=>{try{await api('/api/auth/logout',{});location.assign(adminBase+'/login');}catch(error){notice(error.message);}});
function node(tag, text, className) { const item=document.createElement(tag); if(text!==undefined) item.textContent=text; if(className) item.className=className; return item; }
function factoryVisibility() {
  const type=$('sop-type').value,form=$('create-form');$('factory-field').hidden=type!=='factory_test';form.elements.factoryTestProcesses.required=type==='factory_test';
  for(const [id,key] of [['revision-reason-field','revisionReason'],['revision-content-field','revisionContent']]) {$(id).hidden=type!=='assemble';form.elements[key].disabled=type!=='assemble';}
}
/** 录入页存的封面信息（localStorage）。传 projectId 精确匹配，否则按最近录入的项目。 */
function editorSopInfo(projectId) {
  try {
    const id = String(projectId || localStorage.getItem('ckd-sop-info:last') || '').trim();
    if (!id) return null;
    const info = JSON.parse(localStorage.getItem(`ckd-sop-info:${id}`) || '{}');
    if (!info || !info.updatedAt) return null;
    return { projectId: id, documentNumber: info.document || '', sopName: info.name || '', author: info.author || '', reviewer: info.reviewer || '', version: info.version || '', versionNote: info.versionNote || '', date: info.date || '', revisionReason: info.revisionReason || '', revisionContent: info.revisionContent || '' };
  } catch { return null; }
}
/** 封面信息区的一行提示：告诉用户这个项目从录入页能拿到哪些值。 */
function refreshCoverHint() {
  const hint = $('cover-hint'), form = $('create-form');
  if (!hint || !form) return;
  const projectId = String(form.elements.projectName.value || '').trim();
  if (!projectId) { hint.textContent = '填了项目名称后，如果录入页已经给这个项目填过封面信息，留空的字段会自动使用它。'; return; }
  const info = editorSopInfo(projectId);
  if (!info) { hint.textContent = `逐工序录入里还没有「${projectId}」的封面信息，下面三项请在这里填全。`; return; }
  const parts = [info.documentNumber && `文件编号 ${info.documentNumber}`, info.sopName && `SOP 名称 ${info.sopName}`, info.author && `编制人 ${info.author}`].filter(Boolean);
  hint.textContent = parts.length ? `录入页已填：${parts.join(' · ')}。留空自动使用，改了则覆盖。` : `逐工序录入里「${projectId}」的封面信息是空的，下面三项请在这里填全。`;
}
/** 首屏「基本信息」也刷一次提示（首屏不经过 newTask）。 */
function prefillEditorInfo() { refreshCoverHint(); }
function newTask(input) {
  generation++; selectedId=null; current=null; shownQuestion=null; remember(null); notice('');
  $('create-view').hidden=false; $('run-view').hidden=true;
  $('create-form').reset();
  if(input) { const form=$('create-form'); const select=form.elements.sopType; if(input.sopType!==undefined && [...select.options].some(option=>option.value===input.sopType)) select.value=input.sopType; for(const key of ['templateLanguage','projectName','documentNumber','sopName','author','revisionReason','revisionContent']) if(input[key]!==undefined && input[key]!=='') form.elements[key].value=input[key]; form.elements.factoryTestProcesses.value=(input.factoryTestProcesses||[]).join('\n'); }
  factoryVisibility(); refreshCoverHint(); void refreshList();
}
async function refreshList() {
  const isTrash=viewingTrash,ticket=++listRequest,result=await api(isTrash?'/api/trash':'/api/runs');if(ticket!==listRequest||isTrash!==viewingTrash)return; const list=$('task-list'); list.replaceChildren();
  if(!result.runs.length) list.append(node('p',isTrash?'回收站为空。':'还没有任务，从导出 SOP 开始。','muted small'));
  for(const run of result.runs.slice(0,isTrash?result.runs.length:30)) {
    const button=node('button',undefined,`task-card${run.id===selectedId?' selected':''}`); button.type='button';
    button.append(node('strong',run.inputs.sopName || '未命名 SOP'));
    const meta=node('span',undefined,'task-meta'); meta.append(node('span',run.inputs.projectName),node('span',labels[run.status])); button.append(meta);
    button.disabled=isTrash;button.addEventListener('click',()=>selectTask(run.id));
    const row=node('div',undefined,'task-row'),action=node('button',isTrash?'恢复':'删除','task-delete');action.type='button';action.disabled=!!run.busy||pending;action.title=isTrash?'恢复任务':'移入回收站（可恢复，不影响Library）';action.setAttribute('aria-label',`${isTrash?'恢复':'删除'} ${run.inputs.sopName||'未命名 SOP'}`);
    action.addEventListener('click',async()=>{action.disabled=true;try{await api(`/api/runs/${run.id}/${isTrash?'restore':'trash'}`,{});if(run.id===selectedId)newTask();await refreshList();}catch(e){notice(e.message);action.disabled=false;}});row.append(button,action);list.append(row);
  }
}
async function selectTask(id) {
  const ticket=++generation; selectedId=id; remember(id); notice('');
  try { const result=await api(`/api/runs/${id}`); if(ticket!==generation) return; render(result.run); await refreshList(); }
  catch(error) { if(ticket===generation) notice(error.message); }
}
function render(run) {
  current=run; $('create-view').hidden=true; $('run-view').hidden=false;
  $('run-title').textContent=run.inputs.sopName; $('run-status').textContent=labels[run.status];
  $('run-subtitle').textContent=`${run.inputs.projectName} · ${types[run.inputs.sopType]} · ${run.inputs.templateLanguage}`;
  const index=stages.findIndex(([id])=>id===run.currentNodeId);
  $('steps').replaceChildren(...stages.map(([id,label], i)=>node('li',`${i+1}. ${label}`,run.status==='completed'||i<index?'done':id===run.currentNodeId?'active':'')));
  const details=$('run-details'); details.replaceChildren();
  for(const [label,value] of [['项目名称',run.inputs.projectName],['文档编号',run.inputs.documentNumber],['作者',run.inputs.author],...(run.inputs.sopType==='assemble'?[['修订原因',run.inputs.revisionReason||'未填写'],['修订内容',run.inputs.revisionContent||'未填写']]:[]),['创建时间',new Date(run.createdAt).toLocaleString('zh-CN')]]) { const group=node('div'); group.append(node('dt',label),node('dd',value)); details.append(group); }
  const question=run.pendingQuestion; const canAnswer=!!question&&!run.busy&&!pending&&run.status==='awaiting_clarification';
  $('question-panel').hidden=!question;
  if(question) {
    $('question-title').textContent=question.question;
    const ordered=question.inputUi?.widget==='ordered-string-list-dialog';
    $('question-help').textContent=ordered?'每行填写一个工序，按希望的 SOP 顺序排列。':question.allowFreeText?'选择一项，或在下方填写回答。':'请点击下方选项继续。';
    $('answer-label').textContent=ordered?'有序工序列表':'你的回答';
    if(shownQuestion!==question.id) { $('answer-text').value=''; shownQuestion=question.id; }
    $('question-options').replaceChildren(...question.options.map((option,i)=>{const button=node('button',undefined,'option-button');button.type='button';button.disabled=!canAnswer;button.append(node('span',String(i+1).padStart(2,'0'),'option-number'),node('span',option));button.addEventListener('click',()=>answer(option,question.id));return button;}));
    $('answer-form').hidden=!question.allowFreeText; $('answer-text').disabled=!canAnswer; $('answer-text').required=question.answerRequired; $('answer-button').disabled=!canAnswer;
  }
  const working=run.busy||pending; $('working-panel').hidden=!working;
  $('working-title').textContent=stages.find(([id])=>id===run.currentNodeId)?.[1]||'正在处理…';
  const check=run.imageCheck;
  if(check?.status==='running'&&working)$('working-title').textContent=`${run.result?.provisional?'Excel 已生成，':''}${check.phase==='focus'?'正在检查工序重点':'正在检查图片'} ${check.completed}/${check.total}`;
  $('working-detail').textContent=check?.status==='running'?`${check.processName??''}${check.imageName?' / '+check.imageName:''}。检查结果会自动更新。`:'任务在服务端执行，进度会自动更新。';
  $('run-error').hidden=!run.error; $('run-error').textContent=run.error||'';
  $('result-panel').hidden=!run.result;
  if(run.result) {
    $('delivery-status').textContent=run.result.provisional?`Excel 已生成，可以下载。图片与 AI 工序检查${run.status==='cancelled'?'已取消':run.status==='failed'?'失败，需继续任务或人工复核':run.busy?'尚未完成，报告完成后自动更新':'已中断，可点击继续任务'}；当前不能视为检查通过。`:'Excel 与检查报告已生成，请查看分项结果及人工复核提示。';
    $('delivery-status').className=run.result.provisional?'quality-warning':'muted small';
    $('downloads').replaceChildren(...run.result.artifacts.map(file=>{const link=node('a',undefined,'download-link');link.href=adminUrl(file.url);link.append(node('span',file.name),node('strong',file.name.endsWith('.json')?'下载图片评分 ↓':'下载 Excel ↓'));return link;}));
    const reviews=run.result.output?.processReviews; const target=$('reviews');target.replaceChildren();
    if(Array.isArray(reviews)&&reviews.length) {
      const table=node('table',undefined,'score-table');const head=node('tr');head.append(node('th','工序'),node('th','评分'));table.append(head);
      for(const review of reviews){const row=node('tr');row.append(node('td',review.processName||review.resolvedProcessName||review.requestedProcess||review.processId),node('td',`${review.score} / 100`));table.append(row);} target.append(table);
    }
    const quality=run.result.output?.imageQuality;
    if(quality) {
      const pixelQuality=quality.ruleVersion==='pixel-quality-v1.23.0';
      target.append(node('h2',`图片质量评分：${quality.overallScore==null?'未评分':`${quality.overallScore} / 100`}`));
      target.append(node('p',pixelQuality?`共 ${quality.totalImages} 张，已评分 ${quality.scoredUniqueImages} 张不同图片；${quality.thresholdReminderCount??0} 张不通过，${quality.warningCount??0} 张警告，${quality.errorCount??0} 张计算异常；独立AI工序重点待复核 ${quality.focusNeedsReviewCount??0} 项。`:`共 ${quality.totalImages} 张，已评分 ${quality.scoredUniqueImages} 张不同图片；${quality.reminderCount??0} 张需修改/复核（${quality.thresholdReminderCount??quality.reminderCount??0} 张分数≤${quality.alertThreshold??80}，${quality.uncertaintyReminderCount??0} 张证据需复核，可重叠）；失败 ${quality.errorCount} 张，待确认 ${quality.needsReviewCount} 张；工序重点待复核 ${quality.focusNeedsReviewCount??0} 项。`,'muted small'));
      target.append(node('p',quality.scoringNote,'muted small'));
      if(quality.failureNote)target.append(node('p',quality.failureNote,'quality-warning small'));
      if(quality.calibrationExperimental) target.append(node('p',`当前校准仅有 ${quality.calibrationSampleCount} 张参考图，属于实验性参数，尚未进行独立样例验证。`,'muted small'));
      if(quality.images.length) {
        const table=node('table',undefined,'score-table');const head=node('tr');head.append(node('th','工序 / 图片'),node('th',pixelQuality?'评分方式 / 状态':'整体外框 / 建议'),node('th','图片评分'));table.append(head);
        for(const image of quality.images) {
          const row=node('tr'), checked=image.result;
          const detail=checked?(checked.referenceResult?`像素测量 · ${checked.grade}`:`${checked.subjectRatio==null?'未知':`${(checked.subjectRatio*100).toFixed(1)}%`} · ${{normal:'正常',excessive_whitespace:'留白偏多，建议裁剪',quality_warning:'质量警告，请查看扣分原因',needs_review:'需要人工确认'}[checked.status]}`):`识别失败：${image.error}`;
          const cell=node('td',`${image.processName} / ${image.path.split('/').pop()}`); cell.title=checked?.reason||image.error||'';
          row.append(cell,node('td',image.fallback?image.fallback.reason:detail),node('td',image.fallback?'0 / 100 · 分析失败，需复核':checked?.score==null?'未评分':`${checked.score} / 100`));table.append(row);
        } target.append(table);
        for(const image of quality.images) if(image.result?.components) { const details=node('details',undefined,'quality-detail');details.append(node('summary',`${image.processName} / ${image.path.split('/').pop()} · ${image.result.score??'未评分'} 分${image.result.reminder?' · 需要修改':''}`));const content=node('div');renderImageAssessment(content,{...image.result,operationFocus:image.operationFocus,focusError:image.focusError});details.append(content);target.append(details); }
        for(const image of quality.images)if(image.fallback){const details=node('details',undefined,'quality-detail');details.append(node('summary',`${image.processName} / ${image.path.split('/').pop()} · 0 分 · 分析失败，需复核`));const content=node('div');renderImageAssessment(content,image.fallback);details.append(content);target.append(details);}
      }
    }
  }
  $('resume-button').hidden=working||!!question||!['running','failed'].includes(run.status);
  $('cancel-button').hidden=['completed','terminated','cancelled'].includes(run.status); $('cancel-button').disabled=pending;
  $('reuse-button').disabled=pending;
}
async function mutate(action,data={}) {
  if(!current||pending) return;
  const id=current.id, ticket=generation; pending=true; notice(''); render(current);
  try { const result=await api(`/api/runs/${id}/${action}`,data); if(ticket===generation) { pending=false;render(result.run); } await refreshList(); }
  catch(error) { if(ticket===generation) notice(error.message); }
  finally { pending=false;if(current&&ticket===generation) render(current); }
}
function answer(text,questionId) { return mutate('answer',{questionId,text}); }
$('create-form').addEventListener('submit',async event=>{
  event.preventDefault();if(pending) return;const form=event.currentTarget;const values=Object.fromEntries(new FormData(form));
  const editorInfo=editorSopInfo(String(values.projectName||'').trim());
  const missing=[];
  for(const [key,label] of [['documentNumber','文档编号'],['sopName','SOP 名称'],['author','编制人']]) {
    if(!String(values[key]||'').trim()) { if(editorInfo&&editorInfo[key]) values[key]=editorInfo[key]; else missing.push(label); }
  }
  if(missing.length) { notice(`${missing.join('、')} 没填，逐工序录入里也没有这个项目的封面信息。在这里补上，或先去「逐工序录入」填一次。`); return; }
  if(values.sopType==='factory_test') values.factoryTestProcesses=String(values.factoryTestProcesses).split(/\r?\n/u).map(value=>value.trim()).filter(Boolean); else delete values.factoryTestProcesses;
  for(const key of ['revisionReason','revisionContent']) {if(values.sopType==='assemble')values[key]=String(values[key]||'').trim()||(editorInfo?editorInfo[key]||'':'');else delete values[key];}
  pending=true;$('start-button').disabled=true;notice('');
  try { const result=await api('/api/runs',values);selectedId=result.run.id;remember(selectedId);generation++;pending=false;render(result.run);await refreshList(); }
  catch(error){notice(error.message);}finally{pending=false;$('start-button').disabled=false;}
});
$('answer-form').addEventListener('submit',event=>{event.preventDefault();if(current?.pendingQuestion) void answer($('answer-text').value,current.pendingQuestion.id);});
$('sop-type').addEventListener('change',factoryVisibility);
$('create-form').elements.projectName.addEventListener('input',refreshCoverHint);
$('new-task').addEventListener('click',()=>newTask());
$('fill-example').addEventListener('click',()=>{const form=$('create-form');form.elements.projectName.value='GPOS730';form.elements.documentNumber.value='CKD-001';form.elements.sopName.value='Assembly Test SOP';form.elements.author.value='Patrick Xu';if(form.elements.sopType.value==='factory_test')form.elements.factoryTestProcesses.value='Camera Test\nKey Test';});
$('resume-button').addEventListener('click',()=>mutate('resume'));
$('cancel-button').addEventListener('click',()=>mutate('cancel'));
$('reuse-button').addEventListener('click',()=>{if(current)newTask(current.inputs);});
$('refresh').addEventListener('click',()=>refreshList().catch(error=>notice(error.message)));
let polling=false;
setInterval(async()=>{if(polling||pending||!selectedId||!current||(!current.busy&&current.status!=='running'))return;polling=true;const id=selectedId,ticket=generation;try{const result=await api(`/api/runs/${id}`);if(ticket===generation){render(result.run);await refreshList();}}catch(error){if(ticket===generation)notice(`无法连接本地服务：${error.message}`);}finally{polling=false;}},1200);
(async()=>{try{const status=await api('/api/status');$('library-status').textContent=status.libraryReady?'本地资料库已就绪':'资料库未找到';if(!status.libraryReady)notice('未找到 Library。请设置 CKD_LIBRARY 指向 ckd-library-v2，再重新启动本地界面。');await refreshList();let saved;try{saved=localStorage.getItem('ckd.selectedTask');}catch{}if(saved)await selectTask(saved);}catch(error){notice(error.message);}factoryVisibility();prefillEditorInfo();})();

$('check-library').addEventListener('click',()=>{ $('validation-panel').hidden=false; $('validation-panel').scrollIntoView({block:'start',behavior:'smooth'}); });
$('close-validation').addEventListener('click',()=>{ $('validation-panel').hidden=true; });
$('validation-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('validate-button');button.disabled=true;button.textContent='正在检查…';
  $('validation-summary').textContent='正在逐个检查资料文件，请稍候…';$('validation-errors').replaceChildren();
  try {
    const report=await api('/api/library/validate',{sopType:$('validation-type').value,templateLanguage:$('validation-language').value});
    $('validation-summary').textContent=report.valid?`检查完成：${report.scannedFiles} 个JSON文件、${report.checkedAssetFiles??0} 个文本/图片，${report.checkedEntries} 条 JSON，未发现语法错误。`:`检查完成：${report.scannedFiles+(report.checkedAssetFiles??0)} 个资料文件中，${report.invalidFiles} 个文件有问题，共 ${report.errorCount} 处。`;
    const fragment=document.createDocumentFragment();
    for(const error of report.errors){const card=node('div',undefined,'validation-error');card.append(node('code',error.file),node('strong',error.line===null?'无法读取':`第 ${error.line} 行${error.column===null?'':`，第 ${error.column} 列`}`),node('p',error.message));fragment.append(card);}
    $('validation-errors').replaceChildren(fragment);
  }catch(error){$('validation-summary').textContent=`检查未完成：${error.message}`;}
  finally{button.disabled=false;button.textContent='再次检查';}
});

const imageDimensionLabels={clarity:'清晰度',completeness:'内容完整性',exposure:'亮度与曝光',composition:'构图与留白',obstruction:'遮挡、反光与阴影',color:'色彩',artifacts:'分辨率与瑕疵',resolution:'分辨率与噪点',damage:'画面损坏'};
const capLabels={criticalUnreadable:'关键内容无法判断',detailsBlurred:'主体可辨但细节明显模糊',excessiveWhitespace:'空白 >80% 或主体 <10%',fineDetailUnverified:'细节未达验收要求',key_content_unrecognizable:'关键内容无法判断',subject_blurrable:'主体模糊但可辨识',blank_or_tiny_subject:'非文档图大面积留白',detail_unacceptable:'细节无法验收'};
let imageDefaults=null, calibrationJobId=null, calibrationPolling=false, imagePreviewUrl=null,imageReadOnly=false,policyWeightKeys=[],policyCapKeys=[];
function applyImagePolicyResponse(value){
  imageDefaults=value.defaults;imageReadOnly=!!value.readOnly;fillImagePolicy(value.policy);
  $('save-image-policy').hidden=imageReadOnly;$('reset-image-policy').hidden=imageReadOnly;$('image-threshold').disabled=imageReadOnly;
  if(imageReadOnly){
    $('image-scoring-description').textContent='V1.23.0 固定像素评分：七维测量 → 逐维校准 → 按总权重归一化 → offset 与条件上限。评分不调用 AI；有操作说明时另行执行 AI 工序重点检查。历史任务保留原评分。';
    $('image-caps-description').textContent='客户固定配置：三个上限为100，等于不限制；细节无法验收上限为90。触发条件不代表一定降低当前总分。';
    $('image-threshold-label').textContent='不通过阈值（低于此值）；80至95为警告，95起良好';
    $('image-calibration-description').textContent='采用客户交接包中的清晰度校准曲线，其余六维保持原始分。本次不开放重新拟合或自动学习。';
    $('image-policy-message').textContent='当前参数来自客户 V1.23.0 配置，只读展示。';
  }
}
function fillImagePolicy(policy){
  policyWeightKeys=Object.keys(policy.weights);policyCapKeys=Object.keys(policy.caps);
  for(const [container,values,prefix,labels] of [['image-weights',policy.weights,'weight-',imageDimensionLabels],['image-caps',policy.caps,'cap-',capLabels]]){
    $(container).replaceChildren(...Object.entries(values).map(([key,value])=>{const label=node('label',undefined,'field');label.append(node('span',labels[key]??key));const input=node('input');input.type='number';input.min='0';input.max='100';input.step='1';input.id=prefix+key;input.value=value??'';input.required=prefix==='weight-';input.disabled=imageReadOnly;input.addEventListener('input',updateWeightTotal);label.append(input);return label;}));
  } $('image-threshold').value=policy.alertThreshold;updateWeightTotal();
}
function updateWeightTotal(){const total=policyWeightKeys.reduce((sum,key)=>sum+Number($('weight-'+key)?.value||0),0);$('weight-total').textContent=imageReadOnly?`合计 ${total}（按总权重归一化）`:`合计 ${total} / 100`;$('weight-total').className=imageReadOnly||total===100?'muted':'quality-warning';}
function collectImagePolicy(){return {alertThreshold:Number($('image-threshold').value),weights:Object.fromEntries(policyWeightKeys.map(key=>[key,Number($('weight-'+key).value)])),caps:Object.fromEntries(policyCapKeys.map(key=>[key,$('cap-'+key).value===''?null:Number($('cap-'+key).value)]))};}
function renderPixelAssessment(target,result){
  target.replaceChildren();const ref=result.referenceResult;
  const hero=node('div',undefined,`quality-score${result.scoringStatus!=='good'||result.reminder?' quality-warning':''}`);hero.append(node('strong',`${result.score} / 100`),node('span',result.grade));target.append(hero);
  target.append(node('p',`V1.23.0 · ${result.cached?'复用像素分析缓存':'本次像素计算'} · 低于80不通过，80至95为警告，95起良好`,'muted small'));
  target.append(node('p',`原始加权 ${result.baseScore} · 校准后加权 ${result.calibratedScore} · offset ${result.calibrationOffset}`,'muted small'));
  if(result.dimensionErrors?.length){target.append(node('p','存在维度计算失败：总分包含70分兜底，必须人工复核。','quality-warning'));for(const e of result.dimensionErrors)target.append(node('p',`${e.label}：${e.error}`,'quality-warning small'));}
  const table=node('table',undefined,'score-table component-table'),header=node('tr');for(const title of ['评分项目','原始分 / 100','校准分 / 100','权重','计算依据'])header.append(node('th',title));table.append(header);
  for(const c of result.components){const row=node('tr');for(const text of [c.label,c.rawScore,c.score,`${c.weight}/97`,`${c.methodLabel}：${ref.analysis[c.key].notes}`])row.append(node('td',String(text)));table.append(row);}const scroll=node('div',undefined,'pixel-table-scroll');scroll.append(table);target.append(scroll);
  for(const c of result.appliedCaps??[])target.append(node('p',`触发条件：${c.reason}；上限${c.maximum}分${c.limited?'，已限制总分':'，当前总分未被降低'}。`,'small'));
  const metrics=node('details');metrics.append(node('summary','查看七维测量指标'));
  for(const c of result.components){metrics.append(node('h3',c.label));for(const [key,value] of Object.entries(c.metrics))metrics.append(node('p',`${key}：${value}`,'small'));}target.append(metrics);
  if(result.operationFocus)target.append(node('p',`独立AI工序重点检查：${result.operationFocus.comment}（不影响图片评分）`,'small'));
  else if(result.focusError)target.append(node('p',`独立AI工序重点检查未完成：${result.focusError}；像素评分已保留。`,'quality-warning small'));
  else target.append(node('p','未提供操作说明，本次只评估图片通用质量。','muted small'));
}
function renderImageAssessment(target,result){
  if(result.referenceResult){renderPixelAssessment(target,result);return;}
  if(result.status==='analysis_failed'){target.replaceChildren(node('h3','0 / 100 · 分析失败，必须复核','quality-warning'),node('p',result.reason,'quality-warning'),node('p','原始错误：'+result.error,'small'),node('p',result.recommendations.join('；'),'small'));return;}
  target.replaceChildren();const hero=node('div',undefined,`quality-score${result.reminder?' quality-warning':''}`);hero.append(node('strong',result.score==null?'待确认':`${result.score} / 100`),node('span',`${result.grade??''}${result.reminder?' · 需要修改 / 复核':''}`));target.append(hero);
  target.append(node('p',result.subject,'muted small'));
  target.append(node('p',`原始总分 ${result.baseScore??'未评分'} · offset ${Number(result.calibrationOffset??0).toFixed(2)} · 校准后 ${result.calibratedScore??'未评分'} · 阈值 ${result.alertThreshold}（含等于）`,'muted small'));
  const statuses={uncalibrated:'尚未进行新规则校准',model_mismatch:'模型不匹配，未应用校准',version_mismatch:'分析规则已升级，请重新校准',weights_mismatch:'权重已改变，请重新校准',applied:'已应用数学校准'};target.append(node('p',`${statuses[result.calibrationStatus]??result.calibrationStatus}；${result.cached?'复用分析缓存':'本次识别'}${result.calibrationExperimental?'；样本较少，校准为实验性':''}`,'muted small'));
  if(result.conservativeReview){target.append(node('p','已独立复核；分项采用较保守档位的下限。','muted small'));for(const warning of result.conservativeReview.warnings)target.append(node('p',warning,'quality-warning small'));}
  if(result.calibrationIncreaseBlocked)target.append(node('p',`拟合offset为 ${result.calibrationRequestedOffset.toFixed(2)}；按宁低原则，本次不接受向上加分。`,'quality-warning small'));
  if(result.status==='needs_review')target.append(node('p','分析置信度不足，不能可靠输出总分，请人工确认。','quality-warning small'));
  for(const cap of result.appliedCaps??[])target.append(node('p',`触发上限 ${cap.maximum} 分：${cap.reason}`,'quality-warning small'));
  const table=node('table',undefined,'score-table component-table');const header=node('tr');header.append(node('th','评分项目'),node('th','得分'),node('th','分析 / 扣分原因'));table.append(header);
  for(const item of result.components??[]){const row=node('tr');row.append(node('td',item.label),node('td',`${item.score} / ${item.maximum}`),node('td',`${item.comment}（置信度 ${Math.round(item.confidence*100)}%）`));table.append(row);}target.append(table);
  if(result.conservativeReview){const detail=node('details');detail.append(node('summary','查看两次独立观察'));for(const [label,seen] of [['初检',result.conservativeReview.first],['保守复核',result.conservativeReview.review]]){detail.append(node('h3',label));for(const [key,metric] of Object.entries(seen.metrics))detail.append(node('p',`${imageDimensionLabels[key]}：${metric.comment}`,'small'));}target.append(detail);}
  if(result.framingGeometry){const g=result.framingGeometry;target.append(node('h3','构图细分'));target.append(node('p',`无关留空估计 ${(g.emptyRatio*100).toFixed(1)}%；空间利用 40%，背景干扰 40%，主体突出 20%。`,'muted small'));for(const part of g.parts)target.append(node('p',`${part.label}：${part.score} / ${Number(part.maximum.toFixed(2))}`,'small'));}
  if(result.operationFocus){const f=result.operationFocus;target.append(node('p',`工序重点：${{identified:'描述中的部件与工序匹配',too_small:'重点部件偏小',not_visible:'必要细节未在描述中出现',needs_review:'证据不足，需要人工确认'}[f.status]??f.status}；${f.comment}`,'small'));}else if(result.focusError)target.append(node('p','工序重点检查未完成：'+result.focusError,'quality-warning small'));else target.append(node('p','没有操作说明，未判断具体工序重点。','muted small'));
  target.append(node('p',`有效内容占比估计 ${Math.round(result.effectiveContentRatio*100)}% · 无关背景估计 ${Math.round(result.unrelatedBackgroundRatio*100)}% · 整体外框占比 ${result.subjectRatio==null?'未知':(result.subjectRatio*100).toFixed(1)+'%'}`,'muted small'));
  if(result.estimatedEffectiveContentRatio!==undefined&&Math.abs(result.estimatedEffectiveContentRatio-result.effectiveContentRatio)>.001)target.append(node('p',`模型原始有效内容估计 ${Math.round(result.estimatedEffectiveContentRatio*100)}%，评分时按整体外框面积限制为 ${(result.effectiveContentRatio*100).toFixed(1)}%。`,'muted small'));
  if(result.mainDeductions?.length){target.append(node('h3','主要扣分'));for(const item of result.mainDeductions.slice(0,3))target.append(node('p',`${item.label}扣 ${item.lost} 分：${item.comment}`,'small'));}
  if(result.recommendations?.length)target.append(node('p',`建议：${result.recommendations.join('；')}`,'small'));
  if(result.nearestReferences?.length){target.append(node('h3','最接近的基准图片'));const refs=node('div',undefined,'reference-grid');for(const ref of result.nearestReferences){const card=node('div');const img=node('img');img.src=adminUrl(`/api/images/references/${ref.imageHash}`);img.alt=ref.file;img.loading='lazy';img.addEventListener('error',()=>{img.hidden=true;});card.append(img,node('p',`${ref.file} · 人工 ${ref.humanScore} 分 · 指标距离 ${ref.distance}`,'small'));refs.append(card);}target.append(refs);}
}
async function loadCalibration(){
  const value=await api('/api/images/calibration');$('sample-directory').textContent=value.samplesDir;const c=value.calibration;
  if(value.mode==='fixed'){
    $('sample-directory').hidden=true;for(const id of ['calibrate-images','resume-image-calibration','cancel-image-calibration'])$(id).hidden=true;
    $('calibration-status').textContent='固定清晰度曲线：slope 0.7808，intercept 21.97，覆盖区间31.7–75.1；区间外补偿衰减，其余六维恒等映射。';
    $('calibration-errors').replaceChildren();return;
  }
  $('calibration-status').textContent=c?`当前 ${c.sampleCount} 张样本，拟合 offset ${c.parameters.bias.toFixed(2)}${c.parameters.bias>0?'（保守规则执行0，不加分）':''}${c.weightsHash!==value.weightsHash?'；权重已改变，请重新校准':''}`:'新七项规则尚未校准，可先测试未校准分数。';
}
$('image-settings').addEventListener('click',async()=>{$('image-settings-panel').hidden=false;$('image-settings-panel').scrollIntoView({block:'start',behavior:'smooth'});try{const result=await api('/api/images/policy');applyImagePolicyResponse(result);await loadCalibration();}catch(error){$('image-policy-message').textContent=error.message;}});
$('close-image-settings').addEventListener('click',()=>{$('image-settings-panel').hidden=true;});
$('reset-image-policy').addEventListener('click',()=>{if(imageDefaults){fillImagePolicy(imageDefaults);$('image-policy-message').textContent='已填入默认值，点击保存后生效。';}});
$('image-policy-form').addEventListener('submit',async event=>{event.preventDefault();if(imageReadOnly)return;const button=$('save-image-policy');button.disabled=true;try{const result=await api('/api/images/policy',collectImagePolicy());fillImagePolicy(result.policy);$('image-policy-message').textContent='设置已保存。新的评估使用新设置；已完成的报告不变。修改权重后请重新校准。';await loadCalibration();}catch(error){$('image-policy-message').textContent=error.message;}finally{button.disabled=false;}});
$('image-test-form').addEventListener('submit',async event=>{event.preventDefault();const file=$('image-test-file').files[0];if(!file)return;const button=$('test-image-button');button.disabled=true;$('image-test-result').replaceChildren();$('image-test-message').textContent='正在分析图片，请稍候…';try{if(!['image/png','image/jpeg'].includes(file.type)||file.size>10*1024*1024)throw new Error('请选择 10 MiB 以内的 PNG/JPEG 图片。');if(imagePreviewUrl)URL.revokeObjectURL(imagePreviewUrl);imagePreviewUrl=URL.createObjectURL(file);$('image-test-preview').src=imagePreviewUrl;$('image-test-preview').hidden=false;const operationContext=$('image-test-context').value.trim();const response=await fetch(adminUrl('/api/images/quality'+(operationContext?'?context='+encodeURIComponent(operationContext):'')),{method:'POST',headers:{'Content-Type':file.type,'X-CKD-UI':'1'},body:file});const value=await response.json();if(response.status===401&&adminBase)location.assign(adminBase+'/login');if(!response.ok)throw new Error(value.error);renderImageAssessment($('image-test-result'),value.fallback??value.result);$('image-test-message').textContent=value.fallback?'分析失败，以0分兜底并警告；可显式重试，原图未修改。':'检测完成。图片未被修改或自动裁剪。';}catch(error){$('image-test-message').textContent=error.message;}finally{button.disabled=false;}});
function displayCalibrationJob(job){
  $('calibration-status').textContent=`${{running:'正在校准',completed:'校准完成',interrupted:'校准中断',partial_failed:'部分失败，保留原校准',failed:'校准失败',cancelled:'已取消'}[job.status]??job.status} · ${job.completed}/${job.total} · 新识别 ${job.counts.analyzed}，缓存 ${job.counts.reused}${job.error?' · '+job.error:''}`;
  $('calibration-errors').replaceChildren(...[...(job.warnings??[]),...job.items.filter(item=>item.error).map(item=>`${item.file}: ${item.error}`)].map(text=>node('p',text,'quality-warning')));
  $('calibrate-images').disabled=job.status==='running';$('cancel-image-calibration').hidden=job.status!=='running';$('resume-image-calibration').hidden=!['interrupted','failed','partial_failed'].includes(job.status);
  if(job.status==='completed'&&job.report?.calibration)$('calibration-status').textContent+=` · offset ${job.report.calibration.parameters.bias.toFixed(2)}`;
}
async function runCalibration(action){try{const result=await api(action==='create'?'/api/images/calibrate':`/api/images/calibration/jobs/${calibrationJobId}/${action}`,{});calibrationJobId=result.job.id;try{localStorage.setItem('ckd.imageCalibrationJob',calibrationJobId);}catch{}displayCalibrationJob(result.job);}catch(error){$('calibration-status').textContent=error.message;$('calibrate-images').disabled=false;}}
$('calibrate-images').addEventListener('click',()=>{$('calibrate-images').disabled=true;void runCalibration('create');});$('resume-image-calibration').addEventListener('click',()=>runCalibration('resume'));$('cancel-image-calibration').addEventListener('click',()=>runCalibration('cancel'));
try{calibrationJobId=localStorage.getItem('ckd.imageCalibrationJob');}catch{}
setInterval(async()=>{if(imageReadOnly||!calibrationJobId||calibrationPolling||$('image-settings-panel').hidden)return;calibrationPolling=true;try{const result=await api(`/api/images/calibration/jobs/${calibrationJobId}`);displayCalibrationJob(result.job);if(['completed','cancelled'].includes(result.job.status)){calibrationJobId=null;try{localStorage.removeItem('ckd.imageCalibrationJob');}catch{}}}catch(error){$('calibration-status').textContent=error.message;}finally{calibrationPolling=false;}},1500);

// Overall Library maintenance is separate from reference-image calibration.
const syncStageLabels={validate:'语法检查',translate:'中英文同步',images:'图片评分',summaries:'图片描述与摘要'};
const syncStatusLabels={running:'正在同步',interrupted:'已中断，可恢复',completed:'已完成',partial_failed:'部分失败，可恢复',failed:'失败，可恢复',cancelled:'已取消'};
let librarySyncId=null,librarySyncBusy=false,librarySyncPolling=false;
try{librarySyncId=localStorage.getItem('ckd.librarySyncJob');}catch{}
function showLibrarySync(job){
 const changed=librarySyncId!==job.id;librarySyncId=job.id;librarySyncBusy=job.status==='running';try{localStorage.setItem('ckd.librarySyncJob',job.id);}catch{}
 const c=job.counts,files=job.sync?.deletedFiles??job.sync?.deletions?.filter(d=>d.kind==='file').length??0,dirs=job.sync?.deletedDirectories??job.sync?.deletions?.filter(d=>d.kind==='directory').length??0;
 $('library-sync-status').textContent=`${job.input.dryRun?'预览 · ':''}${syncStatusLabels[job.status]??job.status} · ${syncStageLabels[job.sync?.stage]??'准备'} · 更新 ${c.updated}，复用 ${c.reused}，保留/跳过 ${c.skipped}，计划 ${c.planned}，删除文件 ${files} / 目录 ${dirs}，冲突 ${c.conflict}，错误 ${c.error} · 任务 ${job.id}`;
 $('start-library-sync').disabled=librarySyncBusy;$('plan-library-sync').disabled=librarySyncBusy;$('cancel-library-sync').hidden=!librarySyncBusy;$('resume-library-sync').hidden=!['interrupted','partial_failed','failed'].includes(job.status);
 const stages=node('ol');for(const [key,label] of Object.entries(syncStageLabels)){const stage=job.sync?.stages[key];stages.append(node('li',`${label}：${stage?`${stage.completed}/${stage.total} · ${{running:'进行中',completed:'完成',failed:'失败',interrupted:'中断',cancelled:'取消'}[stage.status]}`:'未开始'}`));}$('library-sync-stages').replaceChildren(stages);
 const results=$('library-sync-results');if(changed||!$('library-sync-detail-button')){results.replaceChildren();const overview=node('p',undefined,'muted small');overview.id='library-sync-overview';results.append(overview);const button=node('button','查看详细结果','button secondary');button.type='button';button.id='library-sync-detail-button';button.addEventListener('click',loadLibrarySyncDetails);results.append(button);const detail=node('div');detail.id='library-sync-detail-content';results.append(detail);}
 const stats=job.sync?.imageStats;$('library-sync-overview').textContent=stats?.unique?`图片 ${stats.paths} 个路径，${stats.unique} 张不同图片；${stats.needsReview} 张需修改/复核，${stats.errors} 张识别失败。${job.warningCount?`另有 ${job.warningCount} 条提示。`:''}`:job.warningCount?`${job.warningCount} 条提示，点击查看详细结果。`:'';
 if(job.error&&!$('library-sync-detail-content').textContent)$('library-sync-overview').textContent=job.error;
}
async function loadLibrarySyncDetails(){
 const id=librarySyncId,button=$('library-sync-detail-button');button.disabled=true;button.textContent='正在加载详细结果…';
 try{const {job}=await api(`/api/library/jobs/${id}`);if(id!==librarySyncId)return;renderLibrarySyncDetails(job);button.textContent='刷新详细结果';}
 catch(error){if(id===librarySyncId)$('library-sync-detail-content').replaceChildren(node('p',error.message,'quality-warning'));button.textContent='重试加载详细结果';}
 finally{button.disabled=false;}
}
function copyIssue(value){const b=node('button','复制路径 / 错误','copy-error');b.type='button';b.addEventListener('click',async()=>{try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);else{const t=node('textarea');t.value=value;document.body.append(t);t.select();const copied=document.execCommand('copy');t.remove();if(!copied)throw new Error('请选中路径后复制。');}b.textContent='已复制';}catch(e){notice(e.message);}});return b;}
function renderLibrarySyncDetails(job){
 const results=$('library-sync-detail-content');results.replaceChildren();if(job.error)results.append(node('p',job.error,'quality-warning'));
 if(job.sync?.validation&&!job.sync.validation.valid)for(const error of job.sync.validation.errors)results.append(node('p',`${error.file}${error.line?` 第${error.line}行${error.column?`第${error.column}列`:''}`:''}：${error.message}`,'quality-warning small'));
 for(const warning of job.warnings){const hash=/image ([a-f0-9]{64})/u.exec(warning)?.[1],paths=(job.sync?.images??[]).filter(i=>i.imageHash===hash).map(i=>i.path).filter(p=>!warning.includes(p));const message=paths.length?`${warning}\n${[...new Set(paths)].join('\n')}`:warning;results.append(node('p',message,'quality-warning small issue-path'),copyIssue(message));}
 const issues=job.items.filter(i=>['error','conflict'].includes(i.status)||i.message?.includes('Deleted')||i.message?.includes('retained'));if(issues.length){const detail=node('details');detail.append(node('summary',`删除、保留及错误记录（${issues.length}）`));for(const i of issues){const message=`${i.key}：${i.message??i.status}`;detail.append(node('p',message,'small issue-path'),copyIssue(message));}results.append(detail);}
 const images=job.sync?.images??[],unique=new Map(images.map(i=>[i.imageHash,i])),allPaths=new Map();for(const image of images){const paths=allPaths.get(image.imageHash)??[];if(!paths.includes(image.path))paths.push(image.path);allPaths.set(image.imageHash,paths);}if(unique.size){const section=node('details');section.append(node('summary',`图片 ${images.length} 个路径，${unique.size} 张不同图片；${[...unique.values()].filter(i=>i.fallback||i.result?.reminder).length} 张需修改/复核。`));let listed=false;section.addEventListener('toggle',()=>{if(!section.open||listed)return;listed=true;for(const image of unique.values()){const detail=node('details');detail.append(node('summary',`${image.path} · ${image.fallback?0:image.result?.score??'未评分'}${image.fallback||image.result?.reminder?' · 需复核':''}`));let rendered=false;detail.addEventListener('toggle',()=>{if(!detail.open||rendered)return;rendered=true;const paths=allPaths.get(image.imageHash)??[image.path];detail.append(node('code',paths.join('\n'),'issue-path'),copyIssue(paths.join('\n')));if(image.result||image.fallback){const content=node('div');renderImageAssessment(content,image.fallback??image.result);detail.append(content);}else detail.append(node('p',image.error,'quality-warning'));});section.append(detail);}});results.append(section);}
}
async function loadLibrarySyncHistory(){const {jobs}=await api('/api/library/jobs/progress');const history=$('library-sync-history');history.replaceChildren();for(const job of jobs.filter(j=>j.kind==='sync').slice(0,15)){const button=node('button',`${new Date(job.createdAt).toLocaleString('zh-CN')} · ${job.input.dryRun?'预览':'同步'} · ${syncStatusLabels[job.status]??job.status}`,'text-button');button.type='button';button.addEventListener('click',()=>showLibrarySync(job));history.append(button);}if(librarySyncId){const job=jobs.find(j=>j.id===librarySyncId);if(job)showLibrarySync(job);else try{showLibrarySync((await api(`/api/library/jobs/${librarySyncId}/progress`)).job);}catch{const newest=jobs.find(j=>j.kind==='sync');if(newest)showLibrarySync(newest);}}else{const newest=jobs.find(j=>j.kind==='sync');if(newest)showLibrarySync(newest);}}
$('sync-library').addEventListener('click',async()=>{$('library-sync-panel').hidden=false;$('library-sync-panel').scrollIntoView({block:'start',behavior:'smooth'});try{await loadLibrarySyncHistory();}catch(error){$('library-sync-status').textContent=error.message;}});
$('close-library-sync').addEventListener('click',()=>{$('library-sync-panel').hidden=true;});
$('open-reference-calibration').addEventListener('click',async()=>{$('image-settings-panel').hidden=false;try{const result=await api('/api/images/policy');applyImagePolicyResponse(result);await loadCalibration();$(imageReadOnly?'calibration-status':'calibrate-images').scrollIntoView({block:'center',behavior:'smooth'});}catch(error){$('image-policy-message').textContent=error.message;}});
async function librarySyncAction(action,dryRun=false){if(librarySyncBusy&&action==='start')return;const buttons=[$('start-library-sync'),$('plan-library-sync')];buttons.forEach(b=>b.disabled=true);try{const {job}=await api(action==='start'?'/api/library/sync':`/api/library/jobs/${librarySyncId}/${action}`,action==='start'?{dryRun}:{});showLibrarySync(job);}catch(error){$('library-sync-status').textContent=error.message;buttons.forEach(b=>b.disabled=librarySyncBusy);}}
$('start-library-sync').addEventListener('click',()=>librarySyncAction('start'));
$('plan-library-sync').addEventListener('click',()=>librarySyncAction('start',true));
$('resume-library-sync').addEventListener('click',()=>librarySyncAction('resume'));
$('cancel-library-sync').addEventListener('click',()=>librarySyncAction('cancel'));
setInterval(async()=>{if(!librarySyncId||!librarySyncBusy||librarySyncPolling||$('library-sync-panel').hidden)return;librarySyncPolling=true;try{const {job}=await api(`/api/library/jobs/${librarySyncId}/progress`);showLibrarySync(job);}catch(error){$('library-sync-status').textContent=error.message;}finally{librarySyncPolling=false;}},1500);

/** 工作台的「资料库」下拉：管理员 cookie 才能取到列表，取不到就隐藏。 */
async function loadWorkbenchLibraries() {
  const field = $('library-field'), select = $('create-library');
  if (!field || !select) return;
  try {
    const response = await fetch(adminUrl('/api/libraries'), { headers: { 'X-CKD-UI': '1' } });
    if (!response.ok) { field.hidden = true; return; }
    const { libraries } = await response.json();
    select.replaceChildren(...libraries.map(library => new Option(`${library.name}（${library.projects ?? 0} 个项目）`, library.master ? '' : library.account)));
    field.hidden = false;
  } catch { field.hidden = true; }
}
void loadWorkbenchLibraries();
