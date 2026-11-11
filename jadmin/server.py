import base64, hashlib, hmac, json, os, secrets, sqlite3, time, subprocess, threading, shutil
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import setup_wizard
DB=os.environ.get('ADMIN_DB','/opt/enterprise-ai-platform/admin-panel/admin.db'); KEY=os.environ.get('ADMIN_SECRET',''); EMAIL=os.environ.get('ADMIN_EMAIL',''); PASS=os.environ.get('ADMIN_PASSWORD',''); LCENV=os.environ.get('LIBRECHAT_ENV','/opt/enterprise-ai-platform/librechat.env'); LCYAML=os.environ.get('LIBRECHAT_CONFIG','/opt/enterprise-ai-platform/librechat.yaml'); MONGO_CONTAINER=os.environ.get('LIBRECHAT_MONGO_CONTAINER','enterprise-ai-platform-mongodb-1')
SUB2API_BASE=os.environ.get('SUB2API_BASE_URL','http://127.0.0.1:8080')
SUB2API_ENV=os.environ.get('SUB2API_ENV','/opt/enterprise-ai-platform/sub2api.env')
VAULT_ADMIN_FILE=os.environ.get('CONFIG_VAULT_ADMIN_FILE','/opt/enterprise-ai-platform/private/vault-admins.json')
VAULT_ADMIN_CLI=os.environ.get('CONFIG_VAULT_ADMIN_CLI','/opt/enterprise-ai-platform/config-vault/admin-users.mjs')
MODEL_BASE_URL=os.environ.get('MODEL_BASE_URL',SUB2API_BASE+'/v1')
def db():
 c=sqlite3.connect(DB); c.row_factory=sqlite3.Row
 c.execute('create table if not exists users(id integer primary key,email text unique,password text,role text,enabled integer default 1,created integer,username text)')
 cols={r[1] for r in c.execute('pragma table_info(users)')}
 if 'username' not in cols: c.execute('alter table users add column username text')
 c.execute('create table if not exists config(k text primary key,v text,updated integer)')
 c.execute('create table if not exists audit(id integer primary key,action text,detail text,at integer)')
 c.execute('create table if not exists metrics(id integer primary key,at integer,cpu real,memory real,disk real,containers text)')
 c.commit(); return c

def audit(c, action, detail):
 c.execute('insert into audit(action,detail,at) values(?,?,?)',(action,detail,int(time.time()))); c.commit()

def health(url, timeout=4):
 import urllib.request
 try: return urllib.request.urlopen(url,timeout=timeout).status==200
 except: return False

def reachable(host, port, timeout=2):
 import socket
 try:
  with socket.create_connection((host, port), timeout=timeout): return True
 except OSError: return False

def module_status():
 return {
  'admin': {'name':'Jadmin','status':'healthy','endpoint':'127.0.0.1:8090','capabilities':['modules','audit','metrics']},
  'librechat': {'name':'Jchat','status':'healthy' if health('http://127.0.0.1:3080/api/config',1) else 'degraded','endpoint':'127.0.0.1:3080','capabilities':['users','endpoint-config','models']},
  'sub2api': {'name':'JAPI','status':'healthy' if health(os.environ.get('SUB2API_HEALTH_URL','http://127.0.0.1:8080/health'),1) else ('unconfigured' if not reachable('127.0.0.1',8080,1) else 'degraded'),'endpoint':os.environ.get('SUB2API_HEALTH_URL','http://127.0.0.1:8080/health'),'capabilities':['health','models']},
  'image': {'name':'Jimage','status':'healthy' if health(os.environ.get('IMAGE_SYSTEM_URL','http://127.0.0.1/'),1) else ('unconfigured' if not reachable('127.0.0.1',3000,1) else 'degraded'),'endpoint':os.environ.get('IMAGE_SYSTEM_URL','http://127.0.0.1/'),'capabilities':['页面可达性检查；业务管理未接入']},
  'configVault': {'name':'配置保险库','status':'reachable' if reachable(os.environ.get('CONFIG_VAULT_HOST','127.0.0.1'),int(os.environ.get('CONFIG_VAULT_PORT','3183'))) else 'unconfigured','endpoint':os.environ.get('CONFIG_VAULT_HOST','127.0.0.1')+':'+os.environ.get('CONFIG_VAULT_PORT','3183'),'capabilities':['端口探测；配置管理未接入']},
  'providerRelay': {'name':'模型转发服务','status':'reachable' if reachable(os.environ.get('PROVIDER_RELAY_HOST','127.0.0.1'),int(os.environ.get('PROVIDER_RELAY_PORT','3181'))) else 'unconfigured','endpoint':os.environ.get('PROVIDER_RELAY_HOST','127.0.0.1')+':'+os.environ.get('PROVIDER_RELAY_PORT','3181'),'capabilities':['端口探测；调用验证未执行']},
 }

def env_file(path):
 out={}
 try:
  for line in open(path):
   line=line.strip()
   if line and not line.startswith('#') and '=' in line:
    k,v=line.split('=',1); out[k]=v.strip().strip('"').strip("'")
 except: pass
 return out

def sub2api_request(path, method='GET', payload=None):
 """Use the existing JAPI admin API; return a redacted view."""
 e=env_file(SUB2API_ENV); email=e.get('ADMIN_EMAIL'); password=e.get('ADMIN_PASSWORD')
 if not email or not password: return {'error':'JAPI管理员凭据未配置'}
 try:
  body=json.dumps({'email':email,'password':password}).encode()
  req=urllib.request.Request(SUB2API_BASE+'/api/v1/auth/login',data=body,headers={'Content-Type':'application/json'},method='POST')
  login=json.load(urllib.request.urlopen(req,timeout=8)); data=login.get('data') or {}; token=data.get('access_token')
  if not token: return {'error':'JAPI登录失败'}
  req=urllib.request.Request(SUB2API_BASE+path,headers={'Authorization':'Bearer '+token},method=method)
  if payload is not None:
   req.data=json.dumps(payload).encode(); req.add_header('Content-Type','application/json')
  return json.load(urllib.request.urlopen(req,timeout=10))
 except urllib.error.HTTPError as e: return {'error':'JAPI接口 HTTP '+str(e.code)}
 except Exception: return {'error':'JAPI接口暂时不可用'}

def vault_admins(action='list', user_id=None):
 args=['node',VAULT_ADMIN_CLI,'--file',VAULT_ADMIN_FILE,'--action',action]
 if user_id: args += ['--user-id',str(user_id)]
 try: return json.loads(subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL,timeout=10))
 except Exception: return {'error':'配置保险库管理员列表读取失败'}

def system_metrics():
 try:
  load=float(os.getloadavg()[0]); cpu=round(min(100,load/(os.cpu_count() or 1)*100),1)
 except: cpu=0
 try:
  du=shutil.disk_usage('/'); disk=round(du.used/du.total*100,1)
  with open('/proc/meminfo') as f: vals={x.split(':')[0]:int(x.split()[1]) for x in f if ':' in x}
  memory=round((1-vals.get('MemAvailable',0)/vals.get('MemTotal',1))*100,1)
 except: memory=disk=0
 try:
  out=subprocess.check_output(['docker','ps','--format','{{.Names}}|{{.Status}}|{{.Image}}'],text=True,timeout=5)
  containers=[dict(zip(['name','status','image'],x.split('|',2))) for x in out.splitlines() if x]
 except: containers=[]
 return {'at':int(time.time()),'cpu':cpu,'memory':memory,'disk':disk,'containers':containers}

def collect_metrics():
 while True:
  try:
   m=system_metrics(); c=db(); c.execute('insert into metrics(at,cpu,memory,disk,containers) values(?,?,?,?,?)',(m['at'],m['cpu'],m['memory'],m['disk'],json.dumps(m['containers']))); c.execute('delete from metrics where at<?',(int(time.time())-86400,)); c.commit(); c.close()
  except Exception: pass
  time.sleep(60)

def raw_env(name):
 try:
  for line in open(LCENV):
   if line.startswith(name+'='): return line.rstrip().split('=',1)[1]
 except: pass
 return ''

def current_config():
 out={}
 try:
  for line in open(LCENV):
   if '=' in line:
    k,v=line.rstrip().split('=',1); out[k]=v
  key=out.get('ZHITOUZHUAN_API_KEY','')
  return {'customBaseURL':MODEL_BASE_URL,'keyConfigured':bool(key),'keySuffix':key[-4:] if key else '', 'domainClient':out.get('DOMAIN_CLIENT',''), 'endpoints':out.get('ENDPOINTS','')}
 except: return {}

def models():
 import urllib.request
 key=raw_env('ZHITOUZHUAN_API_KEY')
 req=urllib.request.Request(MODEL_BASE_URL.rstrip('/')+'/models',headers={'Authorization':'Bearer '+key})
 try:
  x=json.load(urllib.request.urlopen(req,timeout=15)); return [m.get('id') for m in x.get('data',[]) if m.get('id')]
 except Exception as e:return []

def model_status():
 import re, urllib.request, urllib.error
 try: text=open(LCYAML).read()
 except OSError:return {'models':[],'defaultModel':'','baseURL':'','error':'Jchat 待安装'}
 base=re.search(r'^\s*baseURL:\s*(.+)$',text,re.M)
 defaults=re.search(r'^\s*default:\s*\[([^\]]*)\]',text,re.M)
 base=base.group(1).strip().strip('\"\'') if base else ''
 default=defaults.group(1).split(',')[0].strip().strip('\"\'') if defaults else ''
 result={'models':[], 'defaultModel':default, 'baseURL':base, 'error':None}
 try:
  if not base: raise ValueError('未配置 API 地址')
  req=urllib.request.Request(base.rstrip('/')+'/models',headers={'Authorization':'Bearer '+raw_env('ZHITOUZHUAN_API_KEY')})
  with urllib.request.urlopen(req,timeout=15) as response: payload=json.load(response)
  result['models']=list(dict.fromkeys(m['id'] for m in payload.get('data',[]) if isinstance(m,dict) and isinstance(m.get('id'),str)))
  if not result['models']: result['error']='接口返回空模型列表，请检查渠道权限。'
 except urllib.error.HTTPError as e: result['error']='模型接口返回 HTTP '+str(e.code)+'，请检查接口地址、Key 和渠道权限。'
 except Exception: result['error']='模型接口连接失败或返回格式无效，请检查已保存的配置后重试。'
 return result

def mongo_eval(code):
 try:
  r=subprocess.run(['docker','exec',MONGO_CONTAINER,'mongosh','--quiet','LibreChat','--eval',code],capture_output=True,text=True,timeout=30)
  if r.returncode != 0: return None
  return r.stdout.strip()
 except: return None

def sync_librechat_users(c):
 raw=mongo_eval("JSON.stringify(db.users.find({}, {email:1,username:1,role:1,createdAt:1}).toArray())")
 try: rows=json.loads(raw.splitlines()[-1])
 except: rows=[]
 for u in rows:
  c.execute('insert into users(email,password,role,enabled,created,username) values(?,?,?,?,?,?) on conflict(email) do update set role=excluded.role,username=excluded.username',(u.get('email'), 'external:'+u.get('email',''), u.get('role','USER'), 1, int(time.time()), u.get('username','')))
 c.commit(); return rows

def librechat_accounts():
 raw=mongo_eval("JSON.stringify(db.users.find({}, {email:1,username:1,role:1,banned:1,createdAt:1,updatedAt:1,lastLoginAt:1,last_login:1}).toArray())")
 try: users=json.loads(raw.splitlines()[-1])
 except: users=[]
 # Count messages and conversations by the stored user identifier; no message text is returned.
 stats=mongo_eval("JSON.stringify({messages:db.messages.aggregate([{$group:{_id:'$user',count:{$sum:1},last:{$max:'$createdAt'},tokens:{$sum:{$ifNull:['$tokenCount',0]}}}}]).toArray(),conversations:db.conversations.aggregate([{$group:{_id:'$user',count:{$sum:1},last:{$max:'$updatedAt'}}}]).toArray()})")
 try: stats=json.loads(stats.splitlines()[-1])
 except: stats={'messages':[],'conversations':[]}
 bymsg={str(x.get('_id')):x for x in stats.get('messages',[]) if x.get('_id')}; byconv={str(x.get('_id')):x for x in stats.get('conversations',[]) if x.get('_id')}
 out=[]
 for u in users:
  uid=str(u.get('_id','')); m=bymsg.get(uid,{ }); cv=byconv.get(uid,{ }); last=u.get('lastLoginAt') or u.get('last_login') or m.get('last') or cv.get('last')
  out.append({'platform':'Jchat','id':uid,'email':u.get('email'),'username':u.get('username'),'role':u.get('role'),'status':'disabled' if u.get('banned') else 'active','createdAt':u.get('createdAt'),'lastLoginAt':last,'usage':{'messages':m.get('count',0),'conversations':cv.get('count',0),'tokens':m.get('tokens',0)}})
 return out

def vault_admin_details():
 vault=vault_admins(); ids={str(x) for x in vault.get('administratorIds',[]) } if isinstance(vault,dict) else set()
 users=sub2api_request('/api/v1/admin/users'); items=(users.get('data',{}).get('items',[]) if isinstance(users,dict) else [])
 out=[]
 for u in items:
  if str(u.get('id')) in ids: out.append({'id':u.get('id'),'email':u.get('email'),'username':u.get('username'),'role':u.get('role'),'status':u.get('status'),'last_active_at':u.get('last_active_at'),'permission':'已授权'})
 for uid in ids:
  if not any(str(x.get('id'))==uid for x in out): out.append({'id':uid,'permission':'已授权'})
 return {'administrators':out}

def unified_accounts():
 out=librechat_accounts(); users=sub2api_request('/api/v1/admin/users'); items=(users.get('data',{}).get('items',[]) if isinstance(users,dict) else [])
 for u in items:
  if not isinstance(u,dict): continue
  out.append({'platform':'JAPI','id':u.get('id'),'email':u.get('email'),'username':u.get('username'),'role':u.get('role'),'status':u.get('status'),'createdAt':u.get('created_at'),'lastLoginAt':u.get('last_active_at'),'usage':{'balance':u.get('balance'),'frozenBalance':u.get('frozen_balance'),'concurrency':u.get('concurrency')}})
 vault=vault_admins(); admin_ids={str(x) for x in vault.get('administratorIds',[]) } if isinstance(vault,dict) else set()
 for u in items:
  if str(u.get('id')) in admin_ids: out.append({'platform':'配置保险库','id':u.get('id'),'email':u.get('email'),'username':u.get('username'),'role':'vault-admin','status':u.get('status'),'createdAt':u.get('created_at'),'lastLoginAt':u.get('last_active_at'),'usage':{'permission':'team-admin'}})
 return out

def mongo_create(email,name,username,password):
 try:
  import bcrypt
  q=json.dumps(email); n=json.dumps(name); u=json.dumps(username); phash=json.dumps(bcrypt.hashpw(password.encode(),bcrypt.gensalt(rounds=10)).decode())
  code="const u=db.users.findOne({email:"+q+"});if(!u){db.users.insertOne({name:"+n+",username:"+u+",email:"+q+",emailVerified:true,password:"+phash+",provider:'local',role:'USER',plugins:[],createdAt:new Date(),updatedAt:new Date()})}"
  return mongo_eval(code) is not None
 except: return False

def mongo_password(email,password):
 import bcrypt
 q=json.dumps(email); pw=json.dumps(bcrypt.hashpw(password.encode(),bcrypt.gensalt(rounds=10)).decode())
 code="db.users.updateOne({email:"+q+"},{$set:{password:"+pw+",updatedAt:new Date()}})"
 return mongo_eval(code) is not None

def mongo_enabled(email,enabled):
 # LibreChat recognizes banned users; preserve the account while preventing login.
 q=json.dumps(email); value='false' if enabled else 'true'
 code="db.users.updateOne({email:"+q+"},{$set:{banned:"+value+",updatedAt:new Date()}})"
 return mongo_eval(code) is not None

def save_real_config(default_model=None):
 if not default_model:return
 text=open(LCYAML).read()
 import re
 text=re.sub(r'default: \[[^\]]*\]', 'default: ['+default_model+']', text, count=1)
 open(LCYAML,'w').write(text)

def save_endpoint(base_url=None, api_key=None):
 import re
 if base_url:
  text=open(LCYAML).read(); text=re.sub(r"baseURL: [^\n]+", 'baseURL: '+json.dumps(base_url), text, count=1); open(LCYAML,'w').write(text)
 if api_key:
  lines=[]; found=False
  for line in open(LCENV):
   if line.startswith('ZHITOUZHUAN_API_KEY='): lines.append('ZHITOUZHUAN_API_KEY='+api_key+'\n'); found=True
   else: lines.append(line)
  if not found: lines.append('ZHITOUZHUAN_API_KEY='+api_key+'\n')
  open(LCENV,'w').writelines(lines); os.chmod(LCENV,0o600)
def ph(p,s=None):
 s=s or secrets.token_hex(16); return s+':'+hashlib.scrypt(p.encode(),salt=bytes.fromhex(s),n=16384,r=8,p=1).hex()
def check(p,x):
 try:s,h=x.split(':'); return hmac.compare_digest(h,hashlib.scrypt(p.encode(),salt=bytes.fromhex(s),n=16384,r=8,p=1).hex())
 except:return False
def tok(e):
 payload=e+'|'+str(int(time.time()+86400))
 encoded=base64.urlsafe_b64encode(payload.encode()).decode().rstrip('=')
 return encoded+'.'+hmac.new(KEY.encode(),encoded.encode(),hashlib.sha256).hexdigest()
def who(t):
 try:
  a,s=t.split('.'); e,u=base64.urlsafe_b64decode(a+'='*((4-len(a)%4)%4)).decode().split('|')
  return e if int(u)>time.time() and hmac.compare_digest(s,hmac.new(KEY.encode(),a.encode(),hashlib.sha256).hexdigest()) else None
 except:return None
def is_admin_actor(c, email):
 if not email: return False
 if email == EMAIL: return True
 row=c.execute('select role,enabled from users where email=?',(email,)).fetchone()
 return bool(row and row['enabled'] and str(row['role']).upper()=='ADMIN')
class H(BaseHTTPRequestHandler):
 def out(self,x,n=200): self.send_response(n);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(json.dumps(x).encode())
 def body(self): return json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
 def do_GET(self):
  from urllib.parse import urlsplit
  self.path=urlsplit(self.path).path
  if self.path=='/': self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(HTML.encode());return
  c=db()
  actor=who(self.headers.get('Authorization','').replace('Bearer ',''))
  if not actor:return self.out({'error':'unauthorized'},401)
  if not is_admin_actor(c,actor):return self.out({'error':'administrator_required'},403)
  if self.path=='/api/admin/setup':
   if actor!=EMAIL:return self.out({'error':'owner_required'},403)
   return self.out(setup_wizard.status())
  if self.path=='/api/admin/credentials':
   actor=who(self.headers.get('Authorization','').replace('Bearer ',''))
   if actor!=EMAIL: return self.out({'error':'administrator_required'},403)
   keys=sub2api_request('/api/v1/keys')
   audit(c,'view_credentials',actor)
   return self.out({'librechatApiKey':raw_env('ZHITOUZHUAN_API_KEY'),'keys':keys,'adminLogin':{'email':EMAIL,'password':PASS},'passwordNote':'用户密码使用哈希存储，无法还原；配置保险库共用 JAPI 账号。'})
  if self.path=='/api/model-status':return self.out(model_status())
  if self.path in ('/api/modules','/api/admin/modules'):return self.out({'modules':module_status()})
  if self.path=='/api/users':return self.out({'users':[dict(x) for x in c.execute('select id,email,role,enabled,created from users')]})
  if self.path=='/api/config':return self.out({'config':{x['k']:x['v'] for x in c.execute('select k,v from config')},'current':current_config(),'models':models()})
  if self.path in ('/api/health','/api/admin/services'):
   modules=module_status(); return self.out({'librechat':modules['librechat']['status']=='healthy','sub2api':modules['sub2api']['status']=='healthy','image':modules['image']['status']=='healthy','configVault':modules['configVault']['status']=='reachable','providerRelay':modules['providerRelay']['status']=='reachable','admin':True,'nginx':health('http://127.0.0.1:80')})
  if self.path in ('/api/admin/accounts','/api/accounts'): return self.out({'accounts':unified_accounts()})
  if self.path in ('/api/admin/sub2api','/api/sub2api'):
   users=sub2api_request('/api/v1/admin/users'); keys=sub2api_request('/api/v1/keys'); usage=sub2api_request('/api/v1/admin/usage'); me=sub2api_request('/api/v1/auth/me')
   for item in (keys.get('data',{}).get('items',[]) if isinstance(keys,dict) else []):
    if isinstance(item,dict) and item.get('key'): item['keyMasked']=item['key'][:7]+'…'+item['key'][-4:]; item.pop('key',None)
   return self.out({'users':users,'keys':keys,'usage':usage,'account':me})
  if self.path in ('/api/admin/config-vault','/api/config-vault'): return self.out(vault_admin_details())
  if self.path in ('/api/audit','/api/admin/audit'):return self.out({'audit':[dict(x) for x in c.execute('select action,detail,at from audit order by id desc limit 100')]})
  if self.path in ('/api/metrics','/api/admin/metrics'):
   rows=[dict(x) for x in c.execute('select at,cpu,memory,disk,containers from metrics order by at desc limit 1440')];return self.out({'current':system_metrics(),'history':rows})
  if self.path in ('/api/admin/users','/api/admin/models','/api/admin/config','/api/admin/providers'):
   if self.path.endswith('/users'): return self.out({'users':[dict(x) for x in c.execute('select id,email,role,enabled,created,username from users')]})
   if self.path.endswith('/models'): return self.out({'models':models()})
   if self.path.endswith('/providers'): return self.out({'providers':[{'name':os.environ.get('MODEL_PROVIDER_NAME','JAPI'),'baseURL':MODEL_BASE_URL,'keyConfigured':current_config().get('keyConfigured',False)}]})
   return self.out({'config':current_config(),'models':models()})
  self.out({'error':'not_found'},404)
 def do_PATCH(self):
  return self.do_POST()
 def do_POST(self):
  if self.path.startswith('/api/admin/users'):
   self.path=self.path.replace('/api/admin','/api',1)
  elif self.path=='/api/admin/config':
   self.path='/api/config'
  d=self.body();c=db()
  if self.path=='/api/login':
   ok=bool(EMAIL and PASS and d.get('email')==EMAIL and hmac.compare_digest(d.get('password',''),PASS))
   if not ok:
    r=c.execute('select * from users where email=? and enabled=1',(d.get('email',''),)).fetchone();ok=bool(r and check(d.get('password',''),r['password']) and str(r['role']).upper()=='ADMIN')
   return self.out({'token':tok(d.get('email'))} if ok else {'error':'invalid_credentials'},200 if ok else 401)
  actor=who(self.headers.get('Authorization','').replace('Bearer ',''))
  if not actor:return self.out({'error':'unauthorized'},401)
  if not is_admin_actor(c,actor):return self.out({'error':'administrator_required'},403)
  if self.path=='/api/admin/setup':
   if actor!=EMAIL:return self.out({'error':'owner_required'},403)
   result,code=setup_wizard.start(d.get('stage'));return self.out(result,code)
  if self.path in ('/api/users','/api/admin/users'):
   if not d.get('email') or '@' not in d['email']: return self.out({'error':'valid_email_required'},400)
   pw=d.get('password') or secrets.token_urlsafe(14)
   try:
    c.execute('insert into users(email,password,role,created,username) values(?,?,?,?,?)',(d['email'],ph(pw),d.get('role','USER'),int(time.time()),d['email'].split('@')[0])); audit(c,'create_user',d['email'])
    if not mongo_create(d['email'],d.get('name',d['email'].split('@')[0]),d.get('username',d['email'].split('@')[0]),pw):
     c.rollback(); return self.out({'error':'librechat_account_creation_failed'},502)
   except sqlite3.IntegrityError:return self.out({'error':'user_exists'},409)
   return self.out({'email':d['email'],'temporaryPassword':pw})
  if self.path=='/api/users/disable':
   c.execute('update users set enabled=0 where id=?',(d.get('id'),)); row=c.execute('select email from users where id=?',(d.get('id'),)).fetchone()
   if row and not mongo_enabled(row['email'],False): c.rollback(); return self.out({'error':'librechat_account_update_failed'},502)
   audit(c,'disable_user',str(d.get('id')));return self.out({'ok':True})
  if self.path=='/api/users/enable':
   c.execute('update users set enabled=1 where id=?',(d.get('id'),)); row=c.execute('select email from users where id=?',(d.get('id'),)).fetchone()
   if row and not mongo_enabled(row['email'],True): c.rollback(); return self.out({'error':'librechat_account_update_failed'},502)
   audit(c,'enable_user',str(d.get('id')));return self.out({'ok':True})
  if self.path=='/api/users/reset-password':
   pw=d.get('password') or secrets.token_urlsafe(14);c.execute('update users set password=? where id=?',(ph(pw),d.get('id')));row=c.execute('select email from users where id=?',(d.get('id'),)).fetchone()
   if row and not mongo_password(row['email'],pw): c.rollback(); return self.out({'error':'librechat_password_update_failed'},502)
   audit(c,'reset_password',str(d.get('id')));return self.out({'temporaryPassword':pw})
  if self.path in ('/api/admin/sub2api/users','/api/sub2api/users'):
   if not d.get('email') or not d.get('password'): return self.out({'error':'email_and_password_required'},400)
   result=sub2api_request('/api/v1/admin/users','POST',{'email':d.get('email'),'password':d.get('password'),'username':d.get('username',''),'role':d.get('role','user')})
   audit(c,'sub2api_create_user',d.get('email')); return self.out(result, 200 if 'error' not in result else 400)
  if self.path in ('/api/admin/config-vault/grant','/api/config-vault/grant','/api/admin/config-vault/revoke','/api/config-vault/revoke'):
   action='grant' if self.path.endswith('grant') else 'revoke'; uid=d.get('userId')
   if not str(uid).isdigit(): return self.out({'error':'userId_required'},400)
   vault_admins(action,uid); audit(c,'vault_admin_'+action,str(uid)); return self.out(vault_admin_details())
  if self.path=='/api/config':
   for k,v in d.items():c.execute('insert into config(k,v,updated) values(?,?,?) on conflict(k) do update set v=excluded.v,updated=excluded.updated',(k,str(v),int(time.time())))
   save_real_config(d.get('defaultModel')); save_endpoint(d.get('baseURL'),d.get('apiKey')); audit(c,'save_config','endpoint/model'); return self.out({'ok':True,'models':models()})
  self.out({'error':'not_found'},404)
HTML="""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Jadmin</title><style>body{font:15px system-ui;margin:0;background:#f6f7fb;color:#172033}main{max-width:1100px;margin:auto;padding:24px}.card{background:white;border:1px solid #e3e7ef;border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 2px 8px #1720330d}input,select,button{padding:9px 11px;margin:4px;border:1px solid #ccd3df;border-radius:8px}button{background:#2563eb;color:white;border:0;cursor:pointer}.danger{background:#dc2626}.muted{color:#667085}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #edf0f5}pre{background:#f8fafc;padding:12px;border-radius:8px;white-space:pre-wrap}.ok{color:#16803c}.bad{color:#b42318}</style><main><h1>Jadmin</h1><p class=muted>Jchat · Jimage · JAPI</p><section id=loginbox class=card><h2>管理员登录</h2><input id=email placeholder=邮箱 autocomplete=username><input id=password type=password placeholder=密码 autocomplete=current-password><button id=loginbtn>登录</button><p id=msg></p></section><div id=app hidden><section class=card><h2>服务状态</h2><pre id=health></pre><button id=refresh>刷新</button></section><section class=card><h2>用户管理</h2><input id=newemail placeholder=用户邮箱><input id=newpassword type=password placeholder=初始密码（可留空自动生成）><select id=role><option>USER</option><option>ADMIN</option></select><button id=addbtn>创建用户</button><p id=notice></p><table><thead><tr><th>邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id=rows></tbody></table></section><section class=card><h2>统一配置</h2><p>API 地址</p><input id=baseURL size=42><p>统一 API Key（留空保持原值）</p><input id=apiKey type=password size=42 placeholder="当前 Key 已隐藏"><p>模型</p><select id=model></select><button id=savebtn>保存默认模型</button><button id=loadmodels>重新拉取模型</button><div id=config></div></section><section class=card><h2>审计记录</h2><div id=audit></div></section></div></main><script>var token='';const $=id=>document.getElementById(id);async function api(u,o={}){o.headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token},o.headers||{});let r=await fetch(u,o),x=await r.json();if(!r.ok)throw Error(x.error||'请求失败');return x}async function load(){let [h,u,c,a,m]=await Promise.all([api('/api/health'),api('/api/users'),api('/api/config'),api('/api/audit'),api('/api/metrics')]);$('health').innerHTML=Object.entries(h).map(([k,v])=>k+': '+(v?'正常':'异常')).join('\\n')+'\\n\\nCPU: '+m.current.cpu+'%\\n内存: '+m.current.memory+'%\\n磁盘: '+m.current.disk+'%\\nDocker容器: '+m.current.containers.length+'\\n历史采样: '+m.history.length;$('baseURL').value=c.current.customBaseURL||'';$('config').replaceChildren();let ct=document.createElement('table');ct.innerHTML='<tbody></tbody>';[['API Key状态',c.current.keyConfigured?'已配置':'未配置'],['Key末四位',c.current.keySuffix||'—'],['客户端域名',c.current.domainClient||'—'],['统一API地址',c.current.customBaseURL||'—']].forEach(x=>{let tr=document.createElement('tr');let th=document.createElement('th');let td=document.createElement('td');th.textContent=x[0];td.textContent=x[1];tr.append(th,td);ct.querySelector('tbody').appendChild(tr)});$('config').appendChild(ct);$('audit').replaceChildren();let at=document.createElement('table');at.innerHTML='<thead><tr><th>时间</th><th>操作</th><th>详情</th></tr></thead><tbody></tbody>';(a.audit||[]).forEach(x=>{let tr=document.createElement('tr');[new Date(x.at*1000).toLocaleString(),x.action,x.detail].forEach(v=>{let td=document.createElement('td');td.textContent=v||'—';tr.appendChild(td)});at.querySelector('tbody').appendChild(tr)});$('audit').appendChild(at);$('rows').innerHTML=u.users.map(x=>'<tr><td>'+x.email+'</td><td>'+x.role+'</td><td class="'+(x.enabled?'ok':'bad')+'">'+(x.enabled?'启用':'停用')+'</td><td><button data-id="'+x.id+'" data-enabled="'+x.enabled+'">'+(x.enabled?'停用':'启用')+'</button> <button class=danger data-reset="'+x.id+'">重置密码</button></td></tr>').join('');document.querySelectorAll('[data-id]').forEach(b=>b.onclick=async()=>{await api('/api/users/'+(b.dataset.enabled==='1'?'disable':'enable'),{method:'POST',body:JSON.stringify({id:b.dataset.id})});load()});document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=async()=>{let x=await api('/api/users/reset-password',{method:'POST',body:JSON.stringify({id:b.dataset.reset})});alert('临时密码：'+x.temporaryPassword)});}$('loginbtn').onclick=async()=>{try{let x=await api('/api/login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})});token=x.token;$('loginbox').hidden=true;$('app').hidden=false;load()}catch(e){$('msg').textContent=e.message;$('msg').className='bad'}};$('refresh').onclick=load;$('addbtn').onclick=async()=>{try{let x=await api('/api/users',{method:'POST',body:JSON.stringify({email:$('newemail').value,password:$('newpassword').value,role:$('role').value})});$('notice').textContent='创建成功，临时密码：'+x.temporaryPassword;$('newemail').value='';load()}catch(e){$('notice').textContent=e.message}};$('savebtn').onclick=async()=>{await api('/api/config',{method:'POST',body:JSON.stringify({defaultModel:$('model').value,baseURL:$('baseURL').value,apiKey:$('apiKey').value})});load()};</script>"""
from pathlib import Path
HTML=HTML.replace('</script>', '</script><script>'+Path(__file__).with_name('models-ui.js').read_text(encoding='utf-8')+'</script><script>'+Path(__file__).with_name('modules-ui.js').read_text(encoding='utf-8')+'</script>',1)
HTML += '<script>'+Path(__file__).with_name('setup-ui.js').read_text(encoding='utf-8')+'</script>'
def main():
 db()
 threading.Thread(target=collect_metrics,daemon=True).start()
 port=int(os.environ.get('ADMIN_PORT','8090'))
 ThreadingHTTPServer((os.environ.get('ADMIN_HOST','127.0.0.1'),port),H).serve_forever()

if __name__ == '__main__':
 main()
