# -*- coding: utf-8 -*-
"""OpenAI 兼容 LLM 客户端：重试 / 超时 / 推理型模型识别 / token 统计 / 串行。

## 为什么自己写而不用 openai SDK
只要 `POST {base_url}/chat/completions` 一件事，却要为此多一个依赖 + 多一层异常包装；
而这里真正需要的恰恰是 SDK 不直接给的三样东西：**重试与退避的可观测性**、
**推理型模型的显式识别**、**按次累计的 token 统计**（写进 `exp_jobs.tokens_in/out`）。

## 推理型模型为什么会"吞掉" content
部分模型（glm-5.3 这类）把 token 预算先花在 `reasoning_content` 上，`max_tokens` 给得不够时
`content` 直接是空字符串 —— 客户端如果只看 `content`，就会把"模型想太多了"误判成
"模型认为没有经验"，静默丢一批候选。所以这里把「content 空 + reasoning 非空」识别成
`warning="reasoning-model"` 显式回传，调用方据此把任务标 failed 而不是 done(0 条)。
`auto/deepseek-v4.1-flash` 在本机实测也会先产 reasoning（单条经验 1688 reasoning / 1878 output），
预算够时 content 正常返回；默认 `max_tokens=4000` 是按实测留出的下限，长素材还要配合分段。

## 为什么 timeout 要有"硬截止"
`urllib` 的 `timeout` 只管**单次 socket 读**：网关一边生成一边滴流式回包时，每次读都不超时，
整个请求可以挂 10 分钟以上还"活着"。所以这里额外加了一层
**墙钟硬截止**（`hard_timeout_ms`，默认 = `timeout_ms`）：请求放在 worker 线程里跑，
超过截止就放弃并抛 `reason="timeout"`。代价是被放弃的线程会自己跑完（daemon，不阻塞进程退出），
所以硬超时触发的重试可能出现"幽灵请求"——宁可多重试一次，也不要让整批抽取静默挂住。

## 为什么串行
抽提是"读一段素材 → 调一次模型 → 写库"的批处理，并发只会把本机推理服务打到 429，
反而触发重试把总耗时拉长。`chat()` 用一把锁把请求串起来，重试也在这把锁内，
保证同一时刻只有一个请求在飞（调用方不需要自己加锁）。

## 依赖注入
`transport` 默认走 urllib；单测注入 stub 函数即可，**从不真连网络**。
`sleep` 同理可注入，重试退避在测试里不需要真的等 2s/8s。
"""
import json
import re
import threading
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- 默认参数
# 2026-11-20 实测（本机 auto/deepseek-v4.1-flash，抽取任务）：
#   单条经验          → 28.5s，output 1878 tokens（其中 reasoning 1688）
#   1823 字一段素材   → 300s 硬截止仍未完成
#   4000 max_tokens   → 仍出现 finish_reason=length（truncated）
# 所以默认给 4000/120s（决策 9 原为 2000/60s，实测明显偏小）；分段另由
# `exp_pipeline.SEGMENT_MAX_CHARS=800` 控制，两者配合才不会截断。
DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1"
DEFAULT_MODEL = "auto/deepseek-v4.1-flash"
DEFAULT_MAX_TOKENS = 8000
DEFAULT_TIMEOUT_MS = 240_000
DEFAULT_MAX_RETRIES = 2  # 重试 2 次 = 最多 3 次尝试
DEFAULT_BACKOFF = (2.0, 8.0)  # 第 1、2 次重试前的等待秒数
DEFAULT_TEMPERATURE = 0.2

WARN_REASONING_MODEL = "reasoning-model"
WARN_TRUNCATED = "truncated"

# 可重试的失败原因：限流、服务端错误、超时、网络抖动。其余（400/401/403/404）立刻失败，
# 重试只会把错误配置变成三倍延迟。
RETRYABLE_REASONS = ("http-429", "http-5xx", "timeout", "network")


class LLMError(Exception):
    """统一失败类型：`reason` 是稳定短码（进 exp_jobs.error），`attempts` 是实际尝试次数。"""

    def __init__(self, message, *, reason="error", status=None, attempts=0, retryable=False, last=None):
        super().__init__(message)
        self.reason = reason
        self.status = status
        self.attempts = attempts
        self.retryable = retryable
        self.last = last

    def as_dict(self):
        return {
            "reason": self.reason,
            "status": self.status,
            "attempts": self.attempts,
            "retryable": self.retryable,
            "message": str(self),
        }


# ---------------------------------------------------------------- 默认传输（urllib）
def _urllib_post(url, payload, headers, timeout_s):
    """返回解析后的 JSON dict；把 HTTP/超时/网络异常翻译成带 status/reason 的异常。"""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:  # 4xx/5xx 也会抛
        body = b""
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001
            pass
        err = LLMError(
            f"HTTP {exc.code}: {body[:200].decode('utf-8', 'replace')}",
            reason="http-429" if exc.code == 429 else ("http-5xx" if exc.code >= 500 else "http-4xx"),
            status=exc.code,
        )
        raise err from exc
    except urllib.error.URLError as exc:
        cause = getattr(exc, "reason", None)
        if isinstance(cause, (TimeoutError, OSError)) and "timed out" in str(cause).lower():
            raise LLMError(f"timeout after {timeout_s}s", reason="timeout") from exc
        if isinstance(cause, TimeoutError):
            raise LLMError(f"timeout after {timeout_s}s", reason="timeout") from exc
        raise LLMError(f"network: {cause}", reason="network") from exc
    except (TimeoutError, OSError) as exc:
        # socket.timeout 在 3.10+ 即 TimeoutError；其余 OSError 视作网络问题
        if isinstance(exc, TimeoutError):
            raise LLMError(f"timeout after {timeout_s}s", reason="timeout") from exc
        raise LLMError(f"network: {exc}", reason="network") from exc
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise LLMError(f"bad-json: {raw[:200]!r}", reason="bad-json", status=status) from exc
    if isinstance(parsed, dict) and parsed.get("error") and not parsed.get("choices"):
        raise LLMError(f"api-error: {str(parsed['error'])[:200]}", reason="api-error", status=status)
    return parsed


# ---------------------------------------------------------------- 客户端
class LLMClient:
    """串行 OpenAI 兼容客户端。`transport(url, payload, headers, timeout_s) -> dict` 可注入。"""

    def __init__(
        self,
        base_url=DEFAULT_BASE_URL,
        model=DEFAULT_MODEL,
        api_key="",
        *,
        max_tokens=DEFAULT_MAX_TOKENS,
        timeout_ms=DEFAULT_TIMEOUT_MS,
        hard_timeout_ms=None,
        max_retries=DEFAULT_MAX_RETRIES,
        backoff=DEFAULT_BACKOFF,
        temperature=DEFAULT_TEMPERATURE,
        transport=None,
        sleep=None,
        clock=None,
        token_cap=None,
    ):
        base = (base_url or DEFAULT_BASE_URL).strip().rstrip("/")
        # 允许直接传 ".../v1" 或不带 /v1 的根地址，统一补成 /v1
        if not base.endswith("/v1"):
            base = base + "/v1"
        self.base_url = base
        self.model = (model or DEFAULT_MODEL).strip()
        self.api_key = "" if api_key is None else str(api_key)
        self.max_tokens = int(max_tokens)
        self.timeout_ms = int(timeout_ms)
        self.timeout_s = max(0.001, self.timeout_ms / 1000.0)
        # 墙钟硬截止（None = 与 socket 超时一致）。传 0/负数 = 关闭硬截止（仅测 socket 超时用）
        self.hard_timeout_ms = self.timeout_ms if hard_timeout_ms is None else int(hard_timeout_ms)
        self.hard_timeout_s = max(0.0, self.hard_timeout_ms / 1000.0)
        self.max_retries = max(0, int(max_retries))
        self.backoff = tuple(float(x) for x in backoff) or (0.0,)
        self.temperature = float(temperature)
        self.token_cap = None if token_cap is None else int(token_cap)
        self._transport = transport or _urllib_post
        self._sleep = sleep or time.sleep
        self._clock = clock or time.time
        self._lock = threading.Lock()  # 串行：同一时刻只有一个请求在飞
        self.reset_stats()

    # ------------------------------------------------------------ 构造
    @classmethod
    def from_settings(cls, settings, *, transport=None, sleep=None, clock=None):
        """用 admin settings 的 dict 构造（settings 里 api_key 是掩码，明文由调用方另取）。"""
        s = settings or {}
        model = s.get("model") or DEFAULT_MODEL
        return cls(
            base_url=s.get("baseUrl") or s.get("base_url") or DEFAULT_BASE_URL,
            model=model,
            api_key=s.get("apiKeyPlain") or s.get("api_key") or "",
            max_tokens=s.get("maxTokens") or s.get("max_tokens") or DEFAULT_MAX_TOKENS,
            timeout_ms=s.get("timeoutMs") or s.get("timeout_ms") or DEFAULT_TIMEOUT_MS,
            transport=transport,
            sleep=sleep,
            clock=clock,
        )

    # ------------------------------------------------------------ 统计
    def reset_stats(self):
        self.stats = {
            "calls": 0,  # 成功的 chat 次数
            "attempts": 0,  # 含重试的请求次数
            "errors": 0,  # 最终失败的 chat 次数
            "retries": 0,  # 实际发生的重试次数
            "tokensIn": 0,
            "tokensOut": 0,
            "tokensTotal": 0,
            "reasoningTokens": 0,
            "promptChars": 0,
            "totalMs": 0,
            "hardTimeouts": 0,
        }

    def snapshot(self):
        with self._lock:
            return dict(self.stats)

    def _tokens_used(self):
        return self.stats["tokensIn"] + self.stats["tokensOut"]

    # ------------------------------------------------------------ 主入口
    def chat(self, messages, *, max_tokens=None, temperature=None, model=None, response_format=None,
             timeout_ms=None):
        """发一次对话请求（含重试）。返回 dict，失败抛 LLMError。

        返回字段：
          content      模型正文（已 strip）
          reasoning    reasoning_content（可能为空）
          warning      "reasoning-model" / "truncated" / None
          usage        {tokensIn,tokensOut,tokensTotal,reasoningTokens}
          attempts     实际请求次数
          ms           本次总耗时（含重试等待）
          model        实际使用的模型名

        `timeout_ms` 是**本次调用的**墙钟/socket 超时（覆盖实例默认值）：
        管道做二级退化时用更短的截止重试更小的分段——小段产出量本来就小，
        再用 240s 等同一个坏请求只会拖长整批（见 `exp_pipeline.run_pipeline`）。
        """
        payload = {
            "model": model or self.model,
            "messages": list(messages),
            "max_tokens": int(max_tokens if max_tokens is not None else self.max_tokens),
            "temperature": float(temperature if temperature is not None else self.temperature),
        }
        if response_format:
            payload["response_format"] = response_format

        with self._lock:  # 串行 + 统计互斥
            if self.token_cap is not None and self._tokens_used() >= self.token_cap:
                self.stats["errors"] += 1
                raise LLMError(
                    f"token-cap reached: {self._tokens_used()} >= {self.token_cap}",
                    reason="token-cap",
                )
            started = self._clock()
            last_error = None
            for attempt in range(self.max_retries + 1):
                if attempt:
                    delay = self.backoff[min(attempt - 1, len(self.backoff) - 1)]
                    self.stats["retries"] += 1
                    self._sleep(delay)
                self.stats["attempts"] += 1
                try:
                    parsed = self._transport_with_deadline(payload, timeout_ms=timeout_ms)
                except LLMError as exc:
                    last_error = exc
                    if exc.reason not in RETRYABLE_REASONS:
                        # 配置错误/鉴权失败/坏 JSON：重试只会把错误放大三倍，立刻失败
                        self.stats["errors"] += 1
                        exc.attempts = attempt + 1
                        exc.retryable = False
                        raise
                    continue
                except Exception as exc:  # noqa: BLE001 - 传输层未知异常按网络问题重试
                    last_error = LLMError(f"network: {exc}", reason="network")
                    continue
                self.stats["calls"] += 1
                return self._parse_response(parsed, attempt + 1, started)

            # 重试用尽
            self.stats["errors"] += 1
            attempts = self.max_retries + 1
            reason = last_error.reason if last_error else "error"
            message = str(last_error) if last_error else "unknown error"
            raise LLMError(
                f"LLM 失败（{attempts} 次尝试，reason={reason}）：{message}",
                reason=reason,
                status=getattr(last_error, "status", None),
                attempts=attempts,
                retryable=True,
                last=last_error,
            )

    def _headers(self):
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        return headers

    def _transport_with_deadline(self, payload, timeout_ms=None):
        """带墙钟硬截止地调一次 transport；超截止抛 `LLMError(reason="timeout")`。

        `timeout_ms` 传入时覆盖本次调用的 socket 超时与硬截止（二级退化用更短截止）。
        """
        if timeout_ms is not None:
            timeout_s = max(0.001, int(timeout_ms) / 1000.0)
            hard_timeout_s = max(0.0, int(timeout_ms) / 1000.0)
            hard_timeout_ms = int(timeout_ms)
        else:
            timeout_s, hard_timeout_s, hard_timeout_ms = self.timeout_s, self.hard_timeout_s, self.hard_timeout_ms
        args = (self.base_url + "/chat/completions", payload, self._headers(), timeout_s)
        if hard_timeout_s <= 0:
            return self._transport(*args)
        box = {}

        def run():
            try:
                box["value"] = self._transport(*args)
            except BaseException as exc:  # noqa: BLE001 - 包括 transport 自己抛的 LLMError
                box["error"] = exc

        worker = threading.Thread(target=run, name="llm-request", daemon=True)
        worker.start()
        worker.join(hard_timeout_s)
        if worker.is_alive():
            self.stats["hardTimeouts"] = self.stats.get("hardTimeouts", 0) + 1
            raise LLMError(
                f"hard timeout after {hard_timeout_ms}ms（socket 仍活着，已放弃本次请求）",
                reason="timeout",
            )
        if "error" in box:
            raise box["error"]
        return box.get("value")

    def _parse_response(self, parsed, attempts, started):
        if not isinstance(parsed, dict) or not parsed.get("choices"):
            self.stats["errors"] += 1
            raise LLMError(f"响应缺 choices：{str(parsed)[:200]}", reason="bad-response", attempts=attempts)
        choice = parsed["choices"][0] or {}
        message = choice.get("message") or {}
        content = (message.get("content") or "").strip()
        reasoning = (message.get("reasoning_content") or message.get("reasoning") or "").strip()
        usage = parsed.get("usage") or {}
        tokens_in = int(usage.get("prompt_tokens") or 0)
        tokens_out = int(usage.get("completion_tokens") or 0)
        details = usage.get("completion_tokens_details") or {}
        reasoning_tokens = int(details.get("reasoning_tokens") or 0)
        finish = choice.get("finish_reason") or ""

        warning = None
        if not content and reasoning:
            # 推理型模型把预算花光：content 空但 reasoning 有内容 —— 不是"没有经验"
            warning = WARN_REASONING_MODEL
        elif finish == "length" and content:
            warning = WARN_TRUNCATED

        self.stats["tokensIn"] += tokens_in
        self.stats["tokensOut"] += tokens_out
        self.stats["tokensTotal"] += int(usage.get("total_tokens") or (tokens_in + tokens_out))
        self.stats["reasoningTokens"] += reasoning_tokens
        self.stats["totalMs"] += int(round((self._clock() - started) * 1000))
        return {
            "content": content,
            "reasoning": reasoning,
            "warning": warning,
            "finishReason": finish,
            "usage": {
                "tokensIn": tokens_in,
                "tokensOut": tokens_out,
                "tokensTotal": int(usage.get("total_tokens") or (tokens_in + tokens_out)),
                "reasoningTokens": reasoning_tokens,
            },
            "attempts": attempts,
            "ms": int(round((self._clock() - started) * 1000)),
            "model": (parsed.get("model") or self.model),
        }

    # ------------------------------------------------------------ 便捷方法
    def extract_json_array(self, material, *, max_tokens=None, system_prompt=None, timeout_ms=None):
        """把素材喂给 prompt 并解析出候选 dict 列表（解析失败抛 LLMError reason=bad-json）。

        `timeout_ms` 透传给 `chat()`：二级退化用更短截止重试更小分段时用得上。
        """
        import exp_prompt  # 延迟 import：exp_llm 可独立用于其它 prompt

        messages = [{"role": "user", "content": exp_prompt.render_prompt(material)}]
        if system_prompt:
            messages.insert(0, {"role": "system", "content": system_prompt})
        result = self.chat(messages, max_tokens=max_tokens, timeout_ms=timeout_ms)
        entries, parse_error = parse_json_array(result["content"])
        if parse_error and not entries:
            raise LLMError(f"JSON 解析失败：{parse_error}；原文前 200 字：{result['content'][:200]}",
                           reason="bad-json", attempts=result["attempts"])
        result["entries"] = entries
        return result


# ---------------------------------------------------------------- JSON 解析
_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")


def parse_json_array(raw):
    """从模型输出里抠出 JSON 数组。返回 `(entries, error)`；`error` 为 None 表示解析成功。

    模型常见花活：包 ```json 代码块、前后加解释、包一层 `{"experiences": [...]}`、
    多个数组粘连。这里只认"第一个能 decode 的数组/对象里的数组"，不做猜测性修复。
    """
    text = (raw or "").strip()
    if not text:
        return [], "empty content"
    text = _FENCE_RE.sub("", text).strip()
    candidates = []
    for marker in ("[", "{"):
        idx = text.find(marker)
        if idx >= 0:
            candidates.append(text[idx:])
    for chunk in candidates:
        try:
            value, _end = json.JSONDecoder().raw_decode(chunk)
        except ValueError:
            continue
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)], None
        if isinstance(value, dict):
            for key in ("experiences", "items", "results", "data"):
                inner = value.get(key)
                if isinstance(inner, list):
                    return [x for x in inner if isinstance(x, dict)], None
            return [], "object without array"
    return [], "no JSON array found"
