import { config } from "./config.js";
import { createApp } from "./app.js";
const { app } = await createApp(config);
await app.listen({ host: config.host, port: config.port });
console.log(`Jorik: http://127.0.0.1:${config.port} (${config.mode})`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
