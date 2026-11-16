# Figure runtime in Figure Scape

The direct model provider uses the renderer and model preparation components from Figure and DSH. `SOURCE.json` and `direct-tools/SOURCE.json` record the imported files and the local adaptations.

The shared renderer runs native actions, parameter composition, physics, cropping and gaze. Figure Scape owns the editor, window, conversation relay and playback clocks. Third-party licenses are under `pack/sdk` and `pack/vendor`.

Users can confirm the Cubism licenses in the runtime details panel. The SDK service reuses compatible files or retrieves verified components and builds the Framework on the user's computer. This package carries the [runtime license texts](pack/sdk/README.md).

The direct model provider stages verified assets and writes a model resource descriptor. The separate Figure adapter loads authored figure packs from their existing manifests.
