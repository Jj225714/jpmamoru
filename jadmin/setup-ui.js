const setupCard=document.createElement('section');
setupCard.className='card';
setupCard.innerHTML='<h2>分步安装</h2><p>统一管理员邮箱和密码在首次安装时设置。各平台分别验证登录，安装失败可重试。</p><p>JAPI 安装后，请先在其管理页面配置渠道，并在下方“统一配置”保存 API Key，然后执行账号验证。</p><table><thead><tr><th>步骤</th><th>状态</th><th>操作</th></tr></thead><tbody id="setupRows"></tbody></table><p id="setupNotice" role="status"></p>';
$('app').prepend(setupCard);
const setupSteps=[['admin','1. 管理后台'],['jiapi','2. JAPI'],['accounts','3. 账号与模型配置'],['image','4. Jimage'],['jichat','5. Jchat']];
async function refreshSetup(){
 try{
  const data=await api('/api/admin/setup');
  $('setupRows').replaceChildren();
  setupSteps.forEach(([key,label],index)=>{
   const tr=document.createElement('tr');
   const state=data.stages[key]||'pending';
   [label,({done:'已完成',running:data.busy?'正在安装':'安装中断，可重试',failed:'失败，可重试',pending:'待安装'})[state]||state].forEach(value=>{const td=document.createElement('td');td.textContent=value;tr.append(td);});
   const td=document.createElement('td');
   if(index){const button=document.createElement('button');button.textContent=key==='accounts'?'验证账号与模型':'安装 / 重试';button.disabled=!!data.busy||state==='done'||data.stages[setupSteps[index-1][0]]!=='done';button.onclick=async()=>{button.disabled=true;try{await api('/api/admin/setup',{method:'POST',body:JSON.stringify({stage:key})});await refreshSetup();}catch(e){$('setupNotice').textContent=e.message;button.disabled=false;}};td.append(button);}
   tr.append(td);$('setupRows').append(tr);
  });
  $('setupNotice').textContent=data.notice||'请按顺序安装；未安装的模块不会影响后台登录。';
 }catch(e){$('setupNotice').textContent=e.message;}
}
const setupLoad=load;
load=async function(){await refreshSetup();await setupLoad();};
setInterval(()=>{if(token&&!$('app').hidden)refreshSetup();},5000);
