"""Make the logout button visible in the installed Parsian CRM v3 web header."""
from datetime import datetime, timezone
from hashlib import sha256
import os
from pathlib import Path
import shutil
import tempfile

APP = Path("/opt/parsian-crm/current/public/app.js")
BACKUPS = Path("/var/backups/parsian-crm")
BEFORE = "d9f748ca5dda29269edaac3885c867043f78dba7e73b2a9c4fa8fc765d6d5cb7"
AFTER = "76bf4f87569f847c27eed8a25ed379dd9303d095c07619e3f0269fe795a001f5"
OLD_BUTTON = '<button class="icon-btn" data-action="logout" title="خروج از حساب">${icon(\'logout\')}</button>'.encode("utf-8")
NEW_BUTTON = '<button type="button" class="secondary" data-action="logout" aria-label="خروج از حساب" title="خروج از حساب">${icon(\'logout\')} خروج</button>'.encode("utf-8")
HEADER = b'<div class="top-actions">'


def patch(app, backups):
    original = app.read_bytes()
    digest = sha256(original).hexdigest()
    if digest == AFTER:
        return "Logout fix already installed."
    if digest != BEFORE:
        raise ValueError("This app differs from the supported CRM v3 release.")

    updated = original.replace(OLD_BUTTON, b"", 1).replace(HEADER, HEADER + NEW_BUTTON, 1)
    if sha256(updated).hexdigest() != AFTER:
        raise ValueError("Unable to verify the patched app.js.")

    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = Path(tempfile.mkdtemp(prefix=f"logout-{stamp}-", dir=backups)) / "app.js"
    shutil.copy2(app, backup)
    fd, name = tempfile.mkstemp(prefix=".app-logout-", dir=app.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(updated)
        shutil.copystat(app, name)
        os.chown(name, app.stat().st_uid, app.stat().st_gid)
        if app.read_bytes() != original:
            raise ValueError("The app changed during the update.")
        os.replace(name, app)
    finally:
        Path(name).unlink(missing_ok=True)
    return f"Logout fix installed. Backup: {backup}"


if __name__ == "__main__":
    try:
        print(patch(APP.resolve(strict=True), BACKUPS))
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Logout fix stopped: {exc}") from exc
