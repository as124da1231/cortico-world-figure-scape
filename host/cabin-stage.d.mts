export function createCabinStage(parent: string): Promise<string>;
export function removeCabinStage(parent: string, stage: string | undefined): Promise<void>;
export function recoverCabinStages(parent: string): Promise<void>;
