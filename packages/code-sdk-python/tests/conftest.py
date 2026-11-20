from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

FAKE = Path(__file__).with_name("fake_mcode.py")
#: Windows port of the fake CLI. ``fake_mcode.py`` is a shebang script, which Windows cannot
#: execute, and the SDK only starts ``.exe``, ``.com`` and ``.js`` entries there (see
#: ``minimax_code._cli``). A ``.mjs`` entry is started as ``node <entry>``.
FAKE_NODE = Path(__file__).with_name("fake_mcode.mjs")


@pytest.fixture
def fake_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    record = tmp_path / "calls.jsonl"
    env = dict(os.environ)
    fake = FAKE_NODE if sys.platform == "win32" else FAKE
    env.update({"MCODE_BIN": str(fake), "FAKE_MCODE_RECORD": str(record)})
    return env
