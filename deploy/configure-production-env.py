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
from urllib.parse import urlsplit


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


def https_origin(value):
    if not isinstance(value, str) or re.search(r'[\s\\]', value):
        return False
    try:
        parts = urlsplit(value)
        return (parts.scheme == 'https' and bool(parts.hostname) and parts.username is None and parts.password is None
                and parts.path in ('', '/') and not parts.query and not parts.fragment
                and (parts.port is None or 1 <= parts.port <= 65535))
    except ValueError:
        return False


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


def install_config(content, replace_empty):
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


def validate_config():
    if os.geteuid() != 0 or ROOT.is_symlink() or TARGET.is_symlink():
        fail('生产配置需要 root 管理的普通配置文件。')
    root = ROOT.stat(); current = TARGET.lstat()
    if root.st_uid != 0 or root.st_mode & 0o022 or not stat.S_ISREG(current.st_mode) or current.st_uid != 0 or current.st_mode & 0o077 or not current.st_size:
        fail('生产配置目录、文件属主或权限不符合要求。')
    text = TARGET.read_text()
    missing = template_keys(TEMPLATE.read_text()) - template_keys(text)
    values = dict(line.split('=', 1) for line in text.splitlines() if line and not line.lstrip().startswith('#'))
    plain = {key: value.strip("'\"") for key, value in values.items()}
    invalid = set()
    if not plain.get('BACKEND_REDIS_PASSWORD'):
        invalid.add('BACKEND_REDIS_PASSWORD')
    if not https_origin(plain.get('BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL', '')):
        invalid.add('BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL')
    if not 3 <= len(plain.get('BACKEND_WECHAT_CALLBACK_TOKEN', '')) <= 32:
        invalid.add('BACKEND_WECHAT_CALLBACK_TOKEN')
    if not re.fullmatch(r'[A-Za-z0-9+/]{43}', plain.get('BACKEND_WECHAT_CALLBACK_AES_KEY', '')):
        invalid.add('BACKEND_WECHAT_CALLBACK_AES_KEY')
    if missing or invalid:
        fail('生产配置缺少或包含无效必需字段：' + ', '.join(sorted(missing | invalid)))
    print('生产配置校验通过。')


def main():
    if sys.argv[1:] == ['--validate']:
        validate_config()
        return
    if sys.argv[1:]:
        fail('用法：configure-production-env.py [--validate]')
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
        'BACKEND_CONTENT_SAFETY_PROVIDER', 'BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL',
        'BACKEND_WECHAT_CALLBACK_TOKEN', 'BACKEND_WECHAT_CALLBACK_AES_KEY',
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
        'BACKEND_CONTENT_SAFETY_PROVIDER': 'official',
        'BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL': prompt(
            '内容审核使用的公网 HTTPS origin（如 https://qanda.api.zhoust.cn）：', valid=https_origin,
            invalid='请输入不含账号、路径、查询和片段的 HTTPS 地址。',
        ),
        'BACKEND_WECHAT_CALLBACK_TOKEN': prompt(
            '微信消息推送 Token（输入不回显，须与控制台一致）：', secret=True,
            valid=lambda value: 3 <= len(value) <= 32, invalid='Token 长度须为 3 至 32 个字符。',
        ),
        'BACKEND_WECHAT_CALLBACK_AES_KEY': prompt(
            '微信消息推送 EncodingAESKey（输入不回显，须与控制台一致）：', secret=True,
            valid=lambda value: bool(re.fullmatch(r'[A-Za-z0-9+/]{43}', value)), invalid='EncodingAESKey 须为 43 位 Base64 字符。',
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
