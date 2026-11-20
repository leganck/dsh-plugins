# -*- coding: utf-8 -*-
"""单次调用探针：量一段 400 字素材在本机网关上到底要多久 / 能不能出 content。

不写库、不改代码，只打印计时与解析结果。用于决定实验预算。
"""
import json
import sys
import time

sys.path.insert(0, r"D:\Code\dsh-plugins-github\server\storage-hub")
import exp_llm  # noqa: E402
import exp_pipeline  # noqa: E402

BASE = "http://127.0.0.1:3425/v1"
MODEL = "auto/deepseek-v4.1-flash"

MATERIAL = """### [segment_032.md] Errors and Fixes
- Full-branch merge of master-5.0.x into 5.2.3 -> 9 files/16 conflicts resolved but ~200 compile errors because both lines independently created SpecDescFormatter, PackageFeeRecalculateService at identical paths. git merge --abort; switched to per-feature cherry-pick.
- `git cherry-pick --continue` with a resolve equal to HEAD -> "nothing to commit", pick silently dropped; fixed by re-applying intent manually per file.
- gradlew in MSYS: `./gradlew` -> exit 126; `sh ./gradlew` -> path mangled to `D;/Code/...`; working form: JAVA_HOME=...; "$JAVA_HOME/bin/java" -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain <tasks> --offline
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    segs = exp_pipeline.split_segments(MATERIAL, max_chars=exp_pipeline.SEGMENT_MAX_CHARS)
    print("chunks:", len(segs), [len(s["text"]) for s in segs])
    target = segs[0]
    print("--- chunk[0] ---")
    print(target["text"])
    print("--- 调用 ---")
    client = exp_llm.LLMClient(base_url=BASE, model=MODEL, max_tokens=8000,
                               timeout_ms=240000, max_retries=0)
    t0 = time.time()
    try:
        resp = client.extract_json_array(target["text"])
    except Exception as exc:  # noqa: BLE001
        print("FAILED after %.1fs: %r reason=%s" % (time.time() - t0, exc,
                                                    getattr(exc, "reason", "?")))
        return 1
    dt = time.time() - t0
    print("OK %.1fs entries=%d usage=%s warning=%s"
          % (dt, len(resp.get("entries") or []), resp.get("usage"), resp.get("warning")))
    print(json.dumps(resp.get("entries"), ensure_ascii=False, indent=2)[:2000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
