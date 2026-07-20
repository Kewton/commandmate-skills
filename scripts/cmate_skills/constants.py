"""Distribution contract constants, mirrored from CommandMate (#1228).

Upstream source of truth: `src/lib/skills/constants.ts` in `Kewton/CommandMate`.
Nothing here may be "improved" locally: a value that disagrees with upstream
produces artifacts CommandMate refuses to install, and the refusal happens on the
user's machine rather than in this repository's CI.

See `docs/design/contract-sync.md` for the pinned upstream revision.
"""

from __future__ import annotations

import re

# =============================================================================
# Schema version
# =============================================================================

SKILL_SCHEMA_VERSION = 1

# =============================================================================
# Skill ID
# =============================================================================

SKILL_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SKILL_ID_MAX_LENGTH = 64

RESERVED_SKILL_IDS: tuple[str, ...] = (
    "commandmate",
    "system",
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
)

# =============================================================================
# Layout
# =============================================================================

SKILL_INSTALL_ROOT_PREFIX = ".agents/skills"
SKILL_MANIFEST_FILENAME = "commandmate.skill.yaml"
SKILL_MD_FILENAME = "SKILL.md"

REQUIRED_PACKAGE_ENTRIES: tuple[str, ...] = (SKILL_MD_FILENAME, SKILL_MANIFEST_FILENAME)

# =============================================================================
# Artifact
# =============================================================================

SKILL_ARTIFACT_FORMAT = "tar.gz"
SKILL_ARTIFACT_CONTENT_TYPE = "application/gzip"
SKILL_ARTIFACT_MAX_SIZE = 16 * 1024 * 1024
SKILL_FILE_MAX_SIZE = 4 * 1024 * 1024
SKILL_FILES_MAX_COUNT = 500

SKILL_PACKAGE_MAX_ENTRIES = 1000
SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024
SKILL_PACKAGE_MAX_COMPRESSION_RATIO = 200

#: Ratio checking starts here. tar pads every entry to 512 bytes with zeros, so a
#: small legitimate package compresses at a ratio a bomb would also show; below
#: this size the absolute caps are the meaningful guard.
SKILL_PACKAGE_RATIO_FLOOR_BYTES = 1024 * 1024


def build_skill_asset_name(skill_id: str, version: str) -> str:
    """Required release asset name for a version."""
    return f"{skill_id}-{version}.tar.gz"


# =============================================================================
# Payload paths
# =============================================================================

SKILL_PATH_SEGMENT_MAX_LENGTH = 100
SKILL_PATH_MAX_DEPTH = 8
SKILL_PATH_MAX_LENGTH = 255

# =============================================================================
# Text limits
# =============================================================================

SKILL_NAME_MAX_LENGTH = 100
SKILL_SUMMARY_MAX_LENGTH = 200
SKILL_DESCRIPTION_MAX_LENGTH = 2000
SKILL_BULLET_MAX_LENGTH = 200
SKILL_BULLET_MAX_COUNT = 10
SKILL_KEYWORDS_MAX_COUNT = 20
SKILL_KEYWORD_MAX_LENGTH = 40
SKILL_CHANGELOG_MAX_LENGTH = 4000
SKILL_EVIDENCE_MAX_LENGTH = 300
SKILL_RATIONALE_MAX_LENGTH = 500
SKILL_COMMANDS_MAX_COUNT = 20
SKILL_NETWORK_HOSTS_MAX_COUNT = 20
SKILL_CATALOG_ENTRIES_MAX_COUNT = 500
SKILL_CATALOG_VERSIONS_MAX_COUNT = 100

# =============================================================================
# Safe YAML parse profile
# =============================================================================

SKILL_YAML_SAFE_PROFILE = {
    "max_bytes": 64 * 1024,
    "max_depth": 16,
    "max_nodes": 5000,
    "max_scalar_length": 8192,
    "allow_aliases": False,
    "allow_custom_tags": False,
    "allow_duplicate_keys": False,
    "forbidden_keys": ("__proto__", "constructor", "prototype"),
}

# =============================================================================
# Enumerations
# =============================================================================

SKILL_AGENT_SUPPORT_VALUES: tuple[str, ...] = (
    "native",
    "commandmate_runtime",
    "unsupported",
    "unknown",
)

SKILL_RISK_LEVELS: tuple[str, ...] = ("low", "moderate", "high")
SKILL_RISK_ORDER = {"low": 0, "moderate": 1, "high": 2}

SKILL_DECLARED_PERMISSIONS: tuple[str, ...] = (
    "filesystem_read",
    "filesystem_write",
    "network_access",
    "process_execution",
    "environment_read",
    "credential_access",
)

SKILL_FILE_KINDS: tuple[str, ...] = ("skill_md", "instruction", "script", "asset")

# Mirrors `CLI_TOOL_IDS` in `src/lib/cli-tools/types.ts`: `compatibility.agents[].agent`
# is rejected upstream when it is not a known CLI tool.
CLI_TOOL_IDS: tuple[str, ...] = (
    "claude",
    "codex",
    "gemini",
    "vibe-local",
    "opencode",
    "copilot",
    "antigravity",
)

# =============================================================================
# Script / instruction classification (mirrors package-validator.ts)
# =============================================================================

SKILL_SCRIPT_EXTENSIONS: tuple[str, ...] = (
    ".bash",
    ".bat",
    ".cjs",
    ".cmd",
    ".fish",
    ".js",
    ".lua",
    ".mjs",
    ".php",
    ".pl",
    ".ps1",
    ".py",
    ".rb",
    ".sh",
    ".ts",
    ".zsh",
)

INSTRUCTION_EXTENSIONS: tuple[str, ...] = (".md", ".markdown", ".rst", ".txt")

# =============================================================================
# Formats
# =============================================================================

SHA256_HEX_PATTERN = re.compile(r"^[0-9a-f]{64}$")
GIT_COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_SLUG_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$"
)
GIT_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")
RFC3339_UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")
SPDX_LICENSE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$")
COMMAND_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
NETWORK_HOST_PATTERN = re.compile(
    r"^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$"
)
HTTPS_URL_PREFIX = "https://"

# =============================================================================
# Reproducible build
# =============================================================================

#: Every timestamp written into an artifact. Fixed rather than taken from
#: SOURCE_DATE_EPOCH so two builds of the same commit agree without the caller
#: having to pass anything through.
REPRODUCIBLE_MTIME = 0

#: tar entry ownership. Numeric ids are zeroed and the name fields are emptied so
#: the build does not leak the runner's account into the artifact.
REPRODUCIBLE_UID = 0
REPRODUCIBLE_GID = 0
REPRODUCIBLE_UNAME = ""
REPRODUCIBLE_GNAME = ""

#: Normalized modes. Only these three appear in a published artifact.
DIRECTORY_MODE = 0o755
FILE_MODE = 0o644
EXECUTABLE_FILE_MODE = 0o755

#: Fixed deflate level, so the compressor's output is a function of the input.
GZIP_COMPRESS_LEVEL = 9
