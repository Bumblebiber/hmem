"""hermes-hmem — its-over-9k (hmem) integration for the Hermes agent.

Logs every (user, assistant) exchange to the active hmem O-entry and fires
the hmem checkpoint agent when a batch fills up or the session ends.
Mirrors the behavior of src/extensions/pi-hmem.ts in the hmem repo, adapted
to Hermes' Python plugin API.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("hermes-hmem")

_HMEM_BIN = shutil.which("hmem")
_RUN_TIMEOUT = 10.0          # seconds for hmem log-exchange
_DEBOUNCE_SECS = 5.0          # match pi-hmem.ts lastLogTime guard

# Per-session state: { session_id -> {"user": str, "last_log": float} }
_state: Dict[str, Dict[str, Any]] = {}
_state_lock = threading.Lock()


# ── helpers ────────────────────────────────────────────────────────────────

def _extract_text(value: Any) -> str:
    """Hermes passes plain strings for user_message and assistant_response,
    but defensively unwrap dict/list shapes too."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("content", "text", "message"):
            if isinstance(value.get(key), str):
                return value[key]
        return ""
    if isinstance(value, list):
        parts = []
        for block in value:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return ""


def _session_key(session_id: str) -> str:
    return f"hermes:{session_id}" if session_id else "hermes:unknown"


def _run_log_exchange(user_text: str, assistant_text: str, session_id: str) -> str:
    """Pipe an exchange to `hmem log-exchange`. Returns stdout or empty string."""
    if not _HMEM_BIN:
        return ""
    payload = json.dumps({
        "last_user_message": user_text,
        "last_assistant_message": assistant_text,
        "session_id": _session_key(session_id),
    })
    try:
        result = subprocess.run(
            [_HMEM_BIN, "log-exchange"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=_RUN_TIMEOUT,
        )
        return (result.stdout or "") + (result.stderr or "")
    except subprocess.TimeoutExpired:
        logger.debug("hmem log-exchange timed out after %.1fs", _RUN_TIMEOUT)
        return ""
    except Exception as exc:
        logger.debug("hmem log-exchange failed: %s", exc)
        return ""


def _spawn_checkpoint() -> None:
    """Fire-and-forget `hmem checkpoint`. Mirrors spawnCheckpoint in pi-hmem.ts."""
    if not _HMEM_BIN:
        return
    try:
        subprocess.Popen(
            [_HMEM_BIN, "checkpoint"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        logger.debug("hmem checkpoint spawn failed: %s", exc)


def _log_async(user_text: str, assistant_text: str, session_id: str) -> None:
    """Run log-exchange in a background thread; trigger checkpoint if batch full."""
    def _worker() -> None:
        output = _run_log_exchange(user_text, assistant_text, session_id)
        if '"decision":"block"' in output or "Batch" in output:
            _spawn_checkpoint()

    threading.Thread(target=_worker, daemon=True, name="hermes-hmem-log").start()


# ── hooks ──────────────────────────────────────────────────────────────────

def on_session_start(*, session_id: str = "", **_: Any) -> None:
    """Initialize per-session state when a new session begins."""
    if not session_id:
        return
    with _state_lock:
        _state[session_id] = {"user": "", "last_log": 0.0}
    logger.debug("hermes-hmem: session started %s", session_id)


def on_pre_llm_call(*, session_id: str = "", user_message: Any = None,
                    turn_type: str = "user", **_: Any) -> None:
    """Buffer the latest user turn so we can pair it with the assistant
    response in `post_llm_call`."""
    if not session_id:
        return
    # Only capture user-initiated turns (skip tool-result continuations).
    if turn_type and turn_type != "user":
        return
    text = _extract_text(user_message).strip()
    if not text:
        return
    with _state_lock:
        slot = _state.setdefault(session_id, {"user": "", "last_log": 0.0})
        slot["user"] = text


def on_post_llm_call(*, session_id: str = "", assistant_response: Any = None,
                     **_: Any) -> None:
    """Pair the assistant response with the buffered user turn and log it
    to hmem. Triggers checkpoint subprocess when the batch fills up."""
    if not session_id or not _HMEM_BIN:
        return
    assistant_text = _extract_text(assistant_response).strip()
    if not assistant_text:
        return

    with _state_lock:
        slot = _state.setdefault(session_id, {"user": "", "last_log": 0.0})
        user_text = slot.get("user", "")
        now = time.time()
        if not user_text or len(user_text) < 2:
            return
        if now - slot.get("last_log", 0.0) < _DEBOUNCE_SECS:
            return
        slot["last_log"] = now
        slot["user"] = ""  # consumed

    _log_async(user_text, assistant_text, session_id)


# Note: Hermes' `on_session_end` fires once per `run_conversation` call (i.e.
# per turn), not once per process lifetime. Spawning a final `hmem checkpoint`
# there would fire on every turn — disastrous for token budget. Checkpoint
# spawning is therefore handled exclusively by the batch-full signal from
# `hmem log-exchange` inside `post_llm_call`. We do not register on_session_end.


# ── registration ───────────────────────────────────────────────────────────

def register(ctx) -> None:
    if not _HMEM_BIN:
        logger.warning(
            "hermes-hmem: `hmem` CLI not found on PATH — plugin loaded but "
            "inactive. Install with `npm install -g its-over-9k`."
        )
    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("post_llm_call", on_post_llm_call)
