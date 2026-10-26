function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('directory-scraper', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('data')) {
        db.createObjectStore('data', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqValue(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error('Transaction aborted'));
    };
    try {
      const res = work(tx);
      if (res && typeof res.then === 'function') {
        res.then((val) => {
          result = val;
        }, reject);
      } else {
        result = res;
      }
    } catch (err) {
      db.close();
      reject(err);
    }
  });
}

export async function saveSnapshot(meta, items) {
  const id = 'snap_' + Date.now();
  const record = {
    id,
    savedAt: new Date().toISOString(),
    count: items.length,
    ...meta,
  };
  await run(['meta', 'data'], 'readwrite', (tx) => {
    tx.objectStore('meta').put(record);
    tx.objectStore('data').put({ id, items });
  });
  return record;
}

export async function listSnapshots() {
  const rows = await run(['meta'], 'readonly', (tx) => {
    return reqValue(tx.objectStore('meta').getAll());
  });
  return (rows || []).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export async function loadSnapshotItems(id) {
  const row = await run(['data'], 'readonly', (tx) => {
    return reqValue(tx.objectStore('data').get(id));
  });
  return row?.items ?? [];
}

export async function deleteSnapshot(id) {
  return run(['meta', 'data'], 'readwrite', (tx) => {
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
  });
}
