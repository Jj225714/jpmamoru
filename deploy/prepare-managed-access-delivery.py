"""Assemble administrator delivery artifact from explicitly named code files, never log codes."""
import argparse
import json
from pathlib import Path
import re
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gateway-dir', required=True)
    parser.add_argument('--output-file', required=True)
    parser.add_argument('code_files', nargs='+')
    args = parser.parse_args()
    sys.path.insert(0, args.gateway_dir)
    from config import private_write
    rows = ['奥维斯AI生图 · 独立访问码（私密，请按人员分别分发）',
            '访问地址：https://103.79.187.126/',
            '默认每码每天20张图片请求、200次文本/识图请求；北京时间每日重置。',
            '图片生成、背景补全与重试均计入请求额度；这不是人民币费用上限。',
            '登录保持12小时；访问码可由管理员单独停用。请不要公开整个清单。', '']
    for filename in args.code_files:
        record = json.loads(Path(filename).read_text(encoding='utf-8'))
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', record['code']):
            raise ValueError('Invalid generated code')
        name = str(record['name'])
        if any(ord(c) < 32 for c in name):
            raise ValueError('Invalid display name')
        rows.extend([name, '访问码：' + record['code'], '管理员管理编号：' + record['id'], ''])
    private_write(args.output_file, '\n'.join(rows))
    print('Private access-code delivery file created; contents not displayed.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Delivery preparation failed; check private input files.', file=sys.stderr)
        sys.exit(1)
