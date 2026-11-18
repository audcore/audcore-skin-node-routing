(function (root) {
  "use strict";

  const namespace = "audcore.channel-chain.layout.v1";

  function openLayout(receive) {
    const channel = new BroadcastChannel(namespace);
    const revisions = new Map();
    const pending = new Map();
    const database = new Promise((resolve, reject) => {
      const request = indexedDB.open(namespace, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("layout", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    function deliver(record) {
      if (!record || record.revision <= (revisions.get(record.key) ?? 0)) return;
      const write = pending.get(record.key);
      if (write) {
        if (record.revision > (write.latest?.revision ?? 0)) write.latest = record;
        return;
      }
      revisions.set(record.key, record.revision);
      receive(record.key, record.value);
    }

    async function snapshot() {
      const db = await database;
      const request = db.transaction("layout").objectStore("layout").getAll();
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          request.result.forEach(deliver);
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }

    async function put(key, value) {
      const write = pending.get(key) || { count: 0 };
      pending.set(key, write);
      write.count++;
      try {
        const record = await writeRecord(key, value);
        deliver(record);
        channel.postMessage(record);
      } finally {
        write.count--;
        if (!write.count) {
          pending.delete(key);
          deliver(write.latest);
        }
      }
    }

    async function writeRecord(key, value) {
      const db = await database;
      const transaction = db.transaction("layout", "readwrite");
      const records = transaction.objectStore("layout");
      const request = records.get(key);
      let record;
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          record = { key, value, revision: (request.result?.revision ?? 0) + 1 };
          records.put(record);
        };
        transaction.onabort = () => reject(transaction.error);
        transaction.oncomplete = () => resolve(record);
      });
    }

    channel.onmessage = event => deliver(event.data);
    return { snapshot, put };
  }

  root.openChannelChainLayout = openLayout;
})(globalThis);
