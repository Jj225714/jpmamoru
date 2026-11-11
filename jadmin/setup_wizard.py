import json, os, subprocess, sys, threading
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
STATE=Path('/var/lib/enterprise-ai-platform/install-state.json')
NAMES={'jiapi':'安装 JAPI','accounts':'验证统一账号和模型','image':'安装Jimage','jichat':'安装 Jchat'}
lock=threading.Lock()
busy=None
notice=''

def status():
    try: s=json.loads(STATE.read_text())
    except (OSError,ValueError):s={'admin':'done'}
    return {'stages':s,'busy':busy,'notice':notice}

def start(stage):
    global busy,notice
    if stage not in NAMES:return {'error':'未知安装步骤'},400
    if not lock.acquire(blocking=False):return {'error':'已有安装任务正在运行'},409
    steps=list(NAMES);idx=steps.index(stage)
    previous='admin' if idx==0 else steps[idx-1]
    if status()['stages'].get(previous)!='done':
        lock.release();return {'error':'请先完成上一步'},409
    busy=stage;notice='正在执行：'+NAMES[stage]
    def work():
        global busy,notice
        try:
            result=subprocess.run([sys.executable,str(ROOT/'scripts/staged_install.py'),stage],capture_output=True,text=True,encoding='utf-8',timeout=2400)
            notice=result.stdout.strip()[-500:] or '安装未完成，请检查服务状态。'
        except Exception:notice='任务中断，可检查状态后重试；不会删除数据库或重置已有管理员。'
        finally:busy=None;lock.release()
    threading.Thread(target=work,daemon=True).start()
    return {'ok':True},202
