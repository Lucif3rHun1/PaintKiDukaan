const fs = require("node:fs");

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));

const cargoMatch = cargoToml.match(/^version = "([^"]+)"/m);

if (!cargoMatch) {
  console.error("Missing package version in src-tauri/Cargo.toml");
  process.exit(1);
}

const versions = {
  package: packageJson.version,
  cargo: cargoMatch[1],
  tauri: tauriConfig.version,
};

const uniqueVersions = new Set(Object.values(versions));

if (uniqueVersions.size !== 1) {
  console.error(`Version mismatch: ${JSON.stringify(versions)}`);
  process.exit(1);
}

const tag = process.env.GITHUB_REF_NAME;

if (tag) {
  const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;

  if (tagVersion !== versions.package) {
    console.error(`Release tag ${tag} does not match app version ${versions.package}`);
    process.exit(1);
  }
}

console.log(`Release version OK: ${versions.package}`);
