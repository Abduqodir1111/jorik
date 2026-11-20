const started = performance.now();
let phaseStarted = started;
function startupPhase(phase: string) {
  const now = performance.now();
  console.info(
    JSON.stringify({
      event: "startup_phase",
      phase,
      elapsedMs: Math.round(now - phaseStarted),
      totalMs: Math.round(now - started),
    }),
  );
  phaseStarted = now;
}
// Measure module loading separately from DB/setup/listen. No credentials or
// environment values are logged, and integrations are still started only once.
const [{ config }, { createApp }] = await Promise.all([
  import("./config.js"),
  import("./app.js"),
]);
startupPhase("imports");
const { app } = await createApp(config);
startupPhase("app");
await app.listen({ host: config.host, port: config.port });
startupPhase("listening");
console.log(`Jorik: http://127.0.0.1:${config.port} (${config.mode})`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
