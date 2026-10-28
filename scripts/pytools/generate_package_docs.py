#!/usr/bin/env python3
"""
Generate package README.md files from ``__init__.py`` module docstrings.

Purpose:
    Every package directory carries a full module docstring, and its README.md
    is a build artifact derived from it. The docstring is the source; the README
    is generated. This keeps the two from drifting, which is the whole point --
    a README that is written by hand goes stale the first time the code moves,
    and nothing detects it.

    These docstrings are the qmd retrieval surface for the repository. An
    undocumented package is a hole in search: what lives inside it cannot be
    found by anyone who does not already know it is there.

Architecture:
    Three modes, one code path. ``--write`` regenerates every README from its
    docstring. ``--check`` verifies each README already matches what would be
    generated and that every docstring meets the contract, changing nothing.
    ``--dry-run`` reports what ``--write`` would do.

    ``--check`` is the commit gate. It exits non-zero on a missing docstring, a
    docstring lacking the required sections, a missing README, or a README whose
    content has drifted from its docstring. It does not warn, skip, or pass.

    This inverts the reference implementation
    (``WorkStuff/b1x-message-coordinator/scripts/git-tools/generate_folder_docs.py``),
    whose ``should_generate_readme()`` prints "Skipped" for a short or
    unstructured docstring and whose ``main()`` returns 0 regardless. That
    leaves in place exactly the undocumented package the rule exists to prevent.

Key Components:
    - DocstringContract: the required sections and minimum body, in one place
    - PackageDoc: one package's init file, docstring, and expected README
    - collect_packages: finds every package under the given roots
    - render_readme: the single definition of README content
    - check / write: the two operations, sharing render_readme

Pattern/Convention:
    A docstring must open with a summary line, run to at least
    ``MINIMUM_BODY_CHARS`` characters, and carry at least one of the required
    section headings. Add a package, and this gate requires you to describe it
    before the commit lands.

Example:
    >>> # gate a commit (non-zero exit blocks it)
    >>> # python scripts/pytools/generate_package_docs.py --check
    >>>
    >>> # regenerate after editing a docstring
    >>> # python scripts/pytools/generate_package_docs.py --write

See Also:
    - ``docs/CODING_STANDARDS.md`` section 2, self-documenting packages
    - ``docs/CI_CD_REQUIREMENTS.md`` gate 1, pre-commit
"""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path

#: A docstring shorter than this is a placeholder, not documentation. Set by
#: the standard in ``docs/CODING_STANDARDS.md`` section 2, not measured from
#: anything -- it exists to reject "Package." and nothing else.
MINIMUM_BODY_CHARS = 100

#: At least one of these headings must appear. They are the structure that
#: makes a docstring answer a question rather than merely name the package.
REQUIRED_SECTIONS = (
    "Purpose:",
    "Key Components:",
    "Architecture:",
    "Pattern/Convention:",
    "Example:",
)

#: Directory names that are never packages for documentation purposes.
EXCLUDED_DIRECTORY_NAMES = frozenset(
    {
        "__pycache__",
        ".venv",
        "venv",
        "node_modules",
        ".git",
        "build",
        "dist",
    }
)

GENERATED_MARKER = "<!-- generated from __init__.py -- do not edit by hand -->"


class DocumentationError(Exception):
    """One package failed the documentation contract."""


@dataclass(frozen=True)
class PackageDoc:
    """One package directory, its ``__init__.py``, and its README."""

    init_file: Path
    docstring: str | None

    @property
    def directory(self) -> Path:
        """The package directory itself."""
        return self.init_file.parent

    @property
    def readme_path(self) -> Path:
        """Where this package's generated README lives."""
        return self.directory / "README.md"

    def relative_to(self, root: Path) -> str:
        """Path of the package directory relative to ``root``, for messages."""
        try:
            return str(self.directory.relative_to(root))
        except ValueError:
            return str(self.directory)


def extract_docstring(init_file: Path) -> str | None:
    """Return the module docstring of ``init_file``, or None if it has none.

    A file that cannot be read or parsed raises: an unreadable ``__init__.py``
    is a real failure, and treating it as "no docstring" would report the wrong
    cause.
    """
    try:
        source = init_file.read_text(encoding="utf-8")
    except OSError as error:
        raise DocumentationError(f"{init_file}: cannot read ({error})") from error

    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise DocumentationError(f"{init_file}: cannot parse ({error})") from error

    return ast.get_docstring(tree, clean=False)


def describe_contract_violation(docstring: str | None) -> str | None:
    """Return why ``docstring`` fails the contract, or None if it passes.

    Returning the reason rather than a boolean is deliberate: the gate has to
    tell the author what to fix, and a bare False cannot.
    """
    if docstring is None:
        return "has no module docstring"

    body = docstring.strip()
    if not body:
        return "has an empty module docstring"

    if len(body) < MINIMUM_BODY_CHARS:
        return (
            f"docstring is {len(body)} characters; "
            f"the contract requires at least {MINIMUM_BODY_CHARS}"
        )

    if not any(section in docstring for section in REQUIRED_SECTIONS):
        joined = ", ".join(REQUIRED_SECTIONS)
        return f"docstring has none of the required sections ({joined})"

    return None


def render_readme(package: PackageDoc) -> str:
    """Render the README content for ``package``.

    The single definition of what a generated README contains. ``check`` and
    ``write`` both call this, so the gate compares against exactly what the
    writer would produce.
    """
    if package.docstring is None:
        raise DocumentationError(
            f"{package.init_file}: cannot render a README with no docstring"
        )

    return (
        f"# {package.directory.name}\n"
        f"\n"
        f"{GENERATED_MARKER}\n"
        f"\n"
        f"{package.docstring.strip()}\n"
        f"\n"
        f"---\n"
        f"\n"
        f"Generated from the module docstring in `__init__.py`. To change this\n"
        f"file, edit that docstring and run\n"
        f"`python scripts/pytools/generate_package_docs.py --write`.\n"
    )


def collect_packages(roots: tuple[Path, ...]) -> list[PackageDoc]:
    """Find every package under ``roots`` and read its docstring."""
    packages: list[PackageDoc] = []
    seen: set[Path] = set()

    for root in roots:
        if not root.exists():
            raise DocumentationError(f"{root}: path does not exist")

        for init_file in sorted(root.rglob("__init__.py")):
            if any(part in EXCLUDED_DIRECTORY_NAMES for part in init_file.parts):
                continue

            resolved = init_file.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)

            packages.append(
                PackageDoc(
                    init_file=init_file,
                    docstring=extract_docstring(init_file),
                )
            )

    return packages


def check(packages: list[PackageDoc], root: Path) -> list[str]:
    """Return one message per package that fails the contract.

    An empty list means the gate passes.
    """
    failures: list[str] = []

    for package in packages:
        name = package.relative_to(root)

        violation = describe_contract_violation(package.docstring)
        if violation is not None:
            failures.append(f"{name}: {violation}")
            continue

        expected = render_readme(package)

        if not package.readme_path.exists():
            failures.append(f"{name}: README.md is missing")
            continue

        try:
            actual = package.readme_path.read_text(encoding="utf-8")
        except OSError as error:
            failures.append(f"{name}: cannot read README.md ({error})")
            continue

        if actual != expected:
            failures.append(
                f"{name}: README.md does not match its docstring "
                f"(hand-edited, or the docstring changed without regenerating)"
            )

    return failures


def write(packages: list[PackageDoc], root: Path, dry_run: bool) -> list[str]:
    """Regenerate every README. Returns messages for packages that failed.

    A package failing the docstring contract is still a failure here: writing a
    README from a placeholder docstring would produce a placeholder README and
    call the job done.
    """
    failures: list[str] = []

    for package in packages:
        name = package.relative_to(root)

        violation = describe_contract_violation(package.docstring)
        if violation is not None:
            failures.append(f"{name}: {violation}")
            continue

        content = render_readme(package)

        if package.readme_path.exists():
            try:
                if package.readme_path.read_text(encoding="utf-8") == content:
                    print(f"  unchanged  {name}")
                    continue
            except OSError as error:
                failures.append(f"{name}: cannot read README.md ({error})")
                continue

        if dry_run:
            print(f"  would write {name}")
            continue

        try:
            package.readme_path.write_text(content, encoding="utf-8")
        except OSError as error:
            failures.append(f"{name}: cannot write README.md ({error})")
            continue

        print(f"  wrote      {name}")

    return failures


def default_roots(repo_root: Path) -> tuple[Path, ...]:
    """The package roots this repository documents, filtered to those present."""
    candidates = (
        repo_root / "python" / "openbrain-memory" / "src",
        repo_root / "python" / "openbrain-provider" / "src",
    )
    return tuple(path for path in candidates if path.exists())


def find_repo_root() -> Path:
    """Locate the repository root by walking up to the directory holding .git."""
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    raise DocumentationError(
        "cannot locate the repository root: no .git found above this script"
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser."""
    parser = argparse.ArgumentParser(
        description=(
            "Generate package README.md files from __init__.py docstrings. "
            "--check is the commit gate and exits non-zero on any violation."
        )
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="verify docstrings and READMEs without writing; non-zero exit on failure",
    )
    mode.add_argument(
        "--write",
        action="store_true",
        help="regenerate every README from its docstring",
    )
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="report what --write would change, writing nothing",
    )
    parser.add_argument(
        "--path",
        type=Path,
        action="append",
        dest="paths",
        default=None,
        help="package root to scan; repeatable. Defaults to the Python packages.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns a process exit code."""
    args = build_parser().parse_args(argv)

    try:
        repo_root = find_repo_root()
        roots = tuple(args.paths) if args.paths else default_roots(repo_root)

        if not roots:
            print(
                "No package roots found. Nothing was checked -- this is a "
                "failure, not a pass: a gate that examines nothing cannot fail.",
                file=sys.stderr,
            )
            return 1

        packages = collect_packages(roots)
    except DocumentationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    if not packages:
        joined = ", ".join(str(root) for root in roots)
        print(
            f"No __init__.py files under {joined}. Nothing was checked -- "
            f"this is a failure, not a pass.",
            file=sys.stderr,
        )
        return 1

    # --check is the default so that an argument-less invocation from a hook
    # gates rather than silently rewriting the working tree.
    if args.write or args.dry_run:
        print(f"Generating package docs for {len(packages)} package(s)")
        failures = write(packages, repo_root, dry_run=args.dry_run)
    else:
        failures = check(packages, repo_root)

    if failures:
        print(
            f"\nBLOCKED: {len(failures)} package(s) failed the documentation "
            f"contract:\n",
            file=sys.stderr,
        )
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print(
            "\nEvery package carries a module docstring with a summary, at "
            "least one required section, and a README generated from it. "
            "These docstrings are the qmd retrieval surface for this repo.\n"
            "Fix the docstring, then run: "
            "python scripts/pytools/generate_package_docs.py --write",
            file=sys.stderr,
        )
        return 1

    print(f"OK: {len(packages)} package(s) documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
