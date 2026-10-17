"""Shared source and child-process paths for disposable-workspace tests."""
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = REPO_ROOT / "src"
PACKAGE_ROOT = SOURCE_ROOT / "slide_notes"
EXAMPLES_ROOT = PACKAGE_ROOT / "examples"
FIXTURES_ROOT = REPO_ROOT / "tests" / "fixtures"


def python_environment():
    """Keep source imports valid when child processes run in a temp workspace."""
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(SOURCE_ROOT)
    return environment
