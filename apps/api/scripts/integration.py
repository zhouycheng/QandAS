"""Prepare and inspect the isolated, persistent development environment."""
import base64
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import string
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[3]
PRIVATE = Path(os.environ.get("QANDA_INTEGRATION_DIR", Path.home() / ".config/qanda/integration"))
CONFIG = PRIVATE / "environment.json"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def compose_environment():
    env = {**os.environ, "BACKEND_ENV_FILE": str(PRIVATE / "backend.env")}
    ses = Path.home() / ".config/qanda/tencent-ses.env"
    if ses.exists():
        if ses.stat().st_mode & 0o077:
            raise RuntimeError("SES 私有配置权限须为 600")
        for line in ses.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            entry = re.fullmatch(r"(TENCENT_[A-Z0-9_]+)=(.*)", line)
            if not entry:
                raise RuntimeError("SES 私有配置格式错误")
            if entry[2]:
                env.setdefault(entry[1], entry[2])
    return env


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    temp.replace(path)


def initialize():
    if CONFIG.exists():
        raise RuntimeError("联调配置已存在，保留原账号和密钥")
    config = {
        "project": "qanda-integration",
        "dockerHost": "unix://" + str(Path.home() / ".colima/qanda-integration/docker.sock"),
        "api": "http://127.0.0.1:8084", "adminUrl": "http://localhost:5174",
        "mail": "http://127.0.0.1:58026",
        "admin": {"username": "integration_admin", "name": "联调管理员甲"},
        "secondAdmin": {"username": "integration_editor", "name": "联调管理员乙"},
        "student": {"email": "student@example.test", "nickname": "联调同学"},
        "secondStudent": {"email": "student2@example.test", "nickname": "联调同学乙"},
    }
    for account in ["admin", "secondAdmin", "student", "secondStudent"]:
        config[account]["password"] = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(14)) + "A7"
        config[account]["deviceId"] = str(uuid.uuid4())
    values = dict(line.split("=", 1) for line in (ROOT / "apps/api/.env.backend.example").read_text().splitlines() if "=" in line)
    values.update({"BACKEND_API_PORT": "8084", "BACKEND_DB_PORT": "56433", "BACKEND_SMTP_PORT": "51026",
                   "BACKEND_MAIL_UI_PORT": "58026", "BACKEND_IMAGE": "qanda-backend:integration",
                   "BACKEND_ENV_FILE": str(PRIVATE / "backend.env"),
                   "BACKEND_DB_PASSWORD": secrets.token_urlsafe(32), "BACKEND_RABBIT_PASSWORD": secrets.token_urlsafe(32)})
    for key in ["COMMAND_DIGEST", "IDENTITY_MAC", "MAIL_ENCRYPTION"]:
        values["BACKEND_" + key + "_KEYS"] = "1:" + base64.b64encode(secrets.token_bytes(32)).decode()
    values["BACKEND_IDENTITY_RATE_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(PRIVATE / "backend.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write("".join(key + "=" + value + "\n" for key, value in values.items()))
    save(CONFIG, config)
    print("已生成私有联调配置和独立测试账号")


def configuration():
    if CONFIG.stat().st_mode & 0o077:
        raise RuntimeError("私有配置权限须为 600")
    config = json.loads(CONFIG.read_text())
    if config["project"] != "qanda-integration" or not config["dockerHost"].startswith("unix://"):
        raise RuntimeError("联调仅使用独立本机 Docker 项目")
    for key in ["api", "adminUrl", "mail"]:
        url = urlsplit(config[key])
        if url.scheme != "http" or url.hostname not in ["127.0.0.1", "localhost"] or url.username or url.password:
            raise RuntimeError("联调仅允许本机服务地址")
    return config


def compose(config, *args):
    return ["docker", "--host", config["dockerHost"], "compose", "-p", config["project"],
            "--env-file", str(PRIVATE / "backend.env"), "-f", str(ROOT / "apps/api/compose.backend.yml"), *args]


def request(config, method, path, body=None, token=None, key=None, expected=None):
    headers = {"Content-Type": "application/json", "X-Request-Id": str(uuid.uuid4())}
    if token:
        headers["Authorization"] = "Bearer " + token
    if method not in ("GET", "HEAD"):
        headers["Idempotency-Key"] = key or str(uuid.uuid4())
    req = urllib.request.Request(config["api"] + "/api/v1" + path,
                                 None if body is None else json.dumps(body).encode(), headers, method=method)
    try:
        response = OPENER.open(req, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    try:
        data = json.loads(raw) if raw else None
    except ValueError:
        raise RuntimeError(f"{method} {path.split('?')[0]}: HTTP {response.code}，响应格式异常") from None
    if (expected is not None and response.code != expected) or (expected is None and not 200 <= response.code < 300):
        code = data.get("code", data.get("error", {}).get("code", "")) if isinstance(data, dict) else ""
        raise RuntimeError(f"{method} {path.split('?')[0]}: HTTP {response.code} {code}")
    return data


def login(config, name):
    account = config[name]
    admin = "username" in account
    body = {key: account[key] for key in ["username" if admin else "email", "password", "deviceId"]}
    return request(config, "POST", "/admin/auth/sessions" if admin else "/auth/sessions", body)["accessToken"]


def bootstrap(config):
    if config.get("bootstrapped"):
        login(config, "admin")
        print("超级管理员已就绪")
        return
    master, slave = pty.openpty()
    process = subprocess.Popen(compose(config, "run", "--rm", "--no-deps", "-it", "api", "bootstrap"),
                               stdin=slave, stdout=slave, stderr=slave, env=compose_environment())
    os.close(slave)
    prompts = ["管理员用户名：", "管理员姓名：", "管理员密码："]
    account = config["admin"]
    answers = [account["username"], account["name"], account["password"]]
    stage, buffer = 0, b""
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and process.poll() is None:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    buffer += os.read(master, 65536)
                except OSError:
                    break
            if stage < 3 and prompts[stage].encode() in buffer:
                os.write(master, (answers[stage] + "\n").encode())
                stage, buffer = stage + 1, b""
        if stage != 3 or process.wait(timeout=10) != 0:
            raise RuntimeError("首管创建失败，请检查隔离 API 日志")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        os.close(master)
    login(config, "admin")
    config["bootstrapped"] = True
    save(CONFIG, config)
    print("已通过真实终端创建超级管理员")


def seed(config):
    path = PRIVATE / "fixtures.json"
    fixtures = json.loads(path.read_text()) if path.exists() else {}
    token = login(config, "admin")

    def once(name, method, url, body, auth=token):
        record = fixtures.setdefault(name, {"key": str(uuid.uuid4()), "body": body})
        if "result" not in record:
            save(path, fixtures)
            record["result"] = request(config, method, url, record["body"], auth, record["key"])
            save(path, fixtures)
        return record["result"]

    editor = once("editor", "POST", "/admin/administrators", {**{k: config["secondAdmin"][k] for k in ["username", "name", "password"]}, "role": "SUPER_ADMIN"})
    college = once("college", "POST", "/admin/colleges", {"name": "联调工程学院", "code": "INTEGRATION"})
    majors = [once("major" + str(i), "POST", "/admin/majors", {"collegeId": college["id"], "name": name, "code": "INT" + str(i)})
              for i, name in enumerate(["软件工程", "信息管理"])]
    subject = once("subject", "POST", "/admin/subjects", {"name": "三端联调演示课", "description": "用于目录、六类题型与同步联调"})
    bank = once("bank", "POST", "/admin/question-banks", {"subjectId": subject["id"], "name": "六类题型练习", "description": "可反复练习的联调样例", "scopeType": "ALL", "maintainerIds": [editor["id"]]})
    chapter = once("chapter", "POST", f"/admin/question-banks/{bank['id']}/chapters", {"name": "第一章：基础联调", "sortOrder": 0})
    questions = [
        {"type": "SINGLE_CHOICE", "stem": "HTTP 中读取资源通常使用哪个方法？", "options": [{"key": "A", "content": "GET"}, {"key": "B", "content": "DELETE"}], "correctAnswer": ["A"], "explanation": "GET 用于读取资源。"},
        {"type": "MULTIPLE_CHOICE", "stem": "哪些属于关系数据库？", "options": [{"key": "A", "content": "PostgreSQL"}, {"key": "B", "content": "MySQL"}, {"key": "C", "content": "RabbitMQ"}], "correctAnswer": ["A", "B"], "explanation": "PostgreSQL 和 MySQL 是关系数据库。"},
        {"type": "TRUE_FALSE", "stem": "收到 202 响应就表示答案已经写入数据库。", "correctValue": False, "explanation": "202 表示已接收，需要等待落库回执。"},
        {"type": "FILL_BLANK", "stem": "读取方法为 {{1}}，本系统数据库为 {{2}}。", "blanks": [{"answers": ["GET"]}, {"answers": ["PostgreSQL", "postgres"]}], "explanation": "GET 读取资源，PostgreSQL 保存业务数据。"},
        {"type": "SHORT_ANSWER", "stem": "为什么同步过程中要保留本机草稿？", "referenceAnswer": "在网络中断或服务处理中保留作答，收到落库回执后再清理。", "scoringPoints": ["保留作答", "等待落库回执"], "explanation": "本机保存与服务器确认是不同阶段。"},
        {"type": "READING", "stem": "阅读：可靠同步", "passage": "客户端先保存草稿，再将进度交给队列。消费者提交数据库事务后产生回执。\n客户端收到回执后清理已确认草稿。", "subQuestions": [
            {"type": "TRUE_FALSE", "stem": "客户端应先保存草稿再上传。", "correctValue": True, "explanation": "先持久化能够保护未上传的作答。"},
            {"type": "SINGLE_CHOICE", "stem": "何时可以清理已确认草稿？", "options": [{"key": "A", "content": "收到落库回执"}, {"key": "B", "content": "刚发出请求"}], "correctAnswer": ["A"], "explanation": "数据库提交后的回执是清理依据。"}], "explanation": "根据材料判断同步顺序。"},
    ]
    for question in questions:
        once(question["type"], "POST", "/admin/questions", {**question, "questionBankId": bank["id"], "chapterId": chapter["id"]})
    current = request(config, "GET", f"/admin/question-banks/{bank['id']}", token=token)
    once("publication", "PUT", f"/admin/question-banks/{bank['id']}/publication", {"expectedVersion": current["version"], "status": "PUBLISHED"})
    restricted_subject = once("restrictedSubject", "POST", "/admin/subjects", {"name": "软件工程专业课"})
    restricted = once("restrictedBank", "POST", "/admin/question-banks", {"subjectId": restricted_subject["id"], "name": "专业范围联调", "description": "软件工程专业可见", "scopeType": "TARGETED", "audiences": [{"majorId": majors[0]["id"]}], "maintainerIds": [editor["id"]]})
    once("restrictedQuestion", "POST", "/admin/questions", {**questions[0], "questionBankId": restricted["id"]})
    current = request(config, "GET", f"/admin/question-banks/{restricted['id']}", token=token)
    once("restrictedPublication", "PUT", f"/admin/question-banks/{restricted['id']}/publication", {"expectedVersion": current["version"], "status": "PUBLISHED"})
    once("draftBank", "POST", "/admin/question-banks", {"subjectId": subject["id"], "name": "未发布联调草稿", "scopeType": "ALL"})
    once("announcement", "POST", "/admin/announcements", {"title": "三端联调已开放", "summary": "六类题型、资料范围与同步监控可开始体验", "body": "请从题库进入六类题型练习。作答后可在管理端查看学习记录与同步情况。", "status": "PUBLISHED"})
    for index, name in enumerate(["student", "secondStudent"]):
        account = config[name]
        if name not in fixtures or "result" not in fixtures[name]:
            challenge = once(name + "Challenge", "POST", "/auth/email-challenges", {"purpose": "REGISTER", "email": account["email"]}, None)
            code = None
            for _ in range(45):
                with OPENER.open(config["mail"] + "/api/v1/messages", timeout=5) as response:
                    messages = json.load(response).get("messages", [])
                for message in messages:
                    if not any(to.get("Address") == account["email"] for to in message.get("To", [])):
                        continue
                    with OPENER.open(config["mail"] + "/api/v1/message/" + message["ID"], timeout=5) as response:
                        content = json.load(response)
                    found = re.search(r"(?<!\d)\d{6}(?!\d)", content.get("Text", ""))
                    if found:
                        code = found.group()
                        break
                if code:
                    break
                time.sleep(1)
            if not code:
                raise RuntimeError("本地验证码未送达，请检查 worker 邮件投递")
            once(name, "POST", "/auth/email-registrations", {"challengeId": challenge["id"], "code": code, "password": account["password"], "nickname": account["nickname"]}, None)
        student_token = login(config, name)
        me = request(config, "GET", "/me", token=student_token)
        once(name + "Profile", "PUT", "/me/profile", {"expectedVersion": me["version"], "nickname": account["nickname"], "majorId": majors[index]["id"], "currentGrade": 2}, student_token)
    print("已准备两名超级管理员、两名学生、两种专业范围、六类题型和公告")


def connect(config):
    path = ROOT / "apps/miniapp/miniprogram/ext.json"
    data = json.loads(path.read_text()) if path.exists() else json.loads((path.parent / "ext.example.json").read_text())
    if not (PRIVATE / "miniapp-original.json").exists():
        save(PRIVATE / "miniapp-original.json", data)
    data.setdefault("extConfig", {})["apiBaseUrl"] = config["api"]
    save(path, data)
    subprocess.run(["npm", "run", "build"], cwd=ROOT / "apps/miniapp", check=True)


def reset_student_passwords(config):
    path = PRIVATE / "password-resets.json"
    records = json.loads(path.read_text()) if path.exists() else {}
    for name in ["student", "secondStudent"]:
        if len(config[name]["password"]) <= 16:
            continue
        record = records.setdefault(name, {"password": "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(14)) + "A7", "key": str(uuid.uuid4())})
        if "body" not in record:
            with OPENER.open(config["mail"] + "/api/v1/messages", timeout=5) as response:
                previous = {m["ID"] for m in json.load(response).get("messages", [])}
            challenge = request(config, "POST", "/auth/email-challenges", {"purpose": "RESET_PASSWORD", "email": config[name]["email"]})
            for _ in range(45):
                with OPENER.open(config["mail"] + "/api/v1/messages", timeout=5) as response:
                    messages = json.load(response).get("messages", [])
                for message in messages:
                    if message["ID"] in previous or not any(to.get("Address") == config[name]["email"] for to in message.get("To", [])):
                        continue
                    with OPENER.open(config["mail"] + "/api/v1/message/" + message["ID"], timeout=5) as response:
                        found = re.search(r"(?<!\d)\d{6}(?!\d)", json.load(response).get("Text", ""))
                    if found:
                        record["body"] = {"challengeId": challenge["id"], "code": found.group(), "newPassword": record["password"]}
                        save(path, records)
                        break
                if "body" in record:
                    break
                time.sleep(1)
            if "body" not in record:
                raise RuntimeError("重置验证码未送达")
        request(config, "POST", "/auth/password-resets", record["body"], key=record["key"])
        config[name]["password"] = record["password"]
        save(CONFIG, config)
        login(config, name)
    print("学生测试账号已通过正式重置接口采用 16 位字母数字密码")


def main():
    command = sys.argv[1]
    if command == "init":
        return initialize()
    config = configuration()
    if command == "up":
        subprocess.run(["node", str(ROOT / "apps/api/scripts/backend.mjs"), "build"], cwd=ROOT, check=True)
        subprocess.run(compose(config, "build", "api"), env=compose_environment(), check=True)
        subprocess.run(compose(config, "up", "-d", "--wait", "--wait-timeout", "180"), env=compose_environment(), check=True)
    elif command == "bootstrap":
        bootstrap(config)
    elif command == "seed":
        seed(config)
    elif command == "connect":
        connect(config)
    elif command == "passwords":
        reset_student_passwords(config)
    elif command == "admin":
        environment = {**os.environ, "VITE_API_BASE_URL": "/", "QANDA_API_PROXY_TARGET": config["api"]}
        subprocess.run(["pnpm", "dev", "--host", "127.0.0.1", "--strictPort"], cwd=ROOT / "apps/admin", env=environment, check=True)
    elif command in ("status", "logs", "stop"):
        args = {"status": ["ps"], "logs": ["logs", "--tail", "80", "api", "worker", "monitor"], "stop": ["stop"]}[command]
        subprocess.run(compose(config, *args), env=compose_environment(), check=True)
    else:
        raise RuntimeError("命令：init up bootstrap seed passwords connect admin status logs stop")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
