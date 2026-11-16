const captureStates = ['excluded', 'limited', 'allowed', 'failed', 'unverified', 'unsupported'] as const;
type CaptureState = typeof captureStates[number];

export interface WindowCompatibility {
  hideFromCapture: boolean;
  capture: CaptureState | 'pending' | 'offline';
  overTaskbar: boolean | null;
}

export function readWindowCompatibility(message: Record<string, unknown>, exclude: boolean, overlap: boolean): WindowCompatibility | null {
  const capture = captureStates.find(state => state === message.capture);
  if (!capture || message.hideFromCapture !== exclude || (message.overTaskbar !== null && message.overTaskbar !== overlap)) return null;
  if (exclude ? capture === 'allowed' : capture === 'excluded' || capture === 'limited') return null;
  return { hideFromCapture: exclude, capture, overTaskbar: message.overTaskbar === null ? null : overlap };
}
