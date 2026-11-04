import { seedDemoFiles } from "../server/demo-files.js";
import { config } from "../server/config.js";
import { openDb } from "../server/db.js";
import { Store, seed } from "../server/store.js";
const db = openDb(config.dataDir, config.mode);
try {
  const store = new Store(db);
  seed(store);
  seedDemoFiles(store, config.dataDir);
  console.log(
    "Демонстрационные диалоги добавлены. Существующая история сохранена.",
  );
} finally {
  db.close();
}
