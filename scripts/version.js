const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const pkgPath = path.join(ROOT_DIR, "package.json");
const manifestPath = path.join(ROOT_DIR, "manifest.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
let baseVersion = pkg.version || "1.0.0";

// Check highest Git tag if available to guarantee monotonically increasing versions
try {
  const tagOutput = execSync('git tag -l "v*"', { cwd: ROOT_DIR, encoding: "utf-8" }).trim();
  if (tagOutput) {
    const tags = tagOutput
      .split("\n")
      .map((t) => t.trim().replace(/^v/, ""))
      .filter((t) => /^\d+(\.\d+)*$/.test(t));

    tags.sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

    const highestTag = tags[tags.length - 1];
    if (highestTag) {
      baseVersion = highestTag;
    }
  }
} catch {
  // fallback to package.json
}

const arg = (process.argv[2] || "patch").toLowerCase().replace(/^v/, "");

let newVersion = "";
if (arg === "patch" || arg === "minor" || arg === "major") {
  const parts = baseVersion.split(".").map(Number);
  while (parts.length < 3) parts.push(0);

  if (arg === "major") {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (arg === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    // patch
    parts[2] += 1;
  }
  newVersion = parts.join(".");
} else if (/^\d+\.\d+\.\d+/.test(arg)) {
  newVersion = arg;
} else {
  console.error(`Invalid version or bump type: ${arg}`);
  process.exit(1);
}

// 1. Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. Update manifest.json
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Output only the new version for script consumption
console.log(newVersion);
