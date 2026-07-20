"""Reading and checking a Skill package as it sits in the working tree.

Everything here answers one question: *would CommandMate accept the artifact this
directory builds into?* The checks therefore run against the same file set the
build will pack, in the same order, so a green CI run and a successful install
cannot disagree.
"""

from __future__ import annotations

import os
import re
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .constants import (
    INSTRUCTION_EXTENSIONS,
    SKILL_ARTIFACT_MAX_SIZE,
    SKILL_FILE_MAX_SIZE,
    SKILL_MANIFEST_FILENAME,
    SKILL_MD_FILENAME,
    SKILL_SCRIPT_EXTENSIONS,
)
from .errors import ContractError, Finding
from .package import PayloadFile, build_artifact, read_package, sha256_hex
from .safe_yaml import SkillYamlError, parse_skill_frontmatter, parse_skill_yaml
from .schema import (
    compute_risk,
    resolve_effective_risk,
    validate_manifest,
    validate_manifest_file_set,
    validate_payload_path,
)

# Codes owned by this repository's CI rather than by the distribution contract.
TREE_ENTRY_FORBIDDEN = "SKILLS_TREE_ENTRY_FORBIDDEN"
TREE_MODE_FORBIDDEN = "SKILLS_TREE_MODE_FORBIDDEN"
MANIFEST_UNREADABLE = "SKILLS_MANIFEST_UNREADABLE"
SKILL_MD_INVALID = "SKILLS_SKILL_MD_INVALID"
DECLARATION_MISMATCH = "SKILLS_DECLARATION_MISMATCH"
SECRET_DETECTED = "SKILLS_SECRET_DETECTED"
LINK_INSECURE = "SKILLS_LINK_INSECURE"
LICENSE_MISSING = "SKILLS_LICENSE_MISSING"
ARTIFACT_TOO_LARGE = "SKILLS_ARTIFACT_TOO_LARGE"
RISK_UNDERSTATED = "SKILLS_RISK_UNDERSTATED"

#: Files that describe the package to this repository but are not part of the
#: distributed payload. Anything else in a Skill directory ships.
NON_PAYLOAD_NAMES = frozenset({".gitkeep", ".DS_Store"})


@dataclass
class PackageCheck:
    """Outcome of checking one Skill directory."""

    skill_id: str
    directory: Path
    findings: list[Finding]
    manifest: dict[str, Any] | None = None
    payload: list[PayloadFile] | None = None

    @property
    def ok(self) -> bool:
        return not self.findings


# =============================================================================
# Tree reading
# =============================================================================


def discover_skill_dirs(root: Path) -> list[Path]:
    """Skill directories under `root`, in a stable order.

    A directory holding only placeholders (`.gitkeep`) is a reserved slot for a
    Skill that has not been written yet, not a broken package, so it is skipped.
    """
    if not root.is_dir():
        return []
    found: list[Path] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.is_symlink():
            continue
        contents = {entry.name for entry in child.iterdir()}
        if contents <= NON_PAYLOAD_NAMES:
            continue
        found.append(child)
    return found


def read_tree(directory: Path, out: list[Finding]) -> list[PayloadFile] | None:
    """Read a Skill directory into the payload set the build will pack.

    Rejects anything that is not a regular file or a directory *before* reading
    it: a symlink's target and a FIFO's contents are decided by something other
    than the repository, and neither belongs in a distributed artifact.
    """
    payload: list[PayloadFile] = []
    failed = False

    for current_root, dir_names, file_names in os.walk(directory):
        dir_names.sort()
        current = Path(current_root)

        for name in sorted(dir_names):
            entry = current / name
            if entry.is_symlink():
                out.append(
                    Finding(
                        TREE_ENTRY_FORBIDDEN,
                        _rel(entry, directory),
                        "symlinked directories are not allowed in a Skill package",
                    )
                )
                failed = True

        for name in sorted(file_names):
            entry = current / name
            relative = _rel(entry, directory)
            if name in NON_PAYLOAD_NAMES:
                continue

            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode):
                out.append(
                    Finding(TREE_ENTRY_FORBIDDEN, relative, "symlinks are not allowed in a Skill package")
                )
                failed = True
                continue
            if not stat.S_ISREG(info.st_mode):
                out.append(
                    Finding(
                        TREE_ENTRY_FORBIDDEN,
                        relative,
                        "only regular files and directories may be packaged",
                    )
                )
                failed = True
                continue
            if info.st_nlink != 1:
                out.append(Finding(TREE_ENTRY_FORBIDDEN, relative, "hardlinked files are not allowed"))
                failed = True
                continue
            if info.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
                out.append(
                    Finding(TREE_MODE_FORBIDDEN, relative, "setuid, setgid and sticky bits are not allowed")
                )
                failed = True
                continue
            if info.st_size > SKILL_FILE_MAX_SIZE:
                out.append(
                    Finding(
                        TREE_ENTRY_FORBIDDEN,
                        relative,
                        "payload file exceeds the size limit",
                        {"maxSize": SKILL_FILE_MAX_SIZE},
                    )
                )
                failed = True
                continue

            validated, path_findings = validate_payload_path(relative, relative)
            if validated is None:
                out.extend(path_findings)
                failed = True
                continue

            payload.append(
                PayloadFile(
                    path=validated,
                    data=entry.read_bytes(),
                    executable=bool(info.st_mode & 0o111),
                )
            )

    return None if failed else payload


def _rel(entry: Path, root: Path) -> str:
    relative = entry.relative_to(root).as_posix()
    return unicodedata.normalize("NFC", relative)


# =============================================================================
# Classification (mirrors package-validator.ts)
# =============================================================================


def _extension(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    dot = base.rfind(".")
    return "" if dot <= 0 else base[dot:].lower()


def is_script_payload(path: str, data: bytes) -> bool:
    """Whether a payload file is an interpreted script, by extension or shebang.

    Deliberately over-broad: a file wrongly called a script only forces the
    publisher to declare it, while a missed one would ship an interpreted payload
    the user never saw listed.
    """
    if _extension(path) in SKILL_SCRIPT_EXTENSIONS:
        return True
    return len(data) >= 2 and data[0] == 0x23 and data[1] == 0x21


def derive_file_kind(path: str, data: bytes) -> str:
    if path == SKILL_MD_FILENAME:
        return "skill_md"
    if is_script_payload(path, data):
        return "script"
    return "instruction" if _extension(path) in INSTRUCTION_EXTENSIONS else "asset"


# =============================================================================
# Secret / link / license checks
# =============================================================================

#: High-signal credential shapes. Deliberately not a general entropy heuristic:
#: a scan that cries wolf gets muted, and a muted scan catches nothing.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    ("github-token", re.compile(rb"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("github-fine-grained-pat", re.compile(rb"github_pat_[A-Za-z0-9_]{60,}")),
    ("aws-access-key-id", re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("private-key-block", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("slack-token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("google-api-key", re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai-key", re.compile(rb"\bsk-[A-Za-z0-9]{32,}\b")),
    ("npm-token", re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b")),
    ("jwt", re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
)


def scan_for_secrets(payload: Iterable[PayloadFile], out: list[Finding]) -> None:
    for entry in payload:
        for label, pattern in _SECRET_PATTERNS:
            if pattern.search(entry.data):
                # The match itself is never echoed: printing it would move the
                # secret from a package into a public CI log.
                out.append(
                    Finding(
                        SECRET_DETECTED,
                        entry.path,
                        "file matches a known credential pattern",
                        {"pattern": label},
                    )
                )


_URL_RE = re.compile(rb"(?<![\w.])(https?)://[^\s\)\]\"'<>`]+")


def check_links(payload: Iterable[PayloadFile], out: list[Finding]) -> None:
    """Every absolute link a Skill ships must be `https`.

    A Skill's instructions are read by an Agent that may follow them, so a
    plaintext URL is an instruction to fetch something an on-path attacker can
    rewrite.
    """
    for entry in payload:
        for match in _URL_RE.finditer(entry.data):
            if match.group(1) == b"http":
                out.append(
                    Finding(
                        LINK_INSECURE,
                        entry.path,
                        "package contains a plaintext http:// URL",
                        {"url": match.group(0).decode("utf-8", "replace")[:120]},
                    )
                )


def check_license(manifest: dict[str, Any], repo_root: Path, out: list[Finding]) -> None:
    if not (repo_root / "LICENSE").is_file():
        out.append(Finding(LICENSE_MISSING, "LICENSE", "repository LICENSE file is missing"))
    # `license` is already SPDX-shaped by the schema; what is checked here is that
    # the declaration is not silently absent from what the Skill itself ships.
    if not manifest.get("license"):
        out.append(
            Finding(LICENSE_MISSING, "/license", "manifest does not declare an SPDX license identifier")
        )


# =============================================================================
# Whole-package check
# =============================================================================


def check_package(directory: Path, repo_root: Path) -> PackageCheck:
    """Validate one Skill directory end to end.

    Order matters: the manifest is parsed under the safe profile first, because
    every later comparison is against what the manifest *says*, and a manifest
    that CommandMate would refuse to parse makes those comparisons meaningless.
    """
    findings: list[Finding] = []
    skill_id = directory.name

    payload = read_tree(directory, findings)
    if payload is None:
        return PackageCheck(skill_id, directory, findings)

    manifest_entry = next((f for f in payload if f.path == SKILL_MANIFEST_FILENAME), None)
    skill_md_entry = next((f for f in payload if f.path == SKILL_MD_FILENAME), None)
    if manifest_entry is None:
        findings.append(Finding(MANIFEST_UNREADABLE, SKILL_MANIFEST_FILENAME, "manifest is missing"))
    if skill_md_entry is None:
        findings.append(Finding(SKILL_MD_INVALID, SKILL_MD_FILENAME, "SKILL.md is missing"))
    if manifest_entry is None or skill_md_entry is None:
        return PackageCheck(skill_id, directory, findings, payload=payload)

    try:
        document = parse_skill_yaml(manifest_entry.data)
    except SkillYamlError as error:
        findings.append(Finding(error.code, SKILL_MANIFEST_FILENAME, str(error)))
        return PackageCheck(skill_id, directory, findings, payload=payload)

    manifest, schema_findings = validate_manifest(document)
    findings.extend(schema_findings)
    if manifest is None:
        return PackageCheck(skill_id, directory, findings, payload=payload)

    _check_identity(manifest, skill_id, skill_md_entry, findings)
    _check_file_set(manifest, payload, findings)
    _check_risk(manifest, findings)
    scan_for_secrets(payload, findings)
    check_links(payload, findings)
    check_license(manifest, repo_root, findings)

    return PackageCheck(skill_id, directory, findings, manifest=manifest, payload=payload)


def _check_identity(
    manifest: dict[str, Any], skill_id: str, skill_md: PayloadFile, out: list[Finding]
) -> None:
    """Directory name, manifest id and SKILL.md frontmatter must all agree.

    Disagreement is what lets a package install under a name the user never
    reviewed, so it is a rejection rather than a normalization.
    """
    if manifest["id"] != skill_id:
        out.append(
            Finding(
                DECLARATION_MISMATCH,
                "/id",
                "manifest id does not match the directory name",
                {"directory": skill_id, "manifest": manifest["id"]},
            )
        )

    try:
        frontmatter = parse_skill_frontmatter(skill_md.data.decode("utf-8"))
    except (SkillYamlError, UnicodeDecodeError) as error:
        out.append(Finding(SKILL_MD_INVALID, SKILL_MD_FILENAME, f"frontmatter does not parse: {error}"))
        return
    if not isinstance(frontmatter, dict):
        out.append(Finding(SKILL_MD_INVALID, SKILL_MD_FILENAME, "SKILL.md has no YAML frontmatter"))
        return
    name = frontmatter.get("name")
    if not isinstance(name, str):
        out.append(Finding(SKILL_MD_INVALID, SKILL_MD_FILENAME, "frontmatter has no string name"))
        return
    if name != manifest["name"]:
        out.append(
            Finding(
                DECLARATION_MISMATCH,
                SKILL_MD_FILENAME,
                "SKILL.md frontmatter name does not match the manifest name",
                {"frontmatter": name, "manifest": manifest["name"]},
            )
        )
    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        out.append(
            Finding(
                SKILL_MD_INVALID,
                SKILL_MD_FILENAME,
                "frontmatter needs a non-empty description for Agent discovery",
            )
        )


def _check_file_set(manifest: dict[str, Any], payload: list[PayloadFile], out: list[Finding]) -> None:
    out.extend(validate_manifest_file_set(manifest, [entry.path for entry in payload]))

    declared_by_path = {entry["path"]: entry for entry in manifest["files"]}
    for entry in payload:
        if entry.path == SKILL_MANIFEST_FILENAME:
            continue
        declared = declared_by_path.get(entry.path)
        if declared is None:
            continue  # already reported by the file-set comparison

        actual_sha = sha256_hex(entry.data)
        if declared["sha256"] != actual_sha:
            out.append(
                Finding(DECLARATION_MISMATCH, entry.path, "declared sha256 does not match the file")
            )
        if declared["size"] != len(entry.data):
            out.append(
                Finding(
                    DECLARATION_MISMATCH,
                    entry.path,
                    "declared size does not match the file",
                    {"declared": declared["size"], "actual": len(entry.data)},
                )
            )

        derived_kind = derive_file_kind(entry.path, entry.data)
        is_script = is_script_payload(entry.path, entry.data)
        if is_script and (not declared["script"] or declared["kind"] != "script"):
            out.append(
                Finding(DECLARATION_MISMATCH, entry.path, "file is a script but is not declared as one")
            )
        if declared["kind"] == "script" and not declared["script"]:
            out.append(
                Finding(DECLARATION_MISMATCH, entry.path, 'kind is "script" but script is false')
            )
        if (derived_kind == "skill_md") != (declared["kind"] == "skill_md"):
            out.append(Finding(DECLARATION_MISMATCH, entry.path, "declared kind does not match the file"))
        if entry.executable and not declared["executable"]:
            out.append(
                Finding(DECLARATION_MISMATCH, entry.path, "file is executable but is not declared as one")
            )
        if not entry.executable and declared["executable"]:
            out.append(
                Finding(DECLARATION_MISMATCH, entry.path, "file is declared executable but is not")
            )


def _check_risk(manifest: dict[str, Any], out: list[Finding]) -> None:
    """A publisher may over-state risk but never under-state it.

    CommandMate computes the effective risk as `max(declared, computed)` anyway,
    so an under-statement is not a security hole; it is a package whose review
    text will not match what the user is shown, which is caught here instead.
    """
    computed = compute_risk(
        executable_paths=[f["path"] for f in manifest["files"] if f["executable"]],
        script_paths=[f["path"] for f in manifest["files"] if f["script"]],
        network_hosts=manifest["requirements"]["network_hosts"],
        declared_permissions=manifest["declared_permissions"],
    )
    effective = resolve_effective_risk(manifest["declared_risk"], computed)
    if effective != manifest["declared_risk"]:
        out.append(
            Finding(
                RISK_UNDERSTATED,
                "/declared_risk",
                "declared_risk is lower than the risk CommandMate computes",
                {"declared": manifest["declared_risk"], "computed": computed},
            )
        )


# =============================================================================
# Build + read-back
# =============================================================================


def build_and_verify(check: PackageCheck) -> bytes:
    """Build the artifact and parse it back through the strict reader.

    Building without reading back would only prove that `tarfile` can write a
    file. Reading back with the same refusals CommandMate applies is what makes a
    green pipeline a prediction about the install rather than about the build.

    :raises ContractError: when the artifact this package builds into would be
        refused, which is a release-blocking condition.
    """
    assert check.manifest is not None and check.payload is not None
    skill_id = check.manifest["id"]
    version = check.manifest["version"]

    artifact = build_artifact(skill_id, check.payload)
    if len(artifact) > SKILL_ARTIFACT_MAX_SIZE:
        raise ContractError(ARTIFACT_TOO_LARGE, "artifact exceeds the size limit", size=len(artifact))

    table = read_package(artifact, skill_id, version)
    if table.root_name != skill_id:
        raise ContractError(
            "SKILL_PACKAGE_LAYOUT_INVALID", "archive root is not the skill id", root=str(table.root_name)
        )

    round_trip = validate_manifest_file_set(check.manifest, [entry.path for entry in table.files])
    if round_trip:
        raise ContractError("SKILL_PACKAGE_MANIFEST_MISMATCH", str(round_trip[0]))
    for entry in table.files:
        if entry.path == SKILL_MANIFEST_FILENAME:
            continue
        declared = next(f for f in check.manifest["files"] if f["path"] == entry.path)
        if declared["sha256"] != entry.sha256 or declared["size"] != entry.size:
            raise ContractError("SKILL_PACKAGE_DIGEST_MISMATCH", "read-back disagrees with the manifest")
        if declared["executable"] != entry.executable:
            raise ContractError(
                "SKILL_PACKAGE_MANIFEST_MISMATCH", "read-back executable bit disagrees", entry=entry.path
            )
    return artifact
