export interface PetDefinition {
 readonly id: string; readonly schemaVersion: 1;
 readonly resources: { readonly model: { readonly implementation: string } };
 readonly body: { readonly implementation: string };
 readonly scene: { readonly implementation: string };
 readonly actions: { readonly implementation: string };
 readonly input: { readonly implementation: string };
 readonly speech: { readonly implementation: string };
 readonly presentations: Readonly<Record<string, { readonly implementation: string; readonly scene?: string; readonly bodyEffects: Readonly<Record<string, boolean>> }>>;
 readonly defaultPresentation: string;
}
export function definePetDefinition(input: PetDefinition): PetDefinition;
export const DESKTOP_PET_DEFINITION: PetDefinition;
