# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

import flet_desktop

# The native Flet client (flet.exe plus its DLLs and data/ tree) lives outside
# the importable Python package, so PyInstaller's module analysis never sees it.
# Without this, the frozen app raises "Flet executable not found" and — with
# console=False — dies silently.
flet_client_dir = Path(flet_desktop.__file__).parent / "app"
if not (flet_client_dir / "flet" / "flet.exe").exists():
    raise SystemExit(f"Flet desktop client missing at {flet_client_dir}")


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('questions.db', '.'),
        ('scripts', './scripts'),
        (str(flet_client_dir), 'flet_desktop/app'),
    ],
    hiddenimports=['flet_desktop'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'IPython', 'numpy', 'PIL', 'matplotlib', 'setuptools', 'pkg_resources',
        'jupyter_client', 'tornado', 'pytest', 'test',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX mangles the Flutter DLLs shipped with the Flet client.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
