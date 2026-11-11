import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto('http://127.0.0.1:3011/assets');
 await page.getByRole('combobox',{name:'资产范围',exact:true}).waitFor();
 await page.evaluate(async()=>{
  const {useAssetStore}=await import('/src/stores/use-asset-store.ts');
  const {uploadImage}=await import('/src/services/image-storage.ts');
  const refs=[];
  for(const [name,color] of [['B-green.png','green'],['C-blue.png','blue'],['A-red.png','red']]){
   const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillStyle=color;canvas.getContext('2d').fillRect(0,0,16,16);
   const image=await uploadImage(canvas.toDataURL());refs.push({id:name,name,type:'image/png',storageKey:image.storageKey});
  }
  useAssetStore.getState().addAsset({kind:'image',title:'Reuse fixture',coverUrl:'',tags:[],data:{dataUrl:'',width:16,height:16,bytes:10,mimeType:'image/png'},generation:{version:1,prompt:'首跳恢复 B C A',model:'gpt-image-2',parameters:{size:'1024x1024'},generatedAt:'2026-10-25T08:00:00+08:00',references:refs,source:{kind:'image'}}});
 });
 await page.getByRole('heading',{name:'Reuse fixture',exact:true}).click();
 const panel=page.getByRole('region',{name:'本地资产生成来源',exact:true});
 await panel.getByText('gpt-image-2',{exact:true}).waitFor();
 await panel.getByText('2026-10-25T08:00:00+08:00',{exact:true}).waitFor();
 const ordered=await panel.locator('li').allTextContents();if(!ordered[0].includes('B-green.png')||!ordered[1].includes('C-blue.png')||!ordered[2].includes('A-red.png'))throw Error('provenance order');
 await fs.mkdir('test-results/asset-reuse-fix',{recursive:true});await page.waitForTimeout(400);await page.screenshot({path:'test-results/asset-reuse-fix/local-provenance.png'});
 await page.locator('.ant-drawer-close').click();
 const reuse=page.getByRole('link',{name:'带入生图',exact:true});await reuse.click();
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('textarea')).some(input=>input.value==='首跳恢复 B C A'));
 const references=await page.locator('img[alt$=".png"]').evaluateAll(images=>images.map(image=>image.alt));
 if(JSON.stringify(references)!==JSON.stringify(['B-green.png','C-blue.png','A-red.png']))throw Error(JSON.stringify(references));
 await page.locator('textarea').first().fill('changed');
 await page.goBack();await page.getByRole('link',{name:'带入生图',exact:true}).click();
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('textarea')).some(input=>input.value==='首跳恢复 B C A'));
 await fs.mkdir('test-results/asset-reuse-fix',{recursive:true});await page.screenshot({path:'test-results/asset-reuse-fix/first-spa.png'});
 console.log('PASS local provenance model/time/parameters/reference order + first SPA click + repeat reuse without reload; prompt and ordered B/C/A references populated.');
}finally{await browser.close();}
