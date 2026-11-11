import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true});
const now=Date.now();
const statuses=['queued','running','succeeded','failed','canceled','uncertain','recoverable','retrying'];
let complete=false, readFailure=false; const actions=[];
const make=(status,id,provider='gpt')=>({job_id:id,model:provider==='gpt'?'gpt-image-2':'esrgan',status,created_at:now,updated_at:now,started_at:now,finished_at:['succeeded','failed','canceled'].includes(status)?now:null,elapsed_ms:61000,progress:{stage:status,percent:null},queue_mode:'encrypted_persistent',actions:{cancel:{allowed:status==='queued'},retry:{allowed:provider==='fal'&&status==='recoverable',mode:provider==='fal'&&status==='recoverable'?'resume_query':null}},result_job_id:status==='succeeded'?id:null,error:status==='failed'?{message:'failed'}:null});
try {
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 await page.addInitScript(()=>{window.notices=[];window.Notification=class{static permission='default';static async requestPermission(){this.permission='granted';return 'granted';}constructor(title,options){window.notices.push({title,options});}close(){}};});
 await page.route('**/api/providers/**',async route=>{
  const req=route.request(), url=new URL(req.url()), provider=url.pathname.includes('/fal/')?'fal':'gpt';
  if(req.method()==='POST') {actions.push(req.headers()['x-job-action']||'CREATE');return route.fulfill({json:make('running',url.pathname.split('/').at(-1),provider)});}
  if(readFailure)return route.fulfill({status:503,json:{}});
  const list=provider==='gpt'?url.pathname.endsWith('/jobs'):/\/jobs\/(esrgan|flux-fill|qwen-layered)$/.test(url.pathname);
  if(list){const items=url.searchParams.has('cursor')?[make('failed','older',provider)]:statuses.map((status,index)=>make(index===1&&complete?'succeeded':status,`${provider}-${index}`,provider));return route.fulfill({json:{items,next_cursor:url.searchParams.has('cursor')?null:'page2',retention_ms:604800000}});}
  const id=url.pathname.split('/').at(-1), index=Number(id.split('-').at(-1));
  return route.fulfill({json:{...make(index===1&&complete?'succeeded':statuses[index]||'succeeded',id,provider),result:{images:[{url:'https://example.invalid/result.png'}]}}});
 });
 await page.goto('http://127.0.0.1:3011/tasks');
 await page.evaluate(async()=>{
  const {useConfigStore}=await import('/src/stores/use-config-store.ts');const {useServerConfigStore}=await import('/src/services/server-config.ts');
  window.configStore=useConfigStore; window.accountStore=useServerConfigStore;
  useConfigStore.setState({config:{...useConfigStore.getState().config,channels:[{id:'g',name:'GPT test',provider:'general',baseUrl:'https://llm.zhitouzhuan.com/v1',apiKey:'test-A',apiFormat:'openai',models:[{name:'gpt-image-2',capability:'image'}]},{id:'f',name:'Fal test',provider:'fal',baseUrl:'https://queue.fal.run',apiKey:'fal-test',apiFormat:'openai',models:[]}]}});
  useServerConfigStore.setState({user:{id:'A',username:'A'},phase:'ready'});
 });
 await page.locator('[data-task-id="gpt-5"]').waitFor();
 if(!await page.locator('[data-task-id="gpt-5"]').getByRole('button',{name:'恢复查询'}).isDisabled())throw Error('uncertain enabled');
 await page.getByRole('button',{name:'下一页',exact:true}).click(); await page.locator('[data-task-id="older"]').waitFor();
 await page.getByRole('button',{name:'上一页',exact:true}).click(); await page.locator('[data-task-id="gpt-1"]').waitFor();
 await page.getByRole('button',{name:'允许任务完成通知'}).click();
 await page.waitForFunction(()=>Object.keys(localStorage).filter(key=>key.startsWith('task-completion:') && Object.values(JSON.parse(localStorage.getItem(key))).includes('watching')).length===4);
 complete=true;
 await page.getByRole('button',{name:'刷新当前页'}).click();
 await page.waitForFunction(()=>window.notices.length===4,{},{timeout:22000}).catch(async error=>{console.log(await page.evaluate(()=>({notices:window.notices,permission:Notification.permission,keys:Object.keys(localStorage).filter(k=>k.startsWith('task-completion')).map(k=>[k,localStorage.getItem(k)])})));throw error;}); // GPT plus three Fal sources
 await page.evaluate(()=>window.dispatchEvent(new Event('task-notification-permission')));
 await page.waitForTimeout(500); if(await page.evaluate(()=>window.notices.length)!==4)throw Error('duplicate notices');
 await page.locator('[data-task-id="gpt-2"]').getByRole('link',{name:'查看结果'}).click();
 await page.getByRole('link',{name:'打开 / 下载结果 1'}).waitFor();
 await page.reload(); await page.getByRole('link',{name:'打开 / 下载结果 1'}).waitFor();
 await page.evaluate(async()=>{window.accountStore=(await import('/src/services/server-config.ts')).useServerConfigStore;});
 await fs.mkdir('test-results/task-center',{recursive:true}); await page.screenshot({path:'test-results/task-center/detail.png'});
 readFailure=true; await page.getByRole('button',{name:'刷新当前页'}).click(); await page.getByText('查询或操作未完成',{exact:true}).waitFor(); readFailure=false;
 await page.getByRole('link',{name:'返回该渠道列表'}).click();
 await page.getByRole('combobox',{name:'任务渠道和模型'}).click(); await page.getByText('Fal test · Fal esrgan',{exact:true}).last().click();
 await page.locator('[data-task-id="fal-6"]').getByRole('button',{name:'恢复查询'}).click();
 if(actions.join(',')!=='retry')throw Error(`unexpected writes ${actions}`);
 await page.evaluate(()=>{window.accountStore.setState({user:{id:'B'},phase:'ready'});window.accountStore.setState({user:null,phase:'signed-out'});});
 // Local mode still permits configured channels, so enable server auth for the signed-out isolation check.
 await page.evaluate(()=>{window.__RUNTIME_CONFIG__={...window.__RUNTIME_CONFIG__,serverConfigEnabled:true};window.accountStore.setState({user:{id:'B'},phase:'ready'});window.accountStore.setState({user:null,phase:'signed-out'});});
 await page.getByText('当前账号没有可用的任务渠道，请登录或配置 GPT Image / Fal 渠道后选择。',{exact:true}).waitFor();
 if(await page.locator('[data-task-id]').count())throw Error('old account cards retained');
 await fs.mkdir('test-results/task-center',{recursive:true}); await page.screenshot({path:'test-results/task-center/signed-out.png'});
 console.log('PASS /tasks: GPT/Fal states, paging, uncertain disabled, result GET, read failure without create, resume query action, permission + dedup, account logout isolation.');
}finally{await browser.close();}
