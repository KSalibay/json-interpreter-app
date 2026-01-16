(function () {
  function sanitizeId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, '');
    return safe || null;
  }

  async function loadConfigById(id) {
    const safeId = sanitizeId(id);
    if (!safeId) {
      throw new Error('Invalid id. Allowed: A-Z a-z 0-9 _ -');
    }

    const url = `configs/${encodeURIComponent(safeId)}.json`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to load ${url} (${res.status})`);
    }

    const json = await res.json();
    return { id: safeId, sourceUrl: url, config: json };
  }

  function loadConfigFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file provided'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.onload = () => {
        try {
          const json = JSON.parse(String(reader.result || ''));
          resolve({ id: null, sourceUrl: null, config: json });
        } catch (e) {
          reject(new Error(`Invalid JSON: ${e && e.message ? e.message : String(e)}`));
        }
      };
      reader.readAsText(file);
    });
  }

  window.ConfigLoader = {
    sanitizeId,
    loadConfigById,
    loadConfigFromFile
  };
})();
