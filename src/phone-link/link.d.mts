import type { WebUiFileResult } from 'cortico/web/shared/webui-protocol.ts';

export type PairedPhone = { id: string; name: string; added: string };
export type PhoneLinkStatus = {
  ready: boolean;
  coo: string;
  addresses: string[];
  devices: PairedPhone[];
};
export type PhonePairCode = { qr: string; expires: number };
export type RunningPhoneLink = {
  setupStatus(): Promise<PhoneLinkStatus>;
  createPairCode(address: string): Promise<PhonePairCode>;
  revoke(id: string): void;
  stop(): Promise<void>;
};

export const defaultConsolePort: number;
export function apkInfo(): { size: number } | null;
export function androidApk(): WebUiFileResult;
export function startLink(options: {
  home: string;
  cooPort?: number;
  relayPort?: number;
  figureScapeOrigin: () => string;
  getPassword?: () => string;
  onError?: (error: NodeJS.ErrnoException) => void;
}): Promise<RunningPhoneLink>;
