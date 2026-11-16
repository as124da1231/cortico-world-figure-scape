/** Compatibility exports for the original body-only slice. Production uses desktop-system.js.
 * Keep this seam for existing consumers; it is not the product SystemDefinition. */
export { defineBodyAssembly as definePetSystem, createBodyRuntime as createPetSystem } from './framework/body-runtime.js';
export { definePetDefinition, DESKTOP_PET_DEFINITION } from './framework/definition.js';
export { createPetRuntime } from './framework/runtime.js';
