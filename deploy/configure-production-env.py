#!/usr/bin/env python3
"""Create the backend's root-only production environment on first install."""
import base64
import getpass
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile


ROOT = Path('/srv/qanda')
TARGET = ROOT / 'production.env'
TEMPLATE = Path(__file__).with_name('production.env.example')
STATEFUL_VOLUMES = {'qanda-production-pg', 'qanda-production-rabbit'}


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def single_quoted(value):
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        fail('配置值不能包含控制字符。')
    return "'" + value.replace("'", "\\'") + "'"


def prompt(label, *, secret=False, valid=None, invalid='输入值格式不正确。'):
    while True:
        value = getpass.getpass(label) if secret else input(label).strip()
        if value and value == value.strip() and (valid is None or valid(value)):
            return value
        print(invalid, file=sys.stderr)


def token():
    return base64.b64encode(secrets.token_bytes(32)).decode('ascii')


def existing_stateful_volumes():
    try:
        result = subprocess.run(
            ['docker', 'volume', 'ls', '--quiet'],
            check=True, capture_output=True, text=True, timeout=15,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        fail('无法确认 Docker 数据卷状态；配置文件未创建。')
    return sorted(STATEFUL_VOLUMES.intersection(result.stdout.splitlines()))


def template_keys(text):
    keys = set()
    for line in text.splitlines():
        if not line or line.lstrip().startswith('#'):
            continue
        key, separator, _ = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key) or key in keys:
            fail('production.env.example 格式无效；配置文件未创建。')
        keys.add(key)
    return keys


def render(text, values):
    lines = []
    for line in text.splitlines():
        key, separator, _ = line.partition('=')
        lines.append(key + '=' + single_quoted(values[key]) if separator and key in values else line)
    return '\n'.join(lines) + '\n'


def install_config(content, replace_empty, expected_content=None):
    fd, temporary = tempfile.mkstemp(prefix='.production.env.', dir=ROOT)
    try:
        os.fchown(fd, 0, 0)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if replace_empty:
            current = TARGET.lstat()
            identity = (current.st_dev, current.st_ino, current.st_size)
            if not stat.S_ISREG(current.st_mode) or identity != replace_empty:
                fail('production.env 状态已变化；未覆盖现有配置。')
            if expected_content is not None and TARGET.read_bytes() != expected_content:
                fail('production.env 内容已变化；未覆盖现有配置。')
            os.replace(temporary, TARGET)
            temporary = ''
        else:
            try:
                os.link(temporary, TARGET)
            except FileExistsError:
                fail('production.env 已由其他操作创建；未覆盖现有配置。')
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def extend_cache_config(text):
    keys = template_keys(text)
    defaults = {'BACKEND_REDIS_HOST': 'qanda-redis', 'BACKEND_CONTENT_CACHE_ENABLED': 'true'}
    lines = text.splitlines(keepends=True)
    password_present = False
    for index, line in enumerate(lines):
        if line.startswith('BACKEND_REDIS_PASSWORD='):
            password_present = True
            if line.partition('=')[2].strip() in ('', "''", '""'):
                lines[index] = 'BACKEND_REDIS_PASSWORD=' + single_quoted(secrets.token_hex(32)) + '\n'
    if not password_present:
        defaults['BACKEND_REDIS_PASSWORD'] = secrets.token_hex(32)
    extra = ''.join(key + '=' + single_quoted(value) + '\n' for key, value in defaults.items() if key not in keys)
    value = ''.join(lines)
    return value + ('\n' if extra and value and not value.endswith('\n') else '') + extra


def ensure_cache():
    if os.geteuid() != 0 or ROOT.is_symlink() or TARGET.is_symlink():
        fail('缓存配置升级需要 root 管理的普通配置文件。')
    root = ROOT.stat(); current = TARGET.lstat()
    if root.st_uid != 0 or root.st_mode & 0o022 or not stat.S_ISREG(current.st_mode) or current.st_uid != 0 or current.st_mode & 0o077 or not current.st_size:
        fail('现有配置目录、文件属主或权限不符合要求；未修改缓存配置。')
    original = TARGET.read_bytes()
    updated = extend_cache_config(original.decode('utf-8')).encode('utf-8')
    if updated != original:
        install_config(updated.decode('utf-8'), (current.st_dev, current.st_ino, current.st_size), expected_content=original)
    print('缓存配置已就绪，现有业务配置和密钥保持原值。')


def main():
    if sys.argv[1:] == ['--ensure-cache']:
        ensure_cache()
        return
    if sys.argv[1:]:
        fail('用法：configure-production-env.py [--ensure-cache]')
    if os.geteuid() != 0:
        fail('请通过 sudo bash deploy/install.sh 运行首次安装。')
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        fail('首次配置需要交互式服务器终端；配置文件未创建。')

    ROOT.mkdir(parents=True, exist_ok=True)
    if ROOT.is_symlink():
        fail('/srv/qanda 不能是符号链接；配置文件未创建。')
    root_stat = ROOT.stat()
    if root_stat.st_uid != 0 or root_stat.st_mode & 0o022:
        fail('/srv/qanda 必须由 root 管理且不能允许组或其他用户写入。')

    existed_empty = os.path.lexists(TARGET)
    if existed_empty:
        if TARGET.is_symlink() or not TARGET.is_file():
            fail('production.env 不是普通文件；请先检查服务器配置。')
        existing = TARGET.stat()
        if existing.st_size:
            print('production.env 已存在，保留原配置。')
            return
        empty_identity = (existing.st_dev, existing.st_ino, existing.st_size)

    try:
        template = TEMPLATE.read_text(encoding='utf-8')
    except OSError:
        fail('缺少 deploy/production.env.example；配置文件未创建。')
    missing = {
        'BACKEND_DB_PASSWORD', 'BACKEND_RABBIT_PASSWORD', 'BACKEND_REDIS_PASSWORD',
        'BACKEND_COMMAND_DIGEST_KEYS', 'BACKEND_IDENTITY_MAC_KEYS',
        'BACKEND_IDENTITY_RATE_KEY', 'BACKEND_MAIL_ENCRYPTION_KEYS',
        'BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS', 'BACKEND_WECHAT_APP_ID',
        'BACKEND_WECHAT_APP_SECRET', 'BACKEND_WECHAT_PROVIDER',
        'BACKEND_MAIL_ENABLED', 'BACKEND_MAIL_TRANSPORT',
        'BACKEND_SES_SEND_ENABLED', 'BACKEND_COMMAND_DIGEST_ACTIVE_VERSION',
        'BACKEND_IDENTITY_MAC_ACTIVE_VERSION', 'BACKEND_MAIL_ENCRYPTION_ACTIVE_VERSION',
        'BACKEND_TEST_ACCOUNT_ENCRYPTION_ACTIVE_VERSION',
        'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_SES_REGION',
        'TENCENT_SES_FROM_EMAIL', 'TENCENT_SES_VERIFICATION_TEMPLATE_ID',
    } - template_keys(template)
    if missing:
        fail('配置模板缺少字段：' + ', '.join(sorted(missing)) + '。')

    volumes = existing_stateful_volumes()
    if volumes:
        fail('发现已有题小搭数据库或队列数据卷：' + ', '.join(volumes) + '。保留现状；请先恢复对应配置。')

    print('后端生产模式要求启用腾讯云 SES 实发；测试操作可能发送真实邮件。')
    if input('若确认允许真实邮件发送，请输入 YES：').strip() != 'YES':
        fail('未确认真实邮件发送；配置文件未创建。')

    values = {
        'BACKEND_DB_PASSWORD': secrets.token_hex(32),
        'BACKEND_RABBIT_PASSWORD': secrets.token_hex(32),
        'BACKEND_REDIS_PASSWORD': secrets.token_hex(32),
        'BACKEND_COMMAND_DIGEST_KEYS': '1:' + token(),
        'BACKEND_COMMAND_DIGEST_ACTIVE_VERSION': '1',
        'BACKEND_IDENTITY_MAC_KEYS': '1:' + token(),
        'BACKEND_IDENTITY_MAC_ACTIVE_VERSION': '1',
        'BACKEND_IDENTITY_RATE_KEY': token(),
        'BACKEND_MAIL_ENCRYPTION_KEYS': '1:' + token(),
        'BACKEND_MAIL_ENCRYPTION_ACTIVE_VERSION': '1',
        'BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS': '1:' + token(),
        'BACKEND_TEST_ACCOUNT_ENCRYPTION_ACTIVE_VERSION': '1',
        'BACKEND_WECHAT_PROVIDER': 'official',
        'BACKEND_MAIL_ENABLED': 'true',
        'BACKEND_MAIL_TRANSPORT': 'tencent-ses',
        'BACKEND_WECHAT_APP_ID': prompt(
            '微信小程序 AppID：', secret=True,
            valid=lambda value: bool(re.fullmatch(r'wx[A-Za-z0-9]{16}', value)),
            invalid='AppID 格式不正确。',
        ),
        'BACKEND_WECHAT_APP_SECRET': prompt(
            '微信小程序 AppSecret（输入不回显）：', secret=True,
            valid=lambda value: len(value) <= 256,
            invalid='AppSecret 长度不能超过 256 个字符。',
        ),
        'TENCENT_SECRET_ID': prompt('腾讯云 SecretId（输入不回显）：', secret=True),
        'TENCENT_SECRET_KEY': prompt('腾讯云 SecretKey（输入不回显）：', secret=True),
        'TENCENT_SES_REGION': prompt(
            'SES 地域（ap-guangzhou 或 ap-hongkong）：',
            valid=lambda value: value in {'ap-guangzhou', 'ap-hongkong'},
            invalid='请选择 ap-guangzhou 或 ap-hongkong。',
        ),
        'TENCENT_SES_FROM_EMAIL': prompt(
            'SES 已验证发件邮箱：',
            valid=lambda value: len(value) <= 254 and bool(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value)),
            invalid='请输入有效邮箱地址。',
        ),
        'TENCENT_SES_VERIFICATION_TEMPLATE_ID': prompt(
            'SES 验证邮件模板 ID：',
            valid=lambda value: value.isdecimal() and len(value) <= 19 and 0 < int(value) <= 9223372036854775807,
            invalid='模板 ID 必须为正整数。',
        ),
        'BACKEND_SES_SEND_ENABLED': 'true',
    }

    replacement = empty_identity if existed_empty else None
    install_config(render(template, values), replace_empty=replacement)
    print('已创建 /srv/qanda/production.env（root:root，权限 600）。密钥值未回显。')


if __name__ == '__main__':
    main()
