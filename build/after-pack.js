/**
 * electron-builder afterPack hook (v0.1.26).
 *
 * Why this exists: when we don't ship a real code-signing identity
 * (`mac.identity: null` in package.json), electron-builder skips its
 * signing pass, but macOS still auto-applies an ad-hoc signature on
 * arm64 binaries. Once `@xenova/transformers` started pulling in
 * `onnxruntime-node` (which has its own pre-signed native binaries),
 * the consolidated .app signature became inconsistent: the outer
 * bundle says "I'm signed" but the resources directory is missing
 * or partial. macOS Gatekeeper at first launch doesn't care (user
 * does right-click → Open). But **Squirrel.Mac** does, and refuses
 * to apply auto-updates with:
 *
 *   Code signature at URL .../update.X/Prism.app/ did not pass
 *   validation: code has no resources but signature indicates they
 *   must be present
 *
 * Result: every v0.1.17 → v0.1.25 update downloaded and then silently
 * failed to install. User has been pinned to v0.1.16 the whole time.
 *
 * The fix: post-pack, re-sign the entire bundle (including nested
 * Frameworks/, Resources/, ONNX .node bindings) consistently with
 * ad-hoc signing using `codesign --force --deep --sign -`. The
 * resulting signature is internally consistent so Squirrel.Mac
 * validates it, even though there's no real identity. Real signing
 * with an Apple Developer cert is on the v1.0 backlog.
 */
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  // Only run on macOS — Windows/Linux don't have this problem.
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // ad-hoc sign with `-` identity, --deep to apply to nested bundles,
  // --force to overwrite any pre-existing inconsistent signature.
  console.log(`[after-pack] re-signing ${appPath} (ad-hoc, deep)…`);
  try {
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", appPath],
      { stdio: "inherit" },
    );
    console.log("[after-pack] codesign ok");
  } catch (e) {
    // Fail the build — better than silently shipping another broken
    // updater target.
    console.error("[after-pack] codesign FAILED:", e.message);
    throw e;
  }
};
