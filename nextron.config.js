/** @type {import('nextron').NextronConfig} */
export default {
  mainSrcDir: "main",
  rendererSrcDir: "renderer",
  // Next.js 16 (Turbopack) takes ~1s+ to become ready; nextron's default
  // startupDelay of 0 makes waitForPort retry 0 times and fail instantly.
  // 15000ms => 30 retries x 500ms, plenty for the renderer to bind.
  startupDelay: 15000,
};
