"""Export measured capacity results without connection parameters or credentials."""
import argparse
import csv
from datetime import datetime
import html
import json
from pathlib import Path
from zoneinfo import ZoneInfo


def generate(state, output):
    state, output = Path(state), Path(output); output.mkdir(parents=True, exist_ok=True)
    trials = json.loads((state / 'results.json').read_text())
    completion = json.loads((state / 'completion.json').read_text()) if (state / 'completion.json').exists() else {'suite_complete': False}
    restored = json.loads((state / 'restoration.json').read_text()) if (state / 'restoration.json').exists() else {'restored': False}
    columns = ['scenario', 'limits', 'label', 'target', 'duration', 'wall_seconds', 'stable', 'http', 'rps', 'successful_rps', 'completed_operations_per_second', 'limited', 'server_errors', 'transport_errors', 'other_errors', 'p95_ms', 'p99_ms', 'commit_p95_ms', 'commit_p99_ms', 'business_success', 'dropped_iterations', 'stop_reason', 'recovery_seconds', 'integrity_passed']
    with (output / 'trials.csv').open('w') as f:
        writer = csv.DictWriter(f, columns, extrasaction='ignore'); writer.writeheader(); writer.writerows(trials)
    public = [{key: row.get(key) for key in columns} for row in trials]
    (output / 'trials.json').write_text(json.dumps(public, ensure_ascii=False, indent=2))
    lines = ['# 题小搭后端容量实测', '', '生成时间：' + datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds'), '', '整套测试完成：' + str(completion['suite_complete']) + '。', '',
             '测试对象为新后端，经 Mac 原生 k6 与私有 SSH 隧道发压。数据使用独立数据库卷及 RabbitMQ vhost，压测期间保留现有应用和基础服务资源限制。', '',
             'A 组保留每来源每 60 秒 60000 次、每账号读取 600 次和写入 120 次的固定窗口限流；B 组关闭普通业务请求限流。认证和权限校验在两组中均启用。', '',
             '| 场景 | 限流 | 最高通过档 | 首个未通过档 | 最高实发 RPS | 30 分钟稳定档 |', '|---|---|---:|---:|---:|---:|']
    for scenario in dict.fromkeys(x['scenario'] for x in trials):
        for policy in ('on', 'off'):
            rows = [x for x in trials if x['scenario'] == scenario and x['limits'] == policy]
            if not rows: continue
            good = [x['target'] for x in rows if x['stable']]; bad = [x['target'] for x in rows if not x['stable']]
            soak = [x['target'] for x in rows if x['stable'] and x['duration'] >= 1800]
            lines.append('| ' + ' | '.join([scenario, '开启' if policy == 'on' else '关闭', str(max(good)) if good else '未确认', str(min(bad)) if bad else '未触达', f"{max(x.get('rps', 0) for x in rows):.2f}", str(max(soak)) if soak else '未确认']) + ' |')
    lines += ['', '真实学生场景的档位单位为活跃用户；读取、创建、同步和交卷场景为目标业务操作／秒，实际 HTTP RPS 包含协议中的回执查询和准备请求；突发场景为一秒内计划发起操作的用户数。具体实发量、启动时间分布和未启动迭代保存在每次运行结果中。', '',
              '## 数据一致性与恢复', '', f"- 完成运行：{len(trials)} 次。", f"- 全部运行持久化校验通过：{all(x.get('integrity_passed') for x in trials)}。", f"- 原运行配置及服务已恢复：{restored['restored']}。", f"- 临时数据库与消息数据已清理：{restored.get('temporary_data_cleaned', False)}。", '',
              '原始响应指标、容器/JVM/数据库连接池指标、队列指标和命令核对证据保存在仓库外的私有运行目录。202 只计为受理，数据一致性以最终 COMMITTED 回执和答案核对为准。', '',
              '## 结果边界', '', '若停止原因属于发压端、管理连接或链路保护，本次只建立已测下限。注册总人数、真实微信登录、邮件提供端和公网全链路容量需要各自的证据。建议常规负载在已验证稳定容量基础上预留约 30% 余量。']
    (output / 'report.md').write_text('\n'.join(lines) + '\n')
    payload = json.dumps(public, ensure_ascii=False).replace('<', '\\u003c')
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>题小搭容量实测</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:0 20px;color:#20304a;background:#f5f8fc}select{font:inherit;padding:8px}svg{width:100%;background:white;border:1px solid #dce4ef;margin-top:20px}table{border-collapse:collapse;width:100%;background:white;font-size:14px}td,th{padding:8px;border-bottom:1px solid #dce4ef;text-align:right}td:first-child,th:first-child{text-align:left}.note{color:#50607a}</style><h1>题小搭容量实测</h1><p class="note">新后端经 Mac 与私有 SSH 隧道；蓝色开启限流，橙色关闭限流。点表示实际测量。</p><label>场景 <select id="scenario"></select></label><svg id="plot" viewBox="0 0 960 430" role="img" aria-label="目标负载与实际请求吞吐量"></svg><table><thead><tr><th>配置</th><th>目标档位</th><th>实发 RPS</th><th>P95 ms</th><th>429</th><th>稳定</th></tr></thead><tbody id="rows"></tbody></table><script>const data=PAYLOAD;const select=document.getElementById('scenario');for(const v of [...new Set(data.map(x=>x.scenario))]){const o=document.createElement('option');o.value=v;o.textContent=v;select.append(o)}function render(){const rows=data.filter(x=>x.scenario===select.value),mx=Math.max(1,...rows.map(x=>x.target)),my=Math.max(1,...rows.map(x=>x.rps||0));let s='<path d="M65 20V370H930" fill="none" stroke="#66778c"/>';for(let i=0;i<=5;i++){const y=370-i*65;s+=`<text x="55" y="${y+5}" text-anchor="end" font-size="13">${Math.round(my*i/5)}</text><path d="M65 ${y}H930" stroke="#e7edf5"/>`}for(const r of rows){const x=65+r.target/mx*850,y=370-(r.rps||0)/my*325;s+=`<circle cx="${x}" cy="${y}" r="5" fill="${r.limits==='on'?'#2464d7':'#e98725'}"><title>${r.limits}: ${r.target}, ${(r.rps||0).toFixed(2)} RPS</title></circle>`}s+='<text x="480" y="415" text-anchor="middle">目标档位</text><text x="18" y="200" transform="rotate(-90 18 200)" text-anchor="middle">实际 HTTP RPS</text>';document.getElementById('plot').innerHTML=s;document.getElementById('rows').innerHTML=rows.map(r=>`<tr><td>${r.limits==='on'?'开启限流':'关闭限流'}</td><td>${r.target}</td><td>${(r.rps||0).toFixed(2)}</td><td>${r.p95_ms==null?'—':r.p95_ms.toFixed(1)}</td><td>${r.limited||0}</td><td>${r.stable?'通过':'未通过'}</td></tr>`).join('')}select.onchange=render;render()</script></html>'''.replace('PAYLOAD', payload)
    (output / 'report.html').write_text(page)
    return {'trials': len(trials), 'restored': restored['restored']}


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--state', required=True); p.add_argument('--output', required=True); args = p.parse_args()
    print(json.dumps(generate(args.state, args.output)))
