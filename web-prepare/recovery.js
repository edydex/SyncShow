(function (root) {
  'use strict';
  function createRecoveryStore(indexedDB) {
    if (arguments.length === 0) { try { indexedDB = root.indexedDB; } catch {} }
    let opening;
    function database() {
      if (!indexedDB) return Promise.reject(new Error('Browser recovery is unavailable. Download a copy to keep your work.'));
      if (!opening) opening = new Promise((resolve, reject) => {
        const request = indexedDB.open('libreshow-local-recovery', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('drafts', { keyPath: 'id' });
          request.result.createObjectStore('summaries', { keyPath: 'id' });
        };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = () => { opening = null; reject(request.error); };
        request.onblocked = () => { opening = null; reject(new Error('Recovery storage is blocked by another tab. Download a copy.')); };
      });
      return opening;
    }
    async function read(store, method, key) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readonly');
        const request = transaction.objectStore(store)[method](key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async function write(snapshot) {
      if (snapshot.schemaVersion !== 1 || !(snapshot.archive instanceof ArrayBuffer)
        || snapshot.archive.byteLength > root.SyncShowPortable.MAX_BROWSER_BYTES) throw new Error('Recovery snapshot is unsupported.');
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['drafts', 'summaries'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Recovery could not be saved.'));
        transaction.onabort = () => reject(transaction.error || new Error('Recovery save was interrupted.'));
        transaction.objectStore('drafts').put(snapshot);
        transaction.objectStore('summaries').put({ id: snapshot.id, title: snapshot.title, savedAt: snapshot.savedAt, unsaved: snapshot.unsaved });
      });
    }
    async function remove(id) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['drafts', 'summaries'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Recovery removal failed.'));
        transaction.objectStore('drafts').delete(id); transaction.objectStore('summaries').delete(id);
      });
    }
    return Object.freeze({ write, remove, load: id => read('drafts', 'get', id),
      list: async () => (await read('summaries', 'getAll')).sort((a, b) => b.savedAt.localeCompare(a.savedAt)) });
  }
  root.LibreShowRecovery = Object.freeze({ createRecoveryStore });
})(globalThis);
