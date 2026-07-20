"""Make `cmate_skills` importable when a script is run by path.

CI invokes `python3 scripts/validate.py` from the repository root, which puts
`scripts/` on `sys.path` already -- but a contributor running the same script
from inside `scripts/`, or a workflow that changes directory, would not get the
same result. One import here removes that difference.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
