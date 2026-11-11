"""Private deployment smoke check; never generates content or prints credentials."""
import argparse
import http.client
import json
from http.cookies import SimpleCookie
import sys
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gateway-dir', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--through-nginx', action='store_true')
    parser.add_argument('--check-provider', action='store_true')
    args = parser.parse_args()
    sys.path.insert(0, args.gateway_dir)
    from config import load_config
    from state import State
    config = load_config(args.config)
    state = State(config)
    origin = urlsplit(config.origin)

    def request(path, method='GET', payload=None, cookie=None, request_origin=None):
        connection = http.client.HTTPSConnection(origin.hostname, timeout=25) if args.through_nginx else http.client.HTTPConnection('127.0.0.1', 3180, timeout=25)
        headers = {'Host': origin.netloc}
        if method == 'POST':
            headers['Origin'] = request_origin or config.origin
            headers['Content-Type'] = 'application/json'
        if cookie:
            headers['Cookie'] = cookie
        data = json.dumps(payload).encode() if payload is not None else (b'' if method == 'POST' else None)
        try:
            connection.request(method, '/api/managed' + path, body=data, headers=headers)
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024)
            assert config.api_key.encode() not in raw
            return response.status, response.getheader('Set-Cookie'), json.loads(raw)
        finally:
            connection.close()

    assert request('/session')[2]['authenticated'] is False
    assert request('/v1/models')[0] == 401
    principal, code = state.create_code('部署验收临时代码', 0, 0)
    try:
        assert request('/login', 'POST', {'code': code}, request_origin='https://invalid.example')[0] == 403
        status, cookie_header, session = request('/login', 'POST', {'code': code})
        assert status == 200 and session['authenticated'] and session['principal']['id'] == principal
        assert all(flag in cookie_header for flag in ('Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/api/managed/'))
        cookies = SimpleCookie(); cookies.load(cookie_header)
        cookie = 'aoweisi_managed_session=' + cookies['aoweisi_managed_session'].value
        status, _, models = request('/v1/models', cookie=cookie)
        assert status == 200 and {m['id'] for m in models['data']} == set(config.image_models + config.text_models)
        assert request('/logout', 'POST', cookie=cookie)[0] == 200
        assert request('/v1/models', cookie=cookie)[0] == 401
        _, cookie_header, _ = request('/login', 'POST', {'code': code})
        cookies.load(cookie_header)
        cookie = 'aoweisi_managed_session=' + cookies['aoweisi_managed_session'].value
        state.disable(principal)
        assert request('/v1/models', cookie=cookie)[0] == 401
        assert request('/login', 'POST', {'code': code})[0] == 401
        quotas = state.quota({'id': principal, 'image_limit': 0, 'text_limit': 0})
        assert quotas['images']['used'] == 0 and quotas['text']['used'] == 0
        print(json.dumps({'auth': 'pass', 'models': 'pass', 'cookie': 'pass', 'origin': 'pass', 'logout': 'pass', 'revocation': 'pass', 'paid_requests': 0}))
    finally:
        state.disable(principal)
    if args.check_provider:
        upstream = urlsplit(config.upstream_base_url)
        connection = http.client.HTTPSConnection(upstream.hostname, timeout=30)
        try:
            connection.request('GET', '/v1/models', headers={'Authorization': 'Bearer ' + config.api_key, 'Accept': 'application/json'})
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024)
            if response.status != 200:
                print(json.dumps({'provider_models_http': response.status, 'paid_requests': 0}))
                return 2
            result = json.loads(raw)
            available = {item.get('id') for item in result.get('data', [])}
            allowed = set(config.image_models + config.text_models)
            assert allowed <= available
            print(json.dumps({'provider_models_http': 200, 'configured_models_available': True, 'paid_requests': 0}))
        finally:
            connection.close()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Managed service verification failed; no credential details printed.', file=sys.stderr)
        sys.exit(1)
