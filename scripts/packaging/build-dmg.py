"""Package an existing app without Finder automation or code signing."""
import pathlib
import plistlib
import subprocess
import sys

import dmgbuild

root = pathlib.Path(__file__).resolve().parents[2]
if len(sys.argv) != 3:
    raise SystemExit("Usage: build-dmg.py <Flutrace.app> <output-directory>")
app = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
if app.name != "Flutrace.app" or not app.is_dir():
    raise SystemExit("Expected a built Flutrace.app bundle")
with (app / "Contents/Info.plist").open("rb") as file:
    info = plistlib.load(file)
version = info["CFBundleShortVersionString"]
binary = app / "Contents/MacOS" / info["CFBundleExecutable"]
architectures = set(subprocess.check_output(["lipo", "-archs", str(binary)], text=True).split())
if architectures == {"arm64", "x86_64"}:
    architecture = "universal"
elif architectures == {"arm64"}:
    architecture = "aarch64"
elif architectures == {"x86_64"}:
    architecture = "x64"
else:
    raise SystemExit("Unexpected executable architecture")
output.mkdir(parents=True, exist_ok=True)
destination = output / f"Flutrace_{version}_{architecture}.dmg"
dmgbuild.build_dmg(str(destination), "Flutrace", settings={
    "files": [str(app)],
    "symlinks": {"Applications": "/Applications"},
    "background": str(root / "src-tauri/dmg/background.png"),
    "icon": str(app / "Contents/Resources/icon.icns"),
    "window_rect": ((200, 160), (660, 420)),
    "icon_locations": {"Flutrace.app": (180, 245), "Applications": (480, 245)},
    "icon_size": 96,
    "text_size": 13,
    "default_view": "icon-view",
    "show_toolbar": False,
    "show_status_bar": False,
    "show_pathbar": False,
    "show_sidebar": False,
    "include_icon_view_settings": True,
    "include_list_view_settings": False,
    "format": "UDZO",
})
print(destination)
