import importlib.util,json,hashlib,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('release','infinite-canvas/deploy/production-release-20261026.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
p=Path('backups/production-optimization-20261026');package=json.loads((p/'release-package.json').read_text());remote='/root/aoweisi-release-backups/optimization-20261026/incoming'
c=mod.connect()
try:
 result=json.loads(mod.execute(c,"import pathlib,json; p=pathlib.Path('/root/aoweisi-release-backups/optimization-20261026/independent-verification.json'); d=json.loads(p.read_text()); assert d['status']=='independently-verified' and all(d['originalServicesRestored'].values()); p=pathlib.Path('"+remote+"');p.mkdir(mode=0o700);print(json.dumps({'verifiedBackup':True}))"))
 ftp=c.open_sftp()
 for name in ['release.tar.gz',package['node']['archive']]:
  ftp.put(str(p/name),remote+'/'+name+'.partial');ftp.rename(remote+'/'+name+'.partial',remote+'/'+name)
 expected={name:hashlib.sha256((p/name).read_bytes()).hexdigest() for name in ['release.tar.gz',package['node']['archive']]}
 script="import pathlib,json,hashlib;root=pathlib.Path("+repr(remote)+");expected="+repr(expected)+";actual={p.name:hashlib.file_digest(p.open('rb'),'sha256').hexdigest() for p in root.iterdir()};assert actual==expected;print(json.dumps({'uploaded':actual,'root':str(root)}))"
 body=mod.execute(c,script);(p/'upload-result.json').write_text(body,encoding='utf-8');print(body)
finally:c.close()

