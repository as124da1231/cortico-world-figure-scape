/** Apply the policy to our own window and read back the Windows capture affinity. */
function captureProtection(win, exclude) {
  if (process.platform !== 'win32' || typeof win.setContentProtection !== 'function') return 'unsupported';
  try { win.setContentProtection(exclude); }
  catch { return 'failed'; }
  try {
    const getAffinity = require('koffi').load('user32.dll')
      .func('int __stdcall GetWindowDisplayAffinity(intptr_t hwnd, _Out_ uint32_t *affinity)');
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigInt64LE() : BigInt(handle.readInt32LE());
    const affinity = [0];
    if (!getAffinity(hwnd, affinity)) return 'unverified';
    if (exclude && affinity[0] === 0x11) return 'excluded';
    if (exclude && affinity[0] === 0x01) return 'limited';
    if (!exclude && affinity[0] === 0) return 'allowed';
    return 'failed';
  } catch { return 'unverified'; }
}

module.exports = { captureProtection };
