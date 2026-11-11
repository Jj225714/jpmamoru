// Isolated browser UI contract test; HTTP responses are controlled fixtures, not production.
// Run from web/: node src/components/layout/membership-library-panel.e2e.mjs
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MembershipLibraryPanel} from '/src/components/layout/membership-library-panel.tsx';
import {useServerConfigStore} from '/src/services/server-config.ts';
const root=createRoot(document.getElementById('root'));
window.switchAccount=id=>{useServerConfigStore.setState({user:{id,email:'test@example.test'},phase:'ready'});root.render(React.createElement(MembershipLibraryPanel,{key:id}));};
window.switchAccount(1);
`;
const server=await createServer({configFile:false,root,resolve:{alias:{'@':resolve(root,'src')}},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[react(),{
    name:'membership-ui-test',resolveId(id){if(id==='virtual:membership-ui-test')return '\0membership-ui-test';},load(id){if(id==='\0membership-ui-test')return entry;},
    configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/__test')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__test','<div id="root"></div><script type="module" src="/@id/virtual:membership-ui-test"></script>'));});}
}]});
let browser;
try {
    await server.listen();browser=await chromium.launch({headless:true});
    const calls=[];let created=false,accepted=false;
    const team={id:'team-1',name:'Fixture Team',role:'admin',members:{'1':'admin','2':'read'},projects:[{id:'project-1',teamId:'team-1',name:'Fixture Project',role:'admin',members:{}}]};
    const setup=async()=>{
        const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(30000);
        await page.route('**/api/config-vault/**',async route=>{
            const req=route.request();const path=new URL(req.url()).pathname;const id=req.headers()['x-config-user'];
            calls.push({path,id,method:req.method(),body:req.postDataJSON()});
            let response={ok:true};
            if(req.method()==='GET')response={teams:created&&(id==='1'||accepted)?[{...team,...(id==='1'?{}:{role:'read',members:undefined,projects:[]})}]:[]};
            else if(path.endsWith('/memberships/teams')){created=true;response={team};}
            else if(path.endsWith('/invitations/accept')){accepted=true;response={team};}
            else if(path.endsWith('/invitations'))response={invitation:{id:'invite-1',token:'test-invite-token',expiresAt:Date.now()+3600000,targetId:'2',role:'read'}};
            else if(req.method()==='DELETE'&&path.endsWith('/members/2')){delete team.members['2'];accepted=false;}
            await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__test`,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>Boolean(window.switchAccount));return page;
    };
    const admin=await setup();await admin.getByLabel('新团队名称',{exact:true}).fill('Fixture Team');await admin.getByRole('button',{name:'创建团队',exact:true}).click();
    await admin.getByLabel('受邀账号ID',{exact:true}).fill('2');await admin.getByRole('button',{name:'生成定向邀请',exact:true}).click();
    await admin.getByLabel('新邀请码',{exact:true}).waitFor();assert.equal(await admin.getByLabel('新邀请码',{exact:true}).inputValue(),'test-invite-token');
    const member=await setup();await member.evaluate(()=>window.switchAccount(2));
    await member.getByLabel('定向邀请码',{exact:true}).fill('test-invite-token');await member.getByRole('button',{name:'接受邀请',exact:true}).click();
    await member.getByLabel('资产团队',{exact:true}).click();await member.locator('.ant-select-item-option-content').filter({hasText:'Fixture Team'}).click();
    assert.equal(await member.getByRole('button',{name:'生成定向邀请',exact:true}).count(),0);
    await admin.getByLabel('Fixture Project 成员 2 权限',{exact:true}).click();await admin.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText('读写',{exact:true}).click();
    await admin.getByRole('button',{name:'移除成员 2',exact:true}).click();
    await member.getByRole('button',{name:'刷新成员关系',exact:true}).click();
    await member.waitForFunction(()=>!document.body.innerText.includes('团队角色：read'));
    await admin.evaluate(()=>window.switchAccount(3));
    await admin.waitForFunction(()=>!document.body.innerText.includes('移除成员'));
    assert.ok(calls.some(c=>c.method==='PUT'&&c.path.endsWith('/projects/project-1/members/2')&&c.id==='1'));
    assert.ok(calls.some(c=>c.path.endsWith('/invitations/accept')&&c.id==='2'));
    assert.ok(calls.every(c=>Boolean(c.id)));
    console.log('PASS: create, targeted invitation/accept, member view, project grant, revoke refresh, account switch (mock HTTP)');
} finally {await browser?.close();await server.close();}
