"""Reproducible artifact build and strict artifact read-back.

Two halves of the same guarantee:

- :func:`build_artifact` writes a `tar.gz` whose bytes are a pure function of the
  package's *content*. Entry order, timestamps, ownership and modes are all
  normalized, so a second build on a different runner at a different time
  produces a byte-identical file. That is what makes the digest in the Catalog
  mean "this source", not "that build machine at that moment".
- :func:`read_package` parses the result back with the same refusals
  CommandMate's reader applies (`src/lib/skills/package-reader.ts`), so a package
  that CommandMate would reject fails in this repository's CI instead of on a
  user's machine.

The reader is deliberately hand-rolled rather than delegated to `tarfile`: a
general-purpose extractor decides for itself what a symlink, a hardlink or a
`..` component means, and those are exactly the decisions that have to be ours.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import tarfile
import zlib
from dataclasses import dataclass, field

from .constants import (
    DIRECTORY_MODE,
    EXECUTABLE_FILE_MODE,
    FILE_MODE,
    GZIP_COMPRESS_LEVEL,
    REPRODUCIBLE_GID,
    REPRODUCIBLE_GNAME,
    REPRODUCIBLE_MTIME,
    REPRODUCIBLE_UID,
    REPRODUCIBLE_UNAME,
    SKILL_FILE_MAX_SIZE,
    SKILL_FILES_MAX_COUNT,
    SKILL_MANIFEST_FILENAME,
    SKILL_PACKAGE_MAX_COMPRESSION_RATIO,
    SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES,
    SKILL_PACKAGE_MAX_ENTRIES,
    SKILL_PACKAGE_RATIO_FLOOR_BYTES,
)
from .errors import ContractError
from .schema import fold_for_collision, validate_payload_path

TAR_BLOCK_SIZE = 512

# Codes match `SkillPackageErrorCode` upstream so a rejection reads the same on
# both sides of the boundary.
ARCHIVE_FORMAT = "SKILL_PACKAGE_ARCHIVE_FORMAT"
ARCHIVE_TRUNCATED = "SKILL_PACKAGE_ARCHIVE_TRUNCATED"
ENTRY_TYPE_FORBIDDEN = "SKILL_PACKAGE_ENTRY_TYPE_FORBIDDEN"
ENTRY_PATH_UNSAFE = "SKILL_PACKAGE_ENTRY_PATH_UNSAFE"
ENTRY_DUPLICATE = "SKILL_PACKAGE_ENTRY_DUPLICATE"
ENTRY_COLLISION = "SKILL_PACKAGE_ENTRY_COLLISION"
ENTRY_MODE_FORBIDDEN = "SKILL_PACKAGE_ENTRY_MODE_FORBIDDEN"
ENTRY_LIMIT_EXCEEDED = "SKILL_PACKAGE_ENTRY_LIMIT_EXCEEDED"
SIZE_LIMIT_EXCEEDED = "SKILL_PACKAGE_SIZE_LIMIT_EXCEEDED"
COMPRESSION_RATIO_EXCEEDED = "SKILL_PACKAGE_COMPRESSION_RATIO_EXCEEDED"
LAYOUT_INVALID = "SKILL_PACKAGE_LAYOUT_INVALID"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# =============================================================================
# Build
# =============================================================================


@dataclass(frozen=True)
class PayloadFile:
    """One regular file destined for an artifact."""

    #: Package-relative POSIX path, e.g. `references/format.md`.
    path: str
    data: bytes
    executable: bool = False


def build_artifact(skill_id: str, files: list[PayloadFile]) -> bytes:
    """Build a reproducible `tar.gz` for one Skill package.

    Normalizations that make the output a function of the content alone:

    - entries sorted by path, directories emitted before the files under them;
    - `mtime` fixed, `uid`/`gid` zeroed and `uname`/`gname` emptied, so nothing
      about the runner's account or clock reaches the artifact;
    - modes reduced to exactly three values, so a contributor's umask cannot
      change the digest;
    - `USTAR` format, so no PAX extension record carries a timestamp with more
      precision than the format needs;
    - gzip written with a fixed level and a zeroed header `MTIME`/`FNAME`.

    The archive root is the single `<skill-id>/` directory the contract allows.
    """
    if not files:
        raise ContractError(LAYOUT_INVALID, "package has no payload files")

    by_path: dict[str, PayloadFile] = {}
    for entry in files:
        path, findings = validate_payload_path(entry.path, "/entry")
        if path is None:
            raise ContractError(ENTRY_PATH_UNSAFE, findings[0].message, entry=entry.path)
        if path in by_path:
            raise ContractError(ENTRY_DUPLICATE, "path appears twice", entry=path)
        if len(entry.data) > SKILL_FILE_MAX_SIZE:
            raise ContractError(SIZE_LIMIT_EXCEEDED, "payload file is too large", entry=path)
        by_path[path] = entry

    payload_count = len([path for path in by_path if path != SKILL_MANIFEST_FILENAME])
    if payload_count > SKILL_FILES_MAX_COUNT:
        raise ContractError(ENTRY_LIMIT_EXCEEDED, "too many payload files", limit=SKILL_FILES_MAX_COUNT)

    directories: set[str] = set()
    for path in by_path:
        parts = path.split("/")[:-1]
        walked = ""
        for segment in parts:
            walked = segment if not walked else f"{walked}/{segment}"
            directories.add(walked)

    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        tar.addfile(_directory_info(skill_id))
        for directory in sorted(directories):
            tar.addfile(_directory_info(f"{skill_id}/{directory}"))
        for path in sorted(by_path):
            entry = by_path[path]
            info = tarfile.TarInfo(f"{skill_id}/{path}")
            info.type = tarfile.REGTYPE
            info.size = len(entry.data)
            info.mode = EXECUTABLE_FILE_MODE if entry.executable else FILE_MODE
            _normalize(info)
            tar.addfile(info, io.BytesIO(entry.data))

    out = io.BytesIO()
    # `filename=''` matters: GzipFile otherwise copies `fileobj.name` into the
    # header, which would make the digest depend on where the build ran.
    with gzip.GzipFile(
        filename="", mode="wb", fileobj=out, compresslevel=GZIP_COMPRESS_LEVEL, mtime=REPRODUCIBLE_MTIME
    ) as gz:
        gz.write(tar_bytes.getvalue())
    return out.getvalue()


def _directory_info(name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.size = 0
    info.mode = DIRECTORY_MODE
    _normalize(info)
    return info


def _normalize(info: tarfile.TarInfo) -> None:
    info.mtime = REPRODUCIBLE_MTIME
    info.uid = REPRODUCIBLE_UID
    info.gid = REPRODUCIBLE_GID
    info.uname = REPRODUCIBLE_UNAME
    info.gname = REPRODUCIBLE_GNAME


# =============================================================================
# Read back
# =============================================================================


@dataclass(frozen=True)
class PackageEntry:
    path: str
    size: int
    sha256: str
    executable: bool
    data: bytes


@dataclass(frozen=True)
class PackageTable:
    root_name: str | None
    files: list[PackageEntry] = field(default_factory=list)
    directories: list[str] = field(default_factory=list)
    compressed_size: int = 0
    decompressed_size: int = 0

    def find(self, path: str) -> PackageEntry | None:
        for entry in self.files:
            if entry.path == path:
                return entry
        return None


@dataclass(frozen=True)
class _RawEntry:
    name: str
    is_directory: bool
    mode: int
    size: int
    data: bytes


def _read_field(block: bytes, offset: int, length: int) -> str:
    chunk = block[offset : offset + length]
    end = chunk.find(b"\0")
    if end == -1:
        end = len(chunk)
    # A name that continues past its own terminator is a header hand-built to be
    # read one way by one parser and another way by the next.
    if any(byte != 0 for byte in chunk[end:]):
        raise ContractError(ARCHIVE_FORMAT, "tar field has non-NUL padding", field="padding")
    try:
        return chunk[:end].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ContractError(ARCHIVE_FORMAT, "tar field is not UTF-8", field="encoding") from exc


_NUMERIC_PADDING = (0x00, 0x20)


def _read_octal(block: bytes, offset: int, length: int) -> int:
    """Read an octal numeric field, refusing anything two readers could disagree on.

    A numeric field is padding, then octal digits, then padding. Every other tar
    implementation stops at the first NUL or space; digits *after* a terminator
    are therefore read by nobody else, which makes them a way to give one reader
    a `size` of 0 and another a `size` of 1024 from the same header. Since `size`
    decides where the next header starts, the two readers then walk entirely
    different entry streams and one of them never sees the smuggled entry at all.

    So the terminator is honoured, and anything past it must be padding. This is
    stricter than CommandMate's reader on purpose: the safe direction for a
    mirror is to refuse packages the consumer would accept, never the reverse.
    """
    if block[offset] & 0x80:
        # GNU base-256 is refused rather than decoded: every value this reader
        # cares about is bounded far below the point where it would be needed.
        raise ContractError(ARCHIVE_FORMAT, "tar numeric field uses base-256", field="numeric-encoding")

    field = block[offset : offset + length]
    index = 0
    while index < length and field[index] in _NUMERIC_PADDING:
        index += 1
    start = index
    while index < length and 0x30 <= field[index] <= 0x37:
        index += 1
    digits = field[start:index]
    for byte in field[index:]:
        if byte not in _NUMERIC_PADDING:
            raise ContractError(
                ARCHIVE_FORMAT, "tar numeric field has content past its terminator", field="numeric"
            )
    return int(digits, 8) if digits else 0


def _verify_checksum(block: bytes, declared: int) -> None:
    unsigned = 0
    signed = 0
    for index in range(TAR_BLOCK_SIZE):
        byte = 0x20 if 148 <= index < 156 else block[index]
        unsigned += byte
        signed += byte - 256 if byte > 127 else byte
    if declared not in (unsigned, signed):
        raise ContractError(ARCHIVE_FORMAT, "tar header checksum does not verify", field="checksum")


def _read_tar_entries(tar: bytes) -> list[_RawEntry]:
    if not tar or len(tar) % TAR_BLOCK_SIZE != 0:
        raise ContractError(ARCHIVE_TRUNCATED, "tar stream is not block-aligned", field="alignment")

    entries: list[_RawEntry] = []
    offset = 0
    while offset + TAR_BLOCK_SIZE <= len(tar):
        header = tar[offset : offset + TAR_BLOCK_SIZE]
        if not any(header):
            if any(tar[offset:]):
                raise ContractError(ARCHIVE_FORMAT, "tar trailer is not all zeros", field="trailer")
            return entries

        _verify_checksum(header, _read_octal(header, 148, 8))

        # POSIX writes `ustar\0`, GNU writes `ustar `; both are this format.
        if _read_field(header, 257, 6).strip() != "ustar":
            raise ContractError(ARCHIVE_FORMAT, "tar entry is not ustar", field="magic")

        typeflag = _read_field(header, 156, 1) or "\0"
        is_directory = typeflag == "5"
        if not is_directory and typeflag not in ("0", "\0"):
            raise ContractError(ENTRY_TYPE_FORBIDDEN, "entry is not a regular file or directory")
        if _read_field(header, 157, 100) != "":
            raise ContractError(ENTRY_TYPE_FORBIDDEN, "entry carries a link target")

        mode = _read_octal(header, 100, 8)
        if mode & 0o7000:
            raise ContractError(
                ENTRY_MODE_FORBIDDEN, "entry carries setuid, setgid or sticky bits", bits=oct(mode & 0o7000)
            )

        prefix = _read_field(header, 345, 155)
        name = _read_field(header, 0, 100)
        full_name = name if prefix == "" else f"{prefix}/{name}"

        size = _read_octal(header, 124, 12)
        if is_directory and size != 0:
            raise ContractError(ARCHIVE_FORMAT, "directory entry declares a size", field="directory-size")
        if size > SKILL_FILE_MAX_SIZE:
            raise ContractError(SIZE_LIMIT_EXCEEDED, "entry exceeds the file size limit")

        content_start = offset + TAR_BLOCK_SIZE
        content_end = content_start + size
        if content_end > len(tar):
            raise ContractError(ARCHIVE_TRUNCATED, "entry content runs past the end of the stream")

        entries.append(
            _RawEntry(
                name=full_name,
                is_directory=is_directory,
                mode=mode,
                size=size,
                data=b"" if is_directory else tar[content_start:content_end],
            )
        )
        if len(entries) > SKILL_PACKAGE_MAX_ENTRIES:
            raise ContractError(ENTRY_LIMIT_EXCEEDED, "too many archive entries")

        offset = content_start + ((size + TAR_BLOCK_SIZE - 1) // TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE

    # A well-formed archive ends with zero blocks; running off the end does not.
    raise ContractError(ARCHIVE_TRUNCATED, "tar stream has no trailer", field="trailer")


def _decompress_bounded(artifact: bytes) -> bytes:
    """Inflate with a hard output cap.

    The cap is enforced *during* inflation rather than after it, so a small
    artifact that expands to gigabytes is refused instead of being materialized
    first and measured second.
    """
    stream = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    chunks: list[bytes] = []
    produced = 0
    try:
        for start in range(0, len(artifact), 64 * 1024):
            chunk = stream.decompress(
                artifact[start : start + 64 * 1024],
                SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES - produced + 1,
            )
            produced += len(chunk)
            chunks.append(chunk)
            if produced > SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES:
                raise ContractError(SIZE_LIMIT_EXCEEDED, "decompressed archive is too large")
        while stream.unconsumed_tail and produced <= SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES:
            chunk = stream.decompress(
                stream.unconsumed_tail, SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES - produced + 1
            )
            produced += len(chunk)
            chunks.append(chunk)
        if produced > SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES:
            raise ContractError(SIZE_LIMIT_EXCEEDED, "decompressed archive is too large")
        chunks.append(stream.flush())
    except zlib.error as exc:
        raise ContractError(ARCHIVE_FORMAT, "artifact does not decompress", field="gzip") from exc
    if not stream.eof:
        raise ContractError(ARCHIVE_FORMAT, "gzip stream is incomplete", field="gzip")
    if stream.unused_data:
        # Bytes after the first member: either a concatenated second gzip member
        # or trailing garbage. Both are ways to hand two readers different
        # content from one file, so the file is refused rather than truncated to
        # the part we happen to agree on.
        raise ContractError(ARCHIVE_FORMAT, "gzip stream has trailing data", field="gzip-trailer")
    return b"".join(chunks)


def _normalize_name(raw: str) -> tuple[str, bool]:
    value = raw[2:] if raw.startswith("./") else raw
    trailing = value.endswith("/")
    if trailing:
        value = value[:-1]
    if value == "":
        raise ContractError(ENTRY_PATH_UNSAFE, "entry name is empty")
    return value, trailing


def _resolve_root(paths: list[str], skill_id: str, version: str) -> str | None:
    """Strip the single top-level directory a conventional tarball carries.

    Only `<skill-id>` and `<skill-id>-<version>` are accepted, so a package
    cannot install itself under a name the Catalog never named.
    """
    allowed = (skill_id, f"{skill_id}-{version}")
    first_segments = {path.split("/")[0] for path in paths}
    if len(first_segments) != 1:
        return None
    candidate = next(iter(first_segments))
    if not any(path.startswith(f"{candidate}/") for path in paths):
        return None
    if candidate not in allowed:
        raise ContractError(LAYOUT_INVALID, "archive root directory is not allowed", reason="root-directory")
    return candidate


def read_package(artifact: bytes, skill_id: str, version: str) -> PackageTable:
    """Decompress and parse an artifact into a bounded entry table.

    :raises ContractError: for every rejection.
    """
    if len(artifact) < 2 or artifact[0] != 0x1F or artifact[1] != 0x8B:
        raise ContractError(ARCHIVE_FORMAT, "artifact is not gzip", field="gzip-magic")

    tar = _decompress_bounded(artifact)
    if (
        len(tar) > SKILL_PACKAGE_RATIO_FLOOR_BYTES
        and len(tar) / len(artifact) > SKILL_PACKAGE_MAX_COMPRESSION_RATIO
    ):
        raise ContractError(
            COMPRESSION_RATIO_EXCEEDED,
            "decompression ratio exceeds the limit",
            limit=SKILL_PACKAGE_MAX_COMPRESSION_RATIO,
        )

    raw = _read_tar_entries(tar)
    normalized = [(entry, *_normalize_name(entry.name)) for entry in raw]
    root_name = _resolve_root([item[1] for item in normalized], skill_id, version)

    files: list[PackageEntry] = []
    directories: list[str] = []
    by_path: set[str] = set()
    by_fold: dict[str, str] = {}

    for entry, path, trailing_slash in normalized:
        relative = path
        if root_name is not None:
            if relative == root_name:
                continue
            relative = relative[len(root_name) + 1 :]

        is_directory = entry.is_directory or trailing_slash
        validated, findings = validate_payload_path(relative, "/entry")
        if validated is None:
            raise ContractError(ENTRY_PATH_UNSAFE, findings[0].message, entry=relative)

        if relative in by_path:
            raise ContractError(ENTRY_DUPLICATE, "entry appears twice", entry=relative)
        folded = "/".join(fold_for_collision(segment) for segment in relative.split("/"))
        if folded in by_fold:
            raise ContractError(ENTRY_COLLISION, "entry collides with another entry", entry=relative)
        by_path.add(relative)
        by_fold[folded] = relative

        if is_directory:
            directories.append(relative)
            continue

        files.append(
            PackageEntry(
                path=relative,
                size=entry.size,
                sha256=sha256_hex(entry.data),
                executable=bool(entry.mode & 0o111),
                data=entry.data,
            )
        )

    payload_count = len([f for f in files if f.path != SKILL_MANIFEST_FILENAME])
    if payload_count > SKILL_FILES_MAX_COUNT:
        raise ContractError(ENTRY_LIMIT_EXCEEDED, "too many payload files")

    file_paths = {f.path for f in files}
    for directory in directories:
        if directory in file_paths:
            raise ContractError(ENTRY_DUPLICATE, "path is both a file and a directory", entry=directory)
    for entry_file in files:
        walked = ""
        for segment in entry_file.path.split("/")[:-1]:
            walked = segment if not walked else f"{walked}/{segment}"
            if walked in file_paths:
                raise ContractError(
                    ENTRY_PATH_UNSAFE, "a parent path is a regular file", entry=entry_file.path
                )

    return PackageTable(
        root_name=root_name,
        files=files,
        directories=directories,
        compressed_size=len(artifact),
        decompressed_size=len(tar),
    )
