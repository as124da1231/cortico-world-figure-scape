# Figure runtime in Figure Scape

The direct model provider uses the renderer and model preparation components from Figure and DSH. `SOURCE.json` and `direct-tools/SOURCE.json` record the imported files and the local adaptations.

The [Live2D backend](pack/backends/live2d.js) renders direct `.model3.json` imports with Cubism on a WebGL 1 context. It loads the textures referenced by the model and handles native actions, parameter composition, physics, cropping and gaze. Figure Scape owns the editor, window, conversation relay and playback clocks. Third-party licenses are under `pack/sdk` and `pack/vendor`.

Users can confirm the Cubism licenses in the runtime details panel. The SDK service reuses compatible files or retrieves verified components and builds the Framework on the user's computer. This package carries the [runtime license texts](pack/sdk/README.md).

The direct model provider stages verified assets and writes a model resource descriptor. Coo figure packs have a separate load path through their authored `figure.json` entry. See [character rendering](../docs/architecture.md#角色渲染) for both paths.
