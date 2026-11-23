// The fullscreen TUI repaints text while scrolling. Keep the glyph atlas on
// the GPU when one is available. Software WebGL adds an extra raster pass.
let accelerated;
function hardwareWebGL() {
  if (accelerated !== undefined) return accelerated;
  accelerated = false;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat:true, powerPreference:'low-power' });
  if (!gl) return false;
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
    accelerated = !/swiftshader|llvmpipe|softpipe|software rasterizer/i.test(renderer);
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return accelerated;
}

export async function accelerateTerminal(term, disposed) {
  try {
    if (!hardwareWebGL()) return;
    const { WebglAddon } = await import('@xterm/addon-webgl');
    if (disposed()) return;
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch {
    // The terminal opens with the DOM renderer, including on browsers which
    // allow the probe but refuse a second context or the optional chunk.
  }
}
