"""Export measured capacity results without connection parameters or credentials."""
import argparse
import csv
from datetime import datetime
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from resources import series, server_p95


def generate(state, output):
    state, output = Path(state), Path(output); output.mkdir(parents=True, exist_ok=True)
    trials = json.loads((state / 'results.json').read_text())
    completion = json.loads((state / 'completion.json').read_text()) if (state / 'completion.json').exists() else {'suite_complete': False}
    restored = json.loads((state / 'restoration.json').read_text()) if (state / 'restoration.json').exists() else {'restored': False}
    if (state / 'configuration.json').exists():
        (output / 'configuration.json').write_text((state / 'configuration.json').read_text())
    trends = {}
    for trial in trials:
        path = state / 'trials' / trial['label'] / 'samples.jsonl'
        samples = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        trends[trial['label']] = series(samples)
        trial['server_p95_bucket_ms'] = server_p95(samples)
        k6_path = state / 'trials' / trial['label'] / 'k6-summary.json'
        k6 = json.loads(k6_path.read_text()).get('metrics', {}) if k6_path.exists() else {}
        trial['compressed_responses'] = k6.get('compressed_responses', {}).get('count', 0)
        trial['achieved_vus_peak'] = k6.get('vus', {}).get('max')
        trial['generator_received_bytes'] = k6.get('data_received', {}).get('count')
        trial['generator_sent_bytes'] = k6.get('data_sent', {}).get('count')
        trial['accepted_verified'] = trial.get('audit', {}).get('committed')
        trial['accepted_mismatches'] = trial.get('audit', {}).get('answer_mismatches')
    fields = sorted({key for rows in trends.values() for row in rows for key in row})
    with (output / 'resources.csv').open('w') as f:
        writer = csv.DictWriter(f, ['label'] + fields); writer.writeheader()
        for label, rows in trends.items(): writer.writerows({'label': label, **row} for row in rows)
    columns = ['scenario', 'limits', 'label', 'target', 'duration', 'wall_seconds', 'stable', 'http', 'rps', 'successful_rps', 'completed_operations_per_second', 'limited', 'server_errors', 'transport_errors', 'other_errors', 'p95_ms', 'p99_ms', 'commit_p95_ms', 'commit_p99_ms', 'business_success', 'dropped_iterations', 'stop_reason', 'recovery_seconds', 'recovery_includes_readiness', 'source_run', 'integrity_passed', 'accepted_verified', 'accepted_commands', 'committed_commands', 'new_commands', 'unobserved_registrations', 'accepted_mismatches', 'server_p95_bucket_ms', 'suite_stop', 'backend_revision', 'harness_sha256', 'fixture_users', 'fixture_banks', 'achieved_vus_peak', 'generator_received_bytes', 'generator_sent_bytes', 'compressed_responses', 'burst_started', 'burst_start_spread_ms', 'burst_inflight_peak']
    with (output / 'trials.csv').open('w') as f:
        writer = csv.DictWriter(f, columns, extrasaction='ignore'); writer.writeheader(); writer.writerows(trials)
    public = [{key: row.get(key) for key in columns} for row in trials]
    (output / 'trials.json').write_text(json.dumps(public, ensure_ascii=False, indent=2))
    lines = ['# 题小搭后端容量实测', '', '生成时间：' + datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds'), '', '整套测试完成：' + str(completion['suite_complete']) + '。', '',
             '测试对象为新后端，经 Mac 原生 k6 与私有 SSH 隧道发压。数据使用独立数据库卷及 RabbitMQ vhost，压测期间保留现有应用和基础服务资源限制。', '',
             'A 组保留每来源每 60 秒 60000 次、每账号读取 600 次和写入 120 次的固定窗口限流；B 组关闭普通业务请求限流。认证和权限校验在两组中均启用。', '',
             '| 场景 | 限流 | 最高通过档 | 首个未通过档 | 通过档最高成功 RPS | 30 分钟稳定档 |', '|---|---|---:|---:|---:|---:|']
    for scenario in dict.fromkeys(x['scenario'] for x in trials):
        for policy in ('on', 'off'):
            rows = [x for x in trials if x['scenario'] == scenario and x['limits'] == policy]
            if not rows: continue
            good = [x['target'] for x in rows if x['stable']]; bad = [x['target'] for x in rows if not x['stable']]
            soak = [x['target'] for x in rows if x['stable'] and x['duration'] >= 1800]
            lines.append('| ' + ' | '.join([scenario, '开启' if policy == 'on' else '关闭', str(max(good)) if good else '未确认', str(min(bad)) if bad else '未触达', f"{max((x.get('successful_rps', 0) for x in rows if x['stable']), default=0):.2f}", str(max(soak)) if soak else '未确认']) + ' |')
    lines += ['', '后端版本：`' + str(next((x.get('backend_revision') for x in trials if x.get('backend_revision')), '见私有运行清单')) + '`。', '',
              '成功 RPS 仅包含收到成功响应的请求；业务操作完成速率、异步最终落库和请求成功吞吐分别计量。表中通过档均满足当次延迟与错误率标准；30 分钟档提供持续运行证据。', '', '真实学生场景的档位单位为活跃用户；读取、创建、同步和交卷场景为目标业务操作／秒，实际 HTTP RPS 包含协议中的回执查询和准备请求；突发场景为一秒内计划发起操作的用户数。保护提前终止时，实际达到的峰值 VU 可能低于目标档位；两者分别保存在逐次结果中。具体实发量、启动时间分布和未启动迭代一并记录。', '',
              '## 数据一致性与恢复', '', f"- 完成运行：{len(trials)} 次。", f"- 全部运行持久化校验通过：{all(x.get('integrity_passed') for x in trials)}。", f"- 原运行配置及服务已恢复：{restored['restored']}。", f"- 临时数据库与消息数据已清理：{restored.get('temporary_data_cleaned', False)}。", '',
              '原始响应指标、容器/JVM/数据库连接池指标、队列指标和命令核对证据保存在仓库外的私有运行目录。202 只计为受理，数据一致性以最终 COMMITTED 回执和答案核对为准。', '',
              '## 指标文件', '', '`trials.csv` 和 `trials.json` 保存逐次负载、成功吞吐、P95/P99、429、5xx、传输失败及停止原因；`resources.csv` 保存主机、容器 CPU/内存、JVM/GC、连接池等待、队列和投影滞后趋势；`report.html` 可交互查看。服务端 P95 是直方图桶上界估计，不含完整客户端链路耗时。', '', '## 结果边界', '', '若停止原因属于发压端、管理连接或链路保护，本次只建立已测下限。注册总人数、真实微信登录、邮件提供端和公网全链路容量需要各自的证据。建议常规负载在已验证稳定容量基础上预留约 30% 余量。']
    (output / 'report.md').write_text('\n'.join(lines) + '\n')
    payload = json.dumps({'trials': public, 'series': trends, 'complete': completion['suite_complete']}, ensure_ascii=False).replace('<', '\\u003c')
    page = Path(__file__).with_name('report-template.html').read_text().replace('CAPACITY_PAYLOAD', payload)
    (output / 'report.html').write_text(page)
    return {'trials': len(trials), 'restored': restored['restored']}


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--state', required=True); p.add_argument('--output', required=True); args = p.parse_args()
    print(json.dumps(generate(args.state, args.output)))
