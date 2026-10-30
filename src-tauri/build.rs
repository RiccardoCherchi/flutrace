fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "frontend_ready",
            "finish_exit",
            "publish_session",
            "start_discovery",
            "discovery_snapshot",
        ]),
    ))
    .expect("could not prepare Flutrace");
}
