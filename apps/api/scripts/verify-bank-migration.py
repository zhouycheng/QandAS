"""Verify a source bank against a fresh draft on an isolated local API."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID, uuid4
from zipfile import ZipFile


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def api(base, token, method, path, data=None):
    headers = {"Authorization": "Bearer " + token, "Idempotency-Key": str(uuid4())}
    if isinstance(data, bytes):
        headers["Content-Type"] = "application/octet-stream"
    elif data is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(data).encode()
    return build_opener(NoRedirect).open(Request(base.rstrip("/") + "/api/v1/admin/" + path, data, headers, method=method), timeout=180)


def canonical(path):
    with ZipFile(path) as archive:
        doc = json.loads(archive.read("bank.json"))
        chapters = {c["id"]: i for i, c in enumerate(doc["chapters"])}
        images = {a["id"]: hashlib.sha256(archive.read(a["path"])).hexdigest() for a in doc["assets"]}

    def normalize(row):
        row = dict(row)
        if "chapterId" in row:
            row["chapterId"] = chapters[row["chapterId"]]
        row["assetIds"] = sorted(images[key] for key in row.get("assetIds", []))
        def rewrite(value):
            return re.sub(r'(!\[[^\]\n]*\]\(asset:)([A-Za-z0-9_.-]+)(\))',
                          lambda m: m[1] + images.get(m[2], m[2]) + m[3], value)
        for key in ("stem", "explanation", "passage", "referenceAnswer"):
            if key in row:
                row[key] = rewrite(row[key])
        for option in row.get("options", []):
            option["content"] = rewrite(option["content"])
        if "scoringPoints" in row:
            row["scoringPoints"] = list(map(rewrite, row["scoringPoints"]))
        if "subQuestions" in row:
            row["subQuestions"] = list(map(normalize, row["subQuestions"]))
        return row
    return {"bank": doc["bank"], "chapters": [c["name"] for c in doc["chapters"]], "images": sorted(images.values()),
            "sources": sorted(doc["sources"], key=lambda x: x["id"]),
            "questions": sorted(map(normalize, doc["questions"]), key=lambda q: q["id"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--bank", required=True, type=UUID)
    parser.add_argument("--isolated", required=True)
    parser.add_argument("--isolated-subject", required=True, type=UUID)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    source, isolated = urlparse(args.source), urlparse(args.isolated)
    if isolated.hostname != "localhost" and not ipaddress.ip_address(isolated.hostname).is_loopback:
        parser.error("隔离 API 必须使用本机回环地址")
    if source.netloc == isolated.netloc or source.username or isolated.username:
        parser.error("来源和隔离 API 需要独立地址")
    if source.scheme != "https" and source.hostname not in {"localhost", "127.0.0.1", "::1"}:
        parser.error("远程来源需要 HTTPS")
    def read_source(suffix=""):
        return api(args.source, os.environ["QANDA_SOURCE_TOKEN"], "GET", "question-banks/" + str(args.bank) + suffix)
    def local(method, path, data=None):
        return api(args.isolated, os.environ["QANDA_ISOLATED_TOKEN"], method, path, data)
    with tempfile.TemporaryDirectory() as tmp:
        original, copy = Path(tmp) / "original.zip", Path(tmp) / "copy.zip"
        with read_source() as res:
            bank = json.load(res)
        with read_source("/package") as res, original.open("wb") as out:
            shutil.copyfileobj(res, out)
        with local("POST", "question-banks", {"subjectId": str(args.isolated_subject), **{k: bank[k] for k in ("name","description","textbook","status")}}) as res:
            target = json.load(res)["id"]
        path = "question-banks/" + target + "/package"
        with local("POST", path + "/uploads", {"sizeBytes": original.stat().st_size}) as res:
            upload = json.load(res)["uploadId"]
        with original.open("rb") as file:
            part = 0
            while chunk := file.read(4 * 1024 * 1024):
                local("PUT", f"{path}/uploads/{upload}/{part}", chunk).close()
                part += 1
        with local("POST", path + "/preview", {"uploadId": upload}) as res:
            preview = json.load(res)
        local("POST", path + "/commit", {"uploadId": upload, "digest": preview["digest"], "expectedContentVersion": preview["contentVersion"]}).close()
        with local("GET", path) as res, copy.open("wb") as out:
            shutil.copyfileobj(res, out)
        before, after = canonical(original), canonical(copy)
        with read_source() as res:
            fresh = json.load(res)
        different = [k for k in before if before[k] != after[k]]
        valid = not different and all(fresh[k] == bank[k] for k in ("contentVersion", "version"))
        report = {"bankId": str(args.bank), "version": bank["version"], "contentVersion": bank["contentVersion"], "isolatedBankId": target,
                  "digest": preview["digest"], "differences": different, "verified": valid,
                  "missingProvenance": [q["id"] for root in before["questions"] for q in [root, *root.get("subQuestions", [])] if not q.get("provenance")]}
        with tempfile.NamedTemporaryFile(dir=args.report.parent,mode="w",delete=False) as out:
            json.dump(report,out,ensure_ascii=False,indent=2)
        os.replace(out.name,args.report)
        if not valid:
            raise SystemExit("隔离回导比对失败或来源版本已变化")


if __name__ == "__main__":
    main()
