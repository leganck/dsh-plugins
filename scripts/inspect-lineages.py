import sqlite3
c = sqlite3.connect("/data/index.db")
print("== repos 表结构 ==")
for r in c.execute("pragma table_info(repos)"):
    print("  ", r)
print()
print("== repos 全量（repoId -> lineage -> name）==")
cols = [r[1] for r in c.execute("pragma table_info(repos)")]
print("cols:", cols)
for r in c.execute("select * from repos"):
    print("  ", dict(zip(cols, [str(x)[:52] for x in r])))
print()
print("== chunks 表结构 ==")
for r in c.execute("pragma table_info(chunks)"):
    print("  ", r)
