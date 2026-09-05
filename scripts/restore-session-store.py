"""Restore bounded regular transcript files only; never links or CLI settings."""
import pathlib
import sys
import tarfile

archive, home, subdir = sys.argv[1:]
if subdir not in (".claude/projects", ".qwen/projects", ".codex/sessions"):
    raise ValueError("Invalid transcript directory")
root = pathlib.Path(home)
if root.resolve() != root:
    raise ValueError("Transcript home must not be a link")


def create_directories(target):
    # No execution namespace is alive during restore. Walk each component
    # before creating it so an existing link cannot redirect even mkdir.
    current = root
    for component in target.relative_to(root).parts:
        current = current / component
        if current.is_symlink():
            raise ValueError("Transcript parent must not be a link")
        current.mkdir(exist_ok=True)


with tarfile.open(archive, "r:gz") as source:
    entries = []
    size = 0
    for entry in source:
        path = pathlib.PurePosixPath(entry.name)
        if path.is_absolute() or ".." in path.parts or not (str(path) == subdir or str(path).startswith(subdir + "/")):
            raise ValueError("Invalid transcript path")
        if not entry.isfile() and not entry.isdir():
            raise ValueError("Transcript links and special files are forbidden")
        if entry.size < 0 or (entry.isdir() and entry.size != 0):
            raise ValueError("Invalid transcript entry size")
        size += entry.size
        entries.append(entry)
        if size > 64 * 1024 * 1024 or len(entries) > 10000:
            raise ValueError("Transcript exceeds restore limits")
    for entry in entries:
        target = root / entry.name
        if entry.isdir():
            create_directories(target)
        else:
            create_directories(target.parent)
            with source.extractfile(entry) as content, target.open("xb") as output:
                while chunk := content.read(65536):
                    output.write(chunk)
