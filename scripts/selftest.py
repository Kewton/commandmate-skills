#!/usr/bin/env python3
"""Targeted tests for the release pipeline itself.

    python3 scripts/selftest.py

`validate.py` proves that the packages in this repository are good. This proves
that `validate.py` would notice if they were not — every check below breaks
something on purpose and asserts the pipeline rejects it.

Stdlib `unittest`, no runner to install: a test suite that needs a package
manager to run is a test suite that silently stops running the day the registry
is unreachable.
"""

from __future__ import annotations

import copy
import gzip
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _bootstrap  # noqa: F401  (path setup)
from build_release import parse_release_tag
from cmate_skills.errors import ContractError
from cmate_skills.package import PayloadFile, build_artifact, read_package, sha256_hex
from cmate_skills.package import _read_octal as read_octal
from cmate_skills.repo import build_and_verify, check_package
from cmate_skills.safe_yaml import SkillYamlError, parse_skill_yaml
from cmate_skills.schema import validate_catalog, validate_manifest

REPO_ROOT = _bootstrap.REPO_ROOT
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "skills" / "pipeline-selftest"
SKILL_ID = "pipeline-selftest"
VERSION = "0.1.0"
COMMIT = "0123456789abcdef0123456789abcdef01234567"


def _load_fixture_check():
    check = check_package(FIXTURE, REPO_ROOT)
    if check.findings:
        raise AssertionError(
            "the selftest fixture must be valid before anything else is tested:\n"
            + "\n".join(f"  {finding}" for finding in check.findings)
        )
    return check


class FixtureIsValid(unittest.TestCase):
    def test_fixture_package_passes_every_check(self) -> None:
        check = _load_fixture_check()
        self.assertEqual(check.manifest["id"], SKILL_ID)
        self.assertEqual(check.manifest["version"], VERSION)


class Reproducibility(unittest.TestCase):
    def test_two_builds_are_byte_identical(self) -> None:
        check = _load_fixture_check()
        self.assertEqual(build_and_verify(check), build_and_verify(check))

    def test_build_ignores_mtime_ownership_and_umask(self) -> None:
        """A copy with different timestamps and modes must build to the same bytes.

        This is the property the Catalog digest actually depends on. Two builds in
        one process could agree simply by reading the same `stat` twice; a copy
        touched with a different mtime and a different mode cannot.
        """
        check = _load_fixture_check()
        baseline = build_and_verify(check)

        with tempfile.TemporaryDirectory() as tmp:
            copied = Path(tmp) / SKILL_ID
            shutil.copytree(FIXTURE, copied)
            for entry in sorted(copied.rglob("*")):
                if entry.is_file():
                    entry.chmod(0o664)
                    import os

                    os.utime(entry, (1_700_000_000, 1_700_000_000))
            copied_check = check_package(copied, REPO_ROOT)
            self.assertEqual(copied_check.findings, [])
            self.assertEqual(build_and_verify(copied_check), baseline)

    def test_a_content_change_changes_the_digest(self) -> None:
        """The converse: reproducibility must not be achieved by ignoring content."""
        files = [
            PayloadFile("SKILL.md", b"---\nname: x\n---\nbody\n"),
            PayloadFile("commandmate.skill.yaml", b"schema_version: 1\n"),
        ]
        first = build_artifact(SKILL_ID, files)
        files[0] = PayloadFile("SKILL.md", b"---\nname: x\n---\nbody!\n")
        self.assertNotEqual(sha256_hex(first), sha256_hex(build_artifact(SKILL_ID, files)))


class ArtifactLayout(unittest.TestCase):
    def test_archive_root_is_the_skill_id(self) -> None:
        table = read_package(build_and_verify(_load_fixture_check()), SKILL_ID, VERSION)
        self.assertEqual(table.root_name, SKILL_ID)
        self.assertIsNotNone(table.find("SKILL.md"))
        self.assertIsNotNone(table.find("commandmate.skill.yaml"))
        self.assertIsNotNone(table.find("references/checklist.md"))

    def test_a_foreign_root_directory_is_refused(self) -> None:
        artifact = build_artifact(
            "somethingelse",
            [
                PayloadFile("SKILL.md", b"x"),
                PayloadFile("commandmate.skill.yaml", b"schema_version: 1\n"),
            ],
        )
        with self.assertRaises(ContractError) as caught:
            read_package(artifact, SKILL_ID, VERSION)
        self.assertEqual(caught.exception.code, "SKILL_PACKAGE_LAYOUT_INVALID")

    def test_tampered_bytes_do_not_parse_as_the_same_package(self) -> None:
        artifact = bytearray(build_and_verify(_load_fixture_check()))
        original = sha256_hex(bytes(artifact))
        artifact[len(artifact) // 2] ^= 0xFF
        self.assertNotEqual(sha256_hex(bytes(artifact)), original)
        with self.assertRaises(ContractError):
            read_package(bytes(artifact), SKILL_ID, VERSION)

    def test_trailing_gzip_data_is_refused(self) -> None:
        """Two readers must not be able to see different content in one file.

        Bytes appended after the first gzip member — garbage, or a whole second
        member — are how a file gets read one way by the verifier and another way
        by the consumer.
        """
        artifact = build_and_verify(_load_fixture_check())
        for label, mutated in (
            ("garbage", artifact + b"GARBAGE"),
            ("concatenated member", artifact + artifact),
        ):
            with self.subTest(label=label):
                with self.assertRaises(ContractError) as caught:
                    read_package(mutated, SKILL_ID, VERSION)
                self.assertEqual(caught.exception.code, "SKILL_PACKAGE_ARCHIVE_FORMAT")

    def test_a_numeric_field_past_its_terminator_is_refused(self) -> None:
        """The parser-differential that hides a whole entry from this reader.

        Every other tar implementation stops a numeric field at its first NUL.
        Digits after that terminator are read by nobody else, so a `size` field
        of `0\\x002000` means 0 to `tar` and 1024 here — and since `size` decides
        where the next header begins, the two readers walk different entry
        streams. Whatever lives in the gap is never validated by one of them.
        """
        artifact = build_and_verify(_load_fixture_check())
        tar = bytearray(gzip.decompress(artifact))
        smuggled = b"0\x002000\x00\x00\x00\x00\x00\x00"
        self.assertEqual(len(smuggled), 12)

        patched = False
        for offset in range(0, len(tar), 512):
            if bytes(tar[offset : offset + 100]).split(b"\0")[0].endswith(b"SKILL.md"):
                tar[offset + 124 : offset + 136] = smuggled
                checksum = sum(
                    bytes(tar[offset : offset + 148]) + b" " * 8 + bytes(tar[offset + 156 : offset + 512])
                )
                tar[offset + 148 : offset + 156] = ("%06o\0 " % checksum).encode()
                patched = True
                break
        self.assertTrue(patched, "SKILL.md header not found in the archive")

        buffer = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as handle:
            handle.write(bytes(tar))

        with self.assertRaises(ContractError) as caught:
            read_package(buffer.getvalue(), SKILL_ID, VERSION)
        self.assertEqual(caught.exception.code, "SKILL_PACKAGE_ARCHIVE_FORMAT")

    def test_ordinary_numeric_field_paddings_still_parse(self) -> None:
        """The strict rule must not reject headers real tar writers produce."""
        for field, expected in (
            (b"00000002000\x00", 1024),  # GNU/Python: zero-padded, NUL-terminated
            (b"0000002 \x00\x00\x00\x00", 2),  # space-terminated
            (b"       0\x00\x00\x00\x00", 0),  # space-padded on the left
            (b"\x00" * 12, 0),  # entirely empty
        ):
            with self.subTest(field=field):
                self.assertEqual(read_octal(field.ljust(12, b"\x00"), 0, 12), expected)

    def test_unsafe_payload_paths_are_refused_at_build_time(self) -> None:
        for unsafe in ("../escape.md", "/absolute.md", "a\\b.md", "nested/../x.md"):
            with self.subTest(path=unsafe):
                with self.assertRaises(ContractError):
                    build_artifact(SKILL_ID, [PayloadFile(unsafe, b"x")])


class ManifestReconciliation(unittest.TestCase):
    """Every axis of the manifest/package comparison, broken one at a time."""

    def setUp(self) -> None:
        self.check = _load_fixture_check()

    def _mutate(self, path: str, mutate) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            copied = Path(tmp) / SKILL_ID
            shutil.copytree(FIXTURE, copied)
            target = copied / path
            mutate(target)
            return [finding.code for finding in check_package(copied, REPO_ROOT).findings]

    def test_undeclared_file_is_refused(self) -> None:
        codes = self._mutate(
            "references/extra.md", lambda target: target.write_text("undeclared\n", encoding="utf-8")
        )
        self.assertIn("SKILL_FILE_SET_MISMATCH", codes)

    def test_declared_but_missing_file_is_refused(self) -> None:
        codes = self._mutate("references/checklist.md", lambda target: target.unlink())
        self.assertIn("SKILL_FILE_SET_MISMATCH", codes)

    def test_changed_content_without_a_digest_update_is_refused(self) -> None:
        codes = self._mutate(
            "references/checklist.md",
            lambda target: target.write_text("tampered\n", encoding="utf-8"),
        )
        self.assertIn("SKILLS_DECLARATION_MISMATCH", codes)

    def test_undeclared_executable_bit_is_refused(self) -> None:
        codes = self._mutate("references/checklist.md", lambda target: target.chmod(0o755))
        self.assertIn("SKILLS_DECLARATION_MISMATCH", codes)

    def test_symlink_is_refused(self) -> None:
        def plant(target: Path) -> None:
            target.symlink_to("/etc/passwd")

        codes = self._mutate("references/link.md", plant)
        self.assertIn("SKILLS_TREE_ENTRY_FORBIDDEN", codes)

    def test_identity_disagreement_is_refused(self) -> None:
        def rename(target: Path) -> None:
            body = target.read_text(encoding="utf-8")
            target.write_text(body.replace("name: pipeline-selftest", "name: other"), encoding="utf-8")

        codes = self._mutate("SKILL.md", rename)
        self.assertIn("SKILLS_DECLARATION_MISMATCH", codes)

    def test_secret_is_refused(self) -> None:
        codes = self._mutate(
            "references/checklist.md",
            lambda target: target.write_text("token: ghp_" + "a" * 36 + "\n", encoding="utf-8"),
        )
        self.assertIn("SKILLS_SECRET_DETECTED", codes)

    def test_plaintext_http_link_is_refused(self) -> None:
        codes = self._mutate(
            "references/checklist.md",
            lambda target: target.write_text("see http://example.com/doc\n", encoding="utf-8"),
        )
        self.assertIn("SKILLS_LINK_INSECURE", codes)


class SafeYaml(unittest.TestCase):
    """The refusals that keep a manifest from being a parser exploit."""

    def _reject(self, document: str, expected: str) -> None:
        with self.assertRaises(SkillYamlError) as caught:
            parse_skill_yaml(document)
        self.assertEqual(caught.exception.code, expected)

    def test_anchor_and_alias_are_refused(self) -> None:
        self._reject("a: &anchor value\nb: *anchor\n", "SKILL_YAML_ALIAS_FORBIDDEN")

    def test_merge_key_is_refused(self) -> None:
        self._reject("base:\n  a: 1\nderived:\n  <<: base\n", "SKILL_YAML_MERGE_KEY_FORBIDDEN")

    def test_custom_tag_is_refused(self) -> None:
        self._reject("a: !!python/object:os.system x\n", "SKILL_YAML_TAG_FORBIDDEN")

    def test_duplicate_key_is_refused(self) -> None:
        self._reject("a: 1\na: 2\n", "SKILL_YAML_DUPLICATE_KEY")

    def test_prototype_key_is_refused(self) -> None:
        self._reject("__proto__:\n  polluted: true\n", "SKILL_YAML_FORBIDDEN_KEY")

    def test_multiple_documents_are_refused(self) -> None:
        self._reject("a: 1\n---\nb: 2\n", "SKILL_YAML_MULTIPLE_DOCUMENTS")

    def test_non_empty_flow_collection_is_refused(self) -> None:
        self._reject("a: [1, 2]\n", "SKILL_YAML_UNSUPPORTED")

    def test_lone_surrogate_escape_is_refused(self) -> None:
        # Would decode to a string that cannot be re-encoded as UTF-8, crashing
        # somewhere downstream rather than being refused here.
        self._reject('a: "\\ud800"\n', "SKILL_YAML_ENCODING")

    def test_odd_but_legal_input_does_not_crash(self) -> None:
        """Malformed input must produce a SkillYamlError, never a traceback."""
        cases = [
            "- # only a comment\n",
            "a:\n",
            "a:\n  - \n",
            "",
            "# nothing but a comment\n",
            "a: ''\n",
            "a: |\n",
        ]
        for document in cases:
            with self.subTest(document=document):
                try:
                    parse_skill_yaml(document)
                except SkillYamlError:
                    pass  # a refusal is a fine outcome; a crash is not

    def test_version_dependent_plain_scalars_are_refused(self) -> None:
        """Scalars whose *type* depends on the YAML version the reader implements.

        `license: yes` is the string "yes" under YAML 1.2 core and the boolean
        `true` under YAML 1.1. Stringifying it here would let a manifest pass the
        SPDX pattern in CI and be rejected as a non-string at install time —
        precisely the "CI green, install fails" divergence a mirror must not have.
        """
        for value in ("yes", "no", "on", "off", "010", "0x1f", "1_000", "+1", ".5", "1.", "12:30", "2026-07-20"):
            with self.subTest(value=value):
                self._reject(f"a: {value}\n", "SKILL_YAML_AMBIGUOUS_SCALAR")

    def test_quoting_an_ambiguous_scalar_resolves_it(self) -> None:
        self.assertEqual(parse_skill_yaml("a: 'yes'\nb: \"010\"\n"), {"a": "yes", "b": "010"})

    def test_supported_subset_parses(self) -> None:
        parsed = parse_skill_yaml(
            "schema_version: 1\n"
            "name: x\n"
            "quoted: 'a: b'\n"
            "empty_list: []\n"
            "flag: false\n"
            "folded: >-\n"
            "  one\n"
            "  two\n"
            "list:\n"
            "  - path: a\n"
            "    size: 3\n"
        )
        self.assertEqual(parsed["schema_version"], 1)
        self.assertEqual(parsed["quoted"], "a: b")
        self.assertEqual(parsed["empty_list"], [])
        self.assertIs(parsed["flag"], False)
        self.assertEqual(parsed["folded"], "one two")
        self.assertEqual(parsed["list"], [{"path": "a", "size": 3}])


class ManifestSchema(unittest.TestCase):
    """Contract rules that the fixture would never trip, mirrored from #1228."""

    def setUp(self) -> None:
        document = parse_skill_yaml((FIXTURE / "commandmate.skill.yaml").read_bytes())
        manifest, findings = validate_manifest(document)
        self.assertEqual(findings, [])
        self.assertIsNotNone(manifest)
        self.base = document

    def _codes(self, mutate) -> list[str]:
        document = copy.deepcopy(self.base)
        mutate(document)
        _, findings = validate_manifest(document)
        return [finding.code for finding in findings]

    def test_future_schema_version_is_refused(self) -> None:
        self.assertIn(
            "SKILL_SCHEMA_VERSION_UNSUPPORTED",
            self._codes(lambda doc: doc.__setitem__("schema_version", 2)),
        )

    def test_unknown_field_is_refused(self) -> None:
        self.assertIn("SKILL_UNKNOWN_FIELD", self._codes(lambda doc: doc.__setitem__("extra", 1)))

    def test_uppercase_id_is_refused(self) -> None:
        self.assertIn("SKILL_ID_INVALID", self._codes(lambda doc: doc.__setitem__("id", "Pipeline")))

    def test_reserved_id_is_refused(self) -> None:
        self.assertIn("SKILL_ID_RESERVED", self._codes(lambda doc: doc.__setitem__("id", "commandmate")))

    def test_v_prefixed_version_is_refused(self) -> None:
        self.assertIn("SKILL_VERSION_INVALID", self._codes(lambda doc: doc.__setitem__("version", "v1.0.0")))

    def test_uppercase_digest_is_refused(self) -> None:
        self.assertIn(
            "SKILL_DIGEST_INVALID",
            self._codes(lambda doc: doc["files"][0].__setitem__("sha256", "A" * 64)),
        )

    def test_manifest_may_not_declare_itself(self) -> None:
        def add_self(doc):
            doc["files"].append(
                {
                    "path": "commandmate.skill.yaml",
                    "sha256": "0" * 64,
                    "size": 1,
                    "kind": "asset",
                    "executable": False,
                    "script": False,
                }
            )

        self.assertIn("SKILL_FILE_SET_MISMATCH", self._codes(add_self))

    def test_traversal_in_a_declared_path_is_refused(self) -> None:
        self.assertIn(
            "SKILL_FILE_PATH_UNSAFE",
            self._codes(lambda doc: doc["files"][1].__setitem__("path", "../escape.md")),
        )

    def test_empty_capabilities_are_refused(self) -> None:
        self.assertIn("SKILL_MISSING_FIELD", self._codes(lambda doc: doc.__setitem__("capabilities", [])))

    def test_unknown_agent_is_refused(self) -> None:
        self.assertIn(
            "SKILL_INVALID_ENUM",
            self._codes(lambda doc: doc["compatibility"]["agents"][0].__setitem__("agent", "notatool")),
        )

    def test_range_with_or_is_refused(self) -> None:
        self.assertIn(
            "SKILL_VERSION_RANGE_INVALID",
            self._codes(lambda doc: doc["compatibility"].__setitem__("commandmate", ">=1.0.0 || <2.0.0")),
        )


class ReleaseTags(unittest.TestCase):
    """The tag is the only human-typed input to a release, so it is parsed strictly."""

    def test_well_formed_tags_split_correctly(self) -> None:
        cases = {
            "pipeline-selftest-v0.1.0": ("pipeline-selftest", "0.1.0"),
            "cmate-issue-refinement-v1.2.0": ("cmate-issue-refinement", "1.2.0"),
            "x-v2.0.0-rc.1": ("x", "2.0.0-rc.1"),
        }
        for tag, expected in cases.items():
            with self.subTest(tag=tag):
                self.assertEqual(parse_release_tag(tag), expected)

    def test_malformed_tags_are_refused(self) -> None:
        for tag in ("v1.0.0", "skill-1.0.0", "skill-vv1.0.0", "Skill-v1.0.0", "skill-v1.0"):
            with self.subTest(tag=tag):
                self.assertIsNone(parse_release_tag(tag))

    def test_a_tag_that_disagrees_with_the_manifest_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            skills_root = work / "skills"
            skills_root.mkdir()
            shutil.copytree(FIXTURE, skills_root / SKILL_ID)
            result = subprocess.run(
                [
                    sys.executable, str(REPO_ROOT / "scripts" / "build_release.py"),
                    "--tag", f"{SKILL_ID}-v9.9.9",
                    "--skills-root", str(skills_root),
                    "--out", str(work / "dist"),
                    "--repository", "Kewton/commandmate-skills",
                    "--commit", COMMIT,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("but the manifest says", result.stderr)

    def test_an_abbreviated_commit_is_refused(self) -> None:
        result = subprocess.run(
            [
                sys.executable, str(REPO_ROOT / "scripts" / "build_release.py"),
                "--skill", SKILL_ID,
                "--skills-root", str(FIXTURE.parent),
                "--repository", "Kewton/commandmate-skills",
                "--ref", "x",
                "--commit", COMMIT[:12],
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("40-character commit SHA", result.stderr)


class CatalogRules(unittest.TestCase):
    """Refusals that protect an already-published version."""

    def _build_record(self, work: Path) -> Path:
        skills_root = work / "skills"
        skills_root.mkdir()
        shutil.copytree(FIXTURE, skills_root / SKILL_ID)
        subprocess.run(
            [
                sys.executable, str(REPO_ROOT / "scripts" / "build_release.py"),
                "--skill", SKILL_ID, "--skills-root", str(skills_root),
                "--out", str(work / "dist"), "--repository", "Kewton/commandmate-skills",
                "--ref", f"{SKILL_ID}-v{VERSION}", "--commit", COMMIT,
            ],
            capture_output=True, text=True, check=True,
        )
        return work / "dist" / f"{SKILL_ID}-{VERSION}.build.json"

    def _run_catalog(self, record: Path, catalog: Path, work: Path):
        changelog = work / "changelog.md"
        changelog.write_text("Fixture release.\n", encoding="utf-8")
        return subprocess.run(
            [
                sys.executable, str(REPO_ROOT / "scripts" / "build_catalog.py"),
                "--record", str(record), "--catalog", str(catalog),
                "--changelog-file", str(changelog),
                "--published-at", "2026-07-20T09:30:00Z",
            ],
            capture_output=True, text=True, check=False,
        )

    def test_a_non_semver_record_version_fails_cleanly(self) -> None:
        """A clean refusal, not a traceback.

        In the publish job this runs *after* the release is already public, so an
        unhandled exception here leaves exactly the half-published state the
        rollback runbook exists to avoid.
        """
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            record_path = self._build_record(work)
            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["version"] = "1.0"
            record["asset_name"] = f"{SKILL_ID}-1.0.tar.gz"
            record_path.write_text(json.dumps(record), encoding="utf-8")

            result = self._run_catalog(record_path, work / "catalog.json", work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not SemVer 2.0", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_build_metadata_does_not_make_a_version_republishable(self) -> None:
        """`1.0.0` and `1.0.0+build.2` are one version to anyone resolving a range."""
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            record_path = self._build_record(work)
            catalog = work / "catalog.json"
            self.assertEqual(self._run_catalog(record_path, catalog, work).returncode, 0)

            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["version"] = f"{VERSION}+build.2"
            record["asset_name"] = f"{SKILL_ID}-{VERSION}+build.2.tar.gz"
            second = work / "second.build.json"
            second.write_text(json.dumps(record), encoding="utf-8")

            result = self._run_catalog(second, catalog, work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("collides with", result.stderr)

    def test_verification_rejects_a_root_this_pipeline_never_emits(self) -> None:
        """An audit tool must flag a layout the build cannot produce.

        CommandMate also accepts a `<skill-id>-<version>` root, so the archive
        below installs fine — but this repository only ever emits `<skill-id>/`,
        which means an official artifact shaped this way did not come from this
        pipeline even though its digest matches the Catalog.
        """
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            record_path = self._build_record(work)
            check = _load_fixture_check()

            odd = build_artifact(f"{SKILL_ID}-{VERSION}", check.payload)
            asset = work / "dist" / f"{SKILL_ID}-{VERSION}.tar.gz"
            asset.write_bytes(odd)

            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["sha256"] = sha256_hex(odd)
            record["size"] = len(odd)
            record_path.write_text(json.dumps(record), encoding="utf-8")

            catalog = work / "catalog.json"
            self.assertEqual(self._run_catalog(record_path, catalog, work).returncode, 0)

            result = subprocess.run(
                [
                    sys.executable, str(REPO_ROOT / "scripts" / "verify_artifact.py"),
                    "--catalog", str(catalog), "--skill", SKILL_ID,
                    "--version", VERSION, "--artifact", str(asset),
                ],
                capture_output=True, text=True, check=False,
            )
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("archive root is the skill id", result.stdout)
            self.assertIn("REJECT", result.stdout)

    def test_an_invalid_existing_catalog_is_not_merged_into(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            record_path = self._build_record(work)
            catalog = work / "catalog.json"
            catalog.write_text(json.dumps({"schema_version": 1, "entries": [{"id": "x"}]}), encoding="utf-8")
            result = self._run_catalog(record_path, catalog, work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid Catalog", result.stderr)


class EndToEnd(unittest.TestCase):
    """Build, catalog and verify, through the same entry points CI uses."""

    def test_pipeline_produces_a_verifiable_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            skills_root = work / "skills"
            skills_root.mkdir()
            shutil.copytree(FIXTURE, skills_root / SKILL_ID)

            dist = work / "dist"
            self._run(
                "build_release.py",
                "--skill", SKILL_ID,
                "--skills-root", str(skills_root),
                "--out", str(dist),
                "--repository", "Kewton/commandmate-skills",
                "--ref", f"{SKILL_ID}-v{VERSION}",
                "--commit", COMMIT,
            )

            asset = dist / f"{SKILL_ID}-{VERSION}.tar.gz"
            record = dist / f"{SKILL_ID}-{VERSION}.build.json"
            self.assertTrue(asset.is_file())

            checksum_line = (dist / f"{asset.name}.sha256").read_text(encoding="utf-8")
            self.assertEqual(checksum_line, f"{sha256_hex(asset.read_bytes())}  {asset.name}\n")

            changelog = work / "changelog.md"
            changelog.write_text("Initial fixture release.\n", encoding="utf-8")
            catalog_path = work / "catalog.json"
            self._run(
                "build_catalog.py",
                "--record", str(record),
                "--catalog", str(catalog_path),
                "--changelog-file", str(changelog),
                "--published-at", "2026-07-20T09:30:00Z",
                "--snapshot-out", str(dist),
            )

            catalog, findings = validate_catalog(json.loads(catalog_path.read_text(encoding="utf-8")))
            self.assertEqual(findings, [])
            version = catalog["entries"][0]["versions"][0]
            self.assertEqual(version["artifact"]["sha256"], sha256_hex(asset.read_bytes()))
            self.assertEqual(version["artifact"]["size"], asset.stat().st_size)
            self.assertEqual(version["source"]["commit"], COMMIT)
            self.assertTrue((dist / f"catalog-{SKILL_ID}-{VERSION}.json").is_file())

            self._run(
                "verify_artifact.py",
                "--catalog", str(catalog_path),
                "--skill", SKILL_ID,
                "--version", VERSION,
                "--artifact", str(asset),
            )

            # Republishing the same version must be refused: an install already
            # pinned to this digest would otherwise silently change underneath.
            replay = self._run(
                "build_catalog.py",
                "--record", str(record),
                "--catalog", str(catalog_path),
                "--changelog-file", str(changelog),
                "--published-at", "2026-07-20T10:00:00Z",
                expect_failure=True,
            )
            self.assertIn("already in the Catalog", replay.stderr)

            # And a tampered download must be rejected against the same Catalog.
            tampered = work / "tampered.tar.gz"
            corrupt = bytearray(asset.read_bytes())
            corrupt[-16] ^= 0xFF
            tampered.write_bytes(bytes(corrupt))
            rejected = self._run(
                "verify_artifact.py",
                "--catalog", str(catalog_path),
                "--skill", SKILL_ID,
                "--version", VERSION,
                "--artifact", str(tampered),
                expect_failure=True,
            )
            self.assertIn("REJECT", rejected.stdout)

    def _run(self, script: str, *args: str, expect_failure: bool = False):
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / script), *args],
            capture_output=True,
            text=True,
            check=False,
        )
        if expect_failure:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result


if __name__ == "__main__":
    unittest.main(verbosity=2)
