import json
import os
import urllib.request

url = os.environ.get('ADMIN_PANEL_URL', 'http://127.0.0.1:8090/api/health')
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ.get('ADMIN_HEALTH_TOKEN', '')})
with urllib.request.urlopen(req, timeout=5) as response:
    payload = json.load(response)
if response.status != 200 or not payload.get('admin'):
    raise SystemExit('admin panel health check failed')
print(json.dumps(payload, ensure_ascii=False))
