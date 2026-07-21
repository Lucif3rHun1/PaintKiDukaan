import { getCurrentWindow } from "@tauri-apps/api/window";
import { isAnyFormDirty } from "@/pos/hooks";

export function requestGracefulQuit(requestConfirmation: () => void): void {
  if (isAnyFormDirty()) {
    requestConfirmation();
    return;
  }
  void getCurrentWindow().close();
}
