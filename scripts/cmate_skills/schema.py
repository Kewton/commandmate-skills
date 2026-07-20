"""Manifest and Catalog validators, mirrored from CommandMate (#1228).

Upstream source of truth: `src/lib/skills/schema.ts`. Pure functions over an
already-parsed document -- no filesystem, no network, no YAML parser -- and total:
they collect findings instead of raising, so one CI run reports every problem in a
package.

`schema_version: 1` is a *closed* schema. An unknown field is a rejection, not
something to ignore, because a field this build does not understand is a field the
user was never shown.
"""

from __future__ import annotations

import unicodedata
from typing import Any, Iterable

from .constants import (
    CLI_TOOL_IDS,
    COMMAND_NAME_PATTERN,
    GIT_COMMIT_SHA_PATTERN,
    GIT_REF_PATTERN,
    HTTPS_URL_PREFIX,
    NETWORK_HOST_PATTERN,
    REPOSITORY_SLUG_PATTERN,
    RESERVED_SKILL_IDS,
    RFC3339_UTC_PATTERN,
    SHA256_HEX_PATTERN,
    SKILL_AGENT_SUPPORT_VALUES,
    SKILL_ARTIFACT_CONTENT_TYPE,
    SKILL_ARTIFACT_FORMAT,
    SKILL_ARTIFACT_MAX_SIZE,
    SKILL_BULLET_MAX_COUNT,
    SKILL_BULLET_MAX_LENGTH,
    SKILL_CATALOG_ENTRIES_MAX_COUNT,
    SKILL_CATALOG_VERSIONS_MAX_COUNT,
    SKILL_CHANGELOG_MAX_LENGTH,
    SKILL_COMMANDS_MAX_COUNT,
    SKILL_DECLARED_PERMISSIONS,
    SKILL_DESCRIPTION_MAX_LENGTH,
    SKILL_EVIDENCE_MAX_LENGTH,
    SKILL_FILE_KINDS,
    SKILL_FILE_MAX_SIZE,
    SKILL_FILES_MAX_COUNT,
    SKILL_ID_MAX_LENGTH,
    SKILL_ID_PATTERN,
    SKILL_KEYWORD_MAX_LENGTH,
    SKILL_KEYWORDS_MAX_COUNT,
    SKILL_MANIFEST_FILENAME,
    SKILL_MD_FILENAME,
    SKILL_NAME_MAX_LENGTH,
    SKILL_NETWORK_HOSTS_MAX_COUNT,
    SKILL_PATH_MAX_DEPTH,
    SKILL_PATH_MAX_LENGTH,
    SKILL_PATH_SEGMENT_MAX_LENGTH,
    SKILL_RATIONALE_MAX_LENGTH,
    SKILL_RISK_LEVELS,
    SKILL_RISK_ORDER,
    SKILL_SCHEMA_VERSION,
    SKILL_SUMMARY_MAX_LENGTH,
    SPDX_LICENSE_PATTERN,
    build_skill_asset_name,
)
from .errors import Finding, join_path
from .semver import is_valid_semver, is_valid_version_range

# =============================================================================
# Allowed field sets
# =============================================================================

MANIFEST_FIELDS = (
    "schema_version",
    "id",
    "name",
    "version",
    "summary",
    "description",
    "capabilities",
    "expected_outcomes",
    "provider",
    "license",
    "homepage",
    "keywords",
    "compatibility",
    "requirements",
    "declared_permissions",
    "declared_risk",
    "risk_rationale",
    "files",
)

CATALOG_FIELDS = ("schema_version", "entries")
CATALOG_ENTRY_FIELDS = (
    "id",
    "name",
    "summary",
    "provider",
    "license",
    "homepage",
    "keywords",
    "latest",
    "versions",
)
CATALOG_VERSION_FIELDS = (
    "version",
    "changelog",
    "published_at",
    "source",
    "artifact",
    "compatibility",
    "declared_risk",
)
PROVIDER_FIELDS = ("name", "url", "contact")
COMPATIBILITY_FIELDS = ("commandmate", "agents")
AGENT_COMPAT_FIELDS = ("agent", "support", "evidence")
REQUIREMENTS_FIELDS = ("commands", "network_hosts")
COMMAND_FIELDS = ("name", "version_range")
FILE_ENTRY_FIELDS = ("path", "sha256", "size", "kind", "executable", "script")
SOURCE_FIELDS = ("repository", "ref", "commit")
ARTIFACT_FIELDS = ("asset_name", "url", "sha256", "size", "content_type", "format")

# =============================================================================
# Codes (subset of SkillContractErrorCode, same strings)
# =============================================================================

NOT_AN_OBJECT = "SKILL_NOT_AN_OBJECT"
UNKNOWN_FIELD = "SKILL_UNKNOWN_FIELD"
MISSING_FIELD = "SKILL_MISSING_FIELD"
INVALID_TYPE = "SKILL_INVALID_TYPE"
INVALID_FORMAT = "SKILL_INVALID_FORMAT"
INVALID_ENUM = "SKILL_INVALID_ENUM"
LIMIT_EXCEEDED = "SKILL_LIMIT_EXCEEDED"
DUPLICATE_ENTRY = "SKILL_DUPLICATE_ENTRY"
INCONSISTENT_VALUE = "SKILL_INCONSISTENT_VALUE"
ID_INVALID = "SKILL_ID_INVALID"
ID_RESERVED = "SKILL_ID_RESERVED"
ID_COLLISION = "SKILL_ID_COLLISION"
ID_MISMATCH = "SKILL_ID_MISMATCH"
VERSION_INVALID = "SKILL_VERSION_INVALID"
VERSION_RANGE_INVALID = "SKILL_VERSION_RANGE_INVALID"
DIGEST_INVALID = "SKILL_DIGEST_INVALID"
SOURCE_COMMIT_INVALID = "SKILL_SOURCE_COMMIT_INVALID"
ARTIFACT_INVALID = "SKILL_ARTIFACT_INVALID"
FILE_PATH_UNSAFE = "SKILL_FILE_PATH_UNSAFE"
FILE_PATH_DUPLICATE = "SKILL_FILE_PATH_DUPLICATE"
FILE_SET_MISMATCH = "SKILL_FILE_SET_MISMATCH"
SCHEMA_VERSION_UNSUPPORTED = "SKILL_SCHEMA_VERSION_UNSUPPORTED"
CATALOG_LATEST_UNRESOLVED = "SKILL_CATALOG_LATEST_UNRESOLVED"

_MISSING = object()


# =============================================================================
# Primitive readers
# =============================================================================


def _is_mapping(value: object) -> bool:
    return isinstance(value, dict)


def _read_object(value: object, path: str, out: list[Finding]) -> dict[str, Any] | None:
    if not _is_mapping(value):
        out.append(Finding(NOT_AN_OBJECT, path, f"{path or '/'} must be an object"))
        return None
    return value  # type: ignore[return-value]


def _check_unknown(
    obj: dict[str, Any], allowed: Iterable[str], path: str, out: list[Finding]
) -> None:
    allowed_set = set(allowed)
    for key in obj:
        if key not in allowed_set:
            out.append(
                Finding(
                    UNKNOWN_FIELD,
                    join_path(path, key),
                    f"unknown field is not allowed in schema_version {SKILL_SCHEMA_VERSION}",
                )
            )


def _read_string(
    obj: dict[str, Any],
    key: str,
    parent: str,
    out: list[Finding],
    *,
    optional: bool = False,
    min_length: int = 1,
    max_length: int | None = None,
    pattern: Any = None,
    format_code: str | None = None,
) -> str | None:
    path = join_path(parent, key)
    value = obj.get(key, _MISSING)
    if value is _MISSING or value is None:
        if not optional:
            out.append(Finding(MISSING_FIELD, path, f"{key} is required"))
        return None
    if not isinstance(value, str):
        out.append(Finding(INVALID_TYPE, path, f"{key} must be a string"))
        return None
    length_code = format_code or LIMIT_EXCEEDED
    if len(value) < min_length:
        out.append(
            Finding(length_code, path, f"{key} is shorter than the minimum", {"minLength": min_length})
        )
        return None
    if max_length is not None and len(value) > max_length:
        out.append(
            Finding(length_code, path, f"{key} exceeds the maximum length", {"maxLength": max_length})
        )
        return None
    if pattern is not None and not pattern.match(value):
        out.append(
            Finding(format_code or INVALID_FORMAT, path, f"{key} does not match the required format")
        )
        return None
    return value


def _read_integer(
    obj: dict[str, Any], key: str, parent: str, out: list[Finding], *, minimum: int, maximum: int
) -> int | None:
    path = join_path(parent, key)
    value = obj.get(key, _MISSING)
    if value is _MISSING or value is None:
        out.append(Finding(MISSING_FIELD, path, f"{key} is required"))
        return None
    # `bool` is an `int` in Python but never an integer in this schema.
    if isinstance(value, bool) or not isinstance(value, int):
        out.append(Finding(INVALID_TYPE, path, f"{key} must be an integer"))
        return None
    if value < minimum or value > maximum:
        out.append(
            Finding(LIMIT_EXCEEDED, path, f"{key} is out of range", {"min": minimum, "max": maximum})
        )
        return None
    return value


def _read_boolean(obj: dict[str, Any], key: str, parent: str, out: list[Finding]) -> bool | None:
    path = join_path(parent, key)
    value = obj.get(key, _MISSING)
    if value is _MISSING or value is None:
        out.append(Finding(MISSING_FIELD, path, f"{key} is required"))
        return None
    if not isinstance(value, bool):
        out.append(Finding(INVALID_TYPE, path, f"{key} must be a boolean"))
        return None
    return value


def _read_array(
    obj: dict[str, Any],
    key: str,
    parent: str,
    out: list[Finding],
    *,
    max_items: int,
    optional: bool = False,
) -> list[Any] | None:
    path = join_path(parent, key)
    value = obj.get(key, _MISSING)
    if value is _MISSING or value is None:
        if not optional:
            out.append(Finding(MISSING_FIELD, path, f"{key} is required"))
        return None
    if not isinstance(value, list):
        out.append(Finding(INVALID_TYPE, path, f"{key} must be an array"))
        return None
    if len(value) > max_items:
        out.append(Finding(LIMIT_EXCEEDED, path, f"{key} has too many items", {"maxItems": max_items}))
        return None
    return value


def _read_enum(
    obj: dict[str, Any], key: str, parent: str, out: list[Finding], allowed: tuple[str, ...]
) -> str | None:
    path = join_path(parent, key)
    value = obj.get(key, _MISSING)
    if value is _MISSING or value is None:
        out.append(Finding(MISSING_FIELD, path, f"{key} is required"))
        return None
    if not isinstance(value, str) or value not in allowed:
        out.append(
            Finding(INVALID_ENUM, path, f"{key} is not an allowed value", {"allowed": "|".join(allowed)})
        )
        return None
    return value


def _read_string_list(
    obj: dict[str, Any],
    key: str,
    parent: str,
    out: list[Finding],
    *,
    max_items: int,
    max_length: int,
    optional: bool = False,
    pattern: Any = None,
) -> list[str] | None:
    raw = _read_array(obj, key, parent, out, max_items=max_items, optional=optional)
    if raw is None:
        return None
    values: list[str] = []
    failed = False
    for index, item in enumerate(raw):
        path = join_path(join_path(parent, key), index)
        if not isinstance(item, str) or not item or len(item) > max_length:
            out.append(
                Finding(INVALID_TYPE, path, "item must be a bounded string", {"maxLength": max_length})
            )
            failed = True
            continue
        if pattern is not None and not pattern.match(item):
            out.append(Finding(INVALID_FORMAT, path, "item does not match the required format"))
            failed = True
            continue
        values.append(item)
    return None if failed else values


def _read_https_url(
    obj: dict[str, Any], key: str, parent: str, out: list[Finding], *, optional: bool = False
) -> str | None:
    value = _read_string(obj, key, parent, out, optional=optional, max_length=512)
    if value is None:
        return None
    if not value.startswith(HTTPS_URL_PREFIX):
        out.append(Finding(INVALID_FORMAT, join_path(parent, key), f"{key} must be an https URL"))
        return None
    return value


def _read_schema_version(obj: dict[str, Any], out: list[Finding]) -> int | None:
    path = "/schema_version"
    value = obj.get("schema_version", _MISSING)
    if value is _MISSING:
        out.append(Finding(SCHEMA_VERSION_UNSUPPORTED, path, "schema_version is required"))
        return None
    if value != SKILL_SCHEMA_VERSION or isinstance(value, bool):
        # Fail closed: a future schema_version is rejected, never best-effort parsed.
        out.append(
            Finding(
                SCHEMA_VERSION_UNSUPPORTED,
                path,
                "schema_version is not supported by this build",
                {"supported": SKILL_SCHEMA_VERSION},
            )
        )
        return None
    return SKILL_SCHEMA_VERSION


# =============================================================================
# Skill ID and payload paths
# =============================================================================


def fold_for_collision(name: str) -> str:
    """Fold a name for collision detection: NFKC plus case folding."""
    return unicodedata.normalize("NFKC", name).lower()


def validate_skill_id(value: object, path: str = "/id") -> tuple[str | None, list[Finding]]:
    if not isinstance(value, str) or not value:
        return None, [Finding(ID_INVALID, path, "id must be a non-empty string")]
    if len(value) > SKILL_ID_MAX_LENGTH:
        return None, [
            Finding(ID_INVALID, path, "id exceeds the maximum length", {"maxLength": SKILL_ID_MAX_LENGTH})
        ]
    if not SKILL_ID_PATTERN.match(value):
        return None, [Finding(ID_INVALID, path, "id must be a lowercase ASCII slug")]
    if value in RESERVED_SKILL_IDS:
        return None, [Finding(ID_RESERVED, path, "id is reserved")]
    return value, []


_WINDOWS_DRIVE = ("a", "z")


def validate_payload_path(value: object, path: str) -> tuple[str | None, list[Finding]]:
    """String-level payload path check.

    Rejects everything that could escape the Skill root before any filesystem
    call happens. Real-path and symlink checks belong to the code that owns the
    filesystem, not here.
    """

    def fail(message: str, **detail: object) -> tuple[None, list[Finding]]:
        return None, [Finding(FILE_PATH_UNSAFE, path, message, dict(detail))]

    if not isinstance(value, str) or not value:
        return fail("path must be a non-empty string")
    if len(value) > SKILL_PATH_MAX_LENGTH:
        return fail("path exceeds the maximum length", maxLength=SKILL_PATH_MAX_LENGTH)
    for char in value:
        if ord(char) < 0x20 or ord(char) == 0x7F or char == "\\":
            return fail("path contains a control character or a backslash")
    if value.startswith("/"):
        return fail("path must be relative")
    if len(value) >= 2 and value[1] == ":" and value[0].isascii() and value[0].isalpha():
        return fail("path must be relative")
    if value != unicodedata.normalize("NFC", value):
        return fail("path must be NFC-normalized")
    if "//" in value:
        return fail("path must not contain empty segments")
    if value.endswith("/"):
        return fail("path must not be a directory entry")

    segments = value.split("/")
    if len(segments) > SKILL_PATH_MAX_DEPTH:
        return fail("path is nested too deeply", maxDepth=SKILL_PATH_MAX_DEPTH)
    for segment in segments:
        if segment in (".", ".."):
            return fail('path must not contain "." or ".." segments')
        if len(segment) > SKILL_PATH_SEGMENT_MAX_LENGTH:
            return fail("path segment is too long", maxLength=SKILL_PATH_SEGMENT_MAX_LENGTH)
        if segment != segment.strip():
            return fail("path segment must not be padded with whitespace")
    return value, []


# =============================================================================
# Shared sub-object readers
# =============================================================================


def _read_provider(parent_obj: dict[str, Any], parent: str, out: list[Finding]) -> dict[str, Any] | None:
    path = join_path(parent, "provider")
    raw = parent_obj.get("provider", _MISSING)
    if raw is _MISSING:
        out.append(Finding(MISSING_FIELD, path, "provider is required"))
        return None
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, PROVIDER_FIELDS, path, out)

    name = _read_string(obj, "name", path, out, max_length=SKILL_NAME_MAX_LENGTH)
    url = _read_https_url(obj, "url", path, out, optional=True)
    contact = _read_string(obj, "contact", path, out, optional=True, max_length=200)
    if name is None:
        return None
    provider: dict[str, Any] = {"name": name}
    if url is not None:
        provider["url"] = url
    if contact is not None:
        provider["contact"] = contact
    return provider


def _read_agent_compat(raw: object, path: str, out: list[Finding]) -> dict[str, Any] | None:
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, AGENT_COMPAT_FIELDS, path, out)

    agent = _read_string(obj, "agent", path, out, max_length=40)
    if agent is not None and agent not in CLI_TOOL_IDS:
        out.append(Finding(INVALID_ENUM, join_path(path, "agent"), "agent is not a known CLI tool"))
        return None
    support = _read_enum(obj, "support", path, out, SKILL_AGENT_SUPPORT_VALUES)
    evidence = _read_string(obj, "evidence", path, out, max_length=SKILL_EVIDENCE_MAX_LENGTH)
    if agent is None or support is None or evidence is None:
        return None
    return {"agent": agent, "support": support, "evidence": evidence}


def _read_compatibility(
    parent_obj: dict[str, Any], parent: str, out: list[Finding]
) -> dict[str, Any] | None:
    path = join_path(parent, "compatibility")
    raw = parent_obj.get("compatibility", _MISSING)
    if raw is _MISSING:
        out.append(Finding(MISSING_FIELD, path, "compatibility is required"))
        return None
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, COMPATIBILITY_FIELDS, path, out)

    commandmate = _read_string(obj, "commandmate", path, out, max_length=100)
    if commandmate is not None and not is_valid_version_range(commandmate):
        out.append(
            Finding(
                VERSION_RANGE_INVALID,
                join_path(path, "commandmate"),
                "commandmate is not a supported version range",
            )
        )
        return None

    raw_agents = _read_array(obj, "agents", path, out, max_items=20)
    if commandmate is None or raw_agents is None:
        return None

    agents: list[dict[str, Any]] = []
    seen: set[str] = set()
    failed = False
    for index, item in enumerate(raw_agents):
        item_path = join_path(join_path(path, "agents"), index)
        parsed = _read_agent_compat(item, item_path, out)
        if parsed is None:
            failed = True
            continue
        if parsed["agent"] in seen:
            out.append(Finding(DUPLICATE_ENTRY, item_path, "agent is declared more than once"))
            failed = True
            continue
        seen.add(parsed["agent"])
        agents.append(parsed)
    return None if failed else {"commandmate": commandmate, "agents": agents}


def _read_requirements(
    parent_obj: dict[str, Any], parent: str, out: list[Finding]
) -> dict[str, Any] | None:
    path = join_path(parent, "requirements")
    raw = parent_obj.get("requirements", _MISSING)
    if raw is _MISSING:
        out.append(Finding(MISSING_FIELD, path, "requirements is required"))
        return None
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, REQUIREMENTS_FIELDS, path, out)

    raw_commands = _read_array(obj, "commands", path, out, max_items=SKILL_COMMANDS_MAX_COUNT)
    hosts = _read_string_list(
        obj,
        "network_hosts",
        path,
        out,
        max_items=SKILL_NETWORK_HOSTS_MAX_COUNT,
        max_length=253,
        pattern=NETWORK_HOST_PATTERN,
    )
    if raw_commands is None or hosts is None:
        return None

    commands: list[dict[str, Any]] = []
    failed = False
    for index, item in enumerate(raw_commands):
        item_path = join_path(join_path(path, "commands"), index)
        cmd = _read_object(item, item_path, out)
        if cmd is None:
            failed = True
            continue
        _check_unknown(cmd, COMMAND_FIELDS, item_path, out)
        name = _read_string(cmd, "name", item_path, out, max_length=64, pattern=COMMAND_NAME_PATTERN)
        version_range = _read_string(cmd, "version_range", item_path, out, optional=True, max_length=100)
        if version_range is not None and not is_valid_version_range(version_range):
            out.append(
                Finding(
                    VERSION_RANGE_INVALID,
                    join_path(item_path, "version_range"),
                    "version_range is not a supported version range",
                )
            )
            failed = True
            continue
        if name is None:
            failed = True
            continue
        entry: dict[str, Any] = {"name": name}
        if version_range is not None:
            entry["version_range"] = version_range
        commands.append(entry)
    return None if failed else {"commands": commands, "network_hosts": hosts}


def _read_source(parent_obj: dict[str, Any], parent: str, out: list[Finding]) -> dict[str, Any] | None:
    path = join_path(parent, "source")
    raw = parent_obj.get("source", _MISSING)
    if raw is _MISSING:
        out.append(Finding(MISSING_FIELD, path, "source is required"))
        return None
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, SOURCE_FIELDS, path, out)

    repository = _read_string(obj, "repository", path, out, max_length=140, pattern=REPOSITORY_SLUG_PATTERN)
    ref = _read_string(obj, "ref", path, out, max_length=100, pattern=GIT_REF_PATTERN)
    if ref is not None and ".." in ref:
        out.append(Finding(INVALID_FORMAT, join_path(path, "ref"), 'ref must not contain ".."'))
        return None
    commit = _read_string(
        obj,
        "commit",
        path,
        out,
        min_length=40,
        max_length=40,
        pattern=GIT_COMMIT_SHA_PATTERN,
        format_code=SOURCE_COMMIT_INVALID,
    )
    if repository is None or ref is None or commit is None:
        return None
    return {"repository": repository, "ref": ref, "commit": commit}


def _read_artifact(parent_obj: dict[str, Any], parent: str, out: list[Finding]) -> dict[str, Any] | None:
    path = join_path(parent, "artifact")
    raw = parent_obj.get("artifact", _MISSING)
    if raw is _MISSING:
        out.append(Finding(MISSING_FIELD, path, "artifact is required"))
        return None
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, ARTIFACT_FIELDS, path, out)

    asset_name = _read_string(obj, "asset_name", path, out, max_length=200)
    url = _read_https_url(obj, "url", path, out)
    sha256 = _read_string(
        obj,
        "sha256",
        path,
        out,
        min_length=64,
        max_length=64,
        pattern=SHA256_HEX_PATTERN,
        format_code=DIGEST_INVALID,
    )
    size = _read_integer(obj, "size", path, out, minimum=1, maximum=SKILL_ARTIFACT_MAX_SIZE)
    content_type = _read_string(obj, "content_type", path, out, max_length=100)
    fmt = _read_enum(obj, "format", path, out, (SKILL_ARTIFACT_FORMAT,))

    if content_type is not None and content_type != SKILL_ARTIFACT_CONTENT_TYPE:
        out.append(
            Finding(
                ARTIFACT_INVALID,
                join_path(path, "content_type"),
                "content_type must be the fixed artifact media type",
                {"expected": SKILL_ARTIFACT_CONTENT_TYPE},
            )
        )
        return None
    if None in (asset_name, url, sha256, size, content_type, fmt):
        return None
    return {
        "asset_name": asset_name,
        "url": url,
        "sha256": sha256,
        "size": size,
        "content_type": content_type,
        "format": fmt,
    }


# =============================================================================
# Manifest
# =============================================================================


def _read_file_entries(
    parent_obj: dict[str, Any], parent: str, out: list[Finding]
) -> list[dict[str, Any]] | None:
    path = join_path(parent, "files")
    raw = _read_array(parent_obj, "files", parent, out, max_items=SKILL_FILES_MAX_COUNT)
    if raw is None:
        return None

    entries: list[dict[str, Any]] = []
    seen_folded: set[str] = set()
    failed = False

    for index, item in enumerate(raw):
        item_path = join_path(path, index)
        obj = _read_object(item, item_path, out)
        if obj is None:
            failed = True
            continue
        _check_unknown(obj, FILE_ENTRY_FIELDS, item_path, out)

        file_path, path_findings = validate_payload_path(obj.get("path"), join_path(item_path, "path"))
        sha256 = _read_string(
            obj,
            "sha256",
            item_path,
            out,
            min_length=64,
            max_length=64,
            pattern=SHA256_HEX_PATTERN,
            format_code=DIGEST_INVALID,
        )
        size = _read_integer(obj, "size", item_path, out, minimum=0, maximum=SKILL_FILE_MAX_SIZE)
        kind = _read_enum(obj, "kind", item_path, out, SKILL_FILE_KINDS)
        executable = _read_boolean(obj, "executable", item_path, out)
        script = _read_boolean(obj, "script", item_path, out)

        if file_path is None:
            out.extend(path_findings)
            failed = True
            continue
        if None in (sha256, size, kind, executable, script):
            failed = True
            continue

        if file_path == SKILL_MANIFEST_FILENAME:
            out.append(
                Finding(
                    FILE_SET_MISMATCH,
                    join_path(item_path, "path"),
                    "the manifest must not declare a digest for itself",
                )
            )
            failed = True
            continue
        folded = fold_for_collision(file_path)
        if folded in seen_folded:
            out.append(
                Finding(
                    FILE_PATH_DUPLICATE,
                    join_path(item_path, "path"),
                    "path collides with another declared file",
                )
            )
            failed = True
            continue
        seen_folded.add(folded)
        entries.append(
            {
                "path": file_path,
                "sha256": sha256,
                "size": size,
                "kind": kind,
                "executable": executable,
                "script": script,
            }
        )

    if failed:
        return None

    skill_md = [entry for entry in entries if entry["path"] == SKILL_MD_FILENAME]
    if len(skill_md) != 1:
        out.append(
            Finding(FILE_SET_MISMATCH, path, f"files must declare exactly one {SKILL_MD_FILENAME}")
        )
        return None
    if skill_md[0]["kind"] != "skill_md":
        out.append(
            Finding(
                INCONSISTENT_VALUE,
                path,
                f'{SKILL_MD_FILENAME} must be declared with kind "skill_md"',
            )
        )
        return None
    return entries


def validate_manifest(document: object) -> tuple[dict[str, Any] | None, list[Finding]]:
    """Validate a parsed `commandmate.skill.yaml`."""
    out: list[Finding] = []
    obj = _read_object(document, "", out)
    if obj is None:
        return None, out

    schema_version = _read_schema_version(obj, out)
    if schema_version is None:
        return None, out

    _check_unknown(obj, MANIFEST_FIELDS, "", out)

    skill_id, id_findings = validate_skill_id(obj.get("id"))
    out.extend(id_findings)

    name = _read_string(obj, "name", "", out, max_length=SKILL_NAME_MAX_LENGTH)
    version = _read_string(obj, "version", "", out, max_length=64)
    if version is not None and not is_valid_semver(version):
        out.append(
            Finding(VERSION_INVALID, "/version", 'version must be SemVer 2.0 without a "v" prefix')
        )
    summary = _read_string(obj, "summary", "", out, max_length=SKILL_SUMMARY_MAX_LENGTH)
    description = _read_string(obj, "description", "", out, max_length=SKILL_DESCRIPTION_MAX_LENGTH)
    capabilities = _read_string_list(
        obj, "capabilities", "", out, max_items=SKILL_BULLET_MAX_COUNT, max_length=SKILL_BULLET_MAX_LENGTH
    )
    expected_outcomes = _read_string_list(
        obj,
        "expected_outcomes",
        "",
        out,
        max_items=SKILL_BULLET_MAX_COUNT,
        max_length=SKILL_BULLET_MAX_LENGTH,
    )
    provider = _read_provider(obj, "", out)
    license_id = _read_string(obj, "license", "", out, max_length=64, pattern=SPDX_LICENSE_PATTERN)
    homepage = _read_https_url(obj, "homepage", "", out, optional=True)
    keywords = _read_string_list(
        obj,
        "keywords",
        "",
        out,
        max_items=SKILL_KEYWORDS_MAX_COUNT,
        max_length=SKILL_KEYWORD_MAX_LENGTH,
        optional=True,
    )
    compatibility = _read_compatibility(obj, "", out)
    requirements = _read_requirements(obj, "", out)
    declared_permissions = _read_string_list(
        obj,
        "declared_permissions",
        "",
        out,
        max_items=len(SKILL_DECLARED_PERMISSIONS),
        max_length=40,
    )
    if declared_permissions is not None:
        for index, permission in enumerate(declared_permissions):
            if permission not in SKILL_DECLARED_PERMISSIONS:
                out.append(
                    Finding(
                        INVALID_ENUM,
                        join_path("/declared_permissions", index),
                        "declared permission is not an allowed value",
                    )
                )
    declared_risk = _read_enum(obj, "declared_risk", "", out, SKILL_RISK_LEVELS)
    risk_rationale = _read_string(obj, "risk_rationale", "", out, max_length=SKILL_RATIONALE_MAX_LENGTH)
    files = _read_file_entries(obj, "", out)

    # An install dialog that cannot say what a Skill makes possible is not a
    # dialog the user can consent from, so an empty list is a contract violation.
    if capabilities is not None and not capabilities:
        out.append(Finding(MISSING_FIELD, "/capabilities", "capabilities must not be empty"))
    if expected_outcomes is not None and not expected_outcomes:
        out.append(Finding(MISSING_FIELD, "/expected_outcomes", "expected_outcomes must not be empty"))

    required = (
        skill_id,
        name,
        version,
        summary,
        description,
        capabilities,
        expected_outcomes,
        provider,
        license_id,
        compatibility,
        requirements,
        declared_permissions,
        declared_risk,
        risk_rationale,
        files,
    )
    if out or any(item is None for item in required):
        if not out:
            out.append(Finding(MISSING_FIELD, "", "manifest is incomplete"))
        return None, out

    manifest: dict[str, Any] = {
        "schema_version": schema_version,
        "id": skill_id,
        "name": name,
        "version": version,
        "summary": summary,
        "description": description,
        "capabilities": capabilities,
        "expected_outcomes": expected_outcomes,
        "provider": provider,
        "license": license_id,
    }
    if homepage is not None:
        manifest["homepage"] = homepage
    if keywords is not None:
        manifest["keywords"] = keywords
    manifest.update(
        {
            "compatibility": compatibility,
            "requirements": requirements,
            "declared_permissions": declared_permissions,
            "declared_risk": declared_risk,
            "risk_rationale": risk_rationale,
            "files": files,
        }
    )
    return manifest, out


# =============================================================================
# Catalog
# =============================================================================


def _read_catalog_version(
    raw: object, path: str, skill_id: str, out: list[Finding]
) -> dict[str, Any] | None:
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, CATALOG_VERSION_FIELDS, path, out)

    version = _read_string(obj, "version", path, out, max_length=64)
    if version is not None and not is_valid_semver(version):
        out.append(Finding(VERSION_INVALID, join_path(path, "version"), "version must be SemVer 2.0"))
        return None
    changelog = _read_string(obj, "changelog", path, out, max_length=SKILL_CHANGELOG_MAX_LENGTH)
    published_at = _read_string(obj, "published_at", path, out, max_length=30, pattern=RFC3339_UTC_PATTERN)
    source = _read_source(obj, path, out)
    artifact = _read_artifact(obj, path, out)
    compatibility = _read_compatibility(obj, path, out)
    declared_risk = _read_enum(obj, "declared_risk", path, out, SKILL_RISK_LEVELS)

    if None in (version, changelog, published_at, source, artifact, compatibility, declared_risk):
        return None

    expected_asset = build_skill_asset_name(skill_id, version)  # type: ignore[arg-type]
    if artifact["asset_name"] != expected_asset:  # type: ignore[index]
        out.append(
            Finding(
                ARTIFACT_INVALID,
                join_path(join_path(path, "artifact"), "asset_name"),
                "asset_name must follow the <skill-id>-<version>.tar.gz convention",
                {"expected": expected_asset},
            )
        )
        return None

    return {
        "version": version,
        "changelog": changelog,
        "published_at": published_at,
        "source": source,
        "artifact": artifact,
        "compatibility": compatibility,
        "declared_risk": declared_risk,
    }


def _read_catalog_entry(raw: object, path: str, out: list[Finding]) -> dict[str, Any] | None:
    obj = _read_object(raw, path, out)
    if obj is None:
        return None
    _check_unknown(obj, CATALOG_ENTRY_FIELDS, path, out)

    skill_id, id_findings = validate_skill_id(obj.get("id"), join_path(path, "id"))
    if skill_id is None:
        out.extend(id_findings)
        return None

    name = _read_string(obj, "name", path, out, max_length=SKILL_NAME_MAX_LENGTH)
    summary = _read_string(obj, "summary", path, out, max_length=SKILL_SUMMARY_MAX_LENGTH)
    provider = _read_provider(obj, path, out)
    license_id = _read_string(obj, "license", path, out, max_length=64, pattern=SPDX_LICENSE_PATTERN)
    homepage = _read_https_url(obj, "homepage", path, out, optional=True)
    keywords = _read_string_list(
        obj,
        "keywords",
        path,
        out,
        max_items=SKILL_KEYWORDS_MAX_COUNT,
        max_length=SKILL_KEYWORD_MAX_LENGTH,
        optional=True,
    )
    latest = _read_string(obj, "latest", path, out, max_length=64)
    raw_versions = _read_array(obj, "versions", path, out, max_items=SKILL_CATALOG_VERSIONS_MAX_COUNT)

    if None in (name, summary, provider, license_id, latest, raw_versions):
        return None
    if not raw_versions:
        out.append(Finding(MISSING_FIELD, join_path(path, "versions"), "versions must not be empty"))
        return None

    versions: list[dict[str, Any]] = []
    seen: set[str] = set()
    failed = False
    for index, item in enumerate(raw_versions):
        item_path = join_path(join_path(path, "versions"), index)
        parsed = _read_catalog_version(item, item_path, skill_id, out)
        if parsed is None:
            failed = True
            continue
        if parsed["version"] in seen:
            out.append(Finding(DUPLICATE_ENTRY, item_path, "version is listed more than once"))
            failed = True
            continue
        seen.add(parsed["version"])
        versions.append(parsed)
    if failed:
        return None

    if latest not in seen:
        out.append(
            Finding(
                CATALOG_LATEST_UNRESOLVED,
                join_path(path, "latest"),
                "latest must reference a listed version",
            )
        )
        return None

    entry: dict[str, Any] = {
        "id": skill_id,
        "name": name,
        "summary": summary,
        "provider": provider,
        "license": license_id,
    }
    if homepage is not None:
        entry["homepage"] = homepage
    if keywords is not None:
        entry["keywords"] = keywords
    entry["latest"] = latest
    entry["versions"] = versions
    return entry


def validate_catalog(document: object) -> tuple[dict[str, Any] | None, list[Finding]]:
    """Validate a parsed Catalog document."""
    out: list[Finding] = []
    obj = _read_object(document, "", out)
    if obj is None:
        return None, out

    schema_version = _read_schema_version(obj, out)
    if schema_version is None:
        return None, out

    _check_unknown(obj, CATALOG_FIELDS, "", out)

    raw_entries = _read_array(obj, "entries", "", out, max_items=SKILL_CATALOG_ENTRIES_MAX_COUNT)
    if raw_entries is None:
        return None, out

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_entries):
        item_path = join_path("/entries", index)
        parsed = _read_catalog_entry(item, item_path, out)
        if parsed is None:
            continue
        folded = fold_for_collision(parsed["id"])
        if folded in seen:
            out.append(Finding(ID_COLLISION, item_path, "entry id collides with another entry"))
            continue
        seen.add(folded)
        entries.append(parsed)

    if out:
        return None, out
    return {"schema_version": schema_version, "entries": entries}, out


# =============================================================================
# Cross-document rules
# =============================================================================


def validate_manifest_file_set(
    manifest: dict[str, Any], payload_paths: Iterable[str]
) -> list[Finding]:
    """Compare the manifest's declared file set with the package's payload set.

    The comparison set is every regular payload file in the archive minus the
    manifest itself and minus directory entries. The manifest's own integrity is
    covered by the Catalog artifact digest, so it declares no self-digest.
    """
    declared = {entry["path"] for entry in manifest["files"]}
    actual = {path for path in payload_paths if path != SKILL_MANIFEST_FILENAME}

    out: list[Finding] = []
    for path in sorted(declared - actual):
        out.append(
            Finding(FILE_SET_MISMATCH, "/files", "declared file is absent from the package", {"path": path})
        )
    for path in sorted(actual - declared):
        out.append(
            Finding(FILE_SET_MISMATCH, "/files", "package contains an undeclared file", {"path": path})
        )
    return out


def resolve_effective_risk(declared: str, computed: str) -> str:
    """The effective risk shown to the user: the higher of the two inputs."""
    return computed if SKILL_RISK_ORDER[computed] > SKILL_RISK_ORDER[declared] else declared


def compute_risk(
    *,
    executable_paths: Iterable[str],
    script_paths: Iterable[str],
    network_hosts: Iterable[str],
    declared_permissions: Iterable[str],
) -> str:
    """Derive the risk CommandMate computes, independent of the publisher's claim."""
    permissions = set(declared_permissions)
    if list(executable_paths) or "credential_access" in permissions:
        return "high"
    if (
        list(script_paths)
        or list(network_hosts)
        or "process_execution" in permissions
        or "filesystem_write" in permissions
    ):
        return "moderate"
    return "low"
