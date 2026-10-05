"""§236 provider base URL validation (platform admin -> AI providers).

A wrong base URL used to be saved silently and broke every AI call. Now:
https only (plain http just for localhost or OF_PROVIDER_HTTP_HOSTS), no
credentials / query / fragment, a pasted endpoint path is removed.
"""
import os
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "svc-test-key")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "admin-test-key")
os.environ.pop("OF_PROVIDER_HTTP_HOSTS", None)
sys.path.insert(0, os.getcwd())

from test_lib import check, summary  # noqa: E402
import platform_settings as ps  # noqa: E402
import admin_providers  # noqa: E402

ok = ps.clean_api_base
print("== clean_api_base ==")
check("blank -> blank, no error", ok("") == ("", None) and ok("   ") == ("", None))
check("https kept, trailing slash removed", ok("https://api.openai.com/v1/") == ("https://api.openai.com/v1", None))
for suffix in ("/chat/completions", "/embeddings", "/audio/transcriptions", "/models", "/completions"):
    check("pasted %s removed" % suffix, ok("https://api.groq.com/openai/v1" + suffix) ==
          ("https://api.groq.com/openai/v1", None))
check("case-insensitive suffix", ok("https://x.ai/v1/Chat/Completions") == ("https://x.ai/v1", None))
check("localhost http allowed", ok("http://localhost:11434/v1") == ("http://localhost:11434/v1", None)
      and ok("http://127.0.0.1:8000/v1")[1] is None and ok("http://[::1]:8000/v1")[1] is None)
check("remote http refused", ok("http://api.example.com/v1")[1] is not None
      and "localhost" in ok("http://api.example.com/v1")[1])
os.environ["OF_PROVIDER_HTTP_HOSTS"] = "ollama.internal, gpu-box"
check("env allowlist for internal http hosts", ok("http://ollama.internal:11434/v1")[1] is None
      and ok("http://gpu-box/v1")[1] is None and ok("http://other.internal/v1")[1] is not None)
os.environ.pop("OF_PROVIDER_HTTP_HOSTS")
for bad in ("ftp://x.com/v1", "api.openai.com/v1", "https://", "https://u:p@x.com/v1", "https://x.com/v1?key=sk-1",
            "https://x.com/v1#frag", "https://x.com/v 1", "https://" + "a" * 300 + ".com"):
    value, error = ok(bad)
    check("refused: %s" % bad[:40], value == "" and bool(error))
check("the error never echoes the address (keys may be pasted in it)",
      "sk-1" not in ok("https://x.com/v1?key=sk-1")[1])

print("== admin save path ==")
values, error = admin_providers._clean_group("llm", {"base_url": "https://api.openai.com/v1/chat/completions",
                                                     "model": "gpt-4o-mini"})
check("llm: normalised before saving", error is None and values["base_url"] == "https://api.openai.com/v1", values)
for group in ("stt", "embeddings", "vision", "assistant"):
    values, error = admin_providers._clean_group(group, {"base_url": "http://evil.example/v1"})
    check("%s: remote http -> 400 message names the field" % group, values is None
          and error.startswith(group + ".base_url: "), error)
values, error = admin_providers._clean_group("llm", {"base_url": ""})
check("blank base URL still allowed (provider default)", error is None and values.get("base_url") == "", values)
values, error = admin_providers._clean_group("router", {"secondary_base_url": "http://localhost:11434/v1"})
check("router keeps its own validator (local http allowed)", error is None, error)

sys.exit(1 if summary("base_url") else 0)
