# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

import flet_desktop

# Two separate things have to be shipped by hand, because neither is reachable
# by PyInstaller's import analysis:
#
# 1. The native Flet client (flet.exe plus its DLLs and Flutter data). Without
#    it the app raises "Flet executable not found" and, with console=False,
#    dies before showing a window.
# 2. The JSON data files inside the flet package itself
#    (controls/material/icons.json and the Cupertino equivalent). Without them
#    the window opens and then reports "No such file or directory: ...
#    flet\\controls\\material\\icons.json".
flet_client_dir = Path(flet_desktop.__file__).parent / "app"
if not (flet_client_dir / "flet" / "flet.exe").exists():
    raise SystemExit(f"Flet desktop client missing at {flet_client_dir}")

flet_data = collect_data_files("flet") + collect_data_files("flet_desktop")
if not any(src.endswith("icons.json") for src, _dest in flet_data):
    raise SystemExit("flet icons.json was not collected - the app would fail at startup")


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('questions.db', '.'),
        ('scripts', './scripts'),
        (str(flet_client_dir), 'flet_desktop/app'),
        *flet_data,
    ],
    hiddenimports=['flet_desktop', *collect_submodules('flet')],
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
    name='TheoryQuiz',
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
