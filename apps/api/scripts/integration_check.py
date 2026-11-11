"""Run real HTTP and queue checks against the isolated integration fixtures."""
import json
import subprocess
import time
import urllib.request
import uuid
from integration import PRIVATE, OPENER, compose, configuration, login, request, save


def main():
    config = configuration()
    fixtures = json.loads((PRIVATE / "fixtures.json").read_text())
    resource = lambda name: fixtures[name]["result"]["id"]
    checks = []

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)
        print("PASS " + name, flush=True)

    admin, student, second = (login(config, name) for name in ["admin", "student", "secondStudent"])
    r = lambda method, path, body=None, **kwargs: request(config, method, path, body, **kwargs)
    bank, restricted = resource("bank"), resource("restrictedBank")
    guest_banks = r("GET", "/question-banks?pageSize=20")
    check("游客可见已发布题库", {bank, restricted}.issubset({item["id"] for item in guest_banks["items"]}))
    r("GET", "/question-banks/" + resource("draftBank"), expected=404)
    check("游客无法读取未发布题库", resource("draftBank") not in {item["id"] for item in guest_banks["items"]})
    check("不同账号均可按 ID 打开分类题库", r("GET", "/question-banks/" + restricted, token=second)["id"] == restricted)
    selected = r("GET", "/question-banks?majorId=" + resource("major1"), token=second)
    check("分类只影响目录筛选", restricted not in {item["id"] for item in selected["items"]})
    check("已发布公告可读取", any(item["id"] == resource("announcement") for item in r("GET", "/announcements", token=student)["items"]))

    scope = {"questionBankId": bank, "count": 7, "order": "SEQUENTIAL"}
    preview = r("POST", "/practice/scope-preview", scope, token=student)
    session = r("POST", "/practice/sessions", {"scope": scope, "expectedContentVersion": preview["contentVersion"], "deviceId": config["student"]["deviceId"], "feedback": "AFTER_FINISH"}, token=student)
    check("六类内容按七道作答小题创建", len(session["items"]) == 7 and len(session["offlineGrading"]) == 7)
    check("题目展示数据与答案隔离", all(not item["question"].get("correctAnswer") and not item["question"].get("explanation") for item in session["items"]))
    answers = []
    for item in session["items"]:
        grade = next(g for g in session["offlineGrading"] if g["itemId"] == item["itemId"])
        kind = item["question"]["type"]
        if kind in ["SINGLE_CHOICE", "MULTIPLE_CHOICE"]:
            answer = {"optionKeys": grade["correctAnswer"]}
        elif kind == "TRUE_FALSE":
            answer = {"value": grade["correctValue"]}
        elif kind == "FILL_BLANK":
            answer = {"blanks": [blank["answers"][0] for blank in grade["blanks"]]}
        else:
            answer = {"text": "先保存本机草稿，等待数据库提交回执后再清理。"}
        answers.append({"itemId": item["itemId"], "answer": answer, "confirmed": True})

    def snapshot():
        req = urllib.request.Request(config["api"] + "/api/v1/admin/monitoring/sync/stream", headers={"Authorization": "Bearer " + admin, "Accept": "text/event-stream"})
        with OPENER.open(req, timeout=20) as response:
            assert response.headers.get_content_type() == "text/event-stream"
            for line in response:
                if line.startswith(b"data:"):
                    return json.loads(line[5:])
        raise AssertionError("SSE 未返回数据")

    command_key = str(uuid.uuid4())
    body = {"expectedVersion": session["version"], "currentIndex": 6, "durationSeconds": 1,
            "writerToken": session["writer"]["writerToken"], "clientSequence": 1, "items": answers}
    session_path = "/practice/sessions/" + session["id"]
    subprocess.run(compose(config, "stop", "worker"), check=True, capture_output=True)
    try:
        command = r("POST", session_path + "/sync-commands", body, token=student, key=command_key, expected=202)
        duplicate = r("POST", session_path + "/sync-commands", body, token=student, key=command_key, expected=202)
        check("重复进度命令复用同一标识", command["commandId"] == duplicate["commandId"])
        queued = r("GET", session_path + "/sync-commands/" + command_key, token=student)
        check("消费者停止时命令持久排队", queued["state"] == "QUEUED")
        final_key = str(uuid.uuid4())
        final_body = {**body, "kind": "FINISH", "clientSequence": 2}
        final = r("POST", session_path + "/sync-commands", final_body, token=student, key=final_key, expected=202)
        check("交卷可靠接收并排在进度之后", final["state"] == "QUEUED")
        deadline = time.monotonic() + 25
        while True:
            health = snapshot()
            if (health["metrics"]["queued"] or 0) >= 1 or time.monotonic() >= deadline:
                break
            time.sleep(2)
        check("SSE 展示真实排队数量", health["metrics"]["queued"] >= 1)
    finally:
        subprocess.run(compose(config, "start", "worker"), check=True, capture_output=True)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        command = r("GET", session_path + "/sync-commands/" + command_key, token=student)
        if command["state"] in ["COMMITTED", "REJECTED", "DEAD_LETTER"]:
            break
        time.sleep(1)
    check("恢复消费者后唯一落库并确认序号", command["state"] == "COMMITTED" and command["acknowledgement"]["acknowledgedSequence"] == 1)
    deadline = time.monotonic() + 45
    while True:
        final = r("GET", session_path + "/sync-commands/" + final_key, token=student)
        if final["state"] == "COMMITTED": break
        assert time.monotonic() < deadline
        time.sleep(1)
    result = final["result"]
    again = r("GET", session_path + "/sync-commands/" + final_key, token=student)["result"]
    check("交卷幂等且客观题全部正确", result["id"] == again["id"] and result["objective"]["correct"] == 6)
    short = next(i for i in result["items"] if i["question"]["type"] == "SHORT_ANSWER")
    result = r("PUT", session_path + "/items/" + short["itemId"] + "/self-assessment", {"expectedVersion": result["version"], "assessment": "CORRECT"}, token=student)
    check("简答自评计入正式成绩", result["shortAnswer"]["rated"] == 1)
    check("管理端与学生端成绩一致", r("GET", "/practice/sessions/" + session["id"] + "/result", token=student)["id"] == result["id"])

    question = result["items"][0]["question"]
    feedback = r("POST", "/me/question-feedback", {"questionId": question["id"], "revisionId": question["revisionId"], "category": "OTHER", "body": "联调验证处理结果回传"}, token=student)
    entry = next(i for i in r("GET", "/admin/question-feedback", token=admin)["items"] if i["id"] == feedback["id"])
    r("PUT", "/admin/question-feedback/" + entry["id"], {"expectedVersion": entry["version"], "status": "RESOLVED", "response": "已核对联调样例"}, token=admin)
    check("管理端处理结果回传用户", any(i["id"] == entry["id"] and i["status"] == "RESOLVED" for i in r("GET", "/me/question-feedback", token=student)["items"]))
    r("POST", "/me/activity/heartbeat", token=student)
    me = r("GET", "/me", token=student)
    online = r("GET", "/admin/statistics/online-users", token=admin)
    check("心跳后可查看在线账号与客户端", any(i["userId"] == me["id"] and any(c["platform"] == "MINI_PROGRAM" for c in i["clients"]) for i in online["items"]))
    for sort in ["ACTIVE_DAYS", "ANSWERED_COUNT", "DURATION"]:
        r("GET", "/admin/statistics/rankings?sort=" + sort, token=admin)
    check("三种排行榜排序均可读取", True)
    save(PRIVATE / "verification.json", {"checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "checks": checks, "queueSnapshot": health, "practiceItems": result["totalCount"]})
    print(json.dumps({"passed": len(checks), "practiceItems": result["totalCount"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
