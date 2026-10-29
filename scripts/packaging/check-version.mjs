import { readFileSync } from "node:fs";
const json = (path) =>
  JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const version = json("src-tauri/tauri.conf.json").version;
const tag = process.env.RELEASE_TAG;
if (
  !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "") ||
  tag !== `v${version}`
) {
  throw new Error("Release tag must be v<version> and match tauri.conf.json.");
}
const cargo = readFileSync(
  new URL("../../src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lock = json("package-lock.json");
if (
  [
    json("package.json").version,
    lock.version,
    lock.packages[""].version,
    cargoVersion,
  ].some((value) => value !== version)
) {
  throw new Error(
    "Synchronize package.json, package-lock.json, Cargo.toml and tauri.conf.json before tagging.",
  );
}
console.log(`Release version verified: ${version}`);
