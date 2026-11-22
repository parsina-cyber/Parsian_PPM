#!/usr/bin/env python3
"""Upgrade the existing systemd installation of Parsian CRM on crm.parsian-ppm.com."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from zipfile import ZipFile

BASE = Path("/opt/parsian-crm")
STATE = Path("/var/lib/parsian-crm")
DB = STATE / "crm.sqlite"
UNIT = "parsian-crm.service"
ENV = Path("/etc/parsian-crm/production.env")
VHOST = Path("/etc/nginx/sites-available/parsian-crm.conf")
DOMAIN = "crm.parsian-ppm.com"
NODE = BASE / "runtime/node/bin/node"
CURRENT = BASE / "current"
OLD = BASE / "releases/3.0.0-55abd7c206f2"
RELEASE = BASE / "releases/3.1.0-3cc20212db99"
PACKAGE = "https://raw.githubusercontent.com/parsina-cyber/Parsian_PPM/20cf29bac8ffb5a9874551213b9bbe3d6bd76e42/downloads/Parsian-CRM-3.1.zip"
SHA = "3cc20212db99592d077ccc4597d44ccd853d34d5d1bca8f2c7c95a9a2fdbf99b"
ACCOUNT = "parsian-crm"
TABLES = ("users", "customers", "tasks", "events","buyers","contracts","attachments","audit")
PROBE = """
const {fork}=require('node:child_process');
const child=fork('./server.js',[],{silent:true,execArgv:[],env:{...process.env,HOST:'127.0.0.1',PORT:'0',DB_PATH:process.argv[1]}});
const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
let output='',ok=false;
child.stderr.pipe(process.stderr);
child.stdout.on('data',async block=>{
  output+=block;
  const port=output.match(/listening on port (\\d+)/)?.[1];if(!port)return;
  try{
    const res=await fetch('http://127.0.0.1:'+port+'/api/session');
    const s=await res.json();ok=res.ok && s.version==='3.1.0' && s.needsSetup===false;
  }catch(e){console.error(e.message);}finally{child.kill('SIGTERM');}
});
child.on('exit',code=>{clearTimeout(timer);process.exit(ok && code===0?0:1);});
"""


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def as_service(*args, **kwargs):
    return run("runuser", "-u", ACCOUNT, "--", *args, **kwargs)


def snapshot(source, target):
    # SQLite may create WAL sidecars even for a read-only handle. Touch the live
    # database only as its normal service account, including after service stop.
    as_service("python3","-c", """
import sqlite3, sys
from pathlib import Path
src=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
dst=sqlite3.connect(sys.argv[2])
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
""",source,target)
    os.chmod(target, 0o600)


def inspect(dbpath, version):
    with sqlite3.connect(dbpath.resolve().as_uri() + "?mode=ro&immutable=1", uri=True) as db:
        check(db.execute("PRAGMA quick_check").fetchall() == [("ok",)], "Database integrity check failed.")
        check(not db.execute("PRAGMA foreign_key_check").fetchone(), "Database has inconsistent foreign keys.")
        check(db.execute("PRAGMA user_version").fetchone()[0] == version, "Unexpected database version.")
        counts = {t: db.execute("SELECT count(*) FROM " + t).fetchone()[0] for t in TABLES}
        check(counts["users"] > 0, "The database has no existing accounts.")
        return counts


def proxy_config(content):
    check(re.search(r"^\s*server_name\s+crm\.parsian-ppm\.com\s*;", content, re.M), "Unexpected CRM virtual host.")
    check("proxy_pass http://127.0.0.1:3000;" in content, "Missing CRM upstream.")
    result, n = re.subn(r"(?m)^(\s*client_max_body_size\s+)(?:128k|8m)(\s*;)", r"\g<1>8m\2", content)
    check(n == 1, "Unexpected upload limit. Review the CRM virtual host.")
    return result


def web_session(https):
    url = ("https://" + DOMAIN if https else "http://127.0.0.1:3000") + "/api/session"
    args = ["curl", "--noproxy", "*", "-fsS", "--max-time", "5"]
    if https:
        args += ["--resolve", DOMAIN + ":443:127.0.0.1"]
    return json.loads(run(*args, url, capture_output=True).stdout)


def verify_live(version):
    for https in (False, True):
        session = web_session(https)
        check(session.get("version") == version and session.get("needsSetup") is False,
              "Live CRM did not report a configured " + version + " service.")


def activate_release(release, temporary):
    temporary.symlink_to(release)
    os.replace(temporary, CURRENT)


def stage(work):
    archive = work / "package.zip"
    run("curl", "-fLsS", "--retry", "2", "--max-time", "120", PACKAGE, "-o", archive)
    check(hashlib.sha256(archive.read_bytes()).hexdigest() == SHA, "Release ZIP checksum mismatch.")
    # This archive is pinned by content before any source is extracted or executed.
    root = work / "code"
    root.mkdir(mode=0o755)
    with ZipFile(archive) as z:
        for name in z.namelist():
            rel = Path(name).relative_to("Parsian-CRM-3.1")
            check(not rel.is_absolute() and ".." not in rel.parts, "Invalid archive entry.")
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(name))
    for path in [root, *root.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    if RELEASE.exists():
        check(RELEASE.is_dir() and not RELEASE.is_symlink(), "Unexpected release path.")
        def tree(directory):
            return {p.relative_to(directory): hashlib.sha256(p.read_bytes()).digest()
                    for p in directory.rglob("*") if p.is_file() and not p.is_symlink()}
        check(not any(p.is_symlink() for p in RELEASE.rglob("*")) and tree(root) == tree(RELEASE),
              "A different release already exists at the destination.")
    else:
        os.rename(root, RELEASE)
    as_service(NODE, "--test", cwd=RELEASE)


def atomic_config(data, directory):
    fd, name = tempfile.mkstemp(dir=directory, prefix=".crm-vhost-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        shutil.copystat(VHOST, name)
        os.replace(name, VHOST)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    os.umask(0o077)
    check(os.geteuid() == 0, "Run this command in the server console as root.")
    lock = open("/run/lock/parsian-crm-install.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check(CURRENT.is_symlink(), "Existing CRM installation not found.")
    current = CURRENT.resolve()
    if current == RELEASE:
        verify_live("3.1.0")
        print("Already running Parsian CRM 3.1.0: https://" + DOMAIN)
        return
    check(current == OLD and DB.is_file() and not DB.is_symlink(), "Unexpected active release or database path.")
    settings = set(ENV.read_text().splitlines())
    check({"HOST=127.0.0.1","PORT=3000","DB_PATH="+str(DB),"COOKIE_SECURE=1"} <= settings, "Unexpected service environment.")
    unit = run("systemctl","cat",UNIT,capture_output=True,text=True).stdout
    check("WorkingDirectory="+str(CURRENT) in unit and "User="+ACCOUNT in unit and
          f"ExecStart={NODE} {CURRENT}/server.js" in unit, "Unexpected CRM service definition.")
    check(not VHOST.is_symlink() and Path("/etc/nginx/sites-enabled/parsian-crm.conf").resolve()==VHOST,
          "Unexpected CRM Nginx configuration.")
    run("systemctl","is-active","--quiet",UNIT)
    run("nginx","-t")
    verify_live("3.0.0")
    updated = proxy_config(VHOST.read_text())
    account = pwd.getpwnam(ACCOUNT)
    required = DB.stat().st_size + sum(p.stat().st_size for p in [Path(str(DB)+"-wal")] if p.exists())
    for path in (STATE, Path("/var/backups")):
        check(shutil.disk_usage(path).free > required*5 + 32*1024**2, "Insufficient disk space for verified backups.")
    backups=Path("/var/backups/parsian-crm")
    backups.mkdir(mode=0o700,exist_ok=True)
    saved=Path(tempfile.mkdtemp(prefix=time.strftime("v3-%Y%m%dT%H%M%SZ-",time.gmtime()),dir=backups))
    print("Backup directory:",saved,flush=True)
    shutil.copy2(VHOST,saved/"nginx.conf")
    shutil.copy2(ENV,saved/"production.env")
    (saved/"previous-release.txt").write_text(str(current)+"\n")
    # Staging beneath releases keeps the release rename atomic.
    with tempfile.TemporaryDirectory(prefix=".stage-",dir=RELEASE.parent) as tmp:
        stage(Path(tmp))
    candidate = Path(tempfile.mkdtemp(prefix=".upgrade-v3-",dir=STATE))
    os.chown(candidate,account.pw_uid,account.pw_gid)
    draft=candidate/"crm.sqlite"
    # The migration trial runs while v2 still serves the team.
    try:
        snapshot(DB,draft)
        before=inspect(draft,3)
        os.chown(draft,account.pw_uid,account.pw_gid)
        as_service(NODE,"-e",PROBE,draft,cwd=RELEASE)
        after=inspect(draft,3)
        check(all(after[k]>=n for k,n in before.items()),"Trial migration lost existing records.")
    finally:
        shutil.rmtree(candidate)
    with tempfile.TemporaryDirectory(prefix=".cutover-",dir=BASE) as tmp:
        swap=Path(tmp)/"current"
        service_stopped=False
        v3_start_attempted=False
        config_touched=False
        try:
            print("Validated v3 on a private copy. Starting brief CRM maintenance.",flush=True)
            # Apply only the upload limit. Certbot settings and the rest of the vhost stay intact.
            if updated!=VHOST.read_text():
                config_touched=True
                atomic_config(updated.encode(),VHOST.parent)
                run("nginx","-t")
                run("systemctl","reload","nginx")
            service_stopped=True
            run("systemctl","stop",UNIT)
            with tempfile.TemporaryDirectory(prefix=".backup-v3-",dir=STATE) as staging:
                os.chown(staging,account.pw_uid,account.pw_gid)
                file=Path(staging)/"crm.sqlite"
                snapshot(DB,file)
                shutil.copyfile(file,saved/"crm.sqlite")
            counts=inspect(saved/"crm.sqlite",3)
            (saved/"counts.json").write_text(json.dumps(counts)+"\n")
            activate_release(RELEASE,swap)
            # After this point CRM could accept writes. Never roll back a live database automatically.
            v3_start_attempted=True
            run("systemctl","start",UNIT)
            deadline=time.monotonic()+90
            while time.monotonic()<deadline:
                try:
                    verify_live("3.1.0")
                    break
                except (RuntimeError,ValueError,subprocess.CalledProcessError):
                    time.sleep(1)
            else:
                raise RuntimeError("Health check failed. Inspect systemctl status parsian-crm and journalctl -u parsian-crm.")
            print("Upgrade complete: https://"+DOMAIN+" (3.1.0)\nVerified pre-upgrade backup: "+str(saved/"crm.sqlite"))
        except BaseException:
            if not v3_start_attempted:
                if CURRENT.resolve()!=current:
                    activate_release(current,swap)
                if service_stopped:
                    run("systemctl","start",UNIT)
                if config_touched:
                    atomic_config((saved/"nginx.conf").read_bytes(),VHOST.parent)
                    run("nginx","-t")
                    run("systemctl","reload","nginx")
            else:
                print("Live v3 start was attempted. No database was restored. Keep the backup at "+str(saved),file=sys.stderr)
            raise


if __name__=="__main__":
    try:
        def interrupted(sig, frame):
            raise KeyboardInterrupt("Deployment interrupted")
        for sig in (signal.SIGHUP,signal.SIGTERM):
            signal.signal(sig,interrupted)
        main()
    except (RuntimeError,OSError,sqlite3.Error,subprocess.CalledProcessError,ValueError) as exc:
        sys.exit("Upgrade stopped: "+str(exc))
