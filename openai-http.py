#!/usr/bin/env python3
"""Restricted Chrome-impersonating HTTP transport for OpenAI first-party APIs."""

from __future__ import annotations

import json
import sys
from urllib.parse import urlsplit

from curl_cffi import requests


ALLOWED_HOSTS = {"chatgpt.com", "api.openai.com", "pay.openai.com"}
ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
MAX_RESPONSE_BYTES = 1_000_000


def main() -> int:
    payload = json.load(sys.stdin)
    method = str(payload.get("method") or "GET").upper()
    url = str(payload.get("url") or "").strip()
    parsed = urlsplit(url)
    if method not in ALLOWED_METHODS:
        raise ValueError("unsupported method")
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("unsupported URL")

    headers = {
        str(key): str(value)
        for key, value in dict(payload.get("headers") or {}).items()
        if value is not None
    }
    proxy = str(payload.get("proxy") or "").strip()
    timeout = max(2.0, min(60.0, float(payload.get("timeout_seconds") or 20)))
    body = payload.get("body")

    session = requests.Session(impersonate="chrome136")
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    response = session.request(
        method,
        url,
        headers=headers,
        json=body if body is not None else None,
        timeout=timeout,
        allow_redirects=False,
    )
    content = bytes(response.content or b"")[:MAX_RESPONSE_BYTES]
    text = content.decode(response.encoding or "utf-8", errors="replace")
    try:
        data = json.loads(text) if text else None
    except json.JSONDecodeError:
        data = text

    json.dump(
        {"status": int(response.status_code), "data": data, "via": "curl-cffi"},
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        error_code = getattr(error, "code", None)
        json.dump(
            {
                "status": 0,
                "data": f"{type(error).__name__}{f' code={error_code}' if error_code is not None else ''}",
                "via": "curl-cffi",
                "error": True,
            },
            sys.stdout,
            ensure_ascii=False,
        )
        raise SystemExit(1)
