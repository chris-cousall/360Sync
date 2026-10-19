// Byte-range reader for a File/DiskFile that rides out brief drive hiccups (external/USB drives can
// stall or drop out for a few seconds) before giving up with a clear message.
export function rangeReader(file, { timeout = 20000 } = {}) {
  return async (pos, len) => {
    const until = Date.now() + timeout;
    for (let wait = 250; ; wait = Math.min(wait * 2, 2000)) {
      try {
        return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
      } catch (e) {
        if (Date.now() + wait > until) {
          if (/lost access/i.test(e.message)) throw e;
          throw new Error(`lost access to ${file.name} (${e.name || e.message}). If it's on an external drive, check it's still connected — the drive may have disconnected or be failing`);
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
}
