import { ipc, type MasterHealth } from "../lib/ipc";

export function fetchMasterHealth(): Promise<MasterHealth> {
  return ipc.masterHealth();
}

export function fetchBitlockerStatus(): Promise<string> {
  return ipc.bitlockerStatus();
}
