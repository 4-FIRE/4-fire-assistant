import { InstanceLock } from "../../dist/infrastructure/storage.js";
await InstanceLock.acquire(process.argv[2]);
process.on("message", () => {});
process.send({ ready: true });
