## Install on macOS

Download the DMG, open it, and drag Flutrace into Applications. The universal
build runs on Apple Silicon and Intel Macs with macOS 12 or later.

This build has no Developer ID signature and is not notarized. If macOS blocks
it, try opening Flutrace once, then go to System Settings > Privacy & Security
and choose Open Anyway for Flutrace. Confirm the prompt. Only do this for a
build you trust. You do not need to disable Gatekeeper.

The SHA256SUMS file contains the checksum of the DMG. Flutter sessions must be
running in debug mode. Automatic discovery may not find every session; you can
also paste its local VM Service URL.
