"""Read config/models.yaml, the single source of truth for model ids.

Shell scripts call `uv run --quiet sa-models <command>`; Python code calls `load()`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[4]
CONFIG_PATH = Path(os.environ.get("SA_MODELS_CONFIG") or REPO_ROOT / "config" / "models.yaml")
USAGE = "usage: sa-models get <dotted.key> | profile | llm <key> | models-dir"


def load(path: Path | None = None) -> dict[str, Any]:
    with open(path or CONFIG_PATH, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def get(cfg: dict[str, Any], dotted: str) -> Any:
    node: Any = cfg
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(dotted)
        node = node[part]
    return node


def active_profile(cfg: dict[str, Any]) -> str:
    name = os.environ.get("LLM_PROFILE") or cfg["llm"]["active_profile"]
    if name not in cfg["llm"]["profiles"]:
        raise KeyError(f"llm.profiles.{name}")
    return name


def models_dir(cfg: dict[str, Any]) -> Path:
    return Path(os.environ.get("SA_MODELS_DIR") or cfg["paths"]["models_dir"]).expanduser()


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    cfg = load()
    try:
        match args:
            case ["get", dotted]:
                value = get(cfg, dotted)
            case ["profile"]:
                value = active_profile(cfg)
            case ["llm", key]:
                value = get(cfg, f"llm.profiles.{active_profile(cfg)}.{key}")
            case ["models-dir"]:
                value = models_dir(cfg)
            case _:
                print(USAGE, file=sys.stderr)
                return 2
    except KeyError as exc:
        print(f"sa-models: missing key {exc}", file=sys.stderr)
        return 1
    if isinstance(value, dict | list):
        print(yaml.safe_dump(value, sort_keys=False).rstrip())
    else:
        print("" if value is None else value)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
