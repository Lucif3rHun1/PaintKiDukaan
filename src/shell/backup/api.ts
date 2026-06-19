import {
  ipc,
  type BackupMetadata,
  type BackupStatus,
  type BackupTarget,
  type TestRestoreResult,
} from "../lib/ipc";

export function listTargets(): Promise<BackupTarget[]> {
  return ipc.listBackupTargets();
}

export function backupNow(passphrase: string): Promise<BackupMetadata> {
  return ipc.backupNow(passphrase);
}

export function restore(envelopePath: string, passphrase: string): Promise<void> {
  return ipc.restore(envelopePath, passphrase);
}

export function testRestore(
  envelopePath: string,
  passphrase: string,
): Promise<TestRestoreResult> {
  return ipc.testRestore(envelopePath, passphrase);
}

export function status(): Promise<BackupStatus> {
  return ipc.backupStatus();
}
