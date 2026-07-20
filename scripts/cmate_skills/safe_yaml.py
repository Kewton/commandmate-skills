"""Restricted YAML reader for Skill manifests.

Mirrors `src/lib/skills/safe-yaml.ts` in CommandMate. A *subset* parser rather
than a configured general-purpose one, for the same two reasons upstream gives:

- No YAML library in reach enforces `SKILL_YAML_SAFE_PROFILE`. Depth, node count
  and scalar size are unbounded in the common ones, and anchors and merge keys
  resolve by default -- exactly the parser-bomb surface the profile removes.
- A manifest is a closed document. `schema_version: 1` has no field that needs
  anchors, tags, flow collections or multiple documents, so everything outside
  the subset is a rejection rather than a parse.

The accepted subset is: one document, block mappings, block sequences, plain and
quoted scalars, literal/folded block scalars, empty flow collections and
comments.

Running this parser in CI is what makes a manifest's acceptance by CommandMate
predictable: a package that only parses under a permissive reader is caught here,
not on a user's machine.
"""

from __future__ import annotations

import re
from typing import Any

from .constants import SKILL_YAML_SAFE_PROFILE

# =============================================================================
# Error vocabulary (codes match SkillYamlErrorCode upstream)
# =============================================================================

BYTES_LIMIT = "SKILL_YAML_BYTES_LIMIT"
DEPTH_LIMIT = "SKILL_YAML_DEPTH_LIMIT"
NODE_LIMIT = "SKILL_YAML_NODE_LIMIT"
SCALAR_LIMIT = "SKILL_YAML_SCALAR_LIMIT"
ALIAS_FORBIDDEN = "SKILL_YAML_ALIAS_FORBIDDEN"
MERGE_KEY_FORBIDDEN = "SKILL_YAML_MERGE_KEY_FORBIDDEN"
TAG_FORBIDDEN = "SKILL_YAML_TAG_FORBIDDEN"
DUPLICATE_KEY = "SKILL_YAML_DUPLICATE_KEY"
FORBIDDEN_KEY = "SKILL_YAML_FORBIDDEN_KEY"
MULTIPLE_DOCUMENTS = "SKILL_YAML_MULTIPLE_DOCUMENTS"
ENCODING = "SKILL_YAML_ENCODING"
UNSUPPORTED = "SKILL_YAML_UNSUPPORTED"
SYNTAX = "SKILL_YAML_SYNTAX"
#: Local to this repository: a plain scalar whose type depends on which YAML
#: version the reader implements. Not an upstream code, because upstream never
#: needs it -- it is what keeps this mirror from *accepting* something the
#: consumer would read differently.
AMBIGUOUS_SCALAR = "SKILL_YAML_AMBIGUOUS_SCALAR"

_MESSAGES = {
    BYTES_LIMIT: "YAML document exceeds the size limit",
    DEPTH_LIMIT: "YAML document is nested too deeply",
    NODE_LIMIT: "YAML document has too many nodes",
    SCALAR_LIMIT: "YAML scalar exceeds the length limit",
    ALIAS_FORBIDDEN: "YAML anchors and aliases are not accepted",
    MERGE_KEY_FORBIDDEN: "YAML merge keys are not accepted",
    TAG_FORBIDDEN: "YAML tags are not accepted",
    DUPLICATE_KEY: "YAML mapping declares the same key twice",
    FORBIDDEN_KEY: "YAML mapping uses a forbidden key",
    MULTIPLE_DOCUMENTS: "YAML stream carries more than one document",
    ENCODING: "YAML document is not valid UTF-8 text",
    UNSUPPORTED: "YAML document uses an unsupported construct",
    SYNTAX: "YAML document could not be parsed",
    AMBIGUOUS_SCALAR: "YAML plain scalar is read differently by different YAML versions; quote it",
}


class SkillYamlError(Exception):
    """A rejected YAML document.

    Carries a line number but never the offending text: a manifest can embed
    anything, and echoing it back would turn the parser into a reflection gadget.
    """

    def __init__(self, code: str, line: int | None = None) -> None:
        super().__init__(_MESSAGES[code])
        self.code = code
        self.line = line

    def __str__(self) -> str:
        where = f" (line {self.line})" if self.line is not None else ""
        return f"{_MESSAGES[self.code]}{where}"


# =============================================================================
# Grammar
# =============================================================================

_KEY_RE = re.compile(
    r"""^(?:
          "((?:[^"\\]|\\.)*)"      # double-quoted key
        | '((?:[^']|'')*)'         # single-quoted key
        | ([A-Za-z_][A-Za-z0-9_.\-]*)   # plain key
        )[ \t]*:(?:[ \t]+(.*))?$""",
    re.VERBOSE,
)

_INT_RE = re.compile(r"^-?(?:0|[1-9][0-9]*)$")
_FLOAT_RE = re.compile(r"^-?(?:0|[1-9][0-9]*)\.[0-9]+$")
_BLOCK_HEADER_RE = re.compile(r"^([|>])([-+]?)$")

_NULL_LITERALS = {"null", "Null", "NULL", "~", ""}
_TRUE_LITERALS = {"true", "True", "TRUE"}
_FALSE_LITERALS = {"false", "False", "FALSE"}

#: Plain scalars whose *type* depends on which YAML version resolved them.
#:
#: YAML 1.1 reads `yes` as a boolean and `010` as octal 8; YAML 1.2 core reads
#: both as strings. This parser would pick one answer and the consumer's parser
#: might pick the other, which is the one divergence a mirror must never have: a
#: manifest that means one thing in CI and another at install time. So they are
#: refused, and the author quotes what they meant.
_AMBIGUOUS_BOOL_LITERALS = frozenset(
    {"y", "Y", "n", "N", "yes", "Yes", "YES", "no", "No", "NO",
     "on", "On", "ON", "off", "Off", "OFF"}
)

_AMBIGUOUS_NUMERIC_PATTERNS = (
    re.compile(r"^[+-]?0[0-9_]+$"),                       # leading zero: octal in YAML 1.1
    re.compile(r"^[+-]?0[xXoObB][0-9a-fA-F_]+$"),         # hex / octal / binary literal
    re.compile(r"^[+-]?[0-9][0-9_]*_[0-9_]*$"),           # digit separators
    re.compile(r"^\+[0-9]"),                              # explicit plus sign
    re.compile(r"^[+-]?\.[0-9]+$"),                       # .5
    re.compile(r"^[+-]?[0-9]+\.$"),                       # 1.
    re.compile(r"^[+-]?[0-9.]+[eE][+-]?[0-9]+$"),         # exponent form
    re.compile(r"^[+-]?[0-9]+(?::[0-5]?[0-9])+$"),        # sexagesimal: 12:30
    re.compile(r"^[+-]?\.(?:inf|Inf|INF|nan|NaN|NAN)$"),  # infinities and NaN
    re.compile(r"^\d{4}-\d{1,2}-\d{1,2}"),                # date / timestamp
)


def _is_ambiguous_plain_scalar(text: str) -> bool:
    if text in _AMBIGUOUS_BOOL_LITERALS:
        return True
    return any(pattern.match(text) for pattern in _AMBIGUOUS_NUMERIC_PATTERNS)


class _Line:
    # `raw` is kept alongside the trimmed content because a block scalar must
    # preserve interior indentation that `content` has already thrown away.
    __slots__ = ("number", "indent", "content", "blank", "raw")

    def __init__(self, number: int, raw: str) -> None:
        self.number = number
        stripped = raw.lstrip(" ")
        self.indent = len(raw) - len(stripped)
        self.content = stripped.rstrip()
        self.blank = self.content == "" or self.content.startswith("#")
        self.raw = raw


def _strip_comment(text: str) -> str:
    """Drop a trailing `# ...` comment, respecting quotes.

    A `#` only starts a comment when it begins the token or follows whitespace,
    which is the YAML rule and also what keeps `url: https://x/#y` intact.
    """
    in_single = False
    in_double = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_double:
            if char == "\\":
                index += 2
                continue
            if char == '"':
                in_double = False
        elif in_single:
            if char == "'":
                in_single = False
        elif char == '"':
            in_double = True
        elif char == "'":
            in_single = True
        elif char == "#" and (index == 0 or text[index - 1] in " \t"):
            return text[:index].rstrip()
        index += 1
    return text


class _Parser:
    def __init__(self, lines: list[_Line], profile: dict[str, Any]) -> None:
        self.lines = lines
        self.profile = profile
        self.index = 0
        self.nodes = 0

    # -- bookkeeping ------------------------------------------------------

    def _node(self, line: int | None = None) -> None:
        self.nodes += 1
        if self.nodes > self.profile["max_nodes"]:
            raise SkillYamlError(NODE_LIMIT, line)

    def _depth(self, depth: int, line: int | None = None) -> None:
        if depth > self.profile["max_depth"]:
            raise SkillYamlError(DEPTH_LIMIT, line)

    def _skip_blank(self) -> None:
        while self.index < len(self.lines) and self.lines[self.index].blank:
            self.index += 1

    def _peek(self) -> _Line | None:
        self._skip_blank()
        return self.lines[self.index] if self.index < len(self.lines) else None

    # -- structure --------------------------------------------------------

    def parse_document(self) -> Any:
        line = self._peek()
        if line is None:
            return None
        value = self.parse_block(line.indent, depth=1)
        trailing = self._peek()
        if trailing is not None:
            raise SkillYamlError(SYNTAX, trailing.number)
        return value

    def parse_block(self, indent: int, depth: int) -> Any:
        self._depth(depth)
        line = self._peek()
        if line is None:
            return None
        if line.content == "-" or line.content.startswith("- "):
            return self.parse_sequence(indent, depth)
        return self.parse_mapping(indent, depth)

    def parse_sequence(self, indent: int, depth: int) -> list[Any]:
        items: list[Any] = []
        self._node()
        while True:
            line = self._peek()
            if line is None or line.indent != indent:
                break
            if not (line.content == "-" or line.content.startswith("- ")):
                break

            if line.content == "-":
                self.index += 1
                nested = self._peek()
                if nested is not None and nested.indent > indent:
                    items.append(self.parse_block(nested.indent, depth + 1))
                else:
                    items.append(None)
                continue

            body = line.content[1:]
            offset = len(body) - len(body.lstrip(" "))
            item_indent = indent + 1 + offset
            item_content = body.lstrip(" ")

            if not self._starts_a_collection(item_content):
                # A plain item: `- Group merged pull requests by type`.
                self.index += 1
                self._node(line.number)
                items.append(self._scalar(_strip_comment(item_content).strip(), line.number))
                continue

            # A nested collection: rewriting the dash as indentation lets the
            # item body and its continuation lines be parsed as one block.
            line.indent = item_indent
            line.content = item_content
            line.raw = (" " * item_indent) + item_content
            items.append(self.parse_block(item_indent, depth + 1))
        return items

    @staticmethod
    def _starts_a_collection(content: str) -> bool:
        if content == "-" or content.startswith("- "):
            return True
        return _KEY_RE.match(_strip_comment(content)) is not None

    def parse_mapping(self, indent: int, depth: int) -> dict[str, Any]:
        mapping: dict[str, Any] = {}
        self._node()
        while True:
            line = self._peek()
            if line is None or line.indent != indent:
                break
            if line.content == "-" or line.content.startswith("- "):
                break

            content = line.content
            if content.startswith("<<"):
                raise SkillYamlError(MERGE_KEY_FORBIDDEN, line.number)
            if content.startswith("? "):
                raise SkillYamlError(UNSUPPORTED, line.number)

            match = _KEY_RE.match(_strip_comment(content))
            if match is None:
                raise SkillYamlError(SYNTAX, line.number)
            key = self._decode_key(match, line.number)
            rest = match.group(4)
            self.index += 1

            if key in mapping and not self.profile["allow_duplicate_keys"]:
                raise SkillYamlError(DUPLICATE_KEY, line.number)
            if key in self.profile["forbidden_keys"]:
                raise SkillYamlError(FORBIDDEN_KEY, line.number)

            mapping[key] = self._read_value(rest, indent, depth, line)
        return mapping

    def _decode_key(self, match: re.Match[str], line_no: int) -> str:
        if match.group(1) is not None:
            return _unescape_double(match.group(1), line_no)
        if match.group(2) is not None:
            return match.group(2).replace("''", "'")
        return match.group(3)

    def _read_value(self, rest: str | None, indent: int, depth: int, line: _Line) -> Any:
        text = "" if rest is None else _strip_comment(rest).strip()

        block = _BLOCK_HEADER_RE.match(text)
        if block is not None:
            return self._read_block_scalar(block.group(1), block.group(2), indent, line)
        if text.startswith("|") or text.startswith(">"):
            # Explicit indentation indicators (`|2`) are outside the subset.
            raise SkillYamlError(UNSUPPORTED, line.number)

        if text != "":
            self._node(line.number)
            return self._scalar(text, line.number)

        nested = self._peek()
        if nested is None:
            # An empty value is still a node: charging it keeps `max_nodes`
            # meaningful for a document that is nothing but bare keys.
            self._node(line.number)
            return None
        if nested.indent > indent:
            return self.parse_block(nested.indent, depth + 1)
        if nested.indent == indent and (
            nested.content == "-" or nested.content.startswith("- ")
        ):
            # A sequence may sit at the same indent as its key.
            return self.parse_sequence(indent, depth + 1)
        self._node(line.number)
        return None

    def _read_block_scalar(self, style: str, chomp: str, indent: int, line: _Line) -> str:
        # `+` (keep) is refused rather than approximated: how many trailing
        # newlines survive is the one place a subset parser could disagree with
        # CommandMate's reader about a value it accepted, and no manifest field
        # needs it.
        if chomp == "+":
            raise SkillYamlError(UNSUPPORTED, line.number)

        raw_lines: list[str] = []
        block_indent: int | None = None
        while self.index < len(self.lines):
            candidate = self.lines[self.index]
            if candidate.content == "" and not candidate.content.startswith("#"):
                # A blank line belongs to the block until a shallower line ends it.
                raw_lines.append("")
                self.index += 1
                continue
            if candidate.indent <= indent:
                break
            if block_indent is None:
                block_indent = candidate.indent
            if candidate.indent < block_indent:
                break
            raw_lines.append(candidate.raw[block_indent:].rstrip())
            self.index += 1

        while raw_lines and raw_lines[-1] == "":
            raw_lines.pop()

        if style == "|":
            body = "\n".join(raw_lines)
        else:
            body = _fold(raw_lines)

        text = body if chomp == "-" else (body + "\n" if body else "")

        self._node(line.number)
        self._check_scalar_length(text, line.number)
        return text

    def _check_scalar_length(self, text: str, line_no: int) -> None:
        if len(text) > self.profile["max_scalar_length"]:
            raise SkillYamlError(SCALAR_LIMIT, line_no)

    def _scalar(self, text: str, line_no: int) -> Any:
        self._check_scalar_length(text, line_no)

        # An empty scalar is a null, and every check below indexes `text[0]`.
        # Reachable from a sequence item that is nothing but a comment (`- # x`).
        if text == "":
            return None

        if text.startswith("&") or text.startswith("*"):
            if not self.profile["allow_aliases"]:
                raise SkillYamlError(ALIAS_FORBIDDEN, line_no)
        if text.startswith("!"):
            if not self.profile["allow_custom_tags"]:
                raise SkillYamlError(TAG_FORBIDDEN, line_no)

        if text == "[]":
            self._node(line_no)
            return []
        if text == "{}":
            self._node(line_no)
            return {}
        if text[0] in "[{":
            raise SkillYamlError(UNSUPPORTED, line_no)

        if text[0] == '"':
            if len(text) < 2 or not text.endswith('"'):
                raise SkillYamlError(SYNTAX, line_no)
            return _unescape_double(text[1:-1], line_no)
        if text[0] == "'":
            if len(text) < 2 or not text.endswith("'"):
                raise SkillYamlError(SYNTAX, line_no)
            return text[1:-1].replace("''", "'")

        if text in _NULL_LITERALS:
            return None
        if text in _TRUE_LITERALS:
            return True
        if text in _FALSE_LITERALS:
            return False
        if _is_ambiguous_plain_scalar(text):
            raise SkillYamlError(AMBIGUOUS_SCALAR, line_no)
        if _INT_RE.match(text):
            return int(text)
        if _FLOAT_RE.match(text):
            return float(text)
        return text


def _fold(lines: list[str]) -> str:
    """Fold a `>` block: single newlines become spaces, blank lines stay."""
    out: list[str] = []
    for entry in lines:
        if entry == "":
            out.append("\n")
            continue
        if out and not out[-1].endswith("\n"):
            out.append(" ")
        out.append(entry)
    return "".join(out)


_ESCAPES = {
    "0": "\0",
    "a": "\a",
    "b": "\b",
    "t": "\t",
    "n": "\n",
    "v": "\v",
    "f": "\f",
    "r": "\r",
    '"': '"',
    "/": "/",
    "\\": "\\",
    " ": " ",
}


def _unescape_double(text: str, line_no: int) -> str:
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        index += 1
        if index >= len(text):
            raise SkillYamlError(SYNTAX, line_no)
        code = text[index]
        if code == "u":
            hex_digits = text[index + 1 : index + 5]
            if len(hex_digits) != 4 or any(c not in "0123456789abcdefABCDEF" for c in hex_digits):
                raise SkillYamlError(SYNTAX, line_no)
            code_point = int(hex_digits, 16)
            # A lone surrogate is not a character. Accepting one would produce a
            # string that cannot be encoded back to UTF-8, so the failure would
            # surface far from here as a crash while writing the Catalog.
            if 0xD800 <= code_point <= 0xDFFF:
                raise SkillYamlError(ENCODING, line_no)
            out.append(chr(code_point))
            index += 5
            continue
        if code not in _ESCAPES:
            raise SkillYamlError(SYNTAX, line_no)
        out.append(_ESCAPES[code])
        index += 1
    return "".join(out)


# =============================================================================
# Public API
# =============================================================================


def parse_skill_yaml(data: bytes | str, profile: dict[str, Any] | None = None) -> Any:
    """Parse a manifest document under the safe profile.

    :raises SkillYamlError: for every rejection, malicious or merely malformed.
    """
    active = profile or SKILL_YAML_SAFE_PROFILE

    if isinstance(data, bytes):
        if len(data) > active["max_bytes"]:
            raise SkillYamlError(BYTES_LIMIT)
        if data.startswith(b"\xef\xbb\xbf"):
            raise SkillYamlError(ENCODING)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:  # noqa: PERF203 - one call site
            raise SkillYamlError(ENCODING) from exc
    else:
        text = data
        if len(text.encode("utf-8")) > active["max_bytes"]:
            raise SkillYamlError(BYTES_LIMIT)

    if "\r" in text:
        raise SkillYamlError(ENCODING)
    for char in text:
        if char != "\n" and char != "\t" and ord(char) < 0x20:
            raise SkillYamlError(ENCODING)
        if ord(char) == 0x7F:
            raise SkillYamlError(ENCODING)

    raw_lines = text.split("\n")
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()

    body: list[str] = []
    seen_directive_end = False
    for number, raw in enumerate(raw_lines, start=1):
        if raw.rstrip() == "---":
            if seen_directive_end or body:
                raise SkillYamlError(MULTIPLE_DOCUMENTS, number)
            seen_directive_end = True
            continue
        if raw.rstrip() == "...":
            raise SkillYamlError(MULTIPLE_DOCUMENTS, number)
        if raw.startswith("%"):
            raise SkillYamlError(UNSUPPORTED, number)
        if "\t" in raw[: len(raw) - len(raw.lstrip(" \t"))]:
            raise SkillYamlError(SYNTAX, number)
        body.append(raw)

    lines = [_Line(number, raw) for number, raw in enumerate(body, start=1)]
    return _Parser(lines, active).parse_document()


def parse_skill_frontmatter(markdown: str, profile: dict[str, Any] | None = None) -> Any:
    """Parse the YAML frontmatter of a `SKILL.md`, or return None when absent."""
    normalized = markdown.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        return None
    end = normalized.find("\n---", 3)
    if end == -1:
        return None
    return parse_skill_yaml(normalized[4 : end + 1], profile)
