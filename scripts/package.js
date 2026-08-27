const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const RELEASE_DIR = path.join(ROOT_DIR, "release");

// 1. Parse optional version argument: node scripts/package.js --version 1.2.0
const versionArgIndex = process.argv.indexOf("--version");
let targetVersion = versionArgIndex !== -1 ? process.argv[versionArgIndex + 1] : null;

if (targetVersion) {
  // Strip leading 'v' if present (e.g. v1.2.0 -> 1.2.0)
  targetVersion = targetVersion.replace(/^v/, "").trim();
  console.log(`Injecting version: ${targetVersion}`);

  // Update package.json
  const pkgPath = path.join(ROOT_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  pkg.version = targetVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Update manifest.json
  const manifestPath = path.join(ROOT_DIR, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  manifest.version = targetVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// 2. Read effective version from manifest.json
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "manifest.json"), "utf-8"));
const version = manifest.version;
console.log(`Packaging Fast Furigana v${version}...`);

// 3. Run production build
console.log("Running production build...");
execSync("node scripts/build.js", { cwd: ROOT_DIR, stdio: "inherit" });

// 4. Prepare clean staging directory
const stageDir = path.join(RELEASE_DIR, "stage");
if (fs.existsSync(RELEASE_DIR)) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(stageDir, { recursive: true });

// 5. Copy strictly required runtime assets
const requiredEntries = [
  "manifest.json",
  "dist",
  "offscreen.html",
  "dict",
  "icons",
  "LICENSE"
];

for (const entry of requiredEntries) {
  const src = path.join(ROOT_DIR, entry);
  const dest = path.join(stageDir, entry);
  if (!fs.existsSync(src)) {
    throw new Error(`Required extension file missing: ${entry}`);
  }
  fs.cpSync(src, dest, { recursive: true });
}

// 6. Create ZIP archive
const zipName = `fast-furigana-v${version}.zip`;
const zipPath = path.join(RELEASE_DIR, zipName);

console.log(`Creating archive ${zipName}...`);
execSync(`find "${stageDir}" -name ".DS_Store" -depth -exec rm {} \\;`, { stdio: "ignore" });
execSync(`cd "${stageDir}" && zip -r -9 "${zipPath}" . -x "*.DS_Store*"`, { stdio: "inherit" });

// Clean up temporary stage directory
fs.rmSync(stageDir, { recursive: true, force: true });

console.log(`\nExtension package successfully built:`);
console.log(`  - ${zipPath}`);
