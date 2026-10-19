"""Create consistent SQLite + original-photo snapshot; never delete source data."""
from datetime import datetime
from pathlib import Path
import shutil
import sqlite3

root=Path(__file__).resolve().parent
source=root/'data'
if not (source/'lab.sqlite3').exists():
    raise SystemExit('먼저 앱을 한 번 실행해 테스트 DB를 생성해 주세요.')
target=root/'backups'/datetime.now().strftime('%Y%m%d-%H%M%S-%f')
target.mkdir(parents=True,exist_ok=False)
with sqlite3.connect(source/'lab.sqlite3') as src, sqlite3.connect(target/'lab.sqlite3') as dest:
    src.backup(dest)
shutil.copytree(source/'photos',target/'photos')
print(target)
