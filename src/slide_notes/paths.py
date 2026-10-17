"""Runtime resource paths and source-checkout boundaries, independent of cwd."""
import os
from pathlib import Path
import sys

PACKAGE_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = PACKAGE_ROOT / 'static'
EXAMPLES_ROOT = PACKAGE_ROOT / 'examples'
TEMPLATE_PATH = PACKAGE_ROOT / 'example.json'
KERNEL_WORKER = PACKAGE_ROOT / 'notebook/kernel_worker.py'


def environment_python(directory, platform=None):
    """A workspace venv uses the interpreter layout of the running platform."""
    return Path(directory) / ('Scripts/python.exe' if (platform or sys.platform) == 'win32' else 'bin/python')


def configuration_directory():
    """Use native per-user locations while retaining existing configurations."""
    if os.environ.get('SLIDE_NOTES_CONFIG_HOME'):
        return Path(os.environ['SLIDE_NOTES_CONFIG_HOME']).expanduser()
    legacy = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'slide-notes'
    if os.environ.get('XDG_CONFIG_HOME') or legacy.is_dir():
        return legacy
    if sys.platform == 'win32':
        return Path(os.environ.get('APPDATA', Path.home() / 'AppData/Roaming')) / 'slide-notes'
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/slide-notes'
    return legacy

SOURCE_DIRECTORIES = frozenset({
    'src', 'frontend', 'tests', 'docs', 'scripts', 'slide_notes', 'layouts',
    'build', 'dist', '.github',
})
SOURCE_FILES = frozenset({
    'AGENTS.md', 'README.md', 'LICENSE', 'MANIFEST.in', 'pyproject.toml',
    '.gitattributes', '.gitignore', 'SOURCE_MANIFEST.json',
    'requirements.txt', 'requirements-dev.txt', 'notes', 'start.sh',
    'start-notes.sh', 'install.sh', 'install.ps1', 'notebook.py', 'notebook.css', 'idea.md',
})


def is_source_workspace(root):
    """Recognize both current src layout and older user workspaces safely."""
    root = Path(root)
    return (root / 'pyproject.toml').is_file() and any(
        (root / marker).is_file()
        for marker in ('src/slide_notes/web/server.py', 'slide_notes/server.py')
    )


def protected_software_roots(workspace_root):
    """Keep the complete installed package and checkout source read-only."""
    root = Path(workspace_root)
    protected = [PACKAGE_ROOT]
    if is_source_workspace(root):
        protected.extend(root / name for name in SOURCE_DIRECTORIES)
    return protected


def frontend_dependencies():
    checkout = PACKAGE_ROOT.parent.parent
    if is_source_workspace(checkout):
        return checkout / 'frontend/node_modules'
    return PACKAGE_ROOT / 'node_modules'
