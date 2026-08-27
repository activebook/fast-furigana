const esbuild = require("esbuild");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: {
    content: path.resolve(ROOT_DIR, "src/content.ts"),
    background: path.resolve(ROOT_DIR, "src/background.ts"),
    offscreen: path.resolve(ROOT_DIR, "src/offscreen.ts")
  },
  bundle: true,
  outdir: path.resolve(ROOT_DIR, "dist"),
  sourcemap: true,
  target: ["chrome110"],
  platform: "browser",
  alias: {
    kuromoji: path.resolve(ROOT_DIR, "kuromoji")
  },
  logLevel: "info"
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("esbuild: watching for file changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log("esbuild: production build complete.");
  }
}

main().catch((error) => {
  console.error("esbuild error:", error);
  process.exit(1);
});
