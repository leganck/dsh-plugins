"""模型发现/校验：扫描白名单目录，算出与 embedder 一致的 tag 和模型 profile。

## 为什么单独一个文件、且**绝不 import embedder**

后台「模型热切换」要在**不加载 ONNX/tokenizers** 的前提下列出可用模型：
`selftest.py` 会设 `FAKE_EMBED=1` 走纯 Python 路径，那种环境里 numpy/tokenizers
可能根本没装。所以本文件只用标准库，fingerprint 复制一份实现：

    ⚠️ 改这里的 fingerprint() 必须同步 server/code-index-service/embedder.py 的同名函数，
       反之亦然。两者必须**逐字节一致**（同样的文件、同样的顺序、同样的分块读取），
       否则同一份模型在发现页与运行时算出不同 tag —— 客户端会全量重嵌。

## 目录约定（Dockerfile / compose.jina.yaml / scripts/fetch-models.mjs）

    /models/model          bge-base-zh-v1.5（容器内 basename == "model" → 模型名固定）
    /models/model-jina     jina-embeddings-v2-base-code（compose.jina.yaml 挂到这个路径）
    /models/model-rerank   bge-reranker-base（basename 含 "rerank" → 归到 rerank 列表）

模型差异用 profile 表达（query 前缀 / 池化 / 特殊 token）。空 dict 表示沿用
`embedder.DEFAULT_PROFILE`（即环境变量那套默认值）。
"""
import hashlib
import os

# 模型 profile：热切换时 Embedder 按它切 query 前缀 / 池化 / 特殊 token / 截断长度。
# 字段与 embedder.DEFAULT_PROFILE 一一对应；多出的 name 只用于推导 tag（不进 embedder 的运算）。
_BGE_PROFILE = {
    "name": "bge-base-zh-v1.5",
    "query_prefix": "为这个句子生成表示以用于检索相关文章：",
    "max_tokens": 512,
    "sep_id": 102,
    "pooling": "cls",
    "pad_token": "[PAD]",
    "pad_id": 0,
}
_JINA_PROFILE = {
    "name": "jina-embeddings-v2-base-code",
    "query_prefix": "",
    "max_tokens": 512,
    "sep_id": 0,
    "pooling": "auto",
    "pad_token": "<pad>",
    "pad_id": 1,
}

# 目录名 → profile。`model` 是 Dockerfile/compose 的固定挂载点：**目录名改不得**，
# 因为 embedder 用 basename 推导模型名（改名 = 换 tag = 客户端全量重嵌）。
# model-bge 是给「同一个卷里同时放 bge 与 jina」的部署留的别名。
PROFILES = {
    "model": dict(_BGE_PROFILE),
    "model-bge": dict(_BGE_PROFILE),
    "model-jina": dict(_JINA_PROFILE),
}

# 发现/校验用的文件清单；顺序即 embedder.pick_model() 的优先级（fp16 优先）。
EMBED_MODEL_FILES = ("model_fp16.onnx", "model.onnx", "model_int8.onnx")
RERANK_MODEL_FILES = ("model_fp16.onnx", "model.onnx")
TOKENIZER_FILES = ("tokenizer.json", "tokenizer_config.json")
# size_bytes 只做 UI 展示，把目录里这几个已知产物都算上（缺的跳过）。
SIZE_EXTRA_FILES = ("tokenizer.json", "tokenizer_config.json", "config.json", "special_tokens_map.json")


class ModelError(Exception):
    """模型目录不可用（不在白名单 / 缺文件）；消息可直接展示给后台 UI。"""


# ---------------------------------------------------------------- 与 embedder 对齐的算法
def fingerprint(model_dir, model_file):
    """与 `embedder.fingerprint()` **逐字节相同**的算法（这里只依赖标准库）。

    依次把 model_file、tokenizer.json、tokenizer_config.json 的**原始字节**喂给 sha256，
    取 hexdigest()[:8]；文件缺失跳过（tokenizer_config.json 是可选文件）。

    ⚠️ 改这里必须同步 embedder.py 的 fingerprint()：客户端索引里的 embedding_tag 靠它
    和远端对上，两端算法一旦分叉，表现就是"一切换后端就全量重嵌"。
    """
    h = hashlib.sha256()
    for name in (model_file, "tokenizer.json", "tokenizer_config.json"):
        p = os.path.join(model_dir, name)
        try:
            with open(p, "rb") as f:
                while True:
                    chunk = f.read(1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
        except FileNotFoundError:
            pass
    return h.hexdigest()[:8]


def pick_model(directory):
    """按 embedder 的优先级挑模型文件：model_fp16.onnx → model.onnx → model_int8.onnx。

    返回**完整路径**（和 embedder.pick_model 一致）；都没有返回 None。
    """
    for name in EMBED_MODEL_FILES:
        cand = os.path.join(directory, name)
        if os.path.exists(cand):
            return cand
    return None


def precision_of(model_file):
    """从模型文件名推精度：fp16 / int8 / fp32（与 embedder 的 tag 规则一致）。"""
    base = os.path.basename(model_file or "")
    if "fp16" in base:
        return "fp16"
    if "int8" in base:
        return "int8"
    return "fp32"


def name_for_dir(directory):
    """目录名命中 PROFILES → profile 里的模型名；否则原样用 basename。"""
    base = os.path.basename(os.path.normpath(str(directory)))
    profile = PROFILES.get(base)
    return (profile or {}).get("name") or base


def profile_for_dir(directory):
    """返回该目录的 profile；空 dict 表示用 embedder 的默认 profile（环境变量那套）。"""
    base = os.path.basename(os.path.normpath(str(directory)))
    return dict(PROFILES.get(base) or {})


def tag_for_dir(directory):
    """算目录的模型 tag（与 Embedder.tag 同一公式）：`{name}-{fp8}-{precision}`。

    返回 {"tag","name","precision","model_file","model_bytes"[,"dim"]}；
    没有模型文件时抛 ModelError。
    """
    real = os.path.realpath(os.path.abspath(str(directory)))
    model_path = pick_model(real)
    if not model_path:
        raise ModelError("缺少文件: " + "|".join(EMBED_MODEL_FILES))
    model_file = os.path.basename(model_path)
    name = name_for_dir(real)
    precision = precision_of(model_file)
    out = {
        "tag": f"{name}-{fingerprint(real, model_file)}-{precision}",
        "name": name,
        "precision": precision,
        "model_file": model_file,
        "model_bytes": os.path.getsize(model_path),
    }
    dim = profile_for_dir(real).get("dim")
    if dim:
        out["dim"] = int(dim)
    return out


# ---------------------------------------------------------------- 路径/文件校验
def _norm(path):
    """realpath + normcase：Windows 大小写不敏感，dedupe/白名单比较都走这个。"""
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def _is_under(path, root):
    real = _norm(path)
    real_root = _norm(root)
    try:
        return os.path.commonpath([real, real_root]) == real_root
    except ValueError:  # Windows 不同盘符
        return False


def _check_dir(directory, roots):
    """白名单校验（防 `../` 穿越）+ 必须是个已存在的目录；返回 realpath。"""
    if not directory:
        raise ModelError("目录不能为空")
    real = os.path.realpath(os.path.abspath(str(directory)))
    if not any(_is_under(real, root) for root in roots or ()):
        raise ModelError(f"目录不在白名单: {directory}")
    if not os.path.isdir(real):
        raise ModelError(f"目录不存在: {directory}")
    return real


def _first_existing(directory, names):
    for name in names:
        if os.path.isfile(os.path.join(directory, name)):
            return name
    return None


def _missing_files(directory, model_files, extra_files):
    """返回 (模型文件名|None, 缺失文件列表)；模型文件按组给出一个占位错误项。"""
    model_file = _first_existing(directory, model_files)
    missing = []
    if model_file is None:
        missing.append("|".join(model_files))
    missing.extend(name for name in extra_files if not os.path.isfile(os.path.join(directory, name)))
    return model_file, missing


def _size_bytes(directory, model_file):
    """模型文件 + tokenizer/config 等已知产物的总大小（UI 展示用，缺的跳过）。"""
    total = 0
    for name in (model_file, *SIZE_EXTRA_FILES):
        try:
            total += os.path.getsize(os.path.join(directory, name))
        except OSError:
            pass
    return int(total)


def _validated_item(directory, roots, model_files, extra_files):
    real = _check_dir(directory, roots)
    model_file, missing = _missing_files(real, model_files, extra_files)
    if missing:
        raise ModelError("缺少文件: " + ", ".join(missing))
    info = tag_for_dir(real)
    return {
        "dir": real,
        "name": info["name"],
        "tag": info["tag"],
        "precision": info["precision"],
        "model_file": info["model_file"],
        "model_bytes": info["model_bytes"],
        "size_bytes": _size_bytes(real, info["model_file"]),
        "profile": profile_for_dir(real),
    }


def validate_embed_dir(directory, *, roots):
    """校验一个嵌入模型目录并返回发现页所需信息（切模型前必须过这一关）。

    1) realpath 必须在 roots 某个 realpath 之下（防 `../` 穿越）；
    2) 必需文件：model_fp16.onnx|model.onnx|model_int8.onnx、tokenizer.json、tokenizer_config.json；
    3) 返回 {"dir","name","tag","precision","model_file","model_bytes","size_bytes","profile"}。

    失败抛 ModelError（消息可直接展示）。
    """
    return _validated_item(directory, roots, EMBED_MODEL_FILES, TOKENIZER_FILES)


def validate_rerank_dir(directory, *, roots):
    """重排模型目录校验：文件要求更松（model_fp16.onnx|model.onnx + tokenizer.json）。

    返回结构与 validate_embed_dir 相同（profile 为 {}，rerank 没有 query/池化差异）。
    """
    return _validated_item(directory, roots, RERANK_MODEL_FILES, ("tokenizer.json",))


# ---------------------------------------------------------------- 扫描
def _scan_candidates(roots):
    """roots 的直接子目录 + roots 自身（若它本身就是模型目录）去重后的候选列表。"""
    seen = set()
    out = []
    for root in roots:
        try:
            real_root = os.path.realpath(os.path.abspath(str(root)))
        except (TypeError, ValueError):
            continue
        if not os.path.isdir(real_root):
            continue
        # roots 本身可能就是模型目录（部署时把 MODEL_DIR 直接传进来）
        if _looks_like_model_dir(real_root):
            key = _norm(real_root)
            if key not in seen:
                seen.add(key)
                out.append(real_root)
        try:
            entries = sorted(os.scandir(real_root), key=lambda e: e.name.lower())
        except OSError:
            continue
        for entry in entries:
            try:
                if not entry.is_dir():
                    continue
            except OSError:
                continue
            cand = os.path.realpath(entry.path)
            if not _looks_like_model_dir(cand):
                continue
            key = _norm(cand)
            if key in seen:
                continue
            seen.add(key)
            out.append(cand)
    return out


def _looks_like_model_dir(directory):
    """粗筛：有任意 *.onnx + tokenizer.json 才值得进入后续校验（坏目录直接不列）。"""
    if not os.path.isfile(os.path.join(directory, "tokenizer.json")):
        return False
    try:
        for entry in os.scandir(directory):
            try:
                if entry.is_file() and entry.name.lower().endswith(".onnx"):
                    return True
            except OSError:
                continue
    except OSError:
        return False
    return False


def _as_roots(roots):
    if not roots:
        return []
    if isinstance(roots, (str, bytes, os.PathLike)):
        return [roots]
    return list(roots)


def _same_dir(a, b):
    return bool(a) and bool(b) and _norm(a) == _norm(b)


def _sorted(items):
    """active 第一，然后按模型名（再按路径）排；名字相同的不同目录顺序稳定。"""
    return sorted(items, key=lambda it: (not it["active"], it["name"].lower(), it["dir"].lower()))


def discover(*, roots, active_embed_dir=None, active_rerank_dir=None):
    """扫描白名单目录，列出可切的嵌入/重排模型。

    - roots 的每个直接子目录 + roots 本身（若本身就是模型目录）；
    - 只认含 onnx + tokenizer.json 的目录；
    - 目录名含 "rerank" → rerank，否则 embed；
    - 按 realpath 去重；active 排第一，然后按 name；
    - 单个目录校验失败**直接跳过**（一个坏目录不能拖垮整个列表）。

    返回 {"embed":[{...}], "rerank":[{...}]}，每项：
      {"dir","name","tag","precision","model_file","model_bytes","size_bytes",
       "profile","kind","ready":True,"active":bool}
    （profile 是额外字段：热切换时直接传给 Embedder(profile=...)，tag 才会与发现页一致。）
    """
    roots = _as_roots(roots)
    buckets = {"embed": [], "rerank": []}
    for directory in _scan_candidates(roots):
        kind = "rerank" if "rerank" in os.path.basename(directory).lower() else "embed"
        try:
            if kind == "rerank":
                item = validate_rerank_dir(directory, roots=roots)
            else:
                item = validate_embed_dir(directory, roots=roots)
        except ModelError:
            continue  # 缺文件/白名单外的目录：跳过，不拖垮列表
        except Exception:  # 单目录的意外错误（权限/坏文件名）同样不影响其它模型
            continue
        active = _same_dir(directory, active_rerank_dir if kind == "rerank" else active_embed_dir)
        item.update({"kind": kind, "ready": True, "active": active})
        buckets[kind].append(item)
    return {kind: _sorted(items) for kind, items in buckets.items()}
