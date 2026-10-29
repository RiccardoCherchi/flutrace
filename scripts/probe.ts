import { readFileSync } from "node:fs";
import { RpcClient } from "../src/vm/rpc.ts";
import { makeDetail } from "../src/vm/body.ts";
import type { HttpRequest, Profile } from "../src/vm/types.ts";

const path = process.env.FLUTRACE_VM_URL_FILE;
if (!path) {
  console.error(
    "Set FLUTRACE_VM_URL_FILE to a private file containing the VM Service URL.",
  );
  process.exit(1);
}
let client: RpcClient | undefined;
try {
  client = await RpcClient.connect(readFileSync(path, "utf8").trim());
  const vm = await client.call<{ isolates: { id: string }[] }>("getVM");
  let profiles = 0;
  let jsonBodies = 0;
  let rasterBodies = 0;
  let requestBodies = 0;
  for (const { id: isolateId } of vm.isolates) {
    const isolate = await client.call<{ extensionRPCs: string[] }>(
      "getIsolate",
      { isolateId },
    );
    if (!isolate.extensionRPCs.includes("ext.dart.io.getHttpProfile")) continue;
    const profile = await client.call<Profile>("ext.dart.io.getHttpProfile", {
      isolateId,
    });
    profiles += profile.requests.length;
    for (const request of profile.requests.slice(-40)) {
      if (!request.response?.endTime) continue;
      const raw = await client.call<HttpRequest>(
        "ext.dart.io.getHttpProfileRequest",
        { isolateId, id: request.id },
      );
      const detail = makeDetail(raw);
      if (detail.response.text !== undefined) {
        try {
          JSON.parse(detail.response.text);
          jsonBodies++;
        } catch {}
      }
      if (detail.response.imageMime) rasterBodies++;
      if (detail.request.bytes?.length) requestBodies++;
    }
  }
  console.log(
    JSON.stringify({
      connected: true,
      isolates: vm.isolates.length,
      profiles,
      jsonBodies,
      rasterBodies,
      requestBodies,
    }),
  );
} catch {
  console.error(
    "Probe failed. Check that the VM session is reachable. Raw errors are not logged.",
  );
  process.exitCode = 1;
} finally {
  client?.close();
}
